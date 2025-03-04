import { z } from 'zod';
import * as kvStore from './kv-store.js';
import crypto from 'crypto';

// Define bug report types
export const BugReportSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  severity: z.string(),
  url: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  status: z.enum(['open', 'in-progress', 'resolved', 'closed']).default('open'),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
  resolution: z.string().optional(),
  // Reward-related fields
  initialRewardPaid: z.boolean().optional(),
  confirmationRewardPaid: z.boolean().optional(),
  // Confirmation-related fields
  confirmedBy: z.string().optional(),
  confirmedAt: z.string().optional()
});

export type BugReport = z.infer<typeof BugReportSchema>;

// Default reward amounts
const DEFAULT_INITIAL_REWARD = 10;
const DEFAULT_CONFIRMATION_REWARD = 90;

export class BugReportStore {
  async getBugReports(): Promise<BugReport[]> {
    try {
      // Get all bug report IDs
      const reportIds = await kvStore.getSetMembers('BUG_REPORT_IDS', '');

      if (!reportIds || reportIds.length === 0) {
        return [];
      }

      // Get all bug reports
      const reports = await Promise.all(
        reportIds.map(async (id) => {
          const report = await kvStore.getEntity<BugReport>('BUG_REPORT', id);
          return report;
        })
      );

      return reports.filter((report): report is BugReport => report !== null);
    } catch (error) {
      console.error('Error getting bug reports:', error);
      return [];
    }
  }

  async getBugReport(id: string): Promise<BugReport | null> {
    try {
      return await kvStore.getEntity<BugReport>('BUG_REPORT', id);
    } catch (error) {
      console.error(`Error getting bug report ${id}:`, error);
      return null;
    }
  }

  async createBugReport(data: Omit<BugReport, 'id' | 'createdAt'>): Promise<BugReport> {
    try {
      const id = crypto.randomUUID();
      const bugReport: BugReport = {
        ...data,
        id,
        createdAt: new Date().toISOString()
      };

      // Save bug report
      await kvStore.storeEntity('BUG_REPORT', id, bugReport);

      // Add to global set of bug report IDs
      await kvStore.addToSet('BUG_REPORT_IDS', '', id);

      // Add to user's set of bug reports
      await kvStore.addToSet('USER_BUG_REPORTS', data.createdBy, id);

      return bugReport;
    } catch (error) {
      console.error('Error creating bug report:', error);
      throw error;
    }
  }

  async updateBugReport(id: string, data: Partial<BugReport>): Promise<BugReport> {
    try {
      const existingReport = await this.getBugReport(id);
      if (!existingReport) {
        throw new Error(`Bug report ${id} not found`);
      }

      const updatedReport: BugReport = {
        ...existingReport,
        ...data,
        updatedAt: new Date().toISOString()
      };

      // Save updated bug report
      await kvStore.storeEntity('BUG_REPORT', id, updatedReport);

      return updatedReport;
    } catch (error) {
      console.error(`Error updating bug report ${id}:`, error);
      throw error;
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
  async processRewardPayment(
    reportId: string,
    userId: string,
    rewardType: 'initial' | 'confirmation',
    customAmount?: number
    // reason?: string // Removed unused parameter
  ): Promise<{
        success: boolean;
        amount?: number;
        error?: string;
        report?: BugReport;
    }> {
    try {
      // Import balance store to avoid circular dependencies
      const { userBalanceStore } = await import('./user-balance-store.js');

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
        return {
          success: false,
          error: 'Initial reward already paid for this report',
          report
        };
      }

      if (rewardType === 'confirmation' && report.confirmationRewardPaid) {
        return {
          success: false,
          error: 'Confirmation reward already paid for this report',
          report
        };
      }

      // Generate a reason for the transaction if needed in the future
      // const paymentReason = reason || (rewardType === 'initial'
      //   ? `Initial bug report reward for report ${reportId}`
      //   : `Confirmation reward for verified bug report ${reportId}`);

      // Process the payment
      const updatedBalance = await userBalanceStore.addFunds(userId, amount);

      if (!updatedBalance) {
        return { success: false, error: 'Failed to update user balance' };
      }

      // Update the bug report to reflect the paid reward
      const updateData: Partial<BugReport> = {};
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

      return {
        success: true,
        amount,
        report: updatedReport
      };
    } catch (error) {
      console.error(`Error processing reward payment for report ${reportId}:`, error);
      return { success: false, error: 'Failed to process reward payment' };
    }
  }
}

// Export a singleton instance
export const bugReportStore = new BugReportStore();