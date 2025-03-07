import * as kvStore from './kv-store';
import { generateUUID } from './utils';
import { AppError, logger } from './logger';
import { userBalanceStore } from './user-balance-store';

// Create a logger instance for this module
const bugReportLogger = logger.child({ context: 'bug-report-store' });

// Default reward amounts
const DEFAULT_INITIAL_REWARD = 10;
const DEFAULT_CONFIRMATION_REWARD = 90;

export class BugReportStore {
  /**
   * Get all bug reports
   */
  async getAllBugReports() {
    try {
      // Get all bug report IDs
      const reportIds = await kvStore.getSetMembers('BUG_REPORT_IDS', '');

      if (!reportIds || reportIds.length === 0) {
        return [];
      }

      // Get all bug reports
      const reports = await Promise.all(
        reportIds.map(async (id) => {
          const report = await kvStore.getEntity('BUG_REPORT', id);
          return report;
        })
      );

      return reports.filter((report) => report !== null);
    } catch (error) {
      throw new AppError({
        message: 'Failed to retrieve bug reports',
        context: 'bug-report-store',
        code: 'BUG_REPORT_FETCH_ERROR',
        originalError: error instanceof Error ? error : new Error(String(error))
      }).log();
    }
  }

  /**
   * Get specific bug report by ID
   */
  async getBugReport(id: string) {
    if (!id) {
      bugReportLogger.warn({}, 'Attempted to get bug report with empty ID');
      return null;
    }

    const report: any = await kvStore.getEntity('BUG_REPORT', id);

    if (!report) {
      bugReportLogger.debug({ reportId: id }, `Bug report ${id} not found`);
    }

    return report;
  }

  /**
   * Get all bug reports for a specific user
   */
  async getUserBugReports(userId: string) {
    try {
      if (!userId) {
        return [];
      }

      // Get the user's bug report IDs
      const reportIds = await kvStore.getSetMembers('USER_BUG_REPORTS', userId);

      if (reportIds.length === 0) {
        return [];
      }

      // Get all bug reports
      const reports = await Promise.all(
        reportIds.map(id => this.getBugReport(id))
      );

      // Filter out any null reports (in case of data inconsistency)
      return reports.filter((report) => report !== null);
    } catch (error) {
      throw new AppError({
        message: `Failed to retrieve bug reports for user ${userId}`,
        context: 'bug-report-store',
        code: 'USER_BUG_REPORTS_ERROR',
        originalError: error instanceof Error ? error : new Error(String(error)),
        data: { userId }
      }).log();
    }
  }

