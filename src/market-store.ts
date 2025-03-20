import * as kvStore from './kv-store';
import {
  generateUUID,
  MarketQueryOptions,
  filterMarkets,
  sortMarkets,
  paginateResults,
  PaginatedResult
} from './utils';
import { AppError, logger } from './logger';
import {
  makeContractCall,
  broadcastTransaction,
  stringAsciiCV,
  listCV,
  PostConditionMode,
  TxBroadcastResult
} from "@stacks/transactions";
import { STACKS_MAINNET } from '@stacks/network';
import { predictionContractStore, PredictionMarketInfo } from './prediction-contract-store';

// Create a logger instance for this module
const marketLogger = logger.child({ context: 'market-store' });

// On-chain market creation configuration
const onChainConfig = {
  enabled: process.env.ENABLE_ONCHAIN_MARKETS === 'true',
  privateKey: process.env.MARKET_CREATOR_PRIVATE_KEY || '',
  network: STACKS_MAINNET,
  contractAddress: process.env.PREDICTION_CONTRACT_ADDRESS || 'SP2ZNGJ85ENDY6QRHQ5P2D4FXKGZWCKTB2T0Z55KS',
  contractName: process.env.PREDICTION_CONTRACT_NAME || 'blaze-welsh-predictions-v1',
};

// Auto close configuration
const autoCloseConfig = {
  enabled: process.env.ENABLE_AUTO_CLOSE_MARKETS !== 'false', // Enabled by default
  batchSize: Number(process.env.AUTO_CLOSE_BATCH_SIZE || '50'),
  closeOnChain: process.env.AUTO_CLOSE_ON_CHAIN === 'true',
};

export interface Market {
  id: string;
  type: 'binary' | 'multiple';
  name: string;
  description: string;
  outcomes: { id: number; name: string; votes?: number; amount?: number }[];
  createdBy: string;
  category: string;
  endDate: string;
  imageUrl?: string;
  createdAt: string;
  participants: number;
  poolAmount: number;
  status: string;
  resolvedOutcomeId?: number;
  resolvedAt?: string;
  resolvedBy?: string;
  adminFee?: number;
  remainingPot?: number;
  totalWinningAmount?: number;
}

// Market store with Vercel KV
// Interface for blockchain verification result
export interface MarketSyncResult {
  marketId: string;
  name: string;
  status: 'already_synced' | 'updated' | 'error';
  onChainData?: {
    'is-open': boolean;
    'is-resolved': boolean;
    'winning-outcome'?: number;
  };
  localData?: {
    status: string;
    resolvedOutcomeId?: number;
  };
  error?: string;
}

