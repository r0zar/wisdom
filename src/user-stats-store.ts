import * as kvStore from './kv-store';

// User stats store with Vercel KV
export const userStatsStore = {
  // Helper to calculate user score consistently across the app
  calculateUserScore(stats: any): number {
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
  async getUserStats(userId: string) {
    try {
      if (!userId) return null;

      const stats = await kvStore.getEntity('USER_STATS', userId);
      return stats || null;
    } catch (error) {
      console.error(`Error getting user stats for ${userId}:`, error);
      return null;
    }
  },

  // Update user stats when a prediction is made
  async updateStatsForNewPrediction(userId: string, prediction: any) {
    try {
      // Get current stats or create new ones
      const currentStats: any = await this.getUserStats(userId) || {
        userId,
        totalPredictions: 0,
        correctPredictions: 0,
        accuracy: 0,
        totalAmount: 0,
        totalEarnings: 0,
        lastUpdated: new Date().toISOString()
      };

      // Update stats
      const updatedStats = {
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
    prediction: any,
    isCorrect: boolean,
    earnings: number
  ) {
    try {
      // Handle anonymous/test users specially
      if (!userId || userId === 'anonymous') {
        console.log(`Skipping stats update for anonymous user`);
        return {
          userId,
          totalPredictions: 1,
          correctPredictions: isCorrect ? 1 : 0,
          accuracy: isCorrect ? 100 : 0,
          totalAmount: prediction?.amount || 0,
          totalEarnings: earnings,
          lastUpdated: new Date().toISOString()
        };
      }

      // Get current stats
      const currentStats: any = await this.getUserStats(userId);
      if (!currentStats) {
        console.log(`Creating new stats for user ${userId}`);
        // Create default stats if not found
        const newStats = {
          userId,
          totalPredictions: 1,
          correctPredictions: isCorrect ? 1 : 0,
          accuracy: isCorrect ? 100 : 0,
          totalAmount: prediction?.amount || 0,
          totalEarnings: earnings,
          lastUpdated: new Date().toISOString()
        };
        
        // Store new stats
        await kvStore.storeEntity('USER_STATS', userId, newStats);
        
        // Update leaderboard sorted sets
        await this.updateLeaderboardEntries(newStats);
        
        return newStats;
      }

      // Update stats
      const updatedStats = {
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
  async updateUsername(userId: string, username: string) {
    try {
      const stats: any = await this.getUserStats(userId);
      if (!stats) return null;

      const updatedStats = {
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
  async updateLeaderboardEntries(stats: any): Promise<void> {
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
  async getTopEarners(limit: number = 10) {
    try {
      // Get top user IDs sorted by earnings (highest first)
      const userIds = await kvStore.getTopFromSortedSet('LEADERBOARD_EARNINGS', limit);

      // Get full stats for each user ID
      const leaderboard = await this.getUserStatsForIds(userIds);

      // Get scores from the same sorted set to ensure consistency
      const scoresMap = await kvStore.getScoresFromSortedSet('LEADERBOARD_EARNINGS', userIds);

      // Add rank and use the actual scores from Redis
      return leaderboard.map((entry: any, index) => {
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
  async getTopAccurate(limit: number = 10) {
    try {
      // Get top user IDs sorted by accuracy (highest first)
      const userIds = await kvStore.getTopFromSortedSet('LEADERBOARD_ACCURACY', limit);

      // Get full stats for each user ID
      const leaderboard = await this.getUserStatsForIds(userIds);

      // Get scores from the same sorted set to ensure consistency
      const scoresMap = await kvStore.getScoresFromSortedSet('LEADERBOARD_ACCURACY', userIds);

      // Add rank and use the actual scores from Redis
      return leaderboard.map((entry: any, index) => {
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
  async getTopUsers(limit: number = 10) {
    try {
      // Get top user IDs sorted by combined score (highest first)
      const userIds = await kvStore.getTopFromSortedSet('LEADERBOARD', limit);

      // Get full stats for each user ID
      const leaderboard = await this.getUserStatsForIds(userIds);

      // Get scores from the same sorted set to ensure consistency
      const scoresMap = await kvStore.getScoresFromSortedSet('LEADERBOARD', userIds);

      // Add rank and use the actual scores from Redis
      return leaderboard.map((entry: any, index) => {
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
  async getUserStatsForIds(userIds: string[]) {
    try {
      if (userIds.length === 0) return [];

      // Get stats for each user ID
      const statsPromises = userIds.map(id => this.getUserStats(id));
      const statsResults = await Promise.all(statsPromises);

      // Filter out any null results
      return statsResults.filter(Boolean);
    } catch (error) {
      console.error('Error getting user stats for IDs:', error);
      return [];
    }
  }
};