  /**
   * Create a new bug report
   */
  async createBugReport(data: {
    title: string;
    description: string;
    severity: string;
    url?: string;
    createdBy: string;
  }) {
    try {
      // Validate required fields
      if (!data.title || !data.description || !data.createdBy) {
        throw new AppError({
          message: 'Missing required bug report data',
          context: 'bug-report-store',
          code: 'BUG_REPORT_VALIDATION_ERROR',
          data: {
            hasTitle: !!data.title,
            hasDescription: !!data.description,
            hasCreatedBy: !!data.createdBy
          }
        }).log();
      }

      const id = generateUUID();
      const now = new Date().toISOString();

      // Construct complete bug report with defaults
      const bugReport = {
        id,
        title: data.title,
        description: data.description,
        severity: data.severity,
        url: data.url,
        createdBy: data.createdBy,
        createdAt: now,
        status: 'open'
      };

      // Start transaction for atomic operation
      const tx = await kvStore.startTransaction();

      try {
        // Add all operations to transaction
        await tx.addEntity('BUG_REPORT', id, bugReport);
        await tx.addToSetInTransaction('BUG_REPORT_IDS', '', id);
        await tx.addToSetInTransaction('USER_BUG_REPORTS', data.createdBy, id);

        // Execute transaction
        const success = await tx.execute();

        if (!success) {
          throw new AppError({
            message: 'Failed to create bug report - transaction failed',
            context: 'bug-report-store',
            code: 'BUG_REPORT_TRANSACTION_ERROR',
            data: { reportId: id }
          }).log();
        }

        bugReportLogger.info(
          { reportId: id, userId: data.createdBy },
          `Bug report created: ${data.title}`
        );

        return bugReport;
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        } else {
          throw new AppError({
            message: 'Error during bug report creation transaction',
            context: 'bug-report-store',
            code: 'BUG_REPORT_CREATE_TRANSACTION_ERROR',
            originalError: error instanceof Error ? error : new Error(String(error)),
            data: { title: data.title }
          }).log();
        }
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      } else {
        throw new AppError({
          message: 'Failed to create bug report',
          context: 'bug-report-store',
          code: 'BUG_REPORT_CREATE_ERROR',
          originalError: error instanceof Error ? error : new Error(String(error)),
          data: { title: data.title }
        }).log();
      }
    }
  }

  /**
   * Update an existing bug report
   */
  async updateBugReport(id: string, data: any) {
    try {
      const existingReport = await this.getBugReport(id);
      if (!existingReport) {
        bugReportLogger.warn({ reportId: id }, `Cannot update non-existent bug report with ID ${id}`);
        return null;
      }

      // Ensure we don't change critical fields like ID
      const safeData = { ...data };
      if (safeData.id && safeData.id !== id) {
        delete safeData.id;
        bugReportLogger.warn(
          { reportId: id, attemptedId: data.id },
          'Attempted to change bug report ID during update - ignoring'
        );
      }

      const updatedReport = {
        ...existingReport,
        ...safeData,
        updatedAt: new Date().toISOString()
      };

      // Save updated bug report
      await kvStore.storeEntity('BUG_REPORT', id, updatedReport);

      bugReportLogger.debug(
        { reportId: id },
        `Bug report updated: ${existingReport.title}`
      );

      return updatedReport;
    } catch (error) {
      throw new AppError({
        message: `Failed to update bug report ${id}`,
        context: 'bug-report-store',
        code: 'BUG_REPORT_UPDATE_ERROR',
        originalError: error instanceof Error ? error : new Error(String(error)),
        data: { reportId: id }
      }).log();
    }
  }

  async deleteBugReport(id: string): Promise<boolean> {
    try {
      const report = await this.getBugReport(id);
      if (!report) {
        throw new Error(`Bug report ${id} not found`);
      }

      // Delete bug report
      await kvStore.deleteEntity('BUG_REPORT', id);

      // Remove from global set of bug report IDs
      await kvStore.removeFromSet('BUG_REPORT_IDS', '', id);

      // Remove from user's set of bug reports
      await kvStore.removeFromSet('USER_BUG_REPORTS', report.createdBy, id);

      return true;
    } catch (error) {
      console.error(`Error deleting bug report ${id}:`, error);
      return false;
    }
  }

  /**
     * Process a reward payment for a bug report
     * This handles giving the initial or confirmation reward to a user
     * 
     * @param reportId Bug report ID
     * @param userId User ID to receive the reward
     * @param rewardType Type of reward (initial or confirmation)
     * @param customAmount Optional custom amount (overrides defaults)
     * @returns Result object with success/error status
     */
  /**
   * Confirm a bug report (mark as verified by admin)
   * @param id Bug report ID
   * @param adminId ID of the admin confirming the report
   */
  async confirmBugReport(id: string, adminId: string) {
    try {
      const report = await this.getBugReport(id);
      if (!report) {
        bugReportLogger.warn({ reportId: id }, `Cannot confirm non-existent bug report: ${id}`);
        return null;
      }

      if (report.status === 'resolved') {
        bugReportLogger.warn({ reportId: id }, `Bug report ${id} is already resolved`);
        return report;
      }

      const now = new Date().toISOString();
      const updatedReport = await this.updateBugReport(id, {
        status: 'resolved' as const,
        confirmedBy: adminId,
        confirmedAt: now,
        updatedBy: adminId,
        updatedAt: now
      });

      bugReportLogger.info(
        { reportId: id, adminId },
        `Bug report confirmed: ${report.title}`
      );

      return updatedReport;
    } catch (error) {
      throw new AppError({
        message: `Failed to confirm bug report ${id}`,
        context: 'bug-report-store',
        code: 'BUG_REPORT_CONFIRM_ERROR',
        originalError: error instanceof Error ? error : new Error(String(error)),
        data: { reportId: id, adminId }
      }).log();
    }
  }

  /**
   * Pay a reward for a bug report
   * @param id Bug report ID
   * @param isInitialReward Whether to pay the initial (true) or confirmation (false) reward
   */
  async payReward(id: string, isInitialReward: boolean) {
    try {
      // Get the bug report
      const report = await this.getBugReport(id);
      if (!report) {
        bugReportLogger.warn({ reportId: id }, `Cannot pay reward for non-existent bug report: ${id}`);
        return null;
      }

      // Determine recipient and reward type
      const recipientId = report.createdBy;
      const rewardType = isInitialReward ? 'initial' : 'confirmation';

      // Process the payment through the internal method
      const result = await this.processRewardPayment(id, recipientId, rewardType);

      if (!result.success) {
        throw new AppError({
          message: result.error || 'Failed to pay reward',
          context: 'bug-report-store',
          code: 'REWARD_PAYMENT_FAILED',
          data: {
            reportId: id,
            userId: recipientId,
            rewardType,
            error: result.error
          }
        });
      }

      return result.report || null;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      } else {
        throw new AppError({
          message: `Failed to pay ${isInitialReward ? 'initial' : 'confirmation'} reward for bug report ${id}`,
          context: 'bug-report-store',
          code: 'REWARD_PAYMENT_ERROR',
          originalError: error instanceof Error ? error : new Error(String(error)),
          data: { reportId: id, isInitialReward }
        }).log();
      }
    }
  }

  /**
   * Internal helper method to process reward payments
   * This handles giving the initial or confirmation reward to a user
   */
  private async processRewardPayment(
    reportId: string,
    userId: string,
    rewardType: 'initial' | 'confirmation',
    customAmount?: number
  ): Promise<{
    success: boolean;
    amount?: number;
    error?: string;
    report?: any;
  }> {
    try {
      const opLogger = bugReportLogger.child({
        operation: 'processRewardPayment',
        reportId,
        userId,
        rewardType
      });

      opLogger.info({}, `Processing ${rewardType} reward payment`);

      // Get the bug report
      const report = await this.getBugReport(reportId);
      if (!report) {
        return { success: false, error: 'Bug report not found' };
      }

      // Determine the reward amount
      const amount = customAmount ||
        (rewardType === 'initial' ? DEFAULT_INITIAL_REWARD : DEFAULT_CONFIRMATION_REWARD);

      // Check if reward has already been paid
      if (rewardType === 'initial' && report.initialRewardPaid) {
        opLogger.warn({}, 'Initial reward already paid for this report');
        return {
          success: false,
          error: 'Initial reward already paid for this report',
          report
        };
      }

      if (rewardType === 'confirmation' && report.confirmationRewardPaid) {
        opLogger.warn({}, 'Confirmation reward already paid for this report');
        return {
          success: false,
          error: 'Confirmation reward already paid for this report',
          report
        };
      }

      opLogger.debug({ amount }, `Processing payment of ${amount} tokens`);

      // Process the payment
      const updatedBalance = await userBalanceStore.addFunds(userId, amount);

      if (!updatedBalance) {
        throw new AppError({
          message: 'Failed to update user balance',
          context: 'bug-report-store',
          code: 'BALANCE_UPDATE_FAILED',
          data: { userId, amount, reportId }
        });
      }

      // Update the bug report to reflect the paid reward
      const updateData: any = {};
      if (rewardType === 'initial') {
        updateData.initialRewardPaid = true;
      } else {
        updateData.confirmationRewardPaid = true;

        // If we're paying the confirmation reward, also update status if not already resolved
        if (report.status !== 'resolved') {
          updateData.status = 'resolved' as const;
          updateData.confirmedAt = new Date().toISOString();
        }
      }

      const updatedReport = await this.updateBugReport(reportId, updateData);
      if (!updatedReport) {
        throw new AppError({
          message: 'Failed to update bug report after payment',
          context: 'bug-report-store',
          code: 'REPORT_UPDATE_FAILED',
          data: { reportId, rewardType }
        });
      }

      opLogger.info(
        { amount, reportId, userId },
        `Successfully processed ${rewardType} reward payment`
      );

      return {
        success: true,
        amount,
        report: updatedReport
      };
    } catch (error) {
      if (error instanceof AppError) {
        error.log();
        return { success: false, error: error.message };
      } else {
        const appError = new AppError({
          message: `Error processing reward payment for report ${reportId}`,
          context: 'bug-report-store',
          code: 'REWARD_PROCESS_ERROR',
          originalError: error instanceof Error ? error : new Error(String(error)),
          data: { reportId, userId, rewardType }
        }).log();

        return { success: false, error: appError.message };
      }
    }
  }
}

// Export a singleton instance
export const bugReportStore = new BugReportStore();