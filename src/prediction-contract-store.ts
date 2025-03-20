/**
 * Prediction Contract Store: Direct interface to the Clarity smart contract
 * 
 * This module provides function wrappers for interacting with the
 * prediction market contract. It abstracts the complexity of making direct
 * contract calls and provides a cleaner interface for the rest of the application.
 * 
 * Includes both read-only functions and functions for state-changing operations.
 * 
 * Uses a robust client implementation with:
 * - Multiple API endpoint fallbacks
 * - API key rotation
 * - Automatic retries
 * - Request batching
 */

import { logger } from './logger';
import { AppError } from './logger';
import { STACKS_MAINNET, StacksNetwork } from '@stacks/network';
import { createClient, Client } from "@stacks/blockchain-api-client";
import { paths } from "@stacks/blockchain-api-client/lib/generated/schema";

// Import the types and functions we need for contract calls
import {
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
  hexToCV,
  cvToHex,
  PostConditionMode,
  TxBroadcastResult,
  Cl,
} from '@stacks/transactions';

/**
 * API endpoints for Stacks blockchain
 * Multiple endpoints for redundancy and load balancing
 */
const API_ENDPOINTS = [
  "https://api.hiro.so/",
  "https://api.mainnet.hiro.so/",
  "https://stacks-node-api.mainnet.stacks.co/",
];

// Default retry settings
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_DELAY = 1000; // ms

// Contract configuration - consistent with other stores
const contractConfig = {
  contractAddress: process.env.PREDICTION_CONTRACT_ADDRESS || 'SP2ZNGJ85ENDY6QRHQ5P2D4FXKGZWCKTB2T0Z55KS',
  contractName: process.env.PREDICTION_CONTRACT_NAME || 'blaze-welsh-predictions-v1',
  network: STACKS_MAINNET,
  privateKey: process.env.MARKET_CREATOR_PRIVATE_KEY || '',
  apiKey: process.env.HIRO_API_KEY || '',
  apiKeys: process.env.HIRO_API_KEYS ? process.env.HIRO_API_KEYS.split(',') : [],
  apiKeyRotation: process.env.API_KEY_ROTATION || 'loop', // 'loop' or 'random'
  retryCount: parseInt(process.env.API_RETRY_COUNT || '3', 10),
  retryDelay: parseInt(process.env.API_RETRY_DELAY || '1000', 10),
};

// Create a logger instance for this module
const contractLogger = logger.child({ context: 'prediction-contract-store' });

// Initialize API clients with API key rotation
const stacksClients: Client<paths, `${string}/${string}`>[] = [];
let currentClientIndex = 0;
let currentKeyIndex = 0;

// Track metadata cache to avoid redundant calls
interface MetadataCache {
  marketInfo: Map<string, { data: PredictionMarketInfo | null, timestamp: number }>;
  receiptInfo: Map<number, { data: PredictionReceiptInfo | null, timestamp: number }>;
  rewardQuote: Map<number, { data: PredictionRewardQuote | null, timestamp: number }>;
  receiptOwner: Map<number, { data: string | null, timestamp: number }>;
}

// Default cache expiration time in milliseconds (15 seconds)
const CACHE_EXPIRATION = 15 * 1000;

const metadataCache: MetadataCache = {
  marketInfo: new Map(),
  receiptInfo: new Map(),
  rewardQuote: new Map(),
  receiptOwner: new Map()
};

/**
 * Check if cached data is still valid (not expired)
 * @param timestamp The timestamp when the data was cached
 * @returns Boolean indicating if the cache is still valid
 */
const isCacheValid = (timestamp: number): boolean => {
  return Date.now() - timestamp < CACHE_EXPIRATION;
};

/**
 * Helper function to validate a broadcast result is successful
 * @param result The broadcast result to validate
 * @returns True if the transaction appears successful, false otherwise
 */
const isBroadcastSuccessful = (result: any): boolean => {
  // Check for essential properties
  if (!result.txid) {
    return false;
  }

  // Check for error indicators in the response
  if (result.error || result.reason) {
    return false;
  }

  // For Stacks, check tx_status if available
  if (result.tx_status && result.tx_status !== 'success' && result.tx_status !== 'pending') {
    return false;
  }

  return true;
};

