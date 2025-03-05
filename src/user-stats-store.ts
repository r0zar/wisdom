import * as kvStore from './kv-store.js';
import { 
  UserStats, 
  LeaderboardEntry, 
  Prediction, 
  IUserStatsStore 
} from './types.js';

// User stats store with Vercel KV
export const userStatsStore: IUserStatsStore = {
  // Helper to calculate user score consistently across the app
  calculateUserScore(stats: UserStats): number {
    // Only count users with at least 5 predictions for the accuracy component
    const accuracyComponent = stats.totalPredictions >= 5 ? stats.accuracy : 0;
        
    // Normalize earnings (0-100 scale typically)
    const normalizedEarnings = stats.totalEarnings / 100;
        
    // Prediction volume factor (logarithmic scale to prevent domination by volume)
    const volumeFactor = stats.totalPredictions > 0 ? Math.log10(stats.totalPredictions + 1) * 10 : 0;
        
    // Consistency factor - higher for users who maintain accuracy across more predictions
    const consistencyFactor = stats.totalPredictions >= 10 ? 
      (accuracyComponent * Math.min(stats.totalPredictions / 20, 1.5)) : 
      accuracyComponent;
        
    // Final composite score
    return (consistencyFactor * 0.4) + 
               (normalizedEarnings * 0.3) + 
               (Math.min(volumeFactor, 25) * 0.3);
  },

  // Get user stats for a specific user
  async getUserStats(userId: string): Promise<UserStats | null> {
    try {
      if (!userId) return null;

      const stats = await kvStore.getEntity<UserStats>('USER_STATS', userId);
      return stats || null;
    } catch (error) {
      console.error(`Error getting user stats for ${userId}:`, error);
      return null;
    }
  },

  // Update user stats when a prediction is made
  async updateStatsForNewPrediction(userId: string, prediction: Prediction): Promise<UserStats> {
    try {
      // Get current stats or create new ones
      const currentStats = await this.getUserStats(userId) || {
        userId,
        totalPredictions: 0,
        correctPredictions: 0,
        accuracy: 0,
        totalAmount: 0,
        totalEarnings: 0,
        lastUpdated: new Date().toISOString()
      };

      // Update stats
      const updatedStats: UserStats = {
        ...currentStats,
        totalPredictions: currentStats.totalPredictions + 1,
        totalAmount: currentStats.totalAmount + prediction.amount,
        lastUpdated: new Date().toISOString()
      };

      // Recalculate accuracy
      updatedStats.accuracy =
                updatedStats.totalPredictions > 0
                  ? (updatedStats.correctPredictions / updatedStats.totalPredictions) * 100
                  : 0;

      // Store updated stats
      await kvStore.storeEntity('USER_STATS', userId, updatedStats);

      // Update leaderboard sorted sets for efficient querying
      await this.updateLeaderboardEntries(updatedStats);

      return updatedStats;
    } catch (error) {
      console.error(`Error updating stats for user ${userId}:`, error);
      throw error;
    }
  },

  // Update user stats when a prediction is resolved
  async updateStatsForResolvedPrediction(
    userId: string,
    prediction: Prediction,
    isCorrect: boolean,
    earnings: number
  ): Promise<UserStats> {
    try {
      // Get current stats
      const currentStats = await this.getUserStats(userId);
      if (!currentStats) {
        throw new Error(`No stats found for user ${userId}`);
      }

      // Update stats
      const updatedStats: UserStats = {
        ...currentStats,
        correctPredictions: isCorrect
          ? currentStats.correctPredictions + 1
          : currentStats.correctPredictions,
        totalEarnings: currentStats.totalEarnings + earnings,
        lastUpdated: new Date().toISOString()
      };

      // Recalculate accuracy
      updatedStats.accuracy =
                updatedStats.totalPredictions > 0
                  ? (updatedStats.correctPredictions / updatedStats.totalPredictions) * 100
                  : 0;

      // Store updated stats
      await kvStore.storeEntity('USER_STATS', userId, updatedStats);

      // Update leaderboard sorted sets
      await this.updateLeaderboardEntries(updatedStats);

      return updatedStats;
    } catch (error) {
      console.error(`Error updating stats for resolved prediction, user ${userId}:`, error);
      throw error;
    }
  },

  // Update user's username (when available from auth provider)
  async updateUsername(userId: string, username: string): Promise<UserStats | null> {
    try {
      const stats = await this.getUserStats(userId);
      if (!stats) return null;

      const updatedStats: UserStats = {
        ...stats,
        username,
        lastUpdated: new Date().toISOString()
      };

      await kvStore.storeEntity('USER_STATS', userId, updatedStats);

      // Update leaderboard entries
      await this.updateLeaderboardEntries(updatedStats);

      return updatedStats;
    } catch (error) {
      console.error(`Error updating username for user ${userId}:`, error);
      return null;
    }
  },

  // Update leaderboard sorted sets for efficient querying
  async updateLeaderboardEntries(stats: UserStats): Promise<void> {
    try {
      // Add to earnings leaderboard (sorted by total earnings)
      await kvStore.addToSortedSet(
        'LEADERBOARD_EARNINGS',
        stats.userId,
        stats.totalEarnings
      );

      // Add to accuracy leaderboard (sorted by accuracy)
      // Only count users with at least 5 predictions for accuracy
      const accuracyScore = stats.totalPredictions >= 5 ? stats.accuracy : 0;
      await kvStore.addToSortedSet(
        'LEADERBOARD_ACCURACY',
        stats.userId,
        accuracyScore
      );

      // Advanced scoring algorithm for leaderboard ranking
      // Calculate the composite score using the helper method
      const compositeScore = this.calculateUserScore(stats);
            
      // Store in the main leaderboard
      await kvStore.addToSortedSet(
        'LEADERBOARD',
        stats.userId,
        compositeScore
      );
    } catch (error) {
      console.error('Error updating leaderboard entries:', error);
      throw error;
    }
  },

  // Get top leaderboard entries by earnings
  async getTopEarners(limit: number = 10): Promise<LeaderboardEntry[]> {
    try {
      // Get top user IDs sorted by earnings (highest first)
      const userIds = await kvStore.getTopFromSortedSet('LEADERBOARD_EARNINGS', limit);

      // Get full stats for each user ID
      const leaderboard = await this.getUserStatsForIds(userIds);

      // Get scores from the same sorted set to ensure consistency
      const scoresMap = await kvStore.getScoresFromSortedSet('LEADERBOARD_EARNINGS', userIds);

      // Add rank and use the actual scores from Redis
      return leaderboard.map((entry, index) => {
        return {
          ...entry,
          rank: index + 1,
          score: scoresMap[entry.userId] || this.calculateUserScore(entry)
        };
      });
    } catch (error) {
      console.error('Error getting top earners:', error);
      return [];
    }
  },

  // Get top leaderboard entries by accuracy
  async getTopAccuracy(limit: number = 10): Promise<LeaderboardEntry[]> {
    try {
      // Get top user IDs sorted by accuracy (highest first)
      const userIds = await kvStore.getTopFromSortedSet('LEADERBOARD_ACCURACY', limit);

      // Get full stats for each user ID
      const leaderboard = await this.getUserStatsForIds(userIds);

      // Get scores from the same sorted set to ensure consistency
      const scoresMap = await kvStore.getScoresFromSortedSet('LEADERBOARD_ACCURACY', userIds);

      // Add rank and use the actual scores from Redis
      return leaderboard.map((entry, index) => {
        return {
          ...entry,
          rank: index + 1,
          score: scoresMap[entry.userId] || this.calculateUserScore(entry)
        };
      });
    } catch (error) {
      console.error('Error getting top accuracy:', error);
      return [];
    }
  },

  // Get top leaderboard entries by combined score
  async getLeaderboard(limit: number = 10): Promise<LeaderboardEntry[]> {
    try {
      // Get top user IDs sorted by combined score (highest first)
      const userIds = await kvStore.getTopFromSortedSet('LEADERBOARD', limit);

      // Get full stats for each user ID
      const leaderboard = await this.getUserStatsForIds(userIds);

      // Get scores from the same sorted set to ensure consistency
      const scoresMap = await kvStore.getScoresFromSortedSet('LEADERBOARD', userIds);

      // Add rank and use the actual scores from Redis
      return leaderboard.map((entry, index) => {
        return {
          ...entry,
          rank: index + 1,
          score: scoresMap[entry.userId] || this.calculateUserScore(entry)
        };
      });
    } catch (error) {
      console.error('Error getting leaderboard:', error);
      return [];
    }
  },

  // Helper to get multiple user stats by IDs
  async getUserStatsForIds(userIds: string[]): Promise<UserStats[]> {
    try {
      if (userIds.length === 0) return [];

      // Get stats for each user ID
      const statsPromises = userIds.map(id => this.getUserStats(id));
      const statsResults = await Promise.all(statsPromises);

      // Filter out any null results
      return statsResults.filter(Boolean) as UserStats[];
    } catch (error) {
      console.error('Error getting user stats for IDs:', error);
      return [];
    }
  }
};