/**
 * Prediction Contract Store: Direct interface to the Clarity smart contract
 * 
 * This module provides read-only function wrappers for interacting with the
 * prediction market contract. It abstracts the complexity of making direct
 * contract calls and provides a cleaner interface for the rest of the application.
 */

import { logger } from './logger';
import { AppError } from './logger';
import { STACKS_MAINNET } from '@stacks/network';

// Import the types and functions we need for contract calls
import {
  fetchCallReadOnlyFunction,
  uintCV,
  stringAsciiCV,
  tupleCV,
  listCV,
  ClarityType,
  ClarityValue,
  OptionalCV,
  ResponseCV,
  BooleanCV,
  BufferCV,
  StringAsciiCV,
  UIntCV,
  ListCV,
  TupleCV,
  cvToValue,
} from '@stacks/transactions';

// Contract configuration - consistent with other stores
const contractConfig = {
  contractAddress: process.env.PREDICTION_CONTRACT_ADDRESS || 'SP2ZNGJ85ENDY6QRHQ5P2D4FXKGZWCKTB2T0Z55KS',
  contractName: process.env.PREDICTION_CONTRACT_NAME || 'blaze-welsh-predictions-v1',
  network: STACKS_MAINNET,
};

// Create a logger instance for this module
const contractLogger = logger.child({ context: 'prediction-contract-store' });

/**
 * Helper interface for market structure in the contract
 */
export interface PredictionMarketInfo {
  creator: string;
  name: string;
  description: string;
  'outcome-names': string[];
  'outcome-pools': number[];
  'total-pool': number;
  'is-open': boolean;
  'is-resolved': boolean;
  'winning-outcome': number;
  resolver?: string;
  'creation-time': number;
  'resolution-time': number;
}

/**
 * Helper interface for prediction receipt information
 */
export interface PredictionReceiptInfo {
  'market-id': string;
  'outcome-id': number;
  amount: number;
  predictor?: string;
}

/**
 * Interface for prediction reward quote
 */
export interface PredictionRewardQuote {
  dx: string; // market id
  dy: number; // reward amount
  dk: number; // receipt id
}

/**
 * Prediction contract store with read-only functions to query the contract
 */
export const predictionContractStore = {
  /**
   * Check if a receipt ID exists on the blockchain by checking if it has an owner
   * @param receiptId The ID of the receipt to check
   * @returns True if the receipt exists and has an owner, false otherwise
   */
  async doesReceiptExist(receiptId: number): Promise<boolean> {
    try {
      contractLogger.debug({ receiptId }, 'Checking if receipt exists on chain');

      const result = await fetchCallReadOnlyFunction({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'get-owner',
        functionArgs: [uintCV(receiptId)],
        network: contractConfig.network,
        senderAddress: contractConfig.contractAddress
      });

      // If we get a successful response with an owner, the receipt exists
      if (result.type === ClarityType.ResponseOk && result.value && result.value.type !== ClarityType.OptionalNone) {
        contractLogger.debug({ receiptId, owner: cvToValue(result.value).value }, 'Receipt exists on chain');
        return true;
      }

      contractLogger.debug({ receiptId }, 'Receipt does not exist on chain');
      return false;
    } catch (error) {
      contractLogger.error({
        receiptId,
        error: error instanceof Error ? error.message : String(error)
      }, 'Error checking if receipt exists');

      // Return false in case of error, assume it doesn't exist
      return false;
    }
  },

  /**
   * Get the owner of a receipt from the contract
   * @param receiptId The ID of the receipt to check
   * @returns The principal address of the owner, or null if not found or error
   */
  async getReceiptOwner(receiptId: number): Promise<string | null> {
    try {
      contractLogger.debug({ receiptId }, 'Getting receipt owner from chain');

      const result = await fetchCallReadOnlyFunction({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'get-owner',
        functionArgs: [uintCV(receiptId)],
        network: contractConfig.network,
        senderAddress: contractConfig.contractAddress
      });

      // If we get a successful response with an owner, return the owner
      if (result.type === ClarityType.ResponseOk && result.value && result.value.type !== ClarityType.OptionalNone) {
        const owner = cvToValue(result.value).value as string;
        contractLogger.debug({ receiptId, owner }, 'Found receipt owner');
        return owner;
      }

      contractLogger.debug({ receiptId }, 'No owner found for receipt');
      return null;
    } catch (error) {
      contractLogger.error({
        receiptId,
        error: error instanceof Error ? error.message : String(error)
      }, 'Error getting receipt owner');

      return null;
    }
  },

  /**
   * Get information about a specific market from the contract
   * @param marketId The ID of the market to check
   * @returns Market information or null if not found or error
   */
  async getMarketInfo(marketId: string): Promise<PredictionMarketInfo | null> {
    try {
      contractLogger.debug({ marketId }, 'Getting market info from chain');

      const result = await fetchCallReadOnlyFunction({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'get-market-info',
        functionArgs: [stringAsciiCV(marketId)],
        network: contractConfig.network,
        senderAddress: contractConfig.contractAddress
      });

      // If we get a successful response, parse the market info
      if (result.type === ClarityType.ResponseOk) {
        const marketInfoCv = cvToValue(result.value)
        const marketInfo = {
          creator: marketInfoCv.creator.value,
          name: marketInfoCv.name.value,
          description: marketInfoCv.description.value,
          'outcome-names': marketInfoCv['outcome-names'].value,
          'outcome-pools': marketInfoCv['outcome-pools'].value,
          'total-pool': Number(marketInfoCv['total-pool'].value),
          'is-open': marketInfoCv['is-open'].value,
          'is-resolved': marketInfoCv['is-resolved'].value,
          'winning-outcome': Number(marketInfoCv['winning-outcome'].value),
          resolver: marketInfoCv.resolver.value,
          'creation-time': marketInfoCv['creation-time'].value,
          'resolution-time': marketInfoCv['resolution-time'].value
        } as PredictionMarketInfo;
        contractLogger.debug({
          marketId,
          name: marketInfo.name,
          isResolved: marketInfo['is-resolved']
        }, 'Found market info');
        return marketInfo;
      }

      contractLogger.debug({ marketId }, 'Market not found on chain');
      return null;
    } catch (error) {
      contractLogger.error({
        marketId,
        error: error instanceof Error ? error.message : String(error)
      }, 'Error getting market info');

      return null;
    }
  },

  /**
   * Get information about a specific prediction receipt from the contract
   * @param receiptId The ID of the receipt to check
   * @returns Receipt information or null if not found or error
   */
  async getReceiptInfo(receiptId: number): Promise<PredictionReceiptInfo | null> {
    try {
      contractLogger.debug({ receiptId }, 'Getting receipt info from chain');

      const result = await fetchCallReadOnlyFunction({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'get-receipt-info',
        functionArgs: [uintCV(receiptId)],
        network: contractConfig.network,
        senderAddress: contractConfig.contractAddress
      });

      // If we get a successful response, parse the receipt info
      if (result.type === ClarityType.ResponseOk) {
        const receiptInfoCv = cvToValue(result.value)
        const receiptInfo = {
          'market-id': receiptInfoCv['market-id'].value,
          'outcome-id': receiptInfoCv['outcome-id'].value,
          amount: receiptInfoCv.amount.value,
          predictor: receiptInfoCv.predictor.value
        } as PredictionReceiptInfo;
        contractLogger.debug({
          receiptId,
          marketId: receiptInfo['market-id'],
          outcomeId: receiptInfo['outcome-id'],
          predictor: receiptInfo.predictor
        }, 'Found receipt info');
        return receiptInfo;
      }

      contractLogger.debug({ receiptId }, 'Receipt not found on chain');
      return null;
    } catch (error) {
      contractLogger.error({
        receiptId,
        error: error instanceof Error ? error.message : String(error)
      }, 'Error getting receipt info');

      return null;
    }
  },

  /**
   * Check if a prediction is eligible for reward based on the resolved market
   * This calls the quote-reward function to see if there's any reward available
   * 
   * @param receiptId The ID of the receipt to check
   * @returns Object with reward info or null if not found or error
   */
  async getRewardQuote(receiptId: number): Promise<PredictionRewardQuote | null> {
    try {
      contractLogger.debug({ receiptId }, 'Getting reward quote from chain');

      const result = await fetchCallReadOnlyFunction({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'quote-reward',
        functionArgs: [uintCV(receiptId)],
        network: contractConfig.network,
        senderAddress: contractConfig.contractAddress
      });

      // If we get a successful response, parse the reward quote
      if (result.type === ClarityType.ResponseOk) {
        const quoteCv = cvToValue(result.value)
        const quote = {
          dx: quoteCv.dx.value,
          dy: quoteCv.dy.value,
          dk: quoteCv.dk.value
        } as PredictionRewardQuote;

        contractLogger.debug({
          receiptId,
          marketId: quote.dx,
          reward: quote.dy
        }, 'Got reward quote');

        return quote;
      }

      contractLogger.debug({ receiptId }, 'Failed to get reward quote');
      return null;
    } catch (error) {
      contractLogger.error({
        receiptId,
        error: error instanceof Error ? error.message : String(error)
      }, 'Error getting reward quote');

      return null;
    }
  },

  /**
   * Check if a prediction has won in a resolved market
   * 
   * @param receiptId The ID of the receipt to check
   * @returns Boolean indicating if the prediction is a winner (with reward > 0)
   */
  async isPredictionWinner(receiptId: number): Promise<boolean> {
    try {
      // Get the reward quote to see if there's a payout
      const quote = await this.getRewardQuote(receiptId);

      // If there's a reward and it's greater than 0, it's a winner
      if (quote && quote.dy > 0) {
        contractLogger.debug({
          receiptId,
          reward: quote.dy
        }, 'Prediction is a winner');
        return true;
      }

      contractLogger.debug({ receiptId }, 'Prediction is not a winner');
      return false;
    } catch (error) {
      contractLogger.error({
        receiptId,
        error: error instanceof Error ? error.message : String(error)
      }, 'Error checking if prediction is a winner');

      return false;
    }
  },

  /**
   * Get the status of a prediction based on market resolution and outcome
   * This combines multiple contract calls to determine the full status
   * 
   * @param receiptId The ID of the receipt to check
   * @returns 'pending' | 'won' | 'lost' | 'redeemed' | null (if error or not found)
   */
  async getPredictionStatus(receiptId: number): Promise<'pending' | 'won' | 'lost' | 'redeemed' | null> {
    try {
      contractLogger.debug({ receiptId }, 'Determining prediction status from chain');

      // First check if the receipt exists (has an owner)
      const owner = await this.getReceiptOwner(receiptId);

      // If no owner, it's been redeemed (NFT burned) or doesn't exist
      if (!owner) {
        // Get receipt info to check if it's just not found or was redeemed
        const receiptInfo = await this.getReceiptInfo(receiptId);

        if (receiptInfo) {
          contractLogger.debug({ receiptId }, 'Prediction has been redeemed (NFT burned)');
          return 'redeemed';
        } else {
          contractLogger.debug({ receiptId }, 'Prediction not found on chain');
          return null;
        }
      }

      // If we have an owner, get the receipt info
      const receiptInfo = await this.getReceiptInfo(receiptId);
      if (!receiptInfo) {
        contractLogger.debug({ receiptId }, 'Receipt info not found even though owner exists');
        return null;
      }

      // Get the market info to check if it's resolved
      const marketInfo = await this.getMarketInfo(receiptInfo['market-id']);
      if (!marketInfo) {
        contractLogger.debug({ receiptId, marketId: receiptInfo['market-id'] }, 'Market not found');
        return null;
      }

      // If market isn't resolved, prediction is pending
      if (!marketInfo['is-resolved']) {
        contractLogger.debug({ receiptId, marketId: receiptInfo['market-id'] }, 'Market not resolved, prediction is pending');
        return 'pending';
      }

      // Market is resolved, check if prediction is a winner
      const isWinner = await this.isPredictionWinner(receiptId);

      if (isWinner) {
        contractLogger.debug({ receiptId }, 'Prediction is a winner');
        return 'won';
      } else {
        contractLogger.debug({ receiptId }, 'Prediction is a loser');
        return 'lost';
      }
    } catch (error) {
      contractLogger.error({
        receiptId,
        error: error instanceof Error ? error.message : String(error)
      }, 'Error determining prediction status');

      return null;
    }
  },

  /**
   * Get predictions that should be marked as won or lost based on market resolution
   * This checks for receipts with 'pending' status in custody but that should be 'won' or 'lost'
   * based on the blockchain state
   * 
   * @param pendingIds List of receipt IDs that are currently 'pending' in custody
   * @returns Object containing arrays of 'won' and 'lost' IDs
   */
  async getStatusUpdatesForPendingPredictions(pendingIds: number[]): Promise<{
    won: number[];
    lost: number[];
    errors: number[];
  }> {
    try {
      contractLogger.info({
        pendingCount: pendingIds.length
      }, 'Getting status updates for pending predictions');

      const results = {
        won: [] as number[],
        lost: [] as number[],
        errors: [] as number[],
      };

      // Process in batches of 10 to avoid rate limits or timeouts
      const batchSize = 10;

      for (let i = 0; i < pendingIds.length; i += batchSize) {
        const batch = pendingIds.slice(i, i + batchSize);

        // Process each receipt in the batch concurrently
        const statusPromises = batch.map(async (receiptId) => {
          try {
            const status = await this.getPredictionStatus(receiptId);
            return { receiptId, status };
          } catch (error) {
            contractLogger.error({
              receiptId,
              error: error instanceof Error ? error.message : String(error)
            }, 'Error getting prediction status in batch');

            return { receiptId, status: 'error' };
          }
        });

        // Wait for all statuses in this batch
        const statuses = await Promise.all(statusPromises);

        // Sort into appropriate categories
        for (const { receiptId, status } of statuses) {
          if (status === 'won') {
            results.won.push(receiptId);
          } else if (status === 'lost') {
            results.lost.push(receiptId);
          } else if (status === 'error' || status === null) {
            results.errors.push(receiptId);
          }
          // Ignore 'pending' and 'redeemed' as they don't need updates
        }

        // Small delay between batches to avoid rate limiting
        if (i + batchSize < pendingIds.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      contractLogger.info({
        pendingCount: pendingIds.length,
        wonCount: results.won.length,
        lostCount: results.lost.length,
        errorCount: results.errors.length
      }, 'Finished getting status updates for pending predictions');

      return results;
    } catch (error) {
      contractLogger.error({
        error: error instanceof Error ? error.message : String(error)
      }, 'Error getting status updates for pending predictions');

      throw new AppError({
        message: 'Failed to get status updates for pending predictions',
        context: 'prediction-contract-store',
        code: 'STATUS_UPDATE_ERROR',
        originalError: error instanceof Error ? error : new Error(String(error)),
        data: { pendingCount: pendingIds.length }
      }).log();
    }
  }
};