export const marketStore = {
  // Get all markets
  async getMarkets(options?: MarketQueryOptions): Promise<PaginatedResult<Market>> {
    let marketIds: string[] = [];

    // Use indexes when possible for more efficient retrieval
    if (options?.category) {
      // Get markets by category
      marketIds = await kvStore.getSetMembers('MARKET_CATEGORY', options.category);
    } else if (options?.status && options.status !== 'all') {
      // Get markets by status
      marketIds = await kvStore.getSetMembers('MARKET_STATUS', options.status);
    } else {
      // Get all market IDs
      marketIds = await kvStore.getSetMembers('MARKET_IDS', '');
    }

    // If no markets found, return empty result
    if (marketIds.length === 0) {
      return {
        items: [],
        total: 0,
        hasMore: false
      };
    }

    // Get markets in parallel - limit the number if options are provided to avoid loading everything
    const limit = options?.limit || 100;
    const offset = options?.offset || (options?.cursor ? parseInt(options.cursor, 10) : 0);

    // Apply sorting before fetching if we know the sort field is createdAt
    // This allows us to fetch only what we need
    let idsToFetch = marketIds;
    if (options?.sortBy === 'createdAt') {
      // We'll sort markets after fetching them
      // For now, just take the slice we need based on offset/limit
      idsToFetch = marketIds.slice(offset, offset + limit * 2); // Fetch extra items for filtering
    }

    // Get markets in parallel
    const markets = await Promise.all(
      idsToFetch.map(id => this.getMarket(id))
    );

    // Filter out any undefined markets (in case of data inconsistency)
    const validMarkets = markets.filter(Boolean) as Market[];

    if (validMarkets.length < idsToFetch.length) {
      marketLogger.warn(
        { expected: idsToFetch.length, found: validMarkets.length },
        'Some markets could not be retrieved'
      );
    }

    // Apply filtering, sorting, and pagination
    let filteredMarkets = validMarkets;

    // Apply filtering if options are provided
    if (options) {
      // Skip category and status filtering if we already used indexes
      const filterOpts = {
        ...options,
        category: options.category && idsToFetch === marketIds ? options.category : undefined,
        status: options.status && idsToFetch === marketIds ? options.status : undefined
      };
      console.log(filterOpts)

      filteredMarkets = filterMarkets(validMarkets, filterOpts);

      // Apply sorting
      const sortedMarkets = sortMarkets(
        filteredMarkets,
        options.sortBy || 'createdAt',
        options.sortDirection || 'desc'
      );

      // Apply pagination
      return paginateResults(sortedMarkets, {
        limit: options.limit,
        offset: options.offset || (options.cursor ? parseInt(options.cursor, 10) : 0)
      });
    }

    // Return all markets if no options provided
    return {
      items: validMarkets,
      total: validMarkets.length,
      hasMore: false
    };
  },

  // Get a specific market by ID and verify its state with blockchain
  async getMarket(id: string, options?: { verifyWithBlockchain?: boolean }) {
    try {
      const market = await kvStore.getEntity('MARKET', id) as Market;

      // Return undefined if market not found in KV store
      if (!market) {
        return undefined;
      }

      // If verification with blockchain is requested, check on-chain state
      if (options?.verifyWithBlockchain) {
        try {
          // Get the on-chain market information
          const onChainMarket = await this.getMarketInfo(id);

          // If market exists on-chain, verify and potentially update its state
          if (onChainMarket) {
            // Extract the blockchain state
            const isOpenOnChain = onChainMarket['is-open'];
            const isResolvedOnChain = (onChainMarket['is-resolved']);
            const winningOutcomeOnChain = Number(onChainMarket['winning-outcome']);

            // Create a copy of the market to update without modifying the original
            const verifiedMarket = { ...market };

            // Update status based on blockchain state
            if (isResolvedOnChain && market.status !== 'resolved') {
              marketLogger.info({
                marketId: id,
                localStatus: market.status,
                blockchainStatus: 'resolved'
              }, 'Local market status differs from blockchain state');

              verifiedMarket.status = 'resolved';
              verifiedMarket.resolvedOutcomeId = winningOutcomeOnChain;

              // Only set these if they're not already set
              if (!verifiedMarket.resolvedAt) {
                verifiedMarket.resolvedAt = new Date().toISOString();
              }

              if (!verifiedMarket.resolvedBy) {
                verifiedMarket.resolvedBy = 'blockchain-verification';
              }
            } else if (!isOpenOnChain && !isResolvedOnChain && market.status !== 'closed') {
              marketLogger.info({
                marketId: id,
                localStatus: market.status,
                blockchainStatus: 'closed'
              }, 'Local market status differs from blockchain state');

              verifiedMarket.status = 'closed';
            } else if (isOpenOnChain && !isResolvedOnChain && market.status !== 'active') {
              marketLogger.info({
                marketId: id,
                localStatus: market.status,
                blockchainStatus: 'active'
              }, 'Local market status differs from blockchain state');

              verifiedMarket.status = 'active';
            }

            // If resolved, ensure the winning outcome ID matches
            if (isResolvedOnChain &&
              verifiedMarket.resolvedOutcomeId !== winningOutcomeOnChain) {
              marketLogger.warn({
                marketId: id,
                localOutcome: verifiedMarket.resolvedOutcomeId,
                blockchainOutcome: winningOutcomeOnChain
              }, 'Local winning outcome differs from blockchain state');

              verifiedMarket.resolvedOutcomeId = winningOutcomeOnChain;
            }

            // If the market was updated, save the changes to the KV store
            if (JSON.stringify(market) !== JSON.stringify(verifiedMarket)) {
              marketLogger.info({ marketId: id }, 'Updating market in KV store to match blockchain state');
              await kvStore.storeEntity('MARKET', id, verifiedMarket);
            }

            return verifiedMarket;
          }
        } catch (verificationError) {
          // Log the error but don't fail the market retrieval
          marketLogger.error({
            marketId: id,
            error: verificationError instanceof Error
              ? verificationError.message
              : String(verificationError)
          }, 'Error verifying market with blockchain');
        }
      }

      return market;
    } catch (error) {
      if (error instanceof AppError) {
        // Just rethrow AppErrors
        throw error;
      } else {
        throw new AppError({
          message: `Failed to retrieve market ${id}`,
          context: 'market-store',
          code: 'MARKET_GET_ERROR',
          originalError: error instanceof Error ? error : new Error(String(error)),
          data: { marketId: id }
        }).log();
      }
    }
  },

  /**
   * Get market information directly from the blockchain
   * This calls the prediction contract store to get the on-chain market data
   * @param id Market ID
   * @returns Market information from blockchain or null if not found
   */
  async getMarketInfo(id: string): Promise<PredictionMarketInfo | null> {
    try {
      // Use the prediction contract store to get the market info from the blockchain
      const marketInfo = await predictionContractStore.getMarketInfo(id);
      return marketInfo;
    } catch (error) {
      marketLogger.error(
        { marketId: id, error: error instanceof Error ? error.message : String(error) },
        'Failed to get market info from blockchain'
      );
      return null;
    }
  },

  /**
   * Helper function to create a market on-chain
   * @param marketId Unique ID for the market
   * @param name Name of the market
   * @param description Description of the market
   * @param outcomes List of outcome names
   * @returns Promise resolving to the broadcast transaction result
   */
  async createMarketOnChain(
    marketId: string,
    name: string,
    description: string,
    outcomes: { id: number; name: string; }[]
  ): Promise<TxBroadcastResult | null> {
    try {
      // Skip if on-chain creation is disabled
      if (!onChainConfig.enabled) {
        marketLogger.info({ marketId }, 'On-chain market creation is disabled');
        return null;
      }

      // Validate private key is available
      if (!onChainConfig.privateKey) {
        throw new Error('Private key is required for on-chain market creation');
      }

      // Extract just the outcome names for the contract call
      const outcomeNames = outcomes.map(outcome => outcome.name);

      // Prepare the contract call
      const transaction = await makeContractCall({
        contractAddress: onChainConfig.contractAddress,
        contractName: onChainConfig.contractName,
        functionName: 'create-market',
        functionArgs: [
          stringAsciiCV(marketId),
          stringAsciiCV(name.substring(0, 64)), // Limit to 64 chars for Clarity string-ascii 64
          stringAsciiCV(description.substring(0, 128)), // Limit to 128 chars for Clarity string-ascii 128
          listCV(outcomeNames.map(name => stringAsciiCV(name.substring(0, 32)))) // Limit each name to 32 chars
        ],
        senderKey: onChainConfig.privateKey,
        validateWithAbi: true,
        network: onChainConfig.network,
        postConditionMode: PostConditionMode.Allow,
        fee: 1000, // Set appropriate fee
      });

      // Broadcast the transaction
      const result = await broadcastTransaction({ transaction });

      marketLogger.info({
        marketId,
        txId: result.txid || 'unknown',
        successful: !!result.txid
      }, 'On-chain market creation transaction broadcast');

      return result;
    } catch (error) {
      marketLogger.error({
        marketId,
        error: error instanceof Error ? error.message : String(error)
      }, 'Failed to create market on-chain');

      // We don't throw here - just log the error and return null
      // This is to prevent the entire market creation from failing if on-chain creation fails
      return null;
    }
  },

  // Create a new market
  async createMarket(
    data: {
      type: 'binary' | 'multiple';
      name: string;
      description: string;
      outcomes: { id: number; name: string; }[];
      createdBy: string;
      category: string;
      endDate: string;
      imageUrl?: string;
    }
  ) {
    try {
      // Validate required fields
      if (!data.name || !data.description || !data.outcomes || data.outcomes.length === 0) {
        throw new AppError({
          message: 'Missing required market data',
          context: 'market-store',
          code: 'MARKET_VALIDATION_ERROR',
          data: {
            hasName: !!data.name,
            hasDescription: !!data.description,
            outcomeCount: data.outcomes?.length || 0
          }
        }).log();
      }

      // Start a transaction for atomic operation
      const tx = await kvStore.startTransaction();
      const id = generateUUID();
      const now = new Date().toISOString();

      const market = {
        id,
        type: data.type,
        name: data.name,
        description: data.description,
        outcomes: data.outcomes,
        createdBy: data.createdBy,
        category: data.category,
        endDate: data.endDate,
        imageUrl: data.imageUrl,
        createdAt: now,
        participants: 0,
        poolAmount: 0,
        status: 'active'
      };

      // Store market by ID
      await tx.addEntity('MARKET', id, market);

      // Add to market_ids set
      await tx.addToSetInTransaction('MARKET_IDS', '', id);

      // Add to user's markets set
      if (data.createdBy) {
        await tx.addToSetInTransaction('USER_MARKETS', data.createdBy, id);
      }

      // Add to category index
      if (data.category) {
        await tx.addToSetInTransaction('MARKET_CATEGORY', data.category, id);
      }

      // Add to status index
      await tx.addToSetInTransaction('MARKET_STATUS', 'active', id);

      // Execute the transaction
      const success = await tx.execute();

      if (!success) {
        throw new AppError({
          message: 'Failed to create market - transaction failed',
          context: 'market-store',
          code: 'MARKET_CREATE_TRANSACTION_ERROR',
          data: { marketId: id }
        }).log();
      }

      // Create the market on-chain asynchronously
      // We don't await this call to prevent blocking the main flow
      this.createMarketOnChain(id, data.name, data.description, data.outcomes)
        .then(result => {
          if (result?.txid) {
            marketLogger.info({
              marketId: id,
              txId: result.txid
            }, 'Market created on-chain successfully');
          }
        })
        .catch(error => {
          marketLogger.error({
            marketId: id,
            error: error instanceof Error ? error.message : String(error)
          }, 'Error in on-chain market creation');
        });

      marketLogger.info({ marketId: id }, `Created new market: ${market.name}`);
      return market;
    } catch (error) {
      if (error instanceof AppError) {
        // Just rethrow AppErrors
        throw error;
      } else {
        throw new AppError({
          message: 'Failed to create market',
          context: 'market-store',
          code: 'MARKET_CREATE_ERROR',
          originalError: error instanceof Error ? error : new Error(String(error)),
          data: { marketName: data.name }
        }).log();
      }
    }
  },

  /**
   * Resolve a market on-chain with the winning outcome
   * @param marketId Unique ID for the market
   * @param winningOutcomeId The ID of the winning outcome
   * @returns Promise resolving to the broadcast transaction result
   */
  async resolveMarketOnChain(
    marketId: string,
    winningOutcomeId: number
  ): Promise<TxBroadcastResult | null> {
    try {
      // Skip if on-chain market interaction is disabled
      if (!onChainConfig.enabled) {
        marketLogger.info({ marketId }, 'On-chain market resolution is disabled');
        return null;
      }

      // Validate private key is available
      if (!onChainConfig.privateKey) {
        throw new Error('Private key is required for on-chain market resolution');
      }

      // Import the needed CV constructor only when needed
      const { uintCV } = await import('@stacks/transactions');

      // Prepare the contract call
      const transaction = await makeContractCall({
        contractAddress: onChainConfig.contractAddress,
        contractName: onChainConfig.contractName,
        functionName: 'resolve-market',
        functionArgs: [
          stringAsciiCV(marketId),
          uintCV(winningOutcomeId)
        ],
        senderKey: onChainConfig.privateKey,
        validateWithAbi: true,
        network: onChainConfig.network,
        postConditionMode: PostConditionMode.Allow,
        fee: 1000, // Set appropriate fee
      });

      // Broadcast the transaction
      const result = await broadcastTransaction({ transaction });

      marketLogger.info({
        marketId,
        txId: result.txid || 'unknown',
        successful: !!result?.txid
      }, 'On-chain market resolution transaction broadcast');

      return result;
    } catch (error) {
      marketLogger.error({
        marketId,
        error: error instanceof Error ? error.message : String(error)
      }, 'Failed to resolve market on-chain');

      // We don't throw here - just log the error and return null
      return null;
    }
  },

  // Update a market
  async updateMarket(id: string, marketData: any) {
    try {
      const market: any = await this.getMarket(id);
      if (!market) {
        marketLogger.warn({ marketId: id }, `Cannot update non-existent market with ID ${id}`);
        return undefined;
      }

      // Ensure we don't change critical fields like ID
      const safeData = { ...marketData };
      if (safeData.id && safeData.id !== id) {
        delete safeData.id;
        marketLogger.warn(
          { marketId: id, attemptedId: marketData.id },
          'Attempted to change market ID during update - ignoring'
        );
      }

      const updatedMarket = { ...market, ...safeData };

      // Start a transaction for atomic update
      const tx = await kvStore.startTransaction();

      // Store the updated market
      await tx.addEntity('MARKET', id, updatedMarket);

      // Update category index if category changed
      if (marketData.category && marketData.category !== market.category) {
        // Remove from old category
        await kvStore.removeFromSet('MARKET_CATEGORY', market.category, id);

        // Add to new category
        await tx.addToSetInTransaction('MARKET_CATEGORY', marketData.category, id);
      }

      // Update status index if status changed
      if (marketData.status && marketData.status !== market.status) {
        // Remove from old status
        await kvStore.removeFromSet('MARKET_STATUS', market.status, id);

        // Add to new status
        await tx.addToSetInTransaction('MARKET_STATUS', marketData.status, id);
      }

      // Execute transaction
      await tx.execute();

      // Check if this is a market resolution update (is_resolved changed to true)
      if (marketData.is_resolved === true && marketData.winning_outcome !== undefined &&
        (!market.is_resolved || market.is_resolved === false)) {

        // Asynchronously resolve the market on-chain
        this.resolveMarketOnChain(id, marketData.winning_outcome)
          .then(result => {
            if (result?.txid) {
              marketLogger.info({
                marketId: id,
                txId: result.txid,
                winningOutcome: marketData.winning_outcome
              }, 'Market resolved on-chain successfully');
            }
          })
          .catch(error => {
            marketLogger.error({
              marketId: id,
              error: error instanceof Error ? error.message : String(error)
            }, 'Error in on-chain market resolution');
          });
      }

      marketLogger.debug(
        { marketId: id },
        `Updated market: ${market.name}`
      );

      return updatedMarket;
    } catch (error) {
      if (error instanceof AppError) {
        // Just rethrow AppErrors
        throw error;
      } else {
        throw new AppError({
          message: `Failed to update market ${id}`,
          context: 'market-store',
          code: 'MARKET_UPDATE_ERROR',
          originalError: error instanceof Error ? error : new Error(String(error)),
          data: { marketId: id }
        }).log();
      }
    }
  },

  // Delete a market
  async deleteMarket(id: string): Promise<boolean> {
    try {
      // Get the market to know its category and status
      const market = await this.getMarket(id) as Market | null;
      if (!market) {
        return false;
      }

      // Start a transaction for atomic deletion
      await kvStore.startTransaction();

      // Delete the market
      await kvStore.deleteEntity('MARKET', id);

      // Remove the market ID from the set of all market IDs
      await kvStore.removeFromSet('MARKET_IDS', '', id);

      // Remove from category index
      if (market.category) {
        await kvStore.removeFromSet('MARKET_CATEGORY', market.category, id);
      }

      // Remove from status index
      if (market.status) {
        await kvStore.removeFromSet('MARKET_STATUS', market.status, id);
      }

      // Remove from creator's markets
      if (market.createdBy) {
        await kvStore.removeFromSet('USER_MARKETS', market.createdBy, id);
      }

      return true;
    } catch (error) {
      console.error(`Error deleting market ${id}:`, error);
      return false;
    }
  },

  // Update market stats when a prediction is made
  async updateMarketStats(marketId: string, outcomeId: number, amount: number, userId: string) {
    const market: any = await this.getMarket(marketId);
    if (!market) return undefined;

    // Check if this user has already participated in this market
    const userParticipated = await kvStore.isSetMember('MARKET_PARTICIPANTS', marketId, userId);

    // Update the market stats - only increment participants if it's a new user
    if (!userParticipated) {
      market.participants = (market.participants || 0) + 1;
      // Add user to the set of participants for this market
      await kvStore.addToSet('MARKET_PARTICIPANTS', marketId, userId);
    }

    market.poolAmount = (market.poolAmount || 0) + amount;

    // Update the outcome stats
    const outcome = market.outcomes.find((o: any) => o.id === outcomeId);
    if (outcome) {
      outcome.votes = (outcome.votes || 0) + 1;
      outcome.amount = (outcome.amount || 0) + amount;
    }

    // Save the updated market
    return this.updateMarket(marketId, market);
  },

  // Get related markets based on category and similarity
  async getRelatedMarkets(marketId: string, limit: number = 3) {
    try {
      const market: any = await this.getMarket(marketId);
      if (!market) return [];

      // Get all markets with filtering
      const result = await this.getMarkets({
        status: 'active',
        limit: 50 // Get enough markets to find good related ones
      });

      const allMarkets = result.items;

      // Filter out the current market
      const candidates = allMarkets.filter((m: any) =>
        m.id !== marketId &&
        (
          // Same category
          m.category === market.category ||
          // Or contains similar keywords in name/description
          this.calculateSimilarity(m, market) > 0.3
        )
      );

      // Sort by similarity score
      const sortedMarkets = candidates.sort((a, b) =>
        this.calculateSimilarity(b, market) - this.calculateSimilarity(a, market)
      );

      return sortedMarkets.slice(0, limit);
    } catch (error) {
      console.error('Error getting related markets:', error);
      return [];
    }
  },

  // Get markets by category
  async getMarketsByCategory(category: string, options?: Omit<MarketQueryOptions, 'category'>): Promise<PaginatedResult<Market>> {
    return this.getMarkets({
      ...options,
      category
    });
  },

  // Search markets by text
  async searchMarkets(searchText: string, options?: Omit<MarketQueryOptions, 'search'>): Promise<PaginatedResult<Market>> {
    return this.getMarkets({
      ...options,
      search: searchText
    });
  },

  // Get trending markets (highest participation or pool amount)
  async getTrendingMarkets(limit: number = 10): Promise<Market[]> {
    const result = await this.getMarkets({
      status: 'active',
      sortBy: 'poolAmount',
      sortDirection: 'desc',
      limit
    });

    return result.items;
  },

  // Calculate similarity score between two markets
  calculateSimilarity(market1: any, market2: any): number {
    const text1 = `${market1.name} ${market1.description}`.toLowerCase();
    const text2 = `${market2.name} ${market2.description}`.toLowerCase();

    // Get unique words
    const words1 = new Set(text1.split(/\W+/));
    const words2 = new Set(text2.split(/\W+/));

    // Calculate intersection
    const intersection = new Set(Array.from(words1).filter(x => words2.has(x)));

    // Calculate Jaccard similarity
    const union = new Set(Array.from(words1).concat(Array.from(words2)));
    return intersection.size / union.size;
  },

  // Migration: Build indexes for existing markets
  async buildMarketIndexes(): Promise<{ success: boolean; indexed: number }> {
    try {
      // Get all market IDs
      const marketIds = await kvStore.getSetMembers('MARKET_IDS', '');

      // Get all markets
      const markets = await Promise.all(
        marketIds.map(id => this.getMarket(id))
      );

      // Filter out any undefined markets
      const validMarkets = markets.filter(Boolean) as Market[];

      let indexedCount = 0;

      // Process each market
      for (const market of validMarkets) {
        // Add to category index
        if (market.category) {
          await kvStore.addToSet('MARKET_CATEGORY', market.category, market.id);
        }

        // Add to status index
        if (market.status) {
          await kvStore.addToSet('MARKET_STATUS', market.status, market.id);
        }

        indexedCount++;
      }

      marketLogger.info(
        { total: marketIds.length, indexed: indexedCount },
        'Market indexes built successfully'
      );

      return { success: true, indexed: indexedCount };
    } catch (error) {
      marketLogger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Error building market indexes'
      );
      return { success: false, indexed: 0 };
    }
  },

  /**
   * Close a market on-chain
   * @param marketId Unique ID for the market
   * @returns Promise resolving to the broadcast transaction result
   */
  async closeMarketOnChain(
    marketId: string
  ): Promise<TxBroadcastResult | null> {
    try {
      // Skip if on-chain market interaction is disabled
      if (!onChainConfig.enabled) {
        marketLogger.info({ marketId }, 'On-chain market close is disabled');
        return null;
      }

      // Validate private key is available
      if (!onChainConfig.privateKey) {
        throw new Error('Private key is required for on-chain market close');
      }

      // Prepare the contract call
      const transaction = await makeContractCall({
        contractAddress: onChainConfig.contractAddress,
        contractName: onChainConfig.contractName,
        functionName: 'close-market',
        functionArgs: [
          stringAsciiCV(marketId)
        ],
        senderKey: onChainConfig.privateKey,
        validateWithAbi: true,
        network: onChainConfig.network,
        postConditionMode: PostConditionMode.Allow,
        fee: 1000,
      });

      // Broadcast the transaction
      const result = await broadcastTransaction({ transaction });

      marketLogger.info({
        marketId,
        txId: result.txid || 'unknown',
        successful: !!result.txid
      }, 'On-chain market close transaction broadcast');

      return result;
    } catch (error) {
      marketLogger.error({
        marketId,
        error: error instanceof Error ? error.message : String(error)
      }, 'Failed to close market on-chain');

      // We don't throw here - just log the error and return null
      return null;
    }
  },

  /**
   * Automatically close markets that have passed their end date
   * This function is meant to be called by a cron job
   * @returns Object with stats about markets that were closed
   */
  async autoCloseExpiredMarkets(): Promise<{
    success: boolean;
    processed: number;
    closed: number;
    errors: number;
    onChainSucceeded?: number;
    onChainFailed?: number;
  }> {
    try {
      // Skip if auto-close is disabled
      if (!autoCloseConfig.enabled) {
        return { success: true, processed: 0, closed: 0, errors: 0 };
      }

      // Get active markets
      const activeMarkets = await kvStore.getSetMembers('MARKET_STATUS', 'active');

      // Initialize counters
      let processed = 0;
      let closed = 0;
      let errors = 0;
      let onChainSucceeded = 0;
      let onChainFailed = 0;

      // Current time for comparison
      const now = new Date().toISOString();

      // Process markets in batches
      for (let i = 0; i < activeMarkets.length; i += autoCloseConfig.batchSize) {
        const batch = activeMarkets.slice(i, i + autoCloseConfig.batchSize);

        // Get market data in parallel
        const markets = await Promise.all(
          batch.map(id => this.getMarket(id))
        );

        // Filter for valid markets with expired end dates
        const expiredMarkets = markets
          .filter(Boolean)
          .filter((market: any) => market.endDate < now && market.status === 'active') as Market[];

        // Process each expired market
        for (const market of expiredMarkets) {
          processed++;

          try {
            // Update the market to closed
            await this.updateMarket(market.id, {
              status: 'closed',
              is_open: false
            });

            closed++;

            // Close on-chain if enabled
            if (autoCloseConfig.closeOnChain) {
              const onChainResult = await this.closeMarketOnChain(market.id);

              if (onChainResult?.txid) {
                onChainSucceeded++;

                marketLogger.info({
                  marketId: market.id,
                  txId: onChainResult.txid
                }, 'Market closed on-chain successfully');
              } else {
                onChainFailed++;

                marketLogger.warn({
                  marketId: market.id
                }, 'Failed to close market on-chain');
              }
            }

            marketLogger.info({
              marketId: market.id,
              name: market.name,
              endDate: market.endDate
            }, 'Automatically closed expired market');
          } catch (error) {
            errors++;
            marketLogger.error({
              marketId: market.id,
              error: error instanceof Error ? error.message : String(error)
            }, 'Error closing expired market');
          }
        }
      }

      // Log summary
      marketLogger.info({
        processed,
        closed,
        errors,
        onChainSucceeded,
        onChainFailed
      }, 'Completed auto-close of expired markets');

      return {
        success: true,
        processed,
        closed,
        errors,
        onChainSucceeded,
        onChainFailed
      };
    } catch (error) {
      marketLogger.error({
        error: error instanceof Error ? error.message : String(error)
      }, 'Failed to auto-close expired markets');

      return { success: false, processed: 0, closed: 0, errors: 1 };
    }
  },

  /**
   * Synchronize market statuses with blockchain state
   * This checks all markets against their on-chain state and updates them if they don't match
   * @returns Results of the synchronization operation
   */
  async syncMarketsWithBlockchain(): Promise<{
    success: boolean;
    processed: number;
    updated: number;
    errors: number;
    syncResults: MarketSyncResult[];
  }> {
    try {
      marketLogger.info({}, 'Starting market synchronization with blockchain');

      // Get all markets
      const marketsResult = await this.getMarkets({ limit: 500 });
      const markets = marketsResult.items;

      if (markets.length === 0) {
        return {
          success: true,
          processed: 0,
          updated: 0,
          errors: 0,
          syncResults: []
        };
      }

      // Initialize counters and results
      let processed = 0;
      let updated = 0;
      let errors = 0;
      const syncResults: MarketSyncResult[] = [];

      // Process each market
      for (const market of markets) {
        try {
          processed++;
          marketLogger.debug({ marketId: market.id }, `Checking on-chain state for market ${market.name}`);

          // Get the on-chain market information
          const onChainMarket = await this.getMarketInfo(market.id);

          // Skip if market not found on chain
          if (!onChainMarket) {
            marketLogger.warn({ marketId: market.id }, `Market ${market.name} not found on blockchain`);
            syncResults.push({
              marketId: market.id,
              name: market.name,
              status: 'error',
              error: 'Market not found on blockchain'
            });
            errors++;
            continue;
          }

          // Extract the blockchain state
          const isOpenOnChain = onChainMarket['is-open'];
          const isResolvedOnChain = onChainMarket['is-resolved'];
          const winningOutcomeOnChain = onChainMarket['winning-outcome'];

          // Check if the local state matches the on-chain state
          const isStatusMatch = (
            (market.status === 'active' && isOpenOnChain && !isResolvedOnChain) ||
            (market.status === 'resolved' && isResolvedOnChain) ||
            (market.status === 'closed' && !isOpenOnChain)
          );

          // Check if outcome matches when both are resolved
          // If market is resolved on-chain but has no resolvedOutcomeId in database,
          // we should consider this a mismatch
          const isOutcomeMatch = (
            !isResolvedOnChain ||
            (isResolvedOnChain && market.resolvedOutcomeId !== undefined &&
              market.resolvedOutcomeId === winningOutcomeOnChain)
          );

          // If states match, continue to next market
          if (isStatusMatch && isOutcomeMatch) {
            marketLogger.debug({ marketId: market.id }, `Market ${market.name} is already synced with blockchain`);
            syncResults.push({
              marketId: market.id,
              name: market.name,
              status: 'already_synced',
              onChainData: {
                'is-open': isOpenOnChain,
                'is-resolved': isResolvedOnChain,
                'winning-outcome': winningOutcomeOnChain
              },
              localData: {
                status: market.status,
                resolvedOutcomeId: market.resolvedOutcomeId
              }
            });
            continue;
          }

          // Update the market to match blockchain state
          const updates: any = {};

          // Update status based on on-chain state
          if (!isStatusMatch) {
            if (isResolvedOnChain) {
              updates.status = 'resolved';
              updates.resolvedAt = new Date().toISOString();

              // If we're changing to resolved status, we should set resolvedBy to indicate this was done by the system
              if (!market.resolvedBy) {
                updates.resolvedBy = 'blockchain-sync';
              }
            } else if (!isOpenOnChain) {
              updates.status = 'closed';
            } else {
              updates.status = 'active';
            }
          }

          // Update resolved outcome if needed
          // This handles both the case where resolvedOutcomeId doesn't match winningOutcomeOnChain
          // and the case where resolvedOutcomeId is undefined but the market is resolved on-chain
          if (isResolvedOnChain &&
            (market.resolvedOutcomeId === undefined || market.resolvedOutcomeId !== winningOutcomeOnChain)) {
            updates.resolvedOutcomeId = winningOutcomeOnChain;

            // If we're adding a resolved outcome ID, also ensure resolved status and timestamps are set
            if (!updates.status) {
              updates.status = 'resolved';
            }

            if (!updates.resolvedAt) {
              updates.resolvedAt = new Date().toISOString();
            }

            if (!market.resolvedBy && !updates.resolvedBy) {
              updates.resolvedBy = 'blockchain-sync';
            }
          }

          // Apply updates to the market
          if (Object.keys(updates).length > 0) {
            marketLogger.info({
              marketId: market.id,
              updates
            }, `Updating market ${market.name} to match blockchain state`);

            // Update the market
            await this.updateMarket(market.id, updates);
            updated++;

            syncResults.push({
              marketId: market.id,
              name: market.name,
              status: 'updated',
              onChainData: {
                'is-open': isOpenOnChain,
                'is-resolved': isResolvedOnChain,
                'winning-outcome': winningOutcomeOnChain
              },
              localData: {
                status: market.status,
                resolvedOutcomeId: market.resolvedOutcomeId
              }
            });
          }

        } catch (error) {
          errors++;
          marketLogger.error({
            marketId: market.id,
            error: error instanceof Error ? error.message : String(error)
          }, `Error syncing market ${market.name} with blockchain`);

          syncResults.push({
            marketId: market.id,
            name: market.name,
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      // Log summary
      marketLogger.info({
        processed,
        updated,
        errors
      }, 'Completed market synchronization with blockchain');

      return {
        success: true,
        processed,
        updated,
        errors,
        syncResults
      };
    } catch (error) {
      marketLogger.error({
        error: error instanceof Error ? error.message : String(error)
      }, 'Failed to synchronize markets with blockchain');

      return {
        success: false,
        processed: 0,
        updated: 0,
        errors: 1,
        syncResults: []
      };
    }
  }
};