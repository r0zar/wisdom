import * as kvStore from './kv-store';
import { isAdmin } from './utils';
import { AppError, logger } from './logger';
import { marketStore } from './market-store';
import { userBalanceStore } from './user-balance-store';
import { userStatsStore } from './user-stats-store';
import { 
  predictionContractStore, 
  SignedTransactionParams,
  BatchPredictionOperation,
  BatchClaimOperation
} from './prediction-contract-store';

// Create a logger instance for this module
const custodyLogger = logger.child({ context: 'custody-store' });

// On-chain batch processing configuration
const batchConfig = {
  enabled: process.env.ENABLE_BATCH_PROCESSING === 'true',
  maxBatchSize: Number(process.env.BATCH_MAX_SIZE || '200'),
  minAgeMinutes: Number(process.env.BATCH_MIN_AGE_MINUTES || '15'),
};

// Define transaction types based on the chrome extension types
export enum TransactionType {
  TRANSFER = 'transfer',
  PREDICT = 'predict',
  CLAIM_REWARD = 'claim-reward',
}

// User-facing status types
export type UserFacingStatus = 'pending' | 'won' | 'lost' | 'redeemed';

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
  potentialPayout?: number; // Potential payout amount for winners

  // Blockchain verification metadata
  blockchainStatus?: UserFacingStatus; // Status verified from blockchain
  verifiedAt?: string; // When blockchain status was last verified
  isVerifiedWinner?: boolean; // Flag for verified winners
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
      const existingTx = await this.findBySignature(data.signature);

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

      custodyLogger.debug({
        signature: data.signature.substring(0, 8) + '...',
        userId: data.userId,
        type: data.type
      }, 'Taking custody of transaction');

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

  /**
   * Get all potentially redeemable (won) predictions for a user with blockchain verification
   * This is specifically for showing accurate "Ready to Redeem" predictions to users
   */
  async getUserRedeemablePredictions(userId: string): Promise<{
    redeemablePredictions: CustodyTransaction[];
    totalPotentialPayout: number;
  }> {
    try {
      if (!userId) {
        return { redeemablePredictions: [], totalPotentialPayout: 0 };
      }

      custodyLogger.debug({ userId }, 'Getting redeemable predictions for user');

      // Get all user's transactions
      const allTransactions = await this.getUserTransactions(userId);

      // Filter for prediction transactions that are either 'won' or 'submitted'
      // (submitted might be resolved on-chain but not updated in our system)
      const potentiallyRedeemable = allTransactions.filter(tx =>
        tx.type === TransactionType.PREDICT &&
        (tx.blockchainStatus === 'won' || tx.status === 'submitted')
      );

      if (potentiallyRedeemable.length === 0) {
        return { redeemablePredictions: [], totalPotentialPayout: 0 };
      }

      custodyLogger.debug({
        userId,
        potentialCount: potentiallyRedeemable.length
      }, 'Found potentially redeemable predictions');

      // Verify each prediction against the blockchain (batch of 5 at a time)
      const verifiedRedeemable: CustodyTransaction[] = [];
      let totalPayout = 0;

      // Process in batches of 5
      const batchSize = 5;
      for (let i = 0; i < potentiallyRedeemable.length; i += batchSize) {
        const batch = potentiallyRedeemable.slice(i, i + batchSize);

        // Process each prediction in parallel
        const verificationPromises = batch.map(async (tx) => {
          try {
            const receiptId = tx.receiptId || tx.nonce;

            // Get the reward quote from the blockchain
            const rewardQuote = await predictionContractStore.getRewardQuote(receiptId);

            // If there's a reward > 0, this prediction is truly redeemable
            if (rewardQuote && rewardQuote.dy > 0) {
              // Update the potential payout with the exact on-chain amount
              return {
                ...tx,
                potentialPayout: rewardQuote.dy,
                isVerifiedWinner: true
              };
            }
            return null;
          } catch (error) {
            custodyLogger.warn(
              {
                transactionId: tx.id,
                error: error instanceof Error ? error.message : String(error)
              },
              'Error verifying prediction redeemability'
            );
            // In case of error, use our local data
            return tx.blockchainStatus === 'won' ? tx : null;
          }
        });

        const results = await Promise.all(verificationPromises);

        // Add verified winners to our list
        for (const result of results) {
          if (result) {
            verifiedRedeemable.push(result);
            totalPayout += (result.potentialPayout || 0);
          }
        }
      }

      custodyLogger.info({
        userId,
        verifiedCount: verifiedRedeemable.length,
        totalPayout
      }, 'Verified redeemable predictions against blockchain');

      return {
        redeemablePredictions: verifiedRedeemable,
        totalPotentialPayout: totalPayout
      };
    } catch (error) {
      custodyLogger.error({
        userId,
        error: error instanceof Error ? error.message : String(error)
      }, 'Error getting redeemable predictions');

      return { redeemablePredictions: [], totalPotentialPayout: 0 };
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

  /**
   * Helper function to get the user-facing status for a transaction
   * This combines the internal status with blockchain verification data
   */
  getUserFacingStatus(transaction: CustodyTransaction): UserFacingStatus {
    // If we have verified blockchain status, use it
    if (transaction.blockchainStatus) {
      return transaction.blockchainStatus;
    }

    // Otherwise, derive from technical status
    if (transaction.status === 'pending') {
      return 'pending';
    }

    if (transaction.status === 'confirmed') {
      return 'redeemed';
    }

    if (transaction.status === 'rejected') {
      // Rejected predictions are similar to lost ones from user perspective
      return 'lost';
    }

    // For 'submitted' status, we don't know if it's won/lost without blockchain
    // Default to pending for safety
    return 'pending';
  },

  /**
   * Get a specific transaction by ID
   * @param id The transaction ID
   * @param options Optional parameters
   * @param options.verifyBlockchain Whether to verify status against blockchain for submitted transactions
   * @returns The transaction object
   */
  async getTransaction(
    id: string,
    options?: { verifyBlockchain?: boolean }
  ): Promise<CustodyTransaction> {
    try {
      const transaction = await kvStore.getEntity('CUSTODY_TRANSACTION', id) as CustodyTransaction;

      if (!transaction) {
        return transaction;
      }

      // If blockchain verification is requested and this is a prediction
      if (options?.verifyBlockchain &&
        transaction.type === TransactionType.PREDICT &&
        transaction.status === 'submitted') {

        try {
          const receiptId = transaction.receiptId || transaction.nonce;
          const now = new Date().toISOString();

          // Get the prediction status from the blockchain
          const onChainStatus = await predictionContractStore.getPredictionStatus(receiptId);

          // If we got a valid status from blockchain
          if (onChainStatus) {
            // Update the transaction with blockchain data
            transaction.blockchainStatus = onChainStatus;
            transaction.verifiedAt = now;

            // If it's a winner, get the reward amount
            if (onChainStatus === 'won') {
              const reward = await predictionContractStore.getRewardQuote(receiptId);
              if (reward) {
                transaction.potentialPayout = reward.dy;
                transaction.isVerifiedWinner = true;
              }
            }

            // Store the updated transaction with blockchain data
            await kvStore.storeEntity('CUSTODY_TRANSACTION', id, transaction);

            custodyLogger.debug({
              transactionId: id,
              blockchainStatus: onChainStatus,
              technicalStatus: transaction.status
            }, 'Updated transaction with blockchain status');
          }
        } catch (error) {
          custodyLogger.warn({
            transactionId: id,
            error: error instanceof Error ? error.message : String(error)
          }, 'Failed to verify transaction against blockchain');
          // Continue with unverified transaction
        }
      }

      return transaction;
    } catch (error) {
      custodyLogger.error({
        transactionId: id,
        error: error instanceof Error ? error.message : String(error)
      }, 'Error getting transaction');
      return null as unknown as CustodyTransaction;
    }
  },

  // Find a transaction by signature
  async findBySignature(signature: string): Promise<(CustodyTransaction)[]> {
    try {
      if (!signature) return [];

      // Get all markets to find all transactions
      const marketsResult = await marketStore.getMarkets();
      const markets = marketsResult.items;

      if (markets.length === 0) {
        custodyLogger.debug({ signature }, 'No markets found to check for transactions');
        return [];
      }

      // Get transactions for all markets
      const marketTransactionIdsPromises = markets.map(market =>
        this.getMarketTransactions(market.id).then(transactions =>
          transactions.filter((tx: any) => tx.signature === signature)
        )
      );

      // Wait for all promises to resolve
      const marketTransactions = await Promise.all(marketTransactionIdsPromises);

      // Flatten the array of arrays and filter for the specific signature
      const matchingTransactions = marketTransactions.flat();

      custodyLogger.debug({
        signature,
        marketsCount: markets.length,
        matchingTransactionsCount: matchingTransactions.length
      }, 'Finished searching for transactions by signature');

      return matchingTransactions;
    } catch (error) {
      custodyLogger.error({ signature, error }, 'Error finding transaction by signature');
      return [];
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

  // Get pending predictions for a specific market
  async getPendingPredictionsForMarket(marketId: string): Promise<CustodyTransaction[]> {
    try {
      if (!marketId) return [];

      custodyLogger.debug({ marketId }, 'Getting pending predictions for market');

      // Get all transaction IDs for the market
      const transactionIds = await kvStore.getSetMembers('MARKET_TRANSACTIONS', marketId.toString());

      custodyLogger.debug({ marketId, transactionCount: transactionIds.length }, 'Found market transactions');

      if (transactionIds.length === 0) {
        return [];
      }

      // Get all transactions in parallel
      const transactions = await Promise.all(
        transactionIds.map(id => this.getTransaction(id))
      );

      const validTransactions = transactions.filter(Boolean);
      custodyLogger.debug({
        marketId,
        validTransactionCount: validTransactions.length,
        statuses: validTransactions.map(tx => tx?.status),
        types: validTransactions.map(tx => tx?.type)
      }, 'Received valid transactions');

      // Filter for pending predictions only
      const pendingPredictions = transactions
        .filter(Boolean)
        .filter(tx => tx && tx.status === 'pending' && tx.type === TransactionType.PREDICT) as CustodyTransaction[];

      custodyLogger.debug({
        marketId,
        pendingCount: pendingPredictions.length,
        pendingIds: pendingPredictions.map(tx => tx.id)
      }, 'Found pending predictions for market');

      return pendingPredictions;
    } catch (error) {
      custodyLogger.error({ marketId, error }, 'Error getting pending predictions for market');
      return [];
    }
  },

  // Get all pending predictions across all markets
  async getAllPendingPredictions(): Promise<CustodyTransaction[]> {
    try {
      // Get all markets
      const marketsResult = await marketStore.getMarkets();
      const markets = marketsResult.items;

      custodyLogger.info({ marketCount: markets.length }, 'Getting pending predictions - found markets');

      if (markets.length === 0) {
        return [];
      }

      // Get transactions for each market
      const allMarketTransactionsPromises = markets.map(market => this.getMarketTransactions(market.id));
      const allMarketTransactions = await Promise.all(allMarketTransactionsPromises);

      // Flatten the array of arrays
      const allTransactions = allMarketTransactions.flat();

      custodyLogger.info({
        transactionCount: allTransactions.length,
        marketCount: markets.length
      }, 'Getting pending predictions - found transactions');

      if (allTransactions.length === 0) {
        return [];
      }

      // Filter for pending predictions only
      const pendingPredictions = allTransactions
        .filter(tx => tx?.status === 'pending' && tx.type === TransactionType.PREDICT);

      // Log the results along with timestamps
      if (pendingPredictions.length > 0) {
        custodyLogger.info({
          pendingCount: pendingPredictions.length,
          timestamps: pendingPredictions.map(tx => tx?.takenCustodyAt),
          now: new Date().toISOString()
        }, 'Found pending predictions with timestamps');
      } else {
        custodyLogger.info({}, 'No pending predictions found');
      }

      return pendingPredictions;
    } catch (error) {
      custodyLogger.error({ error }, 'Error getting all pending predictions');
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

      // Validate redemption eligibility for confirmed status (redemption)
      if (status === 'confirmed' && transaction.type === TransactionType.PREDICT) {
        try {
          // Use receipt ID if available, otherwise use nonce as the receipt ID
          const receiptId = transaction.receiptId || transaction.nonce;

          // Verify the prediction is actually a winner on the blockchain
          const isWinner = await predictionContractStore.isPredictionWinner(receiptId);

          // For PREDICT transactions, 'confirmed' status should only be set if it won on-chain
          if (!isWinner) {
            custodyLogger.warn(
              { transactionId: id, receiptId },
              'Attempt to confirm (redeem) a prediction that is not a winner on the blockchain'
            );

            return {
              ...transaction,
              status: 'rejected',
              rejectedAt: new Date().toISOString(),
              rejectionReason: 'Prediction is not eligible for redemption according to the blockchain.'
            };
          }

          custodyLogger.info(
            { transactionId: id, receiptId },
            'Confirmed prediction is a winner on the blockchain, proceeding with redemption'
          );
        } catch (verificationError) {
          custodyLogger.error(
            {
              transactionId: id,
              error: verificationError instanceof Error ? verificationError.message : String(verificationError)
            },
            'Error verifying prediction winner status on blockchain'
          );

          // In case of verification error, proceed with caution
          // We'll accept the status change, but log the issue
        }
      }

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

  /**
   * Synchronize submitted prediction statuses with blockchain state
   * This is a batch operation to update all submitted predictions in custody
   * This should be called periodically (e.g., by a cron job)
   */
  async syncSubmittedPredictionStatuses(): Promise<{
    success: boolean;
    updated: number;
    errors: number;
    error?: string;
    details?: {
      won: number;
      lost: number;
      pending: number;
      redeemed: number;
    };
  }> {
    try {
      custodyLogger.info({}, 'Starting batch synchronization of submitted prediction statuses');

      // Get all markets to find all transactions
      const marketsResult = await marketStore.getMarkets();
      const markets = marketsResult.items;

      if (markets.length === 0) {
        return { success: true, updated: 0, errors: 0, details: { won: 0, lost: 0, pending: 0, redeemed: 0 } };
      }

      // Track stats for detailed reporting
      let totalUpdated = 0;
      let totalErrors = 0;
      let wonCount = 0;
      let lostCount = 0;
      let pendingCount = 0;
      let redeemedCount = 0;

      // Process market by market to avoid memory issues
      for (const market of markets) {
        try {
          custodyLogger.debug({ marketId: market.id }, 'Processing market for submitted predictions');

          // Get all transactions for this market
          const transactions = await this.getMarketTransactions(market.id);

          // Filter for submitted prediction transactions only
          const submittedPredictions = transactions.filter(tx =>
            tx.type === TransactionType.PREDICT && tx.status === 'submitted'
          );

          if (submittedPredictions.length === 0) {
            continue; // No submitted predictions for this market
          }

          custodyLogger.info({
            marketId: market.id,
            submittedCount: submittedPredictions.length
          }, 'Found submitted predictions for market');

          // Get receipt IDs for these predictions
          const receiptIds = submittedPredictions.map(tx => tx.receiptId || tx.nonce);

          // Check the blockchain status for these predictions
          const statusUpdates = await predictionContractStore.getStatusUpdatesForPendingPredictions(receiptIds);

          console.log({ statusUpdates })

          // Update the counts
          wonCount += statusUpdates.won.length;
          lostCount += statusUpdates.lost.length;
          totalErrors += statusUpdates.errors.length;

          // Update the status for won predictions
          for (const receiptId of statusUpdates.won) {
            const tx = submittedPredictions.find(t => (t.receiptId || t.nonce) === receiptId);
            if (tx) {
              try {
                // Get reward quote to update potential payout
                const reward = await predictionContractStore.getRewardQuote(receiptId);
                const now = new Date().toISOString();

                // Update transaction with blockchain verification
                const updatedTx = {
                  ...tx,
                  blockchainStatus: 'won' as UserFacingStatus,
                  verifiedAt: now,
                  isVerifiedWinner: true,
                  potentialPayout: reward?.dy || tx.potentialPayout
                };

                // Store updated transaction
                await kvStore.storeEntity('CUSTODY_TRANSACTION', tx.id, updatedTx);
                totalUpdated++;

                custodyLogger.debug({
                  transactionId: tx.id,
                  receiptId,
                  blockchainStatus: 'won'
                }, 'Updated transaction to won status based on blockchain');
              } catch (error) {
                custodyLogger.error({
                  transactionId: tx?.id,
                  receiptId,
                  error: error instanceof Error ? error.message : String(error)
                }, 'Error updating transaction to won status');
                totalErrors++;
              }
            }
          }

          // Update the status for lost predictions
          for (const receiptId of statusUpdates.lost) {
            const tx = submittedPredictions.find(t => (t.receiptId || t.nonce) === receiptId);
            if (tx) {
              try {
                const now = new Date().toISOString();

                // Update transaction with blockchain verification
                const updatedTx = {
                  ...tx,
                  blockchainStatus: 'lost' as UserFacingStatus,
                  verifiedAt: now,
                  isVerifiedWinner: false
                };

                // Store updated transaction
                await kvStore.storeEntity('CUSTODY_TRANSACTION', tx.id, updatedTx);
                totalUpdated++;

                custodyLogger.debug({
                  transactionId: tx.id,
                  receiptId,
                  blockchainStatus: 'lost'
                }, 'Updated transaction to lost status based on blockchain');
              } catch (error) {
                custodyLogger.error({
                  transactionId: tx?.id,
                  receiptId,
                  error: error instanceof Error ? error.message : String(error)
                }, 'Error updating transaction to lost status');
                totalErrors++;
              }
            }
          }
        } catch (marketError) {
          custodyLogger.error({
            marketId: market.id,
            error: marketError instanceof Error ? marketError.message : String(marketError)
          }, 'Error processing market for status updates');
          totalErrors++;
        }
      }

      custodyLogger.info({
        totalUpdated,
        totalErrors,
        won: wonCount,
        lost: lostCount,
        pending: pendingCount,
        redeemed: redeemedCount
      }, 'Completed batch synchronization of submitted prediction statuses');

      return {
        success: true,
        updated: totalUpdated,
        errors: totalErrors,
        details: {
          won: wonCount,
          lost: lostCount,
          pending: pendingCount,
          redeemed: redeemedCount
        }
      };
    } catch (error) {
      custodyLogger.error({
        error: error instanceof Error ? error.message : String(error)
      }, 'Error in batch synchronization of submitted prediction statuses');

      return {
        success: false,
        updated: 0,
        errors: 1,
        error: 'Failed to synchronize prediction statuses: ' +
          (error instanceof Error ? error.message : String(error))
      };
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

  /**
   * Check if a prediction can be returned by the user
   * This checks if the prediction is still within the return window and hasn't been submitted on-chain
   * 
   * @param transactionId The ID of the transaction to check
   * @returns A boolean indicating if the prediction can be returned
   */
  async canReturnPrediction(transactionId: string): Promise<{
    canReturn: boolean;
    reason?: string;
    transaction?: CustodyTransaction
  }> {
    try {
      // Get the transaction
      const transaction = await this.getTransaction(transactionId);
      if (!transaction) {
        return {
          canReturn: false,
          reason: 'Transaction not found'
        };
      }

      // Check if the transaction is a prediction
      if (transaction.type !== TransactionType.PREDICT) {
        return {
          canReturn: false,
          reason: 'Transaction is not a prediction'
        };
      }

      // Check if transaction status is pending (not already submitted/confirmed)
      if (transaction.status !== 'pending') {
        return {
          canReturn: false,
          reason: `Transaction status is ${transaction.status}, only pending transactions can be returned`
        };
      }

      // Check if the transaction is within the return window
      const now = new Date();
      const custodyDate = new Date(transaction.takenCustodyAt);
      const ageInMinutes = (now.getTime() - custodyDate.getTime()) / (1000 * 60);

      if (ageInMinutes > batchConfig.minAgeMinutes) {
        return {
          canReturn: false,
          reason: `Transaction is ${Math.floor(ageInMinutes)} minutes old, exceeding the ${batchConfig.minAgeMinutes} minute return window`
        };
      }

      // Check if prediction has already been registered on chain
      try {
        // Use receipt ID if available, otherwise try to use nonce as the receipt ID
        const receiptId = transaction.receiptId || transaction.nonce;

        // Use our prediction contract store to check if receipt exists on chain
        const receiptExists = await predictionContractStore.doesReceiptExist(receiptId);

        if (receiptExists) {
          return {
            canReturn: false,
            reason: 'Prediction already exists on the blockchain'
          };
        }
      } catch (error) {
        // If there's an error calling the contract, log it but assume the prediction is not on chain
        custodyLogger.warn(
          {
            transactionId,
            error: error instanceof Error ? error.message : String(error)
          },
          'Error checking on-chain prediction status, continuing with assumption that it is not on chain'
        );
      }

      // All checks passed, prediction can be returned
      return {
        canReturn: true,
        transaction
      };
    } catch (error) {
      custodyLogger.error(
        {
          transactionId,
          error: error instanceof Error ? error.message : String(error)
        },
        'Error checking if prediction can be returned'
      );

      return {
        canReturn: false,
        reason: 'Error checking prediction status'
      };
    }
  },

  /**
   * Return a prediction receipt to the user
   * This will delete all records for the prediction
   * 
   * @param userId User ID requesting the return
   * @param transactionId The ID of the transaction to return
   * @returns Result of the return operation
   */
  async returnPrediction(userId: string, transactionId: string): Promise<{
    success: boolean;
    error?: string;
    transaction?: CustodyTransaction;
  }> {
    try {
      // Set up structured logging for this operation
      const opLogger = custodyLogger.child({
        operation: 'returnPrediction',
        userId,
        transactionId
      });

      opLogger.info({}, 'Starting prediction return process');

      // Check if the prediction can be returned
      const { canReturn, reason, transaction } = await this.canReturnPrediction(transactionId);

      if (!canReturn || !transaction) {
        opLogger.warn({ reason }, 'Prediction cannot be returned');
        return { success: false, error: reason };
      }

      // Verify userId matches transaction userId (only owner can return)
      if (transaction.userId !== userId) {
        const error = 'Unauthorized: Only the user who made the prediction can return it';
        opLogger.warn({ transactionUserId: transaction.userId }, error);
        return { success: false, error };
      }

      // Final blockchain verification before transaction
      try {
        // Use receipt ID if available, otherwise try to use nonce as the receipt ID
        const receiptId = transaction.receiptId || transaction.nonce;

        // Do a final check against the blockchain to ensure it's not there
        // This is critical to prevent returning something that's already on chain
        const receiptExists = await predictionContractStore.doesReceiptExist(receiptId);

        if (receiptExists) {
          const error = 'Cannot return prediction: It has already been processed on the blockchain';
          opLogger.warn({
            transactionId,
            receiptId
          }, error);

          // Update the transaction status to reflect blockchain state
          await this.updateTransactionStatus(transactionId, 'submitted');

          return {
            success: false,
            error,
            transaction: await this.getTransaction(transactionId, { verifyBlockchain: true })
          };
        }
      } catch (verificationError) {
        // Log but continue - we already did initial verification
        opLogger.warn({
          error: verificationError instanceof Error ? verificationError.message : String(verificationError)
        }, 'Error during final blockchain verification, proceeding with caution');
      }

      // Delete the transaction and its associated data
      opLogger.debug({}, 'Deleting transaction records');
      const deleteResult = await this.deleteTransaction(transactionId);

      if (!deleteResult) {
        const error = 'Failed to delete transaction records';
        opLogger.error({}, error);
        return { success: false, error };
      }

      opLogger.info({}, 'Prediction successfully returned');

      return {
        success: true,
        transaction
      };
    } catch (error) {
      // If it's already an AppError, just log and return it
      if (error instanceof AppError) {
        error.log();
        return { success: false, error: error.message };
      }

      // Handle other errors
      const appError = new AppError({
        message: 'Failed to return prediction',
        context: 'custody-store',
        code: 'PREDICTION_RETURN_ERROR',
        originalError: error instanceof Error ? error : new Error(String(error)),
        data: { userId, transactionId }
      }).log();

      return { success: false, error: appError.message };
    }
  },

  /**
   * Process pending prediction transactions in batches to send them on-chain
   * This function is intended to be called by a cron job every hour
   * It will process up to maxBatchSize predictions at a time, FIFO order
   * Only processes transactions that are at least minAgeMinutes old by default
   * @param options Optional parameters to customize batch processing
   * @returns Results of the batch processing operation
   */
  async batchProcessPredictions(options?: {
    forceProcess?: boolean; // If true, process all pending transactions regardless of age
    marketId?: string;
  }): Promise<{
    success: boolean;
    processed: number;
    batched: number;
    errors: number;
    error?: string;
    txid?: string;
  }> {
    try {
      // Skip if batch processing is disabled
      if (!batchConfig.enabled) {
        custodyLogger.info({}, 'Batch prediction processing is disabled');
        return { success: true, processed: 0, batched: 0, errors: 0 };
      }

      // Calculate the cutoff time for processing (only process txs older than this)
      const now = new Date();
      const cutoffTime = new Date(now.getTime() - (batchConfig.minAgeMinutes * 60 * 1000));
      const cutoffTimeISO = cutoffTime.toISOString();

      custodyLogger.info(
        { minAgeMinutes: batchConfig.minAgeMinutes, cutoffTime: cutoffTimeISO },
        'Starting batch prediction processing'
      );

      // Find all pending PREDICT transactions
      let pendingPredictions
      if (options?.marketId) {
        pendingPredictions = await this.getPendingPredictionsForMarket(options.marketId);
      } else {
        pendingPredictions = await this.getAllPendingPredictions()
      }
      
      // Log details about pending predictions before filtering
      if (pendingPredictions.length > 0) {
        custodyLogger.info({
          allPendingPredictions: pendingPredictions.map(tx => ({
            id: tx?.id,
            takenCustodyAt: tx?.takenCustodyAt,
            status: tx?.status,
            marketId: tx?.marketId
          })),
          cutoffTimeISO,
          forceProcess: options?.forceProcess
        }, 'Pending predictions before age filtering');
      }

      // Decide if we should apply age filtering
      const shouldApplyAgeFilter = !options?.forceProcess;

      if (options?.forceProcess) {
        custodyLogger.info({ forceProcess: true }, 'Forcing processing of all pending predictions regardless of age');
      }

      // Filter and sort transactions:
      // 1. Only include transactions older than the cutoff time (unless forceProcess is true)
      // 2. Sort by oldest first (FIFO)
      const eligiblePredictions = pendingPredictions
        .filter(tx => {
          // Skip age check if forceProcess is true
          if (!shouldApplyAgeFilter) {
            return true;
          }

          const isPastCutoff = tx.takenCustodyAt < cutoffTimeISO;

          if (!isPastCutoff) {
            custodyLogger.debug({
              transactionId: tx.id,
              takenCustodyAt: tx.takenCustodyAt,
              cutoffTimeISO,
              comparison: `${tx.takenCustodyAt} < ${cutoffTimeISO} = ${isPastCutoff}`
            }, 'Transaction not eligible due to age');
          }

          return isPastCutoff;
        })
        .sort((a, b) => (a.takenCustodyAt > b.takenCustodyAt ? 1 : -1));

      const eligibleCount = eligiblePredictions.length;
      const totalCount = pendingPredictions.length;

      custodyLogger.info(
        {
          totalPending: totalCount,
          eligibleForProcessing: eligibleCount,
          maxBatchSize: batchConfig.maxBatchSize
        },
        'Found pending prediction transactions'
      );

      // If no eligible transactions, return early
      if (eligibleCount === 0) {
        return { success: true, processed: 0, batched: 0, errors: 0 };
      }

      // Take only up to maxBatchSize transactions
      const transactionsToProcess = eligiblePredictions.slice(0, batchConfig.maxBatchSize);
      const batchSize = transactionsToProcess.length;

      custodyLogger.info(
        { batchSize, oldestTxTime: transactionsToProcess[0]?.takenCustodyAt },
        'Processing batch of prediction transactions'
      );

      // Transform transactions to the format expected by the batchPredict function
      const operations: BatchPredictionOperation[] = transactionsToProcess.map(tx => ({
        signet: {
          signature: tx.signature,
          nonce: tx.nonce
        },
        marketId: tx.marketId?.toString() || '',
        outcomeId: tx.outcomeId || 0,
        amount: tx.amount || 0
      }));

      // Use the contract store to process the batch
      const result = await predictionContractStore.batchPredict(operations);

      if (!result.success || !result.txid) {
        throw new AppError({
          message: result.error || 'Failed to process batch prediction transaction',
          context: 'custody-store',
          code: 'BATCH_PREDICT_ERROR',
          data: { error: result.error }
        }).log();
      }

      custodyLogger.info(
        { txid: result.txid, batchSize },
        'Successfully submitted batch prediction transaction'
      );

      // Update the status of all processed transactions
      let updatedCount = 0;
      for (const tx of transactionsToProcess) {
        try {
          await this.updateTransactionStatus(tx.id, 'submitted');
          updatedCount++;
        } catch (updateError) {
          custodyLogger.error(
            { txId: tx.id, error: updateError },
            'Failed to update transaction status to submitted'
          );
        }
      }

      return {
        success: true,
        processed: eligibleCount,
        batched: batchSize,
        errors: batchSize - updatedCount,
        txid: result.txid
      };
    } catch (error) {
      // Log and return the error
      const errorMessage = error instanceof Error ? error.message : String(error);

      custodyLogger.error(
        { error: errorMessage },
        'Error in batch processing predictions'
      );

      if (error instanceof AppError) {
        return {
          success: false,
          processed: 0,
          batched: 0,
          errors: 1,
          error: error.message
        };
      }

      return {
        success: false,
        processed: 0,
        batched: 0,
        errors: 1,
        error: `Failed to process batch predictions: ${errorMessage}`
      };
    }
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
    txid?: string;
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