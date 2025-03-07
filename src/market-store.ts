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

// Create a logger instance for this module
const marketLogger = logger.child({ context: 'market-store' });

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
}

// Market store with Vercel KV
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

  // Get a specific market by ID
  async getMarket(id: string) {
    try {
      const market = await kvStore.getEntity('MARKET', id);
      return market || undefined;
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
  }
};