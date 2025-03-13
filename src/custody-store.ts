import * as kvStore from './kv-store';
import { isAdmin } from './utils';
import { AppError, logger } from './logger';
import { marketStore } from './market-store';
import { userBalanceStore } from './user-balance-store';
import { userStatsStore } from './user-stats-store';

// Create a logger instance for this module
const custodyLogger = logger.child({ context: 'custody-store' });

// Define transaction types based on the chrome extension types
export enum TransactionType {
  TRANSFER = 'transfer',
  PREDICT = 'predict',
  CLAIM_REWARD = 'claim-reward',
}

// Interface for a transaction in custody
export interface CustodyTransaction {
  // Transaction core data (comes from signed transaction)
  signature: string;
  nonce: number;
  signer: string;
  type: TransactionType;
  subnetId: string;

  // Transaction-specific data
  to?: string;
  amount?: number;
  marketId?: string | number;
  outcomeId?: number;
  receiptId?: number;

  // Custody metadata
  id: string; // UUID for this custody record
  userId: string; // User who has custody
  takenCustodyAt: string; // When custody was established
  status: 'pending' | 'submitted' | 'confirmed' | 'rejected';
  submittedAt?: string; // When transaction was submitted to the blockchain
  confirmedAt?: string; // When transaction was confirmed on the blockchain
  rejectedAt?: string; // When transaction was rejected
  rejectionReason?: string; // Why transaction was rejected

  // For predictions - additional metadata
  marketName?: string;
  outcomeName?: string;
  nftReceipt?: any;
}