/**
 * Helper function to broadcast a transaction with automatic fee adjustment
 * @param transaction The transaction to broadcast
 * @param makeContractCallOptions Options to recreate the transaction with adjusted fee
 * @param logContext Context information for logging
 * @returns The broadcast result
 */
const broadcastWithFeeAdjustment = async (
  transaction: any,
  makeContractCallOptions: any,
  logContext: Record<string, any> = {}
): Promise<TxBroadcastResult> => {
  try {
    // First attempt with the provided fee
    const result: any = await broadcastTransaction({ transaction });

    // Check if the result indicates success
    if (!isBroadcastSuccessful(result)) {
      // If we have a txid but there's an error, log it for debugging
      if (result.txid && (result.error || result.reason)) {
        contractLogger.warn({
          ...logContext,
          txid: result.txid,
          error: result.error,
          reason: result.reason,
          status: result.tx_status
        }, 'Transaction broadcast returned a txid but has error indicators');
      }

      throw new AppError({
        message: `Transaction broadcast failed: ${result.reason || result.error || 'Unknown error'}`,
        context: 'prediction-contract-store',
        code: 'BROADCAST_ERROR',
        data: {
          result, ...logContext,
          error: result.error,
          reason: result.reason,
        }
      })
    }

    return result;
  } catch (error: any) {
    // Check for fee too low error
    if (error.data.result.reason === 'FeeTooLow' && error.data.result.reason_data) {
      const actualFee = error.data.result.reason_data.actual || 0;
      const expectedFee = error.data.result.reason_data.expected || 0;
      const feePadding = 10; // Add a little extra to be safe

      contractLogger.warn({
        ...logContext,
        error: 'Fee too low',
        txid: error.txid,
        actualFee,
        expectedFee,
        newFee: expectedFee + feePadding
      }, 'Transaction rejected due to fee too low, retrying with adjusted fee');

      // Create a new transaction with the suggested fee (plus padding)
      const adjustedOptions = {
        ...makeContractCallOptions,
        fee: expectedFee + feePadding
      };

      const newTransaction = await makeContractCall(adjustedOptions);

      // Try broadcasting again with the new fee
      const retryResult: any = await broadcastTransaction({ transaction: newTransaction });

      // Validate the retry result
      if (!isBroadcastSuccessful(retryResult)) {
        throw new AppError({
          message: `Retry transaction broadcast failed: ${retryResult.error || retryResult.reason || 'Unknown error'}`,
          context: 'prediction-contract-store',
          code: 'RETRY_BROADCAST_ERROR',
          data: { retryResult, adjustedFee: expectedFee + feePadding, ...logContext }
        }).log();
      }

      return retryResult;
    }

    // Re-throw other errors
    throw error;
  }
};

/**
 * Initialize API clients
 */
const initClients = () => {
  if (stacksClients.length > 0) return; // Already initialized

  for (const endpoint of API_ENDPOINTS) {
    const client = createClient({ baseUrl: endpoint });

    // Add API key handling middleware
    client.use({
      onRequest({ request }) {
        const apiKeys = contractConfig.apiKeys.length
          ? contractConfig.apiKeys
          : contractConfig.apiKey ? [contractConfig.apiKey] : [];

        if (!apiKeys.length) return;

        // Get next API key based on rotation strategy
        const rotationStrategy = contractConfig.apiKeyRotation;
        let key: string;

        if (rotationStrategy === "random") {
          const randomIndex = Math.floor(Math.random() * apiKeys.length);
          key = apiKeys[randomIndex]!;
        } else {
          // Default loop strategy
          key = apiKeys[currentKeyIndex]!;
          currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
        }
        request.headers.set("x-api-key", key);
      },
    });

    stacksClients.push(client);
  }

  contractLogger.info({
    endpointCount: API_ENDPOINTS.length,
    apiKeyCount: contractConfig.apiKeys.length + (contractConfig.apiKey ? 1 : 0)
  }, 'Initialized Stacks API clients');
};

/**
 * Get the next client with rotation
 */
const getNextClient = (): Client<paths, `${string}/${string}`> => {
  // Initialize clients on first use
  if (stacksClients.length === 0) {
    initClients();
  }

  const client = stacksClients[currentClientIndex]!;
  currentClientIndex = (currentClientIndex + 1) % stacksClients.length;
  return client;
};

/**
 * Helper function to fetch transaction status using client with API key rotation
 */
