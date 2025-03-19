import * as kvStore from './kv-store';
import { isAdmin } from './utils';
import { AppError, logger } from './logger';
import { marketStore } from './market-store';
import { userBalanceStore } from './user-balance-store';
import { userStatsStore } from './user-stats-store';
import {
  makeContractCall,
  broadcastTransaction,
  listCV,
  tupleCV,
  bufferCV,
  uintCV,
  stringAsciiCV,
  PostConditionMode,
  TxBroadcastResult
} from "@stacks/transactions";
import { STACKS_MAINNET } from '@stacks/network';
import { bufferFromHex } from '@stacks/transactions/dist/cl';

// Create a logger instance for this module
const custodyLogger = logger.child({ context: 'custody-store' });

// On-chain batch processing configuration
const batchConfig = {
  enabled: process.env.ENABLE_BATCH_PROCESSING === 'true',
  maxBatchSize: Number(process.env.BATCH_MAX_SIZE || '200'),
  minAgeMinutes: Number(process.env.BATCH_MIN_AGE_MINUTES || '15'),
  // We'll use the same contract config as marketStore for consistency
  privateKey: process.env.MARKET_CREATOR_PRIVATE_KEY || '',
  network: STACKS_MAINNET,
  contractAddress: process.env.PREDICTION_CONTRACT_ADDRESS || 'SP2ZNGJ85ENDY6QRHQ5P2D4FXKGZWCKTB2T0Z55KS',
  contractName: process.env.PREDICTION_CONTRACT_NAME || 'blaze-welsh-predictions-v1',
};

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
  async getTransaction(id: string): Promise<CustodyTransaction> {
    const transaction = await kvStore.getEntity('CUSTODY_TRANSACTION', id);
    return transaction as CustodyTransaction;
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

      // Check if prediction has already been registered on chain by calling the contract
      try {
        const [contractAddress, contractName] = [
          batchConfig.contractAddress,
          batchConfig.contractName
        ];

        // Import the needed functions for contract call
        const { fetchCallReadOnlyFunction, ClarityType } = await import('@stacks/transactions');

        // Use receipt ID if available, otherwise try to use nonce as the receipt ID
        const receiptId = transaction.receiptId || transaction.nonce;

        // Call the get-owner function to check if the receipt exists on chain
        const result = await fetchCallReadOnlyFunction({
          contractAddress,
          contractName,
          functionName: 'get-owner',
          functionArgs: [uintCV(receiptId)],
          network: batchConfig.network,
          senderAddress: transaction.signer
        });

        // If we get a successful response with an owner, it means the prediction exists on chain
        if (result.type === ClarityType.ResponseOk && result.value && result.value.type !== ClarityType.OptionalNone) {
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

      // Validate private key is available
      if (!batchConfig.privateKey) {
        throw new AppError({
          message: 'Private key is required for batch processing',
          context: 'custody-store',
          code: 'BATCH_CONFIG_ERROR'
        }).log();
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

      // Transform transactions to the format expected by the smart contract
      const operations = transactionsToProcess.map(tx => {
        return tupleCV({
          signet: tupleCV({
            signature: bufferFromHex(tx.signature),
            nonce: uintCV(tx.nonce)
          }),
          "market-id": stringAsciiCV(tx.marketId?.toString() || ''),
          "outcome-id": uintCV(tx.outcomeId || 0),
          amount: uintCV(tx.amount || 0)
        });
      });

      // Prepare the contract call
      const transaction = await makeContractCall({
        contractAddress: batchConfig.contractAddress,
        contractName: batchConfig.contractName,
        functionName: 'batch-predict',
        functionArgs: [
          listCV(operations)
        ],
        senderKey: batchConfig.privateKey,
        validateWithAbi: true,
        network: batchConfig.network,
        postConditionMode: PostConditionMode.Allow,
        // Set fee proportional to batch size
        fee: Math.max(1000, 100 * batchSize)
      });

      // Broadcast the transaction
      const result = await broadcastTransaction({ transaction });

      if (!result.txid) {
        throw new AppError({
          message: 'Failed to broadcast batch prediction transaction',
          context: 'custody-store',
          code: 'BROADCAST_ERROR',
          data: { error: 'Unknown broadcast error' }
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