// Custody store with Vercel KV
export const custodyStore = {
  // Take custody of a signed transaction
  async takeCustody(data: {
    // Transaction data from the signed transaction
    signature: string;
    nonce: number;
    signer: string;
    type: TransactionType;
    subnetId: string;

    // Transaction-specific data
    to?: string;
    amount?: number;
    marketId?: string | number;
    outcomeId?: number;
    receiptId?: number;

    // Custody metadata
    userId: string; // User requesting custody
  }): Promise<{
    success: boolean;
    transaction?: CustodyTransaction;
    error?: string;
  }> {
    try {
      // Validate input
      if (!data.signature || !data.userId || !data.type) {
        throw new AppError({
          message: 'Invalid custody data',
          context: 'custody-store',
          code: 'CUSTODY_VALIDATION_ERROR',
          data: {
            hasSignature: !!data.signature,
            hasUserId: !!data.userId,
            hasType: !!data.type
          }
        }).log();
      }

      // Check if this transaction is already in custody
      const existingTx = await this.findByCriteria({
        signature: data.signature
      });

      if (existingTx.length > 0) {
        throw new AppError({
          message: 'Transaction already in custody',
          context: 'custody-store',
          code: 'TRANSACTION_ALREADY_IN_CUSTODY',
          data: {
            signature: data.signature,
            existingCustody: existingTx[0]?.id
          }
        }).log();
      }

      custodyLogger.debug(
        {
          signature: data.signature.substring(0, 8) + '...',
          userId: data.userId,
          type: data.type
        },
        'Taking custody of transaction'
      );

      // Use the transaction signature and nonce as a unique ID
      // This ensures we don't have duplicate custody records
      const id = `${data.signature.substring(0, 10)}-${data.nonce}`;
      const now = new Date().toISOString();

      // Create a custody record
      const transaction: CustodyTransaction = {
        id,
        signature: data.signature,
        nonce: data.nonce,
        signer: data.signer,
        type: data.type,
        subnetId: data.subnetId,
        userId: data.userId,
        takenCustodyAt: now,
        status: 'pending'
      };

      // Add transaction-specific properties
      if (data.to) transaction.to = data.to;
      if (data.amount !== undefined) transaction.amount = data.amount;
      if (data.marketId !== undefined) transaction.marketId = data.marketId;
      if (data.outcomeId !== undefined) transaction.outcomeId = data.outcomeId;
      if (data.receiptId !== undefined) transaction.receiptId = data.receiptId;

      // For prediction transactions - add additional metadata and NFT receipt
      if (data.type === TransactionType.PREDICT && data.marketId && data.outcomeId !== undefined) {
        try {
          const market: any = await marketStore.getMarket(data.marketId.toString());
          if (market) {
            const outcome = market.outcomes.find((o: any) => o.id === data.outcomeId);
            if (outcome) {
              transaction.marketName = market.name;
              transaction.outcomeName = outcome.name;

              // Generate NFT receipt like in the prediction store
              transaction.nftReceipt = {
                id: `${id}-nft`,
                tokenId: `${data.marketId}-${data.userId}-${now}`,
                image: this.generateNftImage(market.name, outcome.name, data.amount || 0),
                transactionId: id,
                marketName: market.name,
                outcomeName: outcome.name,
                amount: data.amount,
                createdAt: now
              };
            }
          }
        } catch (marketError) {
          // Just log the error but continue - NFT receipt is optional
          custodyLogger.error(
            { marketId: data.marketId, error: marketError },
            'Failed to get market data for custody NFT'
          );
        }
      }

      // Start a transaction for atomic operation
      const tx = await kvStore.startTransaction();

      try {
        // Add all operations to the transaction
        await tx.addEntity('CUSTODY_TRANSACTION', id, transaction);

        // Add to user's custody transactions set
        await tx.addToSetInTransaction('USER_TRANSACTIONS', data.userId, id);

        // Add to signer's transactions set
        await tx.addToSetInTransaction('SIGNER_TRANSACTIONS', data.signer, id);

        // For prediction transactions, also add to the market's transactions
        if (data.type === TransactionType.PREDICT && data.marketId) {
          await tx.addToSetInTransaction('MARKET_TRANSACTIONS', data.marketId.toString(), id);
        }

        // If we have an NFT receipt, store it
        if (transaction.nftReceipt) {
          await tx.addEntity('CUSTODY_NFT_RECEIPT', transaction.nftReceipt.id, transaction.nftReceipt);
        }

        // Execute the transaction
        const success = await tx.execute();

        if (!success) {
          throw new AppError({
            message: 'Failed to take custody - transaction failed',
            context: 'custody-store',
            code: 'CUSTODY_TRANSACTION_ERROR',
            data: { transactionId: id }
          }).log();
        }

        // Update market stats if this is a prediction
        if (data.type === TransactionType.PREDICT && data.marketId && data.outcomeId !== undefined && data.amount) {
          try {
            await marketStore.updateMarketStats(
              data.marketId.toString(),
              data.outcomeId,
              data.amount,
              data.userId
            );
          } catch (statsError) {
            // Just log the error but continue - stats are not critical
            custodyLogger.error(
              { marketId: data.marketId, error: statsError },
              'Failed to update market stats for custody transaction'
            );
          }
        }

        custodyLogger.info(
          { transactionId: id, userId: data.userId },
          'Transaction custody established successfully'
        );

        return { success: true, transaction };
      } catch (error) {
        // Rethrow AppErrors, wrap others
        if (error instanceof AppError) {
          throw error;
        } else {
          throw new AppError({
            message: 'Error during custody transaction',
            context: 'custody-store',
            code: 'CUSTODY_ERROR',
            originalError: error instanceof Error ? error : new Error(String(error)),
            data: { signature: data.signature, userId: data.userId }
          }).log();
        }
      }
    } catch (error) {
      if (error instanceof AppError) {
        return { success: false, error: error.message };
      } else {
        const appError = new AppError({
          message: 'Failed to take custody of transaction',
          context: 'custody-store',
          code: 'CUSTODY_ERROR',
          originalError: error instanceof Error ? error : new Error(String(error)),
          data: { signature: data.signature, userId: data.userId }
        }).log();
        return { success: false, error: appError.message };
      }
    }
  },

  // Get all transactions in custody for a user
  async getUserTransactions(userId: string) {
    try {
      if (!userId) return [];

      // Get all transaction IDs for the user
      const transactionIds = await kvStore.getSetMembers('USER_TRANSACTIONS', userId);

      if (transactionIds.length === 0) {
        return [];
      }

      // Get all transactions in parallel
      const transactions = await Promise.all(
        transactionIds.map(id => this.getTransaction(id))
      );

      // Filter out any undefined transactions (in case of data inconsistency)
      return transactions.filter(Boolean);
    } catch (error) {
      custodyLogger.error({ userId, error }, 'Error getting user custody transactions');
      return [];
    }
  },

  // Get all transactions in custody for a signer
  async getSignerTransactions(signer: string) {
    try {
      if (!signer) return [];

      // Get all transaction IDs for the signer
      const transactionIds = await kvStore.getSetMembers('SIGNER_TRANSACTIONS', signer);

      if (transactionIds.length === 0) {
        return [];
      }

      // Get all transactions in parallel
      const transactions = await Promise.all(
        transactionIds.map(id => this.getTransaction(id))
      );

      // Filter out any undefined transactions (in case of data inconsistency)
      return transactions.filter(Boolean);
    } catch (error) {
      custodyLogger.error({ signer, error }, 'Error getting signer custody transactions');
      return [];
    }
  },

  // Get all transactions in custody for a market
  async getMarketTransactions(marketId: string) {
    try {
      if (!marketId) return [];

      // Get all transaction IDs for the market
      const transactionIds = await kvStore.getSetMembers('MARKET_TRANSACTIONS', marketId);

      if (transactionIds.length === 0) {
        return [];
      }

      // Get all transactions in parallel
      const transactions = await Promise.all(
        transactionIds.map(id => this.getTransaction(id))
      );

      // Filter out any undefined transactions (in case of data inconsistency)
      return transactions.filter(Boolean);
    } catch (error) {
      custodyLogger.error({ marketId, error }, 'Error getting market custody transactions');
      return [];
    }
  },

  // Get a specific transaction by ID
  async getTransaction(id: string): Promise<CustodyTransaction | undefined> {
    try {
      if (!id) return undefined;

      const transaction = await kvStore.getEntity('CUSTODY_TRANSACTION', id);
      return transaction as CustodyTransaction || undefined;
    } catch (error) {
      custodyLogger.error({ transactionId: id, error }, 'Error getting custody transaction');
      return undefined;
    }
  },

  // Get a specific NFT receipt
  async getNFTReceipt(id: string) {
    try {
      if (!id) return undefined;

      const receipt = await kvStore.getEntity('CUSTODY_NFT_RECEIPT', id);
      return receipt || undefined;
    } catch (error) {
      custodyLogger.error({ receiptId: id, error }, 'Error getting custody NFT receipt');
      return undefined;
    }
  },

  // Find transactions matching criteria
  async findByCriteria(criteria: {
    signature?: string;
    nonce?: number;
    signer?: string;
    type?: TransactionType;
    status?: string;
    userId?: string;
    marketId?: string | number;
    [key: string]: any; // Allow other properties
  }): Promise<CustodyTransaction[]> {
    try {
      let transactionIds: string[] = [];

      // Try to use the most efficient index based on criteria
      if (criteria.userId) {
        // If looking for a specific user's transactions
        transactionIds = await kvStore.getSetMembers('USER_TRANSACTIONS', criteria.userId);
      } else if (criteria.signer) {
        // If looking for a specific signer's transactions
        transactionIds = await kvStore.getSetMembers('SIGNER_TRANSACTIONS', criteria.signer);
      } else if (criteria.marketId) {
        // If looking for a market's transactions
        transactionIds = await kvStore.getSetMembers('MARKET_TRANSACTIONS', criteria.marketId.toString());
      } else {
        // No efficient lookup available, so we need to scan all transactions
        // This could be very inefficient with large datasets
        // In a production environment, we'd want additional indices or a query engine

        // For demo purposes, let's just look at all users and build a composite set
        const allUsers = await kvStore.getSetMembers('ALL_USERS', '');

        // Get transactions for each user
        const userTransactionIds = await Promise.all(
          allUsers.map(userId => kvStore.getSetMembers('USER_TRANSACTIONS', userId))
        );

        // Flatten the array of arrays
        transactionIds = userTransactionIds.flat();
      }

      if (transactionIds.length === 0) {
        return [];
      }

      // Get all transactions in parallel
      const transactions = await Promise.all(
        transactionIds.map(id => this.getTransaction(id))
      );

      // Filter out undefined transactions and apply criteria filter
      return transactions
        .filter(Boolean)
        .filter(tx => {
          if (!tx) return false;

          // Check each criteria property
          for (const [key, value] of Object.entries(criteria)) {
            //@ts-ignore
            if (tx[key] !== value) {
              return false;
            }
          }

          return true;
        }) as CustodyTransaction[];
    } catch (error) {
      custodyLogger.error({ criteria, error }, 'Error finding custody transactions by criteria');
      return [];
    }
  },

  // Update transaction status
  async updateTransactionStatus(
    id: string,
    status: 'pending' | 'submitted' | 'confirmed' | 'rejected',
    details?: { reason?: string }
  ): Promise<CustodyTransaction | undefined> {
    try {
      const transaction = await this.getTransaction(id);
      if (!transaction) return undefined;

      const now = new Date().toISOString();
      const updatedTransaction = { ...transaction, status };

      // Set appropriate timestamp based on status
      if (status === 'submitted') {
        updatedTransaction.submittedAt = now;
      } else if (status === 'confirmed') {
        updatedTransaction.confirmedAt = now;
      } else if (status === 'rejected') {
        updatedTransaction.rejectedAt = now;
        if (details?.reason) {
          updatedTransaction.rejectionReason = details.reason;
        }
      }

      // Store the updated transaction
      await kvStore.storeEntity('CUSTODY_TRANSACTION', id, updatedTransaction);

      return updatedTransaction;
    } catch (error) {
      custodyLogger.error({ transactionId: id, error }, 'Error updating custody transaction status');
      return undefined;
    }
  },

  // Mark a transaction as submitted to the blockchain
  async markAsSubmitted(id: string): Promise<CustodyTransaction | undefined> {
    return this.updateTransactionStatus(id, 'submitted');
  },

  // Mark a transaction as confirmed on the blockchain
  async markAsConfirmed(id: string): Promise<CustodyTransaction | undefined> {
    return this.updateTransactionStatus(id, 'confirmed');
  },

  // Mark a transaction as rejected
  async markAsRejected(id: string, reason?: string): Promise<CustodyTransaction | undefined> {
    return this.updateTransactionStatus(id, 'rejected', { reason });
  },

  // Delete a transaction and its associated NFT receipt
  async deleteTransaction(transactionId: string): Promise<boolean> {
    try {
      if (!transactionId) return false;

      // Get the transaction to retrieve its data
      const transaction = await this.getTransaction(transactionId);
      if (!transaction) return false;

      // Delete from the main transactions store
      await kvStore.deleteEntity('CUSTODY_TRANSACTION', transactionId);

      // Remove from user's transactions set
      await kvStore.removeFromSet('USER_TRANSACTIONS', transaction.userId, transactionId);

      // Remove from signer's transactions set
      await kvStore.removeFromSet('SIGNER_TRANSACTIONS', transaction.signer, transactionId);

      // If it's a prediction, remove from market's transactions set
      if (transaction.type === TransactionType.PREDICT && transaction.marketId) {
        await kvStore.removeFromSet('MARKET_TRANSACTIONS', transaction.marketId.toString(), transactionId);
      }

      // Delete the NFT receipt if it exists
      if (transaction.nftReceipt?.id) {
        await kvStore.deleteEntity('CUSTODY_NFT_RECEIPT', transaction.nftReceipt.id);
      }

      return true;
    } catch (error) {
      custodyLogger.error({ transactionId, error }, 'Error deleting custody transaction');
      return false;
    }
  },

  // Generate a placeholder image URL for the NFT
  // Similar to the prediction store
  generateNftImage(marketName: string, outcomeName: string, amount: number): string {
    // Create a data URI for a simple SVG image
    const bgColor = '#1a2026';
    const textColor = '#ffffff';
    const accentColor = '#36c758'; // Green accent color

    // Sanitize text to prevent SVG injection
    const sanitizedOutcome = outcomeName.replace(/[<>&"']/g, '');
    const sanitizedMarket = marketName.substring(0, 30).replace(/[<>&"']/g, '');

    const svg = `
        <svg width="600" height="400" xmlns="http://www.w3.org/2000/svg">
            <rect width="600" height="400" fill="${bgColor}" />
            <rect x="20" y="20" width="560" height="360" stroke="${accentColor}" stroke-width="2" fill="none" />
            <text x="300" y="100" font-family="Arial, sans-serif" font-size="24" text-anchor="middle" fill="${accentColor}">Signet Transaction Receipt</text>
            <text x="300" y="170" font-family="Arial, sans-serif" font-size="20" text-anchor="middle" fill="${textColor}">${sanitizedOutcome}</text>
            <text x="300" y="220" font-family="Arial, sans-serif" font-size="16" text-anchor="middle" fill="${textColor}">${sanitizedMarket}</text>
            <text x="300" y="270" font-family="Arial, sans-serif" font-size="24" text-anchor="middle" fill="${accentColor}">$${amount.toFixed(2)}</text>
            <text x="300" y="340" font-family="Arial, sans-serif" font-size="12" text-anchor="middle" fill="${textColor}">Fully backed by on-chain transaction</text>
        </svg>`;

    // Convert SVG to a data URI
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  },

  // Create a prediction with custody
  // This combines the transaction custody and prediction functionality
  async createPredictionWithCustody(data: {
    // Transaction data
    signature: string;
    nonce: number;
    signer: string;
    subnetId: string;

    // Prediction data
    marketId: string;
    outcomeId: number;
    userId: string;
    amount: number;
  }): Promise<{
    success: boolean;
    transaction?: CustodyTransaction;
    error?: string;
    market?: Record<string, unknown>;
  }> {
    try {
      // Set up structured logging for this operation
      const opLogger = custodyLogger.child({
        operation: 'createPredictionWithCustody',
        marketId: data.marketId,
        userId: data.userId,
        amount: data.amount
      });

      opLogger.info({}, 'Starting prediction creation with custody');

      // Input validation
      if (!data.signature || !data.marketId || !data.userId || data.amount <= 0) {
        const error = new AppError({
          message: 'Invalid prediction custody data',
          context: 'custody-store',
          code: 'PREDICTION_CUSTODY_VALIDATION_ERROR',
          data: {
            hasSignature: !!data.signature,
            hasMarketId: !!data.marketId,
            hasUserId: !!data.userId,
            amount: data.amount
          }
        }).log();

        return { success: false, error: error.message };
      }

      // Get the market to verify it exists and get outcome name
      const market: any = await marketStore.getMarket(data.marketId);
      if (!market) {
        const error = new AppError({
          message: `Market not found: ${data.marketId}`,
          context: 'custody-store',
          code: 'MARKET_NOT_FOUND',
          data: { marketId: data.marketId }
        }).log();

        return { success: false, error: error.message };
      }

      // Find the outcome
      const outcome = market.outcomes.find((o: any) => o.id === data.outcomeId);
      if (!outcome) {
        const error = new AppError({
          message: `Outcome ${data.outcomeId} not found in market ${data.marketId}`,
          context: 'custody-store',
          code: 'OUTCOME_NOT_FOUND',
          data: {
            marketId: data.marketId,
            outcomeId: data.outcomeId,
            availableOutcomes: market.outcomes.map((o: any) => o.id)
          }
        }).log();

        return { success: false, error: error.message };
      }

      // Check if market is already resolved
      if (market.resolvedOutcomeId !== undefined) {
        const error = new AppError({
          message: `Market ${data.marketId} is already resolved`,
          context: 'custody-store',
          code: 'MARKET_ALREADY_RESOLVED',
          data: {
            marketId: data.marketId,
            resolvedOutcomeId: market.resolvedOutcomeId
          }
        }).log();

        return { success: false, error: error.message };
      }

      // Check if market end date has passed
      if (new Date(market.endDate) < new Date()) {
        const error = new AppError({
          message: `Market ${data.marketId} has ended`,
          context: 'custody-store',
          code: 'MARKET_ENDED',
          data: {
            marketId: data.marketId,
            endDate: market.endDate,
            currentDate: new Date().toISOString()
          }
        }).log();

        return { success: false, error: error.message };
      }

      opLogger.debug({}, 'Market validation completed, taking custody of transaction');

      // Take custody of the transaction
      const custodyResult = await this.takeCustody({
        signature: data.signature,
        nonce: data.nonce,
        signer: data.signer,
        type: TransactionType.PREDICT,
        subnetId: data.subnetId,
        marketId: data.marketId,
        outcomeId: data.outcomeId,
        amount: data.amount,
        userId: data.userId
      });

      if (!custodyResult.success) {
        return custodyResult;
      }

      opLogger.debug(
        { transactionId: custodyResult.transaction?.id },
        'Custody established, updating user stats'
      );

      // Update user stats for leaderboard tracking
      try {
        await userStatsStore.updateStatsForNewPrediction(data.userId, {
          id: custodyResult.transaction?.id,
          marketId: data.marketId,
          outcomeId: data.outcomeId,
          amount: data.amount
        });
      } catch (statsError) {
        // Just log the error but continue - stats are not critical
        opLogger.error(
          { error: statsError },
          'Failed to update user stats for custody transaction'
        );
      }

      opLogger.info(
        { transactionId: custodyResult.transaction?.id },
        'Prediction with custody completed successfully'
      );

      // Convert market to Record<string, unknown> to comply with return type
      const marketData: Record<string, unknown> = { ...market };

      return {
        success: true,
        transaction: custodyResult.transaction,
        market: marketData
      };
    } catch (error) {
      // If it's already an AppError, just log and return it
      if (error instanceof AppError) {
        error.log();
        return { success: false, error: error.message };
      }

      // Handle other errors
      const appError = new AppError({
        message: 'Failed to create prediction with custody',
        context: 'custody-store',
        code: 'PREDICTION_CUSTODY_ERROR',
        originalError: error instanceof Error ? error : new Error(String(error)),
        data: {
          marketId: data.marketId,
          userId: data.userId,
          amount: data.amount
        }
      }).log();

      return { success: false, error: appError.message };
    }
  }
};