const getTransactionStatus = async (txid: string): Promise<any> => {
  try {
    const client = getNextClient();

    contractLogger.debug({ txid }, 'Getting transaction status');

    try {
      const response = await client.GET(
        "/extended/v1/tx/{tx_id}",
        { params: { path: { tx_id: txid } } }
      );

      return response.data;
    } catch (error: any) {
      // Handle 404 specially - might just be pending
      if (error.status === 404) {
        return { status: 'not_found' };
      }
      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    contractLogger.error({ txid, error: errorMessage }, 'Error getting transaction status');

    throw new AppError({
      message: `Failed to get transaction status for ${txid}`,
      context: 'prediction-contract-store',
      code: 'TX_STATUS_ERROR',
      originalError: error instanceof Error ? error : new Error(String(error)),
      data: { txid }
    }).log();
  }
};

/**
 * Call a read-only contract function using client with API key rotation
 */
const enhancedReadOnlyCall = async <T = any>(
  contractAddress: string,
  contractName: string,
  functionName: string,
  functionArgs: ClarityValue[] = [],
  senderAddress?: string
): Promise<T> => {
  const retryCount = contractConfig.retryCount;
  const retryDelay = contractConfig.retryDelay;
  let lastError: any;

  for (let attempt = 0; attempt < retryCount; attempt++) {
    try {
      // Get client with API key rotation handled by middleware
      const client = getNextClient();

      contractLogger.debug({
        contractId: `${contractAddress}.${contractName}`,
        function: functionName,
        attempt: attempt + 1
      }, 'Calling read-only function');

      // Convert function arguments to hex strings for API
      const args = functionArgs.map(arg => cvToHex(arg));

      // Make the contract call via API client
      const response = await client.POST(
        `/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}` as any,
        {
          body: {
            sender: senderAddress || contractAddress,
            arguments: args
          }
        }
      );

      if (!response?.data?.result) {
        throw new Error(`No result from contract call ${functionName}`);
      }

      // Convert the hex result back to a JS object
      const result = cvToValue(hexToCV(response.data.result)) as T;
      return result

    } catch (error) {
      lastError = error;

      const errorMessage = error instanceof Error ? error.message : String(error);

      contractLogger.warn({
        contractId: `${contractAddress}.${contractName}`,
        function: functionName,
        attempt: attempt + 1,
        maxAttempts: retryCount,
        error: errorMessage
      }, 'Read-only function call failed, retrying');

      // Last attempt failed, wait before retrying with exponential backoff
      if (attempt < retryCount - 1) {
        await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
      }
    }
  }

  // All attempts failed
  const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
  contractLogger.error({
    contractId: `${contractAddress}.${contractName}`,
    function: functionName,
    attempts: retryCount,
    error: errorMessage
  }, 'All read-only function call attempts failed');

  throw new AppError({
    message: `Failed to call read-only function ${functionName} after ${retryCount} attempts`,
    context: 'prediction-contract-store',
    code: 'READ_ONLY_CALL_FAILED',
    originalError: lastError instanceof Error ? lastError : new Error(errorMessage),
    data: { contractAddress, contractName, functionName }
  }).log();
};

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
   * Utility functions for managing the metadata cache
   */
  cache: {
    /**
     * Clear all metadata caches
     */
    clearAll(): void {
      metadataCache.marketInfo.clear();
      metadataCache.receiptInfo.clear();
      metadataCache.rewardQuote.clear();
      metadataCache.receiptOwner.clear();
      contractLogger.info({ message: 'Cleared all metadata caches' });
    },

    /**
     * Clear market info cache for a specific market
     * @param marketId The ID of the market to clear from cache
     */
    clearMarketInfo(marketId: string): void {
      metadataCache.marketInfo.delete(marketId);
      contractLogger.debug({ marketId }, 'Cleared market info from cache');
    },

    /**
     * Clear receipt info cache for a specific receipt
     * @param receiptId The ID of the receipt to clear from cache
     */
    clearReceiptInfo(receiptId: number): void {
      metadataCache.receiptInfo.delete(receiptId);
      metadataCache.receiptOwner.delete(receiptId);
      metadataCache.rewardQuote.delete(receiptId);
      contractLogger.debug({ receiptId }, 'Cleared receipt data from cache');
    },

    /**
     * Get cache statistics
     * @returns Object with cache counts
     */
    getStats(): {
      marketInfoCount: number;
      receiptInfoCount: number;
      rewardQuoteCount: number;
      receiptOwnerCount: number;
      cacheExpirationMs: number;
    } {
      return {
        marketInfoCount: metadataCache.marketInfo.size,
        receiptInfoCount: metadataCache.receiptInfo.size,
        rewardQuoteCount: metadataCache.rewardQuote.size,
        receiptOwnerCount: metadataCache.receiptOwner.size,
        cacheExpirationMs: CACHE_EXPIRATION
      };
    }
  },
  /**
   * Check if a receipt ID exists on the blockchain by checking if it has an owner
   * @param receiptId The ID of the receipt to check
   * @param skipCache Whether to skip the cache and force a fresh lookup
   * @returns True if the receipt exists and has an owner, false otherwise
   */
  async doesReceiptExist(receiptId: number, skipCache: boolean = false): Promise<boolean> {
    try {
      // We can leverage the getReceiptOwner method which is already cache-aware
      const owner = await this.getReceiptOwner(receiptId, skipCache);
      return owner !== null;
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
   * @param skipCache Whether to skip the cache and force a fresh lookup
   * @returns The principal address of the owner, or null if not found or error
   */
  async getReceiptOwner(receiptId: number, skipCache: boolean = false): Promise<string | null> {
    try {
      // Check cache first if not skipping cache
      if (!skipCache) {
        const cached = metadataCache.receiptOwner.get(receiptId);
        if (cached && isCacheValid(cached.timestamp)) {
          contractLogger.debug({ receiptId, fromCache: true }, 'Got receipt owner from cache');
          return cached.data;
        }
      }

      contractLogger.debug({ receiptId }, 'Getting receipt owner from chain');

      const result = await enhancedReadOnlyCall(
        contractConfig.contractAddress,
        contractConfig.contractName,
        'get-owner',
        [uintCV(receiptId)]
      );

      // If we get a successful response with an owner, return the owner
      let owner: string | null = null;
      if (result && result.value && result.value.type !== 'none') {
        owner = result.value.value;
        contractLogger.debug({ receiptId, owner }, 'Found receipt owner');
      } else {
        contractLogger.debug({ receiptId }, 'No owner found for receipt');
      }

      // Update cache with the result
      metadataCache.receiptOwner.set(receiptId, {
        data: owner,
        timestamp: Date.now()
      });

      return owner;
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
   * @param skipCache Whether to skip the cache and force a fresh lookup
   * @returns Market information or null if not found or error
   */
  async getMarketInfo(marketId: string, skipCache: boolean = false): Promise<PredictionMarketInfo | null> {
    try {
      // Check cache first if not skipping cache
      if (!skipCache) {
        const cached = metadataCache.marketInfo.get(marketId);
        if (cached && isCacheValid(cached.timestamp)) {
          contractLogger.debug({ marketId, fromCache: true }, 'Got market info from cache');
          return cached.data;
        }
      }

      contractLogger.debug({ marketId }, 'Getting market info from chain');

      const result = await enhancedReadOnlyCall(
        contractConfig.contractAddress,
        contractConfig.contractName,
        'get-market-info',
        [stringAsciiCV(marketId)]
      );

      // If we get a successful response, parse the market info
      let marketInfo: PredictionMarketInfo | null = null;
      if (result) {
        marketInfo = {
          creator: result.value.creator.value,
          name: result.value.name.value,
          description: result.value.description.value,
          'outcome-names': result.value['outcome-names'].value,
          'outcome-pools': result.value['outcome-pools'].value,
          'total-pool': Number(result.value['total-pool'].value),
          'is-open': result.value['is-open'].value,
          'is-resolved': result.value['is-resolved'].value,
          'winning-outcome': Number(result.value['winning-outcome'].value),
          resolver: result.value.resolver.value,
          'creation-time': result.value['creation-time'].value,
          'resolution-time': result.value['resolution-time'].value
        } as PredictionMarketInfo;

        contractLogger.debug({
          marketId,
          name: marketInfo.name,
          isResolved: marketInfo['is-resolved']
        }, 'Found market info');
      } else {
        contractLogger.debug({ marketId }, 'Market not found on chain');
      }

      // Update cache with the result
      metadataCache.marketInfo.set(marketId, {
        data: marketInfo,
        timestamp: Date.now()
      });

      return marketInfo;
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
   * @param skipCache Whether to skip the cache and force a fresh lookup
   * @returns Receipt information or null if not found or error
   */
  async getReceiptInfo(receiptId: number, skipCache: boolean = false): Promise<PredictionReceiptInfo | null> {
    try {
      // Check cache first if not skipping cache
      if (!skipCache) {
        const cached = metadataCache.receiptInfo.get(receiptId);
        if (cached && isCacheValid(cached.timestamp)) {
          contractLogger.debug({ receiptId, fromCache: true }, 'Got receipt info from cache');
          return cached.data;
        }
      }

      contractLogger.debug({ receiptId }, 'Getting receipt info from chain');

      const result = await enhancedReadOnlyCall(
        contractConfig.contractAddress,
        contractConfig.contractName,
        'get-receipt-info',
        [uintCV(receiptId)]
      );

      // If we get a successful response, parse the receipt info
      let receiptInfo: PredictionReceiptInfo | null = null;
      if (result.success) {
        receiptInfo = {
          'market-id': result.value['market-id'].value,
          'outcome-id': result.value['outcome-id'].value,
          amount: result.value.amount.value,
          predictor: result.value.predictor.value
        } as PredictionReceiptInfo;

        contractLogger.debug({
          receiptId,
          marketId: receiptInfo['market-id'],
          outcomeId: receiptInfo['outcome-id'],
          predictor: receiptInfo.predictor
        }, 'Found receipt info');
      } else {
        contractLogger.debug({ receiptId }, 'Receipt not found on chain');
      }

      // Update cache with the result
      metadataCache.receiptInfo.set(receiptId, {
        data: receiptInfo,
        timestamp: Date.now()
      });

      return receiptInfo;
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
   * @param skipCache Whether to skip the cache and force a fresh lookup
   * @returns Object with reward info or null if not found or error
   */
  async getRewardQuote(receiptId: number, skipCache: boolean = false): Promise<PredictionRewardQuote | null> {
    try {
      // Check cache first if not skipping cache
      if (!skipCache) {
        const cached = metadataCache.rewardQuote.get(receiptId);
        if (cached && isCacheValid(cached.timestamp)) {
          contractLogger.debug({ receiptId, fromCache: true }, 'Got reward quote from cache');
          return cached.data;
        }
      }

      contractLogger.debug({ receiptId }, 'Getting reward quote from chain');

      const result = await enhancedReadOnlyCall(
        contractConfig.contractAddress,
        contractConfig.contractName,
        'quote-reward',
        [uintCV(receiptId)]
      );

      // If we get a successful response, parse the reward quote
      let quote: PredictionRewardQuote | null = null;
      if (result) {
        quote = {
          dx: result.value.dx.value,
          dy: Number(result.value.dy.value),
          dk: Number(result.value.dk.value)
        } as PredictionRewardQuote;

        contractLogger.debug({
          receiptId,
          marketId: quote.dx,
          reward: quote.dy
        }, 'Got reward quote');
      } else {
        contractLogger.debug({ receiptId }, 'Failed to get reward quote');
      }

      // Update cache with the result
      metadataCache.rewardQuote.set(receiptId, {
        data: quote,
        timestamp: Date.now()
      });

      return quote;
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
   * @param skipCache Whether to skip the cache and force a fresh lookup
   * @returns Boolean indicating if the prediction is a winner (with reward > 0)
   */
  async isPredictionWinner(receiptId: number, skipCache: boolean = false): Promise<boolean> {
    try {
      // Get the reward quote to see if there's a payout
      const quote = await this.getRewardQuote(receiptId, skipCache);

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
   * @param skipCache Whether to skip the cache and force a fresh lookup
   * @returns 'unresolved' | 'won' | 'lost' | 'redeemed' | null (if error or not found)
   */
  async getPredictionStatus(receiptId: number, skipCache: boolean = false): Promise<'unresolved' | 'won' | 'lost' | 'redeemed' | null> {
    try {
      contractLogger.debug({ receiptId, skipCache }, 'Determining prediction status from chain');

      // First check if the receipt exists (has an owner)
      const owner = await this.getReceiptOwner(receiptId, skipCache);

      // If no owner, it's been redeemed (NFT burned) or doesn't exist
      if (!owner) {
        // Get receipt info to check if it's just not found or was redeemed
        const receiptInfo = await this.getReceiptInfo(receiptId, skipCache);

        if (receiptInfo) {
          contractLogger.debug({ receiptId }, 'Prediction has been redeemed (NFT burned)');
          return 'redeemed';
        } else {
          contractLogger.debug({ receiptId }, 'Prediction not found on chain');
          return null;
        }
      }

      // If we have an owner, get the receipt info
      const receiptInfo = await this.getReceiptInfo(receiptId, skipCache);
      if (!receiptInfo) {
        contractLogger.debug({ receiptId }, 'Receipt info not found even though owner exists');
        return null;
      }

      // Get the market info to check if it's resolved
      const marketInfo = await this.getMarketInfo(receiptInfo['market-id'], skipCache);
      if (!marketInfo) {
        contractLogger.debug({ receiptId, marketId: receiptInfo['market-id'] }, 'Market not found');
        return null;
      }

      // If market isn't resolved, prediction is unresolved
      if (!marketInfo['is-resolved']) {
        contractLogger.debug({ receiptId, marketId: receiptInfo['market-id'] }, 'Market not resolved, prediction is unresolved');
        return 'unresolved';
      }

      // Market is resolved, check if prediction is a winner
      const isWinner = await this.isPredictionWinner(receiptId, skipCache);

      if (isWinner) {
        return 'won';
      } else {
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
   * @param skipCache Whether to skip the cache and force a fresh lookup for all predictions
   * @returns Object containing arrays of 'won' and 'lost' IDs
   */
  async getStatusUpdatesForPendingPredictions(
    pendingIds: number[],
    skipCache: boolean = false
  ): Promise<{
    won: number[];
    lost: number[];
    errors: number[];
  }> {
    try {
      contractLogger.info({
        pendingCount: pendingIds.length,
        skipCache
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
            // Use cached data by default for performance if not explicitly skipping cache
            const status = await this.getPredictionStatus(receiptId, skipCache);
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
        errorCount: results.errors.length,
        cacheUsed: !skipCache
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
        data: { pendingCount: pendingIds.length, skipCache }
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

      // Prepare contract call options
      const contractCallOptions = {
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
        fee: 500
      };

      // Create the transaction
      const transaction = await makeContractCall(contractCallOptions);

      // Broadcast the transaction with fee adjustment if needed
      const result: any = await broadcastWithFeeAdjustment(
        transaction,
        contractCallOptions,
        { marketId, name }
      );

      // Extra validation to catch any errors that might have been missed
      if (!isBroadcastSuccessful(result)) {
        throw new AppError({
          message: `Failed to broadcast market creation transaction: ${result.error || result.reason || 'Unknown error'}`,
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { result }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        marketId,
        name
      }, 'Successfully submitted market creation transaction');

      // Clear the cache for this market ID if it exists
      this.cache.clearMarketInfo(marketId);

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

      // Prepare contract call options
      const contractCallOptions = {
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
        fee: 500
      };

      // Create the transaction
      const transaction = await makeContractCall(contractCallOptions);

      // Broadcast the transaction with fee adjustment if needed
      const result: any = await broadcastWithFeeAdjustment(
        transaction,
        contractCallOptions,
        { marketId, operation: 'closeMarket' }
      );

      // Extra validation to catch any errors that might have been missed
      if (!isBroadcastSuccessful(result)) {
        throw new AppError({
          message: `Failed to broadcast market close transaction: ${result.error || result.reason || 'Unknown error'}`,
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { result }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        marketId
      }, 'Successfully submitted market close transaction');

      // Clear the cache for this market ID
      this.cache.clearMarketInfo(marketId);

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

      // Prepare contract call options
      const contractCallOptions = {
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
        fee: 500
      };

      // Create the transaction
      const transaction = await makeContractCall(contractCallOptions);

      // Broadcast the transaction with fee adjustment if needed
      const result: any = await broadcastWithFeeAdjustment(
        transaction,
        contractCallOptions,
        { marketId, winningOutcomeId, operation: 'resolveMarket' }
      );

      // Extra validation to catch any errors that might have been missed
      if (!isBroadcastSuccessful(result)) {
        throw new AppError({
          message: `Failed to broadcast market resolution transaction: ${result.error || result.reason || 'Unknown error'}`,
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { result }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        marketId,
        winningOutcomeId
      }, 'Successfully submitted market resolution transaction');

      // Clear the cache for this market ID since its state has changed
      this.cache.clearMarketInfo(marketId);

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

      // Prepare contract call options
      const contractCallOptions = {
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
        fee: 500
      };

      // Create the transaction
      const transaction = await makeContractCall(contractCallOptions);

      // Broadcast the transaction with fee adjustment if needed
      const result: any = await broadcastWithFeeAdjustment(
        transaction,
        contractCallOptions,
        { marketId, outcomeId, amount, operation: 'makePrediction' }
      );

      // Extra validation to catch any errors that might have been missed
      if (!isBroadcastSuccessful(result)) {
        throw new AppError({
          message: `Failed to broadcast prediction transaction: ${result.error || result.reason || 'Unknown error'}`,
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { result }
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
          dy: Number(amount),
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

      // Prepare contract call options
      const contractCallOptions = {
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
        fee: 500
      };

      // Create the transaction
      const transaction = await makeContractCall(contractCallOptions);

      // Broadcast the transaction with fee adjustment if needed
      const result: any = await broadcastWithFeeAdjustment(
        transaction,
        contractCallOptions,
        { marketId, outcomeId, amount, nonce: signet.nonce, operation: 'signedPredict' }
      );

      // Extra validation to catch any errors that might have been missed
      if (!isBroadcastSuccessful(result)) {
        throw new AppError({
          message: `Failed to broadcast signed prediction transaction: ${result.error || result.reason || 'Unknown error'}`,
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { result }
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
          dy: Number(amount),
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

      // Prepare contract call options
      const contractCallOptions = {
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
        fee: 500
      };

      // Create the transaction
      const transaction = await makeContractCall(contractCallOptions);

      // Broadcast the transaction with fee adjustment if needed
      const result: any = await broadcastWithFeeAdjustment(
        transaction,
        contractCallOptions,
        { receiptId, operation: 'claimReward' }
      );

      // Extra validation to catch any errors that might have been missed
      if (!isBroadcastSuccessful(result)) {
        throw new AppError({
          message: `Failed to broadcast claim reward transaction: ${result.error || result.reason || 'Unknown error'}`,
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { result }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        receiptId
      }, 'Successfully submitted claim reward transaction');

      // Clear the cache for this receipt ID since its state has changed
      this.cache.clearReceiptInfo(receiptId);

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

      // Prepare contract call options
      const contractCallOptions = {
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
        fee: 500
      };

      // Create the transaction
      const transaction = await makeContractCall(contractCallOptions);

      // Broadcast the transaction with fee adjustment if needed
      const result: any = await broadcastWithFeeAdjustment(
        transaction,
        contractCallOptions,
        { receiptId, nonce: signet.nonce, operation: 'signedClaimReward' }
      );

      // Extra validation to catch any errors that might have been missed
      if (!isBroadcastSuccessful(result)) {
        throw new AppError({
          message: `Failed to broadcast signed claim reward transaction: ${result.error || result.reason || 'Unknown error'}`,
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { result }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        receiptId,
        nonce: signet.nonce
      }, 'Successfully submitted signed claim reward transaction');

      // Clear the cache for this receipt ID since its state has changed
      this.cache.clearReceiptInfo(receiptId);

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
            signature: Cl.bufferFromHex(op.signet.signature),
            nonce: uintCV(op.signet.nonce)
          }),
          "market-id": stringAsciiCV(op.marketId),
          "outcome-id": uintCV(op.outcomeId),
          amount: uintCV(op.amount)
        });
      });

      // Prepare contract call options
      const contractCallOptions = {
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
        // Set fee proportional to batch size, with a higher base
        fee: Math.min(100000, 1100 * operations.length)
      };

      // Create the transaction
      const transaction = await makeContractCall(contractCallOptions);

      // Broadcast the transaction with fee adjustment if needed
      const result: any = await broadcastWithFeeAdjustment(
        transaction,
        contractCallOptions,
        { operationCount: operations.length, operation: 'batchPredict' }
      );

      // Extra validation to catch any errors that might have been missed
      if (!isBroadcastSuccessful(result)) {
        throw new AppError({
          message: `Failed to broadcast batch predict transaction: ${result.error || result.reason || 'Unknown error'}`,
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { result }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        operationCount: operations.length
      }, 'Successfully submitted batch predict transaction');

      // Clear market cache for all markets in the batch
      // We use a Set to remove duplicates in case multiple predictions are for the same market
      const uniqueMarketIds = new Set(operations.map(op => op.marketId));
      uniqueMarketIds.forEach(marketId => {
        this.cache.clearMarketInfo(marketId);
      });

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
   * @param waitForStatus Whether to wait for transaction status to be confirmed
   * @returns Result of the batch operation
   */
  async batchClaimReward(
    operations: BatchClaimOperation[],
    senderKey?: string,
    waitForStatus: boolean = false
  ): Promise<{
    success: boolean;
    results?: boolean[];
    txid?: string;
    error?: string;
    status?: string;
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

      // Prepare contract call options
      const contractCallOptions = {
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
        // Set fee proportional to batch size, with a higher base
        fee: Math.min(100000, 110 * operations.length)
      };

      // Create the transaction
      const transaction = await makeContractCall(contractCallOptions);

      // Broadcast the transaction with fee adjustment if needed
      const result: any = await broadcastWithFeeAdjustment(
        transaction,
        contractCallOptions,
        { operationCount: operations.length, operation: 'batchClaimReward' }
      );

      // Extra validation to catch any errors that might have been missed
      if (!isBroadcastSuccessful(result)) {
        throw new AppError({
          message: `Failed to broadcast batch claim reward transaction: ${result.error || result.reason || 'Unknown error'}`,
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { result }
        }).log();
      }

      contractLogger.info({
        txid: result.txid,
        operationCount: operations.length
      }, 'Successfully submitted batch claim reward transaction');

      // Clear cache for all receipt IDs in the batch
      operations.forEach(op => {
        this.cache.clearReceiptInfo(op.receiptId);
      });

      // If we want to wait for status, check the transaction with API keys
      if (waitForStatus) {
        try {
          // Wait for the transaction to be confirmed - with a timeout
          const txStatus = await getTransactionStatus(result.txid);

          return {
            success: true,
            txid: result.txid,
            status: txStatus.tx_status || txStatus.status,
            results: Array(operations.length).fill(true)
          };
        } catch (error) {
          // Transaction was broadcast but we couldn't get status
          // This is not a failure, just return the txid
          contractLogger.warn({
            txid: result.txid,
            error: error instanceof Error ? error.message : String(error)
          }, 'Transaction submitted but status check failed');

          return {
            success: true,
            txid: result.txid,
            results: Array(operations.length).fill(true),
            status: 'unknown'
          };
        }
      }

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

      // Prepare contract call options
      const contractCallOptions = {
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'add-admin',
        functionArgs: [Cl.principal(adminAddress)],
        senderKey: key,
        validateWithAbi: true,
        network: contractConfig.network,
        postConditionMode: PostConditionMode.Allow,
        fee: 500 // Starting with higher default fee
      };

      // Create the transaction
      const transaction = await makeContractCall(contractCallOptions);

      // Broadcast the transaction with fee adjustment if needed
      const result: any = await broadcastWithFeeAdjustment(
        transaction,
        contractCallOptions,
        { adminAddress, operation: 'addAdmin' }
      );

      // Extra validation to catch any errors that might have been missed
      if (!isBroadcastSuccessful(result)) {
        throw new AppError({
          message: `Failed to broadcast add admin transaction: ${result.error || result.reason || 'Unknown error'}`,
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { result }
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

      // Prepare contract call options
      const contractCallOptions = {
        contractAddress: contractConfig.contractAddress,
        contractName: contractConfig.contractName,
        functionName: 'remove-admin',
        functionArgs: [Cl.address(adminAddress)],
        senderKey: key,
        validateWithAbi: true,
        network: contractConfig.network,
        postConditionMode: PostConditionMode.Allow,
        fee: 500 // Starting with higher default fee
      };

      // Create the transaction
      const transaction = await makeContractCall(contractCallOptions);

      // Broadcast the transaction with fee adjustment if needed
      const result: any = await broadcastWithFeeAdjustment(
        transaction,
        contractCallOptions,
        { adminAddress, operation: 'removeAdmin' }
      );

      // Extra validation to catch any errors that might have been missed
      if (!isBroadcastSuccessful(result)) {
        throw new AppError({
          message: `Failed to broadcast remove admin transaction: ${result.error || result.reason || 'Unknown error'}`,
          context: 'prediction-contract-store',
          code: 'BROADCAST_ERROR',
          data: { result }
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