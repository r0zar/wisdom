import * as kvStore from './kv-store.js';
import crypto from 'crypto';
import { 
  Prediction, 
  PredictionNFTReceipt,
  IPredictionStore,
  Market
} from './types.js';
import {
  getMarketStore,
  getUserBalanceStore,
  getUserStatsStore
} from './services.js';
import { isAdmin } from './utils.js';
import { AppError, logger } from './logger.js';

// Create a logger instance for this module
const predictionLogger = logger.child({ context: 'prediction-store' });

// Prediction store with Vercel KV
export const predictionStore: IPredictionStore = {
  // Create a new prediction
  async createPrediction(data: {
        marketId: string;
        marketName: string;
        outcomeId: number;
        outcomeName: string;
        userId: string;
        amount: number;
    }): Promise<Prediction> {
    try {
      // Validate input
      if (!data.marketId || !data.userId || data.amount <= 0) {
        throw new AppError({
          message: 'Invalid prediction data',
          context: 'prediction-store',
          code: 'PREDICTION_VALIDATION_ERROR',
          data: { 
            hasMarketId: !!data.marketId, 
            hasUserId: !!data.userId,
            amount: data.amount
          }
        }).log();
      }
      
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      predictionLogger.debug(
        { marketId: data.marketId, userId: data.userId, amount: data.amount },
        'Creating new prediction'
      );

      // Generate NFT receipt
      const nftReceipt: PredictionNFTReceipt = {
        id: crypto.randomUUID(),
        tokenId: `${data.marketId}-${data.userId}-${now}`,
        image: this.generateNftImage(data.marketName, data.outcomeName, data.amount),
        predictionId: id,
        marketName: data.marketName,
        outcomeName: data.outcomeName,
        amount: data.amount,
        createdAt: now
      };

      // Create the prediction
      const prediction: Prediction = {
        id,
        marketId: data.marketId,
        outcomeId: data.outcomeId,
        outcomeName: data.outcomeName,
        userId: data.userId,
        amount: data.amount,
        createdAt: now,
        nftReceipt,
        status: 'active'
      };

      // Start a transaction for atomic operation
      const tx = await kvStore.startTransaction();
      
      try {
        // Add all operations to the transaction
        await tx.addEntity('PREDICTION', id, prediction);
        await tx.addEntity('PREDICTION_NFT', nftReceipt.id, nftReceipt);
        await tx.addToSetInTransaction('USER_PREDICTIONS', data.userId, id);
        await tx.addToSetInTransaction('MARKET_PREDICTIONS', data.marketId, id);
        
        // Execute the transaction
        const success = await tx.execute();
        
        if (!success) {
          throw new AppError({
            message: 'Failed to create prediction - transaction failed',
            context: 'prediction-store',
            code: 'PREDICTION_TRANSACTION_ERROR',
            data: { predictionId: id }
          }).log();
        }
        
        // Update market stats separately since it requires accessing the market store
        // This is not included in the transaction since it involves another store
        const marketStore = getMarketStore();
        await marketStore.updateMarketStats(
          data.marketId, 
          data.outcomeId, 
          data.amount, 
          data.userId
        );
        
        predictionLogger.info(
          { predictionId: id, userId: data.userId }, 
          'Prediction created successfully'
        );
        
        return prediction;
      } catch (error) {
        // Rethrow AppErrors, wrap others
        if (error instanceof AppError) {
          throw error;
        } else {
          throw new AppError({
            message: 'Error during prediction creation transaction',
            context: 'prediction-store',
            code: 'PREDICTION_CREATE_ERROR',
            originalError: error instanceof Error ? error : new Error(String(error)),
            data: { marketId: data.marketId, userId: data.userId }
          }).log();
        }
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      } else {
        throw new AppError({
          message: 'Failed to create prediction',
          context: 'prediction-store',
          code: 'PREDICTION_CREATE_ERROR',
          originalError: error instanceof Error ? error : new Error(String(error)),
          data: { 
            marketId: data.marketId, 
            userId: data.userId,
            amount: data.amount
          }
        }).log();
      }
    }
  },

  // Get all predictions for a user
  async getUserPredictions(userId: string): Promise<Prediction[]> {
    try {
      if (!userId) return [];

      // Get all prediction IDs for the user
      const predictionIds = await kvStore.getSetMembers('USER_PREDICTIONS', userId);

      if (predictionIds.length === 0) {
        return [];
      }

      // Get all predictions in parallel
      const predictions = await Promise.all(
        predictionIds.map(id => this.getPrediction(id))
      );

      // Filter out any undefined predictions (in case of data inconsistency)
      return predictions.filter(Boolean) as Prediction[];
    } catch (error) {
      console.error('Error getting user predictions:', error);
      return [];
    }
  },

  // Get all predictions for a market
  async getMarketPredictions(marketId: string): Promise<Prediction[]> {
    try {
      if (!marketId) return [];

      // Get all prediction IDs for the market
      const predictionIds = await kvStore.getSetMembers('MARKET_PREDICTIONS', marketId);

      if (predictionIds.length === 0) {
        return [];
      }

      // Get all predictions in parallel
      const predictions = await Promise.all(
        predictionIds.map(id => this.getPrediction(id))
      );

      // Filter out any undefined predictions (in case of data inconsistency)
      return predictions.filter(Boolean) as Prediction[];
    } catch (error) {
      console.error('Error getting market predictions:', error);
      return [];
    }
  },

  // Get a specific prediction by ID
  async getPrediction(id: string): Promise<Prediction | undefined> {
    try {
      if (!id) return undefined;

      const prediction = await kvStore.getEntity<Prediction>('PREDICTION', id);
      return prediction || undefined;
    } catch (error) {
      console.error(`Error getting prediction ${id}:`, error);
      return undefined;
    }
  },

  // Get a specific NFT receipt
  async getNFTReceipt(id: string): Promise<PredictionNFTReceipt | undefined> {
    try {
      if (!id) return undefined;

      const receipt = await kvStore.getEntity<PredictionNFTReceipt>('PREDICTION_NFT', id);
      return receipt || undefined;
    } catch (error) {
      console.error(`Error getting NFT receipt ${id}:`, error);
      return undefined;
    }
  },

  // Update prediction status
  async updatePredictionStatus(
    id: string,
    status: 'active' | 'won' | 'lost' | 'redeemed' | 'cancelled'
  ): Promise<Prediction | undefined> {
    try {
      const prediction = await this.getPrediction(id);
      if (!prediction) return undefined;

      const updatedPrediction = { ...prediction, status };

      // Store the updated prediction
      await kvStore.storeEntity('PREDICTION', id, updatedPrediction);

      return updatedPrediction;
    } catch (error) {
      console.error(`Error updating prediction ${id}:`, error);
      return undefined;
    }
  },

  // Generate a placeholder image URL for the NFT
  // In a real app, this would generate or reference an actual image
  generateNftImage(marketName: string, outcomeName: string, amount: number): string {
    // Create a data URI for a simple SVG image
    // This approach doesn't rely on external services and works in all environments
    const bgColor = '#1a2026';
    const textColor = '#ffffff';

    // Sanitize text to prevent SVG injection
    const sanitizedOutcome = outcomeName.replace(/[<>&"']/g, '');
    const sanitizedMarket = marketName.substring(0, 30).replace(/[<>&"']/g, '');

    const svg = `
        <svg width="600" height="400" xmlns="http://www.w3.org/2000/svg">
            <rect width="600" height="400" fill="${bgColor}" />
            <text x="300" y="170" font-family="Arial, sans-serif" font-size="24" text-anchor="middle" fill="${textColor}">Prediction Receipt</text>
            <text x="300" y="210" font-family="Arial, sans-serif" font-size="20" text-anchor="middle" fill="${textColor}">${sanitizedOutcome}</text>
            <text x="300" y="250" font-family="Arial, sans-serif" font-size="16" text-anchor="middle" fill="${textColor}">${sanitizedMarket}</text>
            <text x="300" y="280" font-family="Arial, sans-serif" font-size="18" text-anchor="middle" fill="${textColor}">$${amount.toFixed(2)}</text>
        </svg>`;

    // Convert SVG to a data URI
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  },
    
  /**
     * Create a prediction with balance update
     * This function handles the complete process of:
     * 1. Checking user balance and deducting funds
     * 2. Creating the prediction and NFT receipt
     * 3. Updating market stats
     * 4. Updating user stats for leaderboard
     * 
     * @param data Prediction data
     * @returns Object with created prediction or error message
     */
  async createPredictionWithBalanceUpdate(data: {
        marketId: string;
        outcomeId: number;
        userId: string;
        amount: number;
    }): Promise<{
        success: boolean;
        prediction?: Prediction;
        error?: string;
        market?: Record<string, unknown>;
        outcomeName?: string;
    }> {
    try {
      // Set up structured logging for this operation
      const opLogger = predictionLogger.child({
        operation: 'createPredictionWithBalance',
        marketId: data.marketId,
        userId: data.userId,
        amount: data.amount
      });
      
      opLogger.info({}, 'Starting prediction creation with balance update');
      
      // Input validation
      if (!data.marketId || !data.userId || data.amount <= 0) {
        const error = new AppError({
          message: 'Invalid prediction data',
          context: 'prediction-store',
          code: 'PREDICTION_VALIDATION_ERROR',
          data: {
            hasMarketId: !!data.marketId,
            hasUserId: !!data.userId,
            amount: data.amount
          }
        }).log();
        
        return { success: false, error: error.message };
      }
      
      // Get services from registry
      const marketStore = getMarketStore();
      const userBalanceStore = getUserBalanceStore();
      const userStatsStore = getUserStatsStore();
            
      // Get the market to verify it exists and get outcome name
      const market = await marketStore.getMarket(data.marketId);
      if (!market) {
        const error = new AppError({
          message: `Market not found: ${data.marketId}`,
          context: 'prediction-store',
          code: 'MARKET_NOT_FOUND',
          data: { marketId: data.marketId }
        }).log();
        
        return { success: false, error: error.message };
      }

      // Find the outcome
      const outcome = market.outcomes.find(o => o.id === data.outcomeId);
      if (!outcome) {
        const error = new AppError({
          message: `Outcome ${data.outcomeId} not found in market ${data.marketId}`,
          context: 'prediction-store',
          code: 'OUTCOME_NOT_FOUND',
          data: { 
            marketId: data.marketId, 
            outcomeId: data.outcomeId,
            availableOutcomes: market.outcomes.map(o => o.id) 
          }
        }).log();
        
        return { success: false, error: error.message };
      }

      // Check if market is already resolved
      if (market.resolvedOutcomeId !== undefined) {
        const error = new AppError({
          message: `Market ${data.marketId} is already resolved`,
          context: 'prediction-store',
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
          context: 'prediction-store',
          code: 'MARKET_ENDED',
          data: { 
            marketId: data.marketId, 
            endDate: market.endDate,
            currentDate: new Date().toISOString()
          }
        }).log();
        
        return { success: false, error: error.message };
      }

      opLogger.debug({}, 'Market validation completed, processing balance update');
      
      // Deduct the amount from user's balance
      try {
        const balanceResult = await userBalanceStore.updateBalanceForPrediction(
          data.userId,
          data.amount
        );
  
        if (!balanceResult) {
          throw new AppError({
            message: 'Failed to update user balance',
            context: 'prediction-store',
            code: 'BALANCE_UPDATE_FAILED',
            data: { userId: data.userId, amount: data.amount }
          });
        }
        
        opLogger.debug({}, 'Balance updated successfully, creating prediction');
      } catch (balanceError) {
        // Handle insufficient balance case specifically
        if (balanceError instanceof Error && 
            balanceError.message.includes('Insufficient balance')) {
          const error = new AppError({
            message: 'Insufficient balance. Please add more funds to your account.',
            context: 'prediction-store',
            code: 'INSUFFICIENT_BALANCE',
            originalError: balanceError,
            data: { userId: data.userId, amount: data.amount }
          }).log();
          
          return { success: false, error: error.message };
        }
        
        // Rethrow other errors
        throw balanceError;
      }

      // Create the prediction with NFT receipt
      const prediction = await this.createPrediction({
        marketId: market.id,
        marketName: market.name,
        outcomeId: data.outcomeId,
        outcomeName: outcome.name,
        userId: data.userId,
        amount: data.amount
      });

      opLogger.debug(
        { predictionId: prediction.id }, 
        'Prediction created, updating user stats'
      );
      
      // Update user stats for leaderboard tracking
      await userStatsStore.updateStatsForNewPrediction(data.userId, prediction);

      opLogger.info(
        { predictionId: prediction.id }, 
        'Prediction with balance update completed successfully'
      );
      
      // Convert market to Record<string, unknown> to comply with return type
      const marketData: Record<string, unknown> = { ...market };
      
      return {
        success: true,
        prediction,
        market: marketData,
        outcomeName: outcome.name
      };
    } catch (error) {
      // If it's already an AppError, just log and return it
      if (error instanceof AppError) {
        error.log();
        return { success: false, error: error.message };
      }
      
      // Handle other errors
      const appError = new AppError({
        message: 'Failed to create prediction',
        context: 'prediction-store',
        code: 'PREDICTION_CREATE_ERROR',
        originalError: error instanceof Error ? error : new Error(String(error)),
        data: { 
          marketId: data.marketId, 
          userId: data.userId, 
          amount: data.amount 
        }
      }).log();
      
      return { success: false, error: appError.message };
    }
  },

  // Delete a prediction and its associated NFT receipt
  async deletePrediction(predictionId: string): Promise<boolean> {
    try {
      if (!predictionId) return false;

      // Get the prediction to retrieve its data
      const prediction = await this.getPrediction(predictionId);
      if (!prediction) return false;

      // Delete from the main predictions store
      await kvStore.deleteEntity('PREDICTION', predictionId);

      // Remove from user's predictions set
      await kvStore.removeFromSet('USER_PREDICTIONS', prediction.userId, predictionId);

      // Remove from market's predictions set
      await kvStore.removeFromSet('MARKET_PREDICTIONS', prediction.marketId, predictionId);

      // Delete the NFT receipt if it exists
      if (prediction.nftReceipt?.id) {
        await kvStore.deleteEntity('PREDICTION_NFT', prediction.nftReceipt.id);
      }

      return true;
    } catch (error) {
      console.error(`Error deleting prediction ${predictionId}:`, error);
      return false;
    }
  },

  /**
     * Update a prediction with new data
     */
  async updatePrediction(predictionId: string, data: Partial<Prediction>): Promise<Prediction | null> {
    try {
      // Get existing prediction
      const prediction = await this.getPrediction(predictionId);
      if (!prediction) {
        return null;
      }

      // Update prediction data
      const updatedPrediction: Prediction = {
        ...prediction,
        ...data,
      };

      // Store updated prediction
      await kvStore.storeEntity('PREDICTION', predictionId, updatedPrediction);

      return updatedPrediction;
    } catch (error) {
      console.error(`Error updating prediction ${predictionId}:`, error);
      return null;
    }
  },

  /**
     * Validate if a prediction is eligible for redemption
     * 
     * @param predictionId ID of the prediction
     * @param userId User attempting to redeem
     * @returns Validation result with prediction if successful
     */
  async validateRedemptionEligibility(
    predictionId: string, 
    userId: string
  ): Promise<{
        success: boolean;
        prediction?: Prediction;
        error?: string;
        isAdmin?: boolean;
    }> {
    try {
      // Get prediction
      const prediction = await this.getPrediction(predictionId);
      if (!prediction) {
        return { success: false, error: 'Prediction not found' };
      }

      // Use isAdmin function directly (already imported at the top)
      const userIsAdmin = isAdmin(userId);

      // Verify the prediction belongs to the user or user is admin
      if (prediction.userId !== userId && !userIsAdmin) {
        return { success: false, error: 'Unauthorized: This prediction does not belong to you' };
      }

      // Check if prediction is already redeemed
      if (prediction.status === 'redeemed') {
        return { success: false, error: 'Prediction has already been redeemed' };
      }

      // Check if prediction is eligible for redemption (must be won or lost)
      if (prediction.status !== 'won' && prediction.status !== 'lost') {
        return { success: false, error: 'Prediction is not eligible for redemption yet' };
      }

      return { 
        success: true, 
        prediction,
        isAdmin: userIsAdmin 
      };
    } catch (error) {
      console.error(`Error validating redemption eligibility for prediction ${predictionId}:`, error);
      return { success: false, error: 'Failed to validate prediction redemption eligibility' };
    }
  },

  /**
     * Redeem a prediction with balance update
     * This function handles the complete process of:
     * 1. Validating the prediction is eligible for redemption 
     * 2. Updating the prediction status
     * 3. Updating the user's balance
     * 
     * @param predictionId The ID of the prediction to redeem
     * @param userId The ID of the user trying to redeem
     * @returns Object with redemption result
     */
  async redeemPredictionWithBalanceUpdate(
    predictionId: string,
    userId: string
  ): Promise<{
        success: boolean;
        prediction?: Prediction;
        payout?: number;
        error?: string;
    }> {
    try {
      // First validate eligibility
      const validationResult = await this.validateRedemptionEligibility(predictionId, userId);
      if (!validationResult.success) {
        return { success: false, error: validationResult.error };
      }

      const prediction = validationResult.prediction!;

      // Calculate payout (winners get their calculated payout, losers get 0)
      const payout = prediction.status === 'won' ? prediction.potentialPayout || 0 : 0;

      // Update prediction as redeemed
      const updatedPrediction = await this.updatePrediction(predictionId, {
        status: 'redeemed',
        redeemedAt: new Date().toISOString()
      });

      if (!updatedPrediction) {
        return { success: false, error: 'Failed to update prediction' };
      }

      // Get userBalanceStore from registry
      const userBalanceStore = getUserBalanceStore();

      // Update user's balance
      if (payout > 0) {
        await userBalanceStore.updateBalanceForResolvedPrediction(
          userId,
          prediction.amount,
          payout
        );
      } else {
        // For losers, just update to decrease the inPredictions amount
        await userBalanceStore.updateBalanceForResolvedPrediction(
          userId,
          prediction.amount,
          0
        );
      }

      return {
        success: true,
        prediction: updatedPrediction,
        payout
      };
    } catch (error) {
      console.error(`Error redeeming prediction ${predictionId}:`, error);
      return { success: false, error: 'Failed to redeem prediction' };
    }
  },

  /**
     * Redeem a prediction after market resolution
     * This is kept for backward compatibility but we recommend using 
     * redeemPredictionWithBalanceUpdate for new code
     */
  async redeemPrediction(predictionId: string): Promise<{
        prediction: Prediction | null;
        payout: number;
    }> {
    try {
      // Get prediction
      const prediction = await this.getPrediction(predictionId);
      if (!prediction) {
        return { prediction: null, payout: 0 };
      }

      // Check if prediction is already redeemed
      if (prediction.status === 'redeemed') {
        return { prediction: prediction, payout: 0 };
      }

      // Check if prediction is eligible for redemption (must be won or lost)
      if (prediction.status !== 'won' && prediction.status !== 'lost') {
        return { prediction: prediction, payout: 0 };
      }

      // Calculate payout (winners get their calculated payout, losers get 0)
      const payout = prediction.status === 'won' ? prediction.potentialPayout || 0 : 0;

      // Update prediction as redeemed
      const updatedPrediction = await this.updatePrediction(predictionId, {
        status: 'redeemed',
        redeemedAt: new Date().toISOString()
      });

      return {
        prediction: updatedPrediction,
        payout: payout
      };
    } catch (error) {
      console.error(`Error redeeming prediction ${predictionId}:`, error);
      return { prediction: null, payout: 0 };
    }
  },

  /**
     * Get all predictions for a specific market with a specific status
     */
  async getMarketPredictionsByStatus(marketId: string, status: string): Promise<Prediction[]> {
    try {
      const predictions = await this.getMarketPredictions(marketId);
      return predictions.filter(p => p.status === status);
    } catch (error) {
      console.error(`Error getting market predictions by status for market ${marketId}:`, error);
      return [];
    }
  }
};