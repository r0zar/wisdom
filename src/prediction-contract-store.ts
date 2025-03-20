/**
 * Prediction Contract Store: Direct interface to the Clarity smart contract
 * 
 * This module provides function wrappers for interacting with the
 * prediction market contract. It abstracts the complexity of making direct
 * contract calls and provides a cleaner interface for the rest of the application.
 * 
 * Includes both read-only functions and functions for state-changing operations.
 */

import { logger } from './logger';
import { AppError } from './logger';
import { STACKS_MAINNET } from '@stacks/network';

// Import the types and functions we need for contract calls
import {
  fetchCallReadOnlyFunction,
  makeContractCall,
  broadcastTransaction,
  uintCV,
  stringAsciiCV,
  tupleCV,
  listCV,
  noneCV,
  someCV,
  bufferCV,
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
  PostConditionMode,
  TxBroadcastResult,
  Cl
} from '@stacks/transactions';

// Contract configuration - consistent with other stores
const contractConfig = {
  contractAddress: process.env.PREDICTION_CONTRACT_ADDRESS || 'SP2ZNGJ85ENDY6QRHQ5P2D4FXKGZWCKTB2T0Z55KS',
  contractName: process.env.PREDICTION_CONTRACT_NAME || 'blaze-welsh-predictions-v1',
  network: STACKS_MAINNET,
  privateKey: process.env.MARKET_CREATOR_PRIVATE_KEY || '',
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
 * Interface for market creation result
 */
export interface MarketCreationResult {
  marketId: string;
  creator: string;
  creationTime: number;
}

/**
 * Interface for market resolution request
 */
export interface MarketResolutionRequest {
  marketId: string;
  winningOutcomeId: number;
}

/**
 * Interface for prediction transaction result
 */
export interface PredictionTransactionResult {
  dx: string; // market id
  dy: number; // pool amount
  dk: number; // receipt id
}

/**
 * Interface for signed transaction parameters
 */
export interface SignedTransactionParams {
  signature: string; // hex string of signature buffer
  nonce: number;
}

/**
 * Interface for batch prediction operation
 */
export interface BatchPredictionOperation {
  signet: SignedTransactionParams;
  marketId: string;
  outcomeId: number;
  amount: number;
}

/**
 * Interface for batch claim reward operation
 */
export interface BatchClaimOperation {
  signet: SignedTransactionParams;
  receiptId: number;
}

/**
 * Prediction contract store with functions to query and interact with the contract
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
  },

  /**
   * Create a new prediction market on the blockchain
   * @param marketId Unique identifier for the market (max 64 ASCII chars)
   * @param name Name of the market (max 64 ASCII chars)
   * @param description Description of the market (max 128 ASCII chars)
   * @param outcomeNames List of possible outcome names (max 16 outcomes, each max 32 chars)
   * @param senderKey Private key of the sender (defaults to contract config)
   * @returns Result of the transaction with market creation details
   */
  async createMarket(
    marketId: string,
    name: string,
    description: string,
    outcomeNames: string[],
    senderKey?: string
  ): Promise<{
    success: boolean;
    result?: MarketCreationResult;
    txid?: string;
    error?: string;
  }> {
    try {
      contractLogger.info({
        marketId,
        name,
        descriptionLength: description.length,
        outcomeCount: outcomeNames.length
      }, 'Creating new prediction market on-chain');

      // Validate input
      if (!marketId || !name || !description || !outcomeNames.length) {
        throw new AppError({
          message: 'Invalid market data',
          context: 'prediction-contract-store',
          code: 'INVALID_MARKET_DATA',
          data: { marketId, name, descriptionLength: description.length, outcomeCount: outcomeNames.length }
        }).log();
      }

      // Validate string lengths according to contract constraints
      if (marketId.length > 64) {
        throw new AppError({
          message: 'Market ID exceeds maximum length of 64 ASCII characters',
          context: 'prediction-contract-store',
          code: 'INVALID_MARKET_ID_LENGTH',
          data: { marketId, length: marketId.length }
        }).log();
      }

      if (name.length > 64) {
        throw new AppError({
          message: 'Market name exceeds maximum length of 64 ASCII characters',
          context: 'prediction-contract-store',
          code: 'INVALID_MARKET_NAME_LENGTH',
          data: { name, length: name.length }
        }).log();
      }

      if (description.length > 128) {
        throw new AppError({
          message: 'Market description exceeds maximum length of 128 ASCII characters',
          context: 'prediction-contract-store',
          code: 'INVALID_MARKET_DESCRIPTION_LENGTH',
          data: { descriptionLength: description.length }
        }).log();
      }

      if (outcomeNames.length > 16) {
        throw new AppError({
          message: 'Too many outcomes, maximum is 16',
          context: 'prediction-contract-store',
          code: 'TOO_MANY_OUTCOMES',
          data: { outcomeCount: outcomeNames.length }
        }).log();
      }

      // Check if any outcome name is too long
      const longOutcomes = outcomeNames.filter(name => name.length > 32);
      if (longOutcomes.length > 0) {
        throw new AppError({
          message: 'One or more outcome names exceed maximum length of 32 ASCII characters',
          context: 'prediction-contract-store',
          code: 'INVALID_OUTCOME_NAME_LENGTH',
          data: { longOutcomes: longOutcomes.map(name => ({ name, length: name.length })) }
        }).log();
      }

      // Use provided senderKey or fall back to config
      const key = senderKey || contractConfig.privateKey;
      if (!key) {
        throw new AppError({
          message: 'No private key available for transaction',
          context: 'prediction-contract-store',
          code: 'NO_PRIVATE_KEY'
        }).log();
      }

      // Prepare the contract call
      const transaction = await makeContractCall({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'create-market',
        functionArgs: [
          stringAsciiCV(marketId),
          stringAsciiCV(name),
          stringAsciiCV(description),
          listCV(outcomeNames.map(name => stringAsciiCV(name)))
        ],
        senderKey: key,
        validateWithAbi: true,
        network: contractConfig.network,
        postConditionMode: PostConditionMode.Allow,
        fee: 1000 // Default fee, can be adjusted based on network conditions
      });

      // Broadcast the transaction
      const result = await broadcastTransaction({ transaction });

      if (!result.txid) {
        throw new AppError({
          message: 'Failed to broadcast market creation transaction',
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { error: 'No transaction ID returned' }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        marketId,
        name
      }, 'Successfully submitted market creation transaction');

      return {
        success: true,
        txid: result.txid,
        result: {
          marketId,
          creator: transaction.auth.spendingCondition.signer,
          creationTime: Math.floor(Date.now() / 1000)
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      contractLogger.error({
        marketId,
        error: errorMessage
      }, 'Error creating market on blockchain');

      if (error instanceof AppError) {
        return {
          success: false,
          error: error.message
        };
      }

      return {
        success: false,
        error: `Failed to create market: ${errorMessage}`
      };
    }
  },

  /**
   * Close a market (no more predictions allowed)
   * @param marketId The ID of the market to close
   * @param senderKey Private key of the sender (must be admin or deployer)
   * @returns Result of the transaction
   */
  async closeMarket(
    marketId: string,
    senderKey?: string
  ): Promise<{
    success: boolean;
    txid?: string;
    error?: string;
  }> {
    try {
      contractLogger.info({ marketId }, 'Closing market on-chain');

      // Validate input
      if (!marketId) {
        throw new AppError({
          message: 'Invalid market ID',
          context: 'prediction-contract-store',
          code: 'INVALID_MARKET_ID',
          data: { marketId }
        }).log();
      }

      // Use provided senderKey or fall back to config
      const key = senderKey || contractConfig.privateKey;
      if (!key) {
        throw new AppError({
          message: 'No private key available for transaction',
          context: 'prediction-contract-store',
          code: 'NO_PRIVATE_KEY'
        }).log();
      }

      // Prepare the contract call
      const transaction = await makeContractCall({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'close-market',
        functionArgs: [
          stringAsciiCV(marketId)
        ],
        senderKey: key,
        validateWithAbi: true,
        network: contractConfig.network,
        postConditionMode: PostConditionMode.Allow,
        fee: 1000
      });

      // Broadcast the transaction
      const result = await broadcastTransaction({ transaction });

      if (!result.txid) {
        throw new AppError({
          message: 'Failed to broadcast market close transaction',
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { error: 'No transaction ID returned' }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        marketId
      }, 'Successfully submitted market close transaction');

      return {
        success: true,
        txid: result.txid
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      contractLogger.error({
        marketId,
        error: errorMessage
      }, 'Error closing market on blockchain');

      if (error instanceof AppError) {
        return {
          success: false,
          error: error.message
        };
      }

      return {
        success: false,
        error: `Failed to close market: ${errorMessage}`
      };
    }
  },

  /**
   * Resolve a market by setting the winning outcome
   * @param marketId The ID of the market to resolve
   * @param winningOutcomeId The ID of the winning outcome
   * @param senderKey Private key of the sender (must be admin or deployer)
   * @returns Result of the transaction
   */
  async resolveMarket(
    marketId: string,
    winningOutcomeId: number,
    senderKey?: string
  ): Promise<{
    success: boolean;
    txid?: string;
    error?: string;
  }> {
    try {
      contractLogger.info({ marketId, winningOutcomeId }, 'Resolving market on-chain');

      // Validate input
      if (!marketId) {
        throw new AppError({
          message: 'Invalid market ID',
          context: 'prediction-contract-store',
          code: 'INVALID_MARKET_ID',
          data: { marketId }
        }).log();
      }

      if (winningOutcomeId < 0) {
        throw new AppError({
          message: 'Invalid winning outcome ID',
          context: 'prediction-contract-store',
          code: 'INVALID_OUTCOME_ID',
          data: { winningOutcomeId }
        }).log();
      }

      // Use provided senderKey or fall back to config
      const key = senderKey || contractConfig.privateKey;
      if (!key) {
        throw new AppError({
          message: 'No private key available for transaction',
          context: 'prediction-contract-store',
          code: 'NO_PRIVATE_KEY'
        }).log();
      }

      // Prepare the contract call
      const transaction = await makeContractCall({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'resolve-market',
        functionArgs: [
          stringAsciiCV(marketId),
          uintCV(winningOutcomeId)
        ],
        senderKey: key,
        validateWithAbi: true,
        network: contractConfig.network,
        postConditionMode: PostConditionMode.Allow,
        fee: 1000
      });

      // Broadcast the transaction
      const result = await broadcastTransaction({ transaction });

      if (!result.txid) {
        throw new AppError({
          message: 'Failed to broadcast market resolution transaction',
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { error: 'No transaction ID returned' }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        marketId,
        winningOutcomeId
      }, 'Successfully submitted market resolution transaction');

      return {
        success: true,
        txid: result.txid
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      contractLogger.error({
        marketId,
        winningOutcomeId,
        error: errorMessage
      }, 'Error resolving market on blockchain');

      if (error instanceof AppError) {
        return {
          success: false,
          error: error.message
        };
      }

      return {
        success: false,
        error: `Failed to resolve market: ${errorMessage}`
      };
    }
  },

  /**
   * Make a prediction on a market outcome (direct transaction)
   * @param marketId The ID of the market
   * @param outcomeId The ID of the outcome being predicted
   * @param amount The amount to stake on this prediction
   * @param senderKey Private key of the sender
   * @returns Result of the transaction with prediction details
   */
  async makePrediction(
    marketId: string,
    outcomeId: number,
    amount: number,
    senderKey: string
  ): Promise<{
    success: boolean;
    result?: PredictionTransactionResult;
    txid?: string;
    error?: string;
  }> {
    try {
      contractLogger.info({
        marketId,
        outcomeId,
        amount
      }, 'Making prediction on-chain');

      // Validate input
      if (!marketId || outcomeId < 0 || amount <= 0) {
        throw new AppError({
          message: 'Invalid prediction data',
          context: 'prediction-contract-store',
          code: 'INVALID_PREDICTION_DATA',
          data: { marketId, outcomeId, amount }
        }).log();
      }

      if (!senderKey) {
        throw new AppError({
          message: 'No private key provided for transaction',
          context: 'prediction-contract-store',
          code: 'NO_PRIVATE_KEY'
        }).log();
      }

      // Prepare the contract call
      const transaction = await makeContractCall({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'make-prediction',
        functionArgs: [
          stringAsciiCV(marketId),
          uintCV(outcomeId),
          uintCV(amount)
        ],
        senderKey: senderKey,
        validateWithAbi: true,
        network: contractConfig.network,
        postConditionMode: PostConditionMode.Allow,
        fee: 1000
      });

      // Broadcast the transaction
      const result = await broadcastTransaction({ transaction });

      if (!result.txid) {
        throw new AppError({
          message: 'Failed to broadcast prediction transaction',
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { error: 'No transaction ID returned' }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        marketId,
        outcomeId,
        amount
      }, 'Successfully submitted prediction transaction');

      // We don't know the receipt ID yet - it will be assigned by the contract
      // The receipt ID should be retrieved by monitoring the transaction result
      return {
        success: true,
        txid: result.txid,
        result: {
          dx: marketId,
          dy: amount,
          dk: 0 // We don't know the actual receipt ID yet
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      contractLogger.error({
        marketId,
        outcomeId,
        amount,
        error: errorMessage
      }, 'Error making prediction on blockchain');

      if (error instanceof AppError) {
        return {
          success: false,
          error: error.message
        };
      }

      return {
        success: false,
        error: `Failed to make prediction: ${errorMessage}`
      };
    }
  },

  /**
   * Make a prediction using a signed transaction
   * @param signet Signature and nonce for the transaction
   * @param marketId The ID of the market
   * @param outcomeId The ID of the outcome being predicted
   * @param amount The amount to stake on this prediction
   * @param senderKey Private key for sending the transaction (admin key)
   * @returns Result of the transaction with prediction details
   */
  async signedPredict(
    signet: SignedTransactionParams,
    marketId: string,
    outcomeId: number,
    amount: number,
    senderKey?: string
  ): Promise<{
    success: boolean;
    result?: PredictionTransactionResult;
    txid?: string;
    error?: string;
  }> {
    try {
      contractLogger.info({
        marketId,
        outcomeId,
        amount,
        nonce: signet.nonce
      }, 'Making signed prediction on-chain');

      // Validate input
      if (!marketId || outcomeId < 0 || amount <= 0) {
        throw new AppError({
          message: 'Invalid prediction data',
          context: 'prediction-contract-store',
          code: 'INVALID_PREDICTION_DATA',
          data: { marketId, outcomeId, amount }
        }).log();
      }

      if (!signet.signature || signet.nonce === undefined) {
        throw new AppError({
          message: 'Invalid signet data',
          context: 'prediction-contract-store',
          code: 'INVALID_SIGNET',
          data: { hasSignature: !!signet.signature, hasNonce: signet.nonce !== undefined }
        }).log();
      }

      // Use provided senderKey or fall back to config
      const key = senderKey || contractConfig.privateKey;
      if (!key) {
        throw new AppError({
          message: 'No private key available for transaction',
          context: 'prediction-contract-store',
          code: 'NO_PRIVATE_KEY'
        }).log();
      }

      // Prepare the contract call
      const transaction = await makeContractCall({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'signed-predict',
        functionArgs: [
          tupleCV({
            signature: bufferCV(Buffer.from(signet.signature, 'hex')),
            nonce: uintCV(signet.nonce)
          }),
          stringAsciiCV(marketId),
          uintCV(outcomeId),
          uintCV(amount)
        ],
        senderKey: key,
        validateWithAbi: true,
        network: contractConfig.network,
        postConditionMode: PostConditionMode.Allow,
        fee: 1000
      });

      // Broadcast the transaction
      const result = await broadcastTransaction({ transaction });

      if (!result.txid) {
        throw new AppError({
          message: 'Failed to broadcast signed prediction transaction',
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { error: 'No transaction ID returned' }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        marketId,
        outcomeId,
        amount,
        nonce: signet.nonce
      }, 'Successfully submitted signed prediction transaction');

      // The receipt ID should be the same as the nonce in signed transactions
      return {
        success: true,
        txid: result.txid,
        result: {
          dx: marketId,
          dy: amount,
          dk: signet.nonce
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      contractLogger.error({
        marketId,
        outcomeId,
        amount,
        nonce: signet.nonce,
        error: errorMessage
      }, 'Error making signed prediction on blockchain');

      if (error instanceof AppError) {
        return {
          success: false,
          error: error.message
        };
      }

      return {
        success: false,
        error: `Failed to make signed prediction: ${errorMessage}`
      };
    }
  },

  /**
   * Claim a reward for a winning prediction
   * @param receiptId The ID of the winning prediction receipt
   * @param senderKey Private key of the receipt owner
   * @returns Result of the transaction with reward details
   */
  async claimReward(
    receiptId: number,
    senderKey: string
  ): Promise<{
    success: boolean;
    result?: PredictionTransactionResult;
    txid?: string;
    error?: string;
  }> {
    try {
      contractLogger.info({ receiptId }, 'Claiming prediction reward on-chain');

      // Validate input
      if (receiptId <= 0) {
        throw new AppError({
          message: 'Invalid receipt ID',
          context: 'prediction-contract-store',
          code: 'INVALID_RECEIPT_ID',
          data: { receiptId }
        }).log();
      }

      if (!senderKey) {
        throw new AppError({
          message: 'No private key provided for transaction',
          context: 'prediction-contract-store',
          code: 'NO_PRIVATE_KEY'
        }).log();
      }

      // Prepare the contract call
      const transaction = await makeContractCall({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'claim-reward',
        functionArgs: [
          uintCV(receiptId)
        ],
        senderKey: senderKey,
        validateWithAbi: true,
        network: contractConfig.network,
        postConditionMode: PostConditionMode.Allow,
        fee: 1000
      });

      // Broadcast the transaction
      const result = await broadcastTransaction({ transaction });

      if (!result.txid) {
        throw new AppError({
          message: 'Failed to broadcast claim reward transaction',
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { error: 'No transaction ID returned' }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        receiptId
      }, 'Successfully submitted claim reward transaction');

      return {
        success: true,
        txid: result.txid,
        result: {
          dx: "", // We don't know the market ID yet
          dy: 0,  // We don't know the reward amount yet
          dk: receiptId
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      contractLogger.error({
        receiptId,
        error: errorMessage
      }, 'Error claiming reward on blockchain');

      if (error instanceof AppError) {
        return {
          success: false,
          error: error.message
        };
      }

      return {
        success: false,
        error: `Failed to claim reward: ${errorMessage}`
      };
    }
  },

  /**
   * Claim a reward using a signed transaction
   * @param signet Signature and nonce for the transaction
   * @param receiptId The ID of the winning prediction receipt
   * @param senderKey Private key for sending the transaction (admin key)
   * @returns Result of the transaction with reward details
   */
  async signedClaimReward(
    signet: SignedTransactionParams,
    receiptId: number,
    senderKey?: string
  ): Promise<{
    success: boolean;
    result?: PredictionTransactionResult;
    txid?: string;
    error?: string;
  }> {
    try {
      contractLogger.info({
        receiptId,
        nonce: signet.nonce
      }, 'Claiming reward with signed transaction on-chain');

      // Validate input
      if (receiptId <= 0) {
        throw new AppError({
          message: 'Invalid receipt ID',
          context: 'prediction-contract-store',
          code: 'INVALID_RECEIPT_ID',
          data: { receiptId }
        }).log();
      }

      if (!signet.signature || signet.nonce === undefined) {
        throw new AppError({
          message: 'Invalid signet data',
          context: 'prediction-contract-store',
          code: 'INVALID_SIGNET',
          data: { hasSignature: !!signet.signature, hasNonce: signet.nonce !== undefined }
        }).log();
      }

      // Use provided senderKey or fall back to config
      const key = senderKey || contractConfig.privateKey;
      if (!key) {
        throw new AppError({
          message: 'No private key available for transaction',
          context: 'prediction-contract-store',
          code: 'NO_PRIVATE_KEY'
        }).log();
      }

      // Prepare the contract call
      const transaction = await makeContractCall({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'signed-claim-reward',
        functionArgs: [
          tupleCV({
            signature: bufferCV(Buffer.from(signet.signature, 'hex')),
            nonce: uintCV(signet.nonce)
          }),
          uintCV(receiptId)
        ],
        senderKey: key,
        validateWithAbi: true,
        network: contractConfig.network,
        postConditionMode: PostConditionMode.Allow,
        fee: 1000
      });

      // Broadcast the transaction
      const result = await broadcastTransaction({ transaction });

      if (!result.txid) {
        throw new AppError({
          message: 'Failed to broadcast signed claim reward transaction',
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { error: 'No transaction ID returned' }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        receiptId,
        nonce: signet.nonce
      }, 'Successfully submitted signed claim reward transaction');

      return {
        success: true,
        txid: result.txid,
        result: {
          dx: "", // We don't know the market ID yet
          dy: 0,  // We don't know the reward amount yet
          dk: receiptId
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      contractLogger.error({
        receiptId,
        nonce: signet.nonce,
        error: errorMessage
      }, 'Error claiming reward with signed transaction on blockchain');

      if (error instanceof AppError) {
        return {
          success: false,
          error: error.message
        };
      }

      return {
        success: false,
        error: `Failed to claim reward with signed transaction: ${errorMessage}`
      };
    }
  },

  /**
   * Process a batch of prediction operations in a single transaction
   * @param operations Array of prediction operations to execute
   * @param senderKey Private key for sending the transaction (admin key)
   * @returns Result of the batch operation
   */
  async batchPredict(
    operations: BatchPredictionOperation[],
    senderKey?: string
  ): Promise<{
    success: boolean;
    results?: boolean[];
    txid?: string;
    error?: string;
  }> {
    try {
      contractLogger.info({
        operationCount: operations.length
      }, 'Processing batch predictions on-chain');

      // Validate input
      if (!operations.length) {
        throw new AppError({
          message: 'No operations provided for batch processing',
          context: 'prediction-contract-store',
          code: 'EMPTY_BATCH',
          data: { operationCount: 0 }
        }).log();
      }

      // Check maximum batch size (from contract constant)
      const MAX_BATCH_SIZE = 200; // From contract
      if (operations.length > MAX_BATCH_SIZE) {
        throw new AppError({
          message: `Batch size exceeds maximum of ${MAX_BATCH_SIZE} operations`,
          context: 'prediction-contract-store',
          code: 'BATCH_TOO_LARGE',
          data: { operationCount: operations.length, maxSize: MAX_BATCH_SIZE }
        }).log();
      }

      // Use provided senderKey or fall back to config
      const key = senderKey || contractConfig.privateKey;
      if (!key) {
        throw new AppError({
          message: 'No private key available for transaction',
          context: 'prediction-contract-store',
          code: 'NO_PRIVATE_KEY'
        }).log();
      }

      // Transform operations into contract format
      const operationCVs = operations.map(op => {
        return tupleCV({
          signet: tupleCV({
            signature: bufferCV(Buffer.from(op.signet.signature, 'hex')),
            nonce: uintCV(op.signet.nonce)
          }),
          "market-id": stringAsciiCV(op.marketId),
          "outcome-id": uintCV(op.outcomeId),
          amount: uintCV(op.amount)
        });
      });

      // Prepare the contract call
      const transaction = await makeContractCall({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'batch-predict',
        functionArgs: [
          listCV(operationCVs)
        ],
        senderKey: key,
        validateWithAbi: true,
        network: contractConfig.network,
        postConditionMode: PostConditionMode.Allow,
        // Set fee proportional to batch size
        fee: Math.max(1000, 100 * operations.length)
      });

      // Broadcast the transaction
      const result = await broadcastTransaction({ transaction });

      if (!result.txid) {
        throw new AppError({
          message: 'Failed to broadcast batch predict transaction',
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { error: 'No transaction ID returned' }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        operationCount: operations.length
      }, 'Successfully submitted batch predict transaction');

      return {
        success: true,
        txid: result.txid,
        // We don't know the actual results until the transaction is processed
        results: Array(operations.length).fill(true)
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      contractLogger.error({
        operationCount: operations.length,
        error: errorMessage
      }, 'Error processing batch predictions on blockchain');

      if (error instanceof AppError) {
        return {
          success: false,
          error: error.message
        };
      }

      return {
        success: false,
        error: `Failed to process batch predictions: ${errorMessage}`
      };
    }
  },

  /**
   * Process a batch of claim reward operations in a single transaction
   * @param operations Array of claim reward operations to execute
   * @param senderKey Private key for sending the transaction (admin key)
   * @returns Result of the batch operation
   */
  async batchClaimReward(
    operations: BatchClaimOperation[],
    senderKey?: string
  ): Promise<{
    success: boolean;
    results?: boolean[];
    txid?: string;
    error?: string;
  }> {
    try {
      contractLogger.info({
        operationCount: operations.length
      }, 'Processing batch claim rewards on-chain');

      // Validate input
      if (!operations.length) {
        throw new AppError({
          message: 'No operations provided for batch processing',
          context: 'prediction-contract-store',
          code: 'EMPTY_BATCH',
          data: { operationCount: 0 }
        }).log();
      }

      // Check maximum batch size (from contract constant)
      const MAX_BATCH_SIZE = 200; // From contract
      if (operations.length > MAX_BATCH_SIZE) {
        throw new AppError({
          message: `Batch size exceeds maximum of ${MAX_BATCH_SIZE} operations`,
          context: 'prediction-contract-store',
          code: 'BATCH_TOO_LARGE',
          data: { operationCount: operations.length, maxSize: MAX_BATCH_SIZE }
        }).log();
      }

      // Use provided senderKey or fall back to config
      const key = senderKey || contractConfig.privateKey;
      if (!key) {
        throw new AppError({
          message: 'No private key available for transaction',
          context: 'prediction-contract-store',
          code: 'NO_PRIVATE_KEY'
        }).log();
      }

      // Transform operations into contract format
      const operationCVs = operations.map(op => {
        return tupleCV({
          signet: tupleCV({
            signature: bufferCV(Buffer.from(op.signet.signature, 'hex')),
            nonce: uintCV(op.signet.nonce)
          }),
          "receipt-id": uintCV(op.receiptId)
        });
      });

      // Prepare the contract call
      const transaction = await makeContractCall({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'batch-claim-reward',
        functionArgs: [
          listCV(operationCVs)
        ],
        senderKey: key,
        validateWithAbi: true,
        network: contractConfig.network,
        postConditionMode: PostConditionMode.Allow,
        // Set fee proportional to batch size
        fee: Math.max(1000, 100 * operations.length)
      });

      // Broadcast the transaction
      const result = await broadcastTransaction({ transaction });

      if (!result.txid) {
        throw new AppError({
          message: 'Failed to broadcast batch claim reward transaction',
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { error: 'No transaction ID returned' }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        operationCount: operations.length
      }, 'Successfully submitted batch claim reward transaction');

      return {
        success: true,
        txid: result.txid,
        // We don't know the actual results until the transaction is processed
        results: Array(operations.length).fill(true)
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      contractLogger.error({
        operationCount: operations.length,
        error: errorMessage
      }, 'Error processing batch claim rewards on blockchain');

      if (error instanceof AppError) {
        return {
          success: false,
          error: error.message
        };
      }

      return {
        success: false,
        error: `Failed to process batch claim rewards: ${errorMessage}`
      };
    }
  },

  /**
   * Add an admin to the contract
   * @param adminAddress The principal address to add as admin
   * @param senderKey Private key of the contract deployer (required)
   * @returns Result of the transaction
   */
  async addAdmin(
    adminAddress: string,
    senderKey?: string
  ): Promise<{
    success: boolean;
    txid?: string;
    error?: string;
  }> {
    try {
      contractLogger.info({ adminAddress }, 'Adding admin on-chain');

      // Validate input
      if (!adminAddress) {
        throw new AppError({
          message: 'Invalid admin address',
          context: 'prediction-contract-store',
          code: 'INVALID_ADMIN_ADDRESS',
          data: { adminAddress }
        }).log();
      }

      // Use provided senderKey or fall back to config
      const key = senderKey || contractConfig.privateKey;
      if (!key) {
        throw new AppError({
          message: 'No private key available for transaction',
          context: 'prediction-contract-store',
          code: 'NO_PRIVATE_KEY'
        }).log();
      }

      // Prepare the contract call
      const transaction = await makeContractCall({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'add-admin',
        functionArgs: [Cl.principal(adminAddress)],
        senderKey: key,
        validateWithAbi: true,
        network: contractConfig.network,
        postConditionMode: PostConditionMode.Allow,
        fee: 1000
      });

      // Broadcast the transaction
      const result = await broadcastTransaction({ transaction });

      if (!result.txid) {
        throw new AppError({
          message: 'Failed to broadcast add admin transaction',
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { error: 'No transaction ID returned' }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        adminAddress
      }, 'Successfully submitted add admin transaction');

      return {
        success: true,
        txid: result.txid
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      contractLogger.error({
        adminAddress,
        error: errorMessage
      }, 'Error adding admin on blockchain');

      if (error instanceof AppError) {
        return {
          success: false,
          error: error.message
        };
      }

      return {
        success: false,
        error: `Failed to add admin: ${errorMessage}`
      };
    }
  },

  /**
   * Remove an admin from the contract
   * @param adminAddress The principal address to remove as admin
   * @param senderKey Private key of the contract deployer (required)
   * @returns Result of the transaction
   */
  async removeAdmin(
    adminAddress: string,
    senderKey?: string
  ): Promise<{
    success: boolean;
    txid?: string;
    error?: string;
  }> {
    try {
      contractLogger.info({ adminAddress }, 'Removing admin on-chain');

      // Validate input
      if (!adminAddress) {
        throw new AppError({
          message: 'Invalid admin address',
          context: 'prediction-contract-store',
          code: 'INVALID_ADMIN_ADDRESS',
          data: { adminAddress }
        }).log();
      }

      // Use provided senderKey or fall back to config
      const key = senderKey || contractConfig.privateKey;
      if (!key) {
        throw new AppError({
          message: 'No private key available for transaction',
          context: 'prediction-contract-store',
          code: 'NO_PRIVATE_KEY'
        }).log();
      }

      // Prepare the contract call
      const transaction = await makeContractCall({
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'remove-admin',
        functionArgs: [Cl.address(adminAddress)],
        senderKey: key,
        validateWithAbi: true,
        network: contractConfig.network,
        postConditionMode: PostConditionMode.Allow,
        fee: 1000
      });

      // Broadcast the transaction
      const result = await broadcastTransaction({ transaction });

      if (!result.txid) {
        throw new AppError({
          message: 'Failed to broadcast remove admin transaction',
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { error: 'No transaction ID returned' }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        adminAddress
      }, 'Successfully submitted remove admin transaction');

      return {
        success: true,
        txid: result.txid
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      contractLogger.error({
        adminAddress,
        error: errorMessage
      }, 'Error removing admin on blockchain');

      if (error instanceof AppError) {
        return {
          success: false,
          error: error.message
        };
      }

      return {
        success: false,
        error: `Failed to remove admin: ${errorMessage}`
      };
    }
  }
};