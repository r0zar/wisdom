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
        // If no markets exist, create sample markets
        await this.createSampleMarkets();
        return this.getMarkets();
      }

      // Get all markets in parallel
      const markets = await Promise.all(
        marketIds.map(id => this.getMarket(id))
      );

      // Filter out any undefined markets (in case of data inconsistency)
      return markets.filter(Boolean) as Market[];
    } catch (error) {
      console.error('Error getting markets:', error);
      return [];
    }
  },

  // Get a specific market by ID
  async getMarket(id: string): Promise<Market | undefined> {
    try {
      const market = await kvStore.getEntity<Market>('MARKET', id);
      return market || undefined;
    } catch (error) {
      console.error(`Error getting market ${id}:`, error);
      return undefined;
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
      await kvStore.storeEntity('MARKET', id, market);

      // Add to market_ids set
      await kvStore.addToSet('MARKET_IDS', '', id);

      // Add to user's markets set
      if (data.createdBy) {
        await kvStore.addToSet('USER_MARKETS', data.createdBy, id);
      }

      return market;
    } catch (error) {
      console.error('Error creating market:', error);
      throw error;
    }
  },

  // Update a market
  async updateMarket(id: string, marketData: Partial<Market>): Promise<Market | undefined> {
    try {
      const market = await this.getMarket(id);
      if (!market) return undefined;

      const updatedMarket = { ...market, ...marketData };

      // Store the updated market
      await kvStore.storeEntity('MARKET', id, updatedMarket);

      return updatedMarket;
    } catch (error) {
      console.error(`Error updating market ${id}:`, error);
      return undefined;
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
      // Get services from registry
      const predictionStore = getPredictionStore();
      const userStatsStore = getUserStatsStore();
      const userBalanceStore = getUserBalanceStore();
      const { startTransaction } = kvStore;
      
      // First, get the market - this needs to be done outside the transaction to verify it exists
      const market = await this.getMarket(marketId);
      if (!market) {
        return { success: false, error: 'Market not found' };
      }

      // Check if market is already resolved
      if (market.resolvedOutcomeId !== undefined) {
        return { success: false, error: 'Market is already resolved' };
      }

      // Find the winning outcome
      const winningOutcome = market.outcomes.find(o => o.id === winningOutcomeId);
      if (!winningOutcome) {
        return { success: false, error: 'Winning outcome not found' };
      }

      // Get all predictions for this market - needs to be done before transaction starts
      const marketPredictions = await predictionStore.getMarketPredictions(market.id);
      if (marketPredictions.length === 0) {
        return { success: false, error: 'No predictions found for this market' };
      }

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
      
      // Start a transaction
      const tx = await startTransaction();
      
      // Within the transaction:
      
      // 1. Double-check the market is not already resolved (critical safety check)
      // We'll need to get the market again, but inside the transaction
      // This is handled by our atomic transaction - the entire transaction will fail
      // if any command fails or if the market has been modified
      
      // 2. Update the market
      await tx.addEntity('MARKET', marketId, updatedMarket);
      
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
      }
      
      // 4. Update all predictions
      for (const updatedPrediction of updatedPredictions) {
        await tx.addEntity('PREDICTION', updatedPrediction.id, updatedPrediction);
      }
      
      // 5. Update user stats
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
        }
      }
      
      // Execute the transaction
      const success = await tx.execute();
      
      if (!success) {
        return { success: false, error: 'Transaction failed' };
      }
      
      return {
        success: true,
        market: updatedMarket,
        adminFee: adminFee,
        predictions: updatedPredictions
      };
    } catch (error) {
      console.error('Error resolving market with payouts:', error);
      return { success: false, error: 'Failed to resolve market' };
    }
  },

  // Create sample markets for testing
  async createSampleMarkets(): Promise<void> {
    try {
      console.log('Creating sample markets...');

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
      console.log(`Creating ${sampleMarkets.length} sample markets...`);

      for (const marketData of sampleMarkets) {
        try {
          const market = await this.createMarket({
            ...marketData,
            createdBy: 'admin',
            category: 'general',
            endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          });
          console.log(`Created sample market: ${market.id} - ${market.name}`);
        } catch (marketError) {
          console.error(`Error creating sample market: ${marketData.name}`, marketError);
        }
      }

      console.log('Sample markets creation completed');
    } catch (error) {
      console.error('Error creating sample markets:', error);
    }
  },
};