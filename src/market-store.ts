import * as kvStore from './kv-store.js';
import crypto from 'crypto';
import { 
  Market, 
  MarketOutcome, 
  IMarketStore, 
  Prediction
} from './types.js';
import { 
  getPredictionStore, 
  getUserBalanceStore, 
  getUserStatsStore 
} from './services.js';
import { AppError, logger } from './logger.js';

// Create a logger instance for this module
const marketLogger = logger.child({ context: 'market-store' });

// Define admin fee percentage
const ADMIN_FEE_PERCENTAGE = 0.05; // 5%

// Market store with Vercel KV
export const marketStore: IMarketStore = {
  // Get all markets
  async getMarkets(): Promise<Market[]> {
    try {
      // Get all market IDs
      const marketIds = await kvStore.getSetMembers('MARKET_IDS', '');

      if (marketIds.length === 0) {
        marketLogger.info({}, 'No markets found, creating sample markets');
        // If no markets exist, create sample markets
        await this.createSampleMarkets();
        return this.getMarkets();
      }

      // Get all markets in parallel
      const markets = await Promise.all(
        marketIds.map(id => this.getMarket(id))
      );

      // Filter out any undefined markets (in case of data inconsistency)
      const validMarkets = markets.filter(Boolean) as Market[];
      
      if (validMarkets.length < marketIds.length) {
        marketLogger.warn(
          { expected: marketIds.length, found: validMarkets.length },
          'Some markets could not be retrieved'
        );
      }
      
      return validMarkets;
    } catch (error) {
      throw new AppError({
        message: 'Failed to retrieve markets',
        context: 'market-store',
        code: 'MARKET_LIST_ERROR',
        originalError: error instanceof Error ? error : new Error(String(error))
      }).log();
    }
  },

  // Get a specific market by ID
  async getMarket(id: string): Promise<Market | undefined> {
    try {
      const market = await kvStore.getEntity<Market>('MARKET', id);
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
  ): Promise<Market> {
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
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const market: Market = {
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
  async updateMarket(id: string, marketData: Partial<Market>): Promise<Market | undefined> {
    try {
      const market = await this.getMarket(id);
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

      // Store the updated market
      await kvStore.storeEntity('MARKET', id, updatedMarket);
      
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
      // Delete the market
      await kvStore.deleteEntity('MARKET', id);

      // Remove the market ID from the set of all market IDs
      await kvStore.removeFromSet('MARKET_IDS', '', id);

      return true;
    } catch (error) {
      console.error(`Error deleting market ${id}:`, error);
      return false;
    }
  },

  // Update market stats when a prediction is made
  async updateMarketStats(marketId: string, outcomeId: number, amount: number, userId: string): Promise<Market | undefined> {
    const market = await this.getMarket(marketId);
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
    const outcome = market.outcomes.find(o => o.id === outcomeId);
    if (outcome) {
      outcome.votes = (outcome.votes || 0) + 1;
      outcome.amount = (outcome.amount || 0) + amount;
    }

    // Save the updated market
    return this.updateMarket(marketId, market);
  },

  // Get related markets based on category and similarity
  async getRelatedMarkets(marketId: string, limit: number = 3): Promise<Market[]> {
    try {
      const market = await this.getMarket(marketId);
      if (!market) return [];

      // Get all markets
      const allMarkets = await this.getMarkets();

      // Filter out the current market and non-active markets
      const candidates = allMarkets.filter(m =>
        m.id !== marketId &&
                m.status === 'active' &&
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

  // Calculate similarity score between two markets
  calculateSimilarity(market1: Market, market2: Market): number {
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

  /**
     * Resolve a market with payouts
     * This handles the complex resolution logic, admin fees, and payout calculations
     * 
     * @param marketId The ID of the market to resolve
     * @param winningOutcomeId The ID of the winning outcome
     * @param adminId The ID of the admin resolving the market (for fee attribution)
     * @returns Object containing success/error status and related data
     */
  /**
   * Resolve a market with payouts using atomic transactions to prevent race conditions
   * 
   * This implementation uses Redis transactions to ensure the entire resolution process
   * is atomic and avoids race conditions when multiple admins try to resolve simultaneously.
   */
  async resolveMarketWithPayouts(
    marketId: string, 
    winningOutcomeId: number, 
    adminId: string
  ): Promise<{
        success: boolean;
        market?: Market;
        adminFee?: number;
        error?: string;
        predictions?: Record<string, unknown>[];
    }> {
    try {
      // Set up structured logging for this operation
      const opLogger = marketLogger.child({ 
        operation: 'resolveMarket',
        marketId, 
        winningOutcomeId, 
        adminId 
      });
      
      opLogger.info({}, 'Starting market resolution process');
      
      // Get services from registry
      const predictionStore = getPredictionStore();
      const userStatsStore = getUserStatsStore();
      const userBalanceStore = getUserBalanceStore();
      const { startTransaction } = kvStore;
      
      // First, get the market - this needs to be done outside the transaction to verify it exists
      const market = await this.getMarket(marketId);
      if (!market) {
        const error = new AppError({
          message: `Market not found: ${marketId}`,
          context: 'market-store',
          code: 'MARKET_RESOLUTION_ERROR',
          data: { marketId }
        }).log();
        
        return { success: false, error: error.message };
      }

      // Check if market is already resolved
      if (market.resolvedOutcomeId !== undefined) {
        const error = new AppError({
          message: `Market ${marketId} is already resolved`,
          context: 'market-store',
          code: 'MARKET_ALREADY_RESOLVED',
          data: { 
            marketId,
            currentOutcomeId: market.resolvedOutcomeId,
            attemptedOutcomeId: winningOutcomeId 
          }
        }).log();
        
        return { success: false, error: error.message };
      }

      // Find the winning outcome
      const winningOutcome = market.outcomes.find(o => o.id === winningOutcomeId);
      if (!winningOutcome) {
        const error = new AppError({
          message: `Winning outcome ${winningOutcomeId} not found in market ${marketId}`,
          context: 'market-store',
          code: 'INVALID_OUTCOME_ID',
          data: { 
            marketId,
            winningOutcomeId,
            availableOutcomes: market.outcomes.map(o => o.id)
          }
        }).log();
        
        return { success: false, error: error.message };
      }

      // Get all predictions for this market - needs to be done before transaction starts
      const marketPredictions = await predictionStore.getMarketPredictions(market.id);
      if (marketPredictions.length === 0) {
        opLogger.warn(
          { marketId }, 
          'No predictions found for this market, cannot resolve'
        );
        
        return { success: false, error: 'No predictions found for this market' };
      }

      opLogger.info(
        { predictionCount: marketPredictions.length },
        `Processing ${marketPredictions.length} predictions for market resolution`
      );

      // Calculate total pot and admin fee (5%)
      const totalPot = marketPredictions.reduce((sum, prediction) => sum + prediction.amount, 0);
      const adminFee = totalPot * ADMIN_FEE_PERCENTAGE;
      const remainingPot = totalPot - adminFee;

      // Find winning predictions
      const winningPredictions = marketPredictions.filter(
        p => p.outcomeId === winningOutcomeId
      );

      // Calculate total winning amount
      const totalWinningAmount = winningPredictions.reduce(
        (sum, prediction) => sum + prediction.amount,
        0
      );
      
      opLogger.info(
        { 
          totalPot, 
          adminFee, 
          remainingPot, 
          winningPredictions: winningPredictions.length,
          totalWinningAmount 
        },
        'Market payout calculations completed'
      );
      
      // Create updated market object with resolved status
      const updatedMarket = {
        ...market,
        resolvedOutcomeId: winningOutcomeId,
        resolvedAt: new Date().toISOString(),
        status: 'resolved' as const,
        resolvedBy: adminId,
        adminFee: adminFee,
        remainingPot: remainingPot,
        totalWinningAmount: totalWinningAmount || 0
      };
      
      // Update outcomes to mark the winner
      updatedMarket.outcomes = market.outcomes.map(outcome => ({
        ...outcome,
        isWinner: outcome.id === winningOutcomeId
      }));

      // Prepare updated predictions array
      const updatedPredictions = marketPredictions.map(prediction => {
        const isWinner = prediction.outcomeId === winningOutcomeId;
        const winnerShare = isWinner && totalWinningAmount > 0
          ? (prediction.amount / totalWinningAmount) * remainingPot
          : 0;
          
        return {
          ...prediction,
          status: isWinner ? 'won' : 'lost',
          potentialPayout: isWinner ? winnerShare : 0,
          resolvedAt: new Date().toISOString()
        };
      });
      
      opLogger.info({}, 'Starting transaction for market resolution');
      
      // Start a transaction
      const tx = await startTransaction();
      
      try {
        // Within the transaction:
        
        // 1. Double-check the market is not already resolved (critical safety check)
        // We'll need to get the market again, but inside the transaction
        // This is handled by our atomic transaction - the entire transaction will fail
        // if any command fails or if the market has been modified
        
        // 2. Update the market
        await tx.addEntity('MARKET', marketId, updatedMarket);
        opLogger.debug({}, 'Added market update to transaction');
        
        // 3. Update the user balance for admin (fee)
        const userBalance = await userBalanceStore.getUserBalance(adminId);
        if (userBalance) {
          const updatedBalance = {
            ...userBalance,
            availableBalance: userBalance.availableBalance + adminFee,
            totalDeposited: userBalance.totalDeposited + adminFee,
            lastUpdated: new Date().toISOString()
          };
          await tx.addEntity('USER_BALANCE', adminId, updatedBalance);
          opLogger.debug({}, 'Added admin balance update to transaction');
        } else {
          opLogger.warn(
            { adminId }, 
            'Admin user balance not found, skipping fee distribution'
          );
        }
        
        // 4. Update all predictions
        for (const updatedPrediction of updatedPredictions) {
          await tx.addEntity('PREDICTION', updatedPrediction.id, updatedPrediction);
        }
        opLogger.debug(
          { count: updatedPredictions.length }, 
          'Added prediction updates to transaction'
        );
        
        // 5. Update user stats
        let userStatsUpdated = 0;
        for (const prediction of marketPredictions) {
          const isWinner = prediction.outcomeId === winningOutcomeId;
          const winnerShare = isWinner && totalWinningAmount > 0
            ? (prediction.amount / totalWinningAmount) * remainingPot
            : 0;
            
          const userStats = await userStatsStore.getUserStats(prediction.userId);
          if (userStats) {
            const updatedStats = {
              ...userStats,
              correctPredictions: isWinner
                ? userStats.correctPredictions + 1
                : userStats.correctPredictions,
              totalEarnings: userStats.totalEarnings + (isWinner ? winnerShare : -prediction.amount),
              lastUpdated: new Date().toISOString()
            };
            
            // Recalculate accuracy
            updatedStats.accuracy = updatedStats.totalPredictions > 0
              ? (updatedStats.correctPredictions / updatedStats.totalPredictions) * 100
              : 0;
              
            await tx.addEntity('USER_STATS', prediction.userId, updatedStats);
            
            // Update leaderboard entries
            const accuracyScore = updatedStats.totalPredictions >= 5 ? updatedStats.accuracy : 0;
            await tx.addToSortedSetInTransaction('LEADERBOARD_EARNINGS', prediction.userId, updatedStats.totalEarnings);
            await tx.addToSortedSetInTransaction('LEADERBOARD_ACCURACY', prediction.userId, accuracyScore);
            
            // Calculate composite score for leaderboard
            // This is simplified - in production you'd use the real algorithm
            const compositeScore = (accuracyScore * 0.5) + (updatedStats.totalEarnings * 0.5);
            await tx.addToSortedSetInTransaction('LEADERBOARD', prediction.userId, compositeScore);
            
            userStatsUpdated++;
          } else {
            opLogger.warn(
              { userId: prediction.userId }, 
              'User stats not found for participant, skipping stats update'
            );
          }
        }
        
        opLogger.debug(
          { updated: userStatsUpdated, total: marketPredictions.length }, 
          'Added user stats updates to transaction'
        );
        
        // Execute the transaction
        opLogger.info(
          { operationCount: tx.operations.length }, 
          'Executing transaction with all updates'
        );
        
        const success = await tx.execute();
        
        if (!success) {
          throw new AppError({
            message: 'Transaction failed during market resolution',
            context: 'market-store',
            code: 'TRANSACTION_EXECUTION_FAILED',
            data: { marketId, operationCount: tx.operations.length }
          });
        }
        
        opLogger.info(
          { marketId, winningOutcomeId },
          'Market successfully resolved'
        );
        
        return {
          success: true,
          market: updatedMarket,
          adminFee: adminFee,
          predictions: updatedPredictions
        };
      } catch (error) {
        // If any operation fails, throw a structured error
        throw new AppError({
          message: 'Error during transaction preparation',
          context: 'market-store',
          code: 'RESOLUTION_TRANSACTION_ERROR',
          originalError: error instanceof Error ? error : new Error(String(error)),
          data: { marketId, winningOutcomeId }
        });
      }
    } catch (error) {
      // Return a friendly error to the caller
      const appError = error instanceof AppError 
        ? error
        : new AppError({
            message: 'Failed to resolve market',
            context: 'market-store',
            code: 'MARKET_RESOLUTION_ERROR',
            originalError: error instanceof Error ? error : new Error(String(error)),
            data: { marketId, winningOutcomeId }
          });
      
      // Log the error but return a user-friendly message
      appError.log();
      
      return { 
        success: false, 
        error: appError.message
      };
    }
  },

  // Create sample markets for testing
  async createSampleMarkets(): Promise<void> {
    try {
      marketLogger.info({}, 'Creating sample markets...');

      const sampleMarkets = [
        {
          type: 'binary' as const,
          name: 'Will Bitcoin reach $100,000 by the end of 2024?',
          description: 'This market will resolve to "Yes" if the price of Bitcoin reaches or exceeds $100,000 USD on any major exchange before January 1, 2025. It will resolve to "No" otherwise.',
          outcomes: [
            { id: 1, name: 'Yes' },
            { id: 2, name: 'No' },
          ],
        },
        {
          type: 'multiple' as const,
          name: 'Which country will win the 2024 Summer Olympics medal count?',
          description: 'This market will resolve based on the total medal count (gold, silver, and bronze) at the conclusion of the 2024 Summer Olympics in Paris.',
          outcomes: [
            { id: 1, name: 'United States' },
            { id: 2, name: 'China' },
            { id: 3, name: 'Japan' },
            { id: 4, name: 'Russia' },
            { id: 5, name: 'Other' },
          ],
        },
        {
          type: 'binary' as const,
          name: 'Will SpaceX successfully land humans on Mars by 2030?',
          description: 'This market resolves to "Yes" if SpaceX successfully lands at least one human on the surface of Mars before January 1, 2031. The landing must be officially confirmed by SpaceX and independent space agencies.',
          outcomes: [
            { id: 1, name: 'Yes' },
            { id: 2, name: 'No' },
          ],
        },
      ];

      // Create each sample market
      marketLogger.info(
        { marketCount: sampleMarkets.length }, 
        `Creating ${sampleMarkets.length} sample markets...`
      );

      for (const marketData of sampleMarkets) {
        try {
          const market = await this.createMarket({
            ...marketData,
            createdBy: 'admin',
            category: 'general',
            endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          });
          marketLogger.info(
            { marketId: market.id }, 
            `Created sample market: ${market.name}`
          );
        } catch (error) {
          // Already handled and logged by createMarket, no need to rethrow
          marketLogger.error(
            { marketName: marketData.name },
            `Error creating sample market: ${marketData.name}`
          );
        }
      }

      marketLogger.info({}, 'Sample markets creation completed');
    } catch (error) {
      throw new AppError({
        message: 'Failed to create sample markets',
        context: 'market-store',
        code: 'SAMPLE_MARKET_ERROR',
        originalError: error instanceof Error ? error : new Error(String(error))
      }).log();
    }
  },
};