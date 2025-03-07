import * as kvStore from './kv-store';

// Default starting balance for new users
const DEFAULT_STARTING_BALANCE = 1000;

// User balance store with Vercel KV
export const userBalanceStore = {
  // Get user balance for a specific user
  async getUserBalance(userId: string) {
    try {
      if (!userId) return null;

      let balance = await kvStore.getEntity('USER_BALANCE', userId);

      // If no balance exists, initialize with default balance
      if (!balance) {
        balance = await this.createUserBalance(userId);
      }

      return balance;
    } catch (error) {
      console.error(`Error getting user balance for ${userId}:`, error);
      return null;
    }
  },

  // Initialize a new user with default balance
  async createUserBalance(userId: string) {
    try {
      const newBalance = {
        userId,
        availableBalance: DEFAULT_STARTING_BALANCE,
        totalDeposited: DEFAULT_STARTING_BALANCE, // Initial $1000 counts as a deposit
        totalWithdrawn: 0,
        inPredictions: 0,
        lastUpdated: new Date().toISOString()
      };

      await kvStore.storeEntity('USER_BALANCE', userId, newBalance);
      return newBalance;
    } catch (error) {
      console.error(`Error initializing user balance for ${userId}:`, error);
      throw error;
    }
  },

  // Update user balance when making a prediction
  async updateBalanceForPrediction(userId: string, amount: number) {
    try {
      const balance: any = await this.getUserBalance(userId);
      if (!balance) return null;

      // Check if user has enough balance
      if (balance.availableBalance < amount) {
        throw new Error('Insufficient balance');
      }

      const updatedBalance = {
        ...balance,
        availableBalance: balance.availableBalance - amount,
        inPredictions: balance.inPredictions + amount,
        lastUpdated: new Date().toISOString()
      };

      await kvStore.storeEntity('USER_BALANCE', userId, updatedBalance);
      return updatedBalance;
    } catch (error) {
      console.error(`Error updating balance for prediction, user ${userId}:`, error);
      throw error;
    }
  },

  // Update user balance when a prediction is resolved
  async updateBalanceForResolvedPrediction(
    userId: string,
    originalAmount: number,
    winnings: number = 0
  ) {
    try {
      const balance: any = await this.getUserBalance(userId);
      if (!balance) return null;

      const updatedBalance = {
        ...balance,
        availableBalance: balance.availableBalance + winnings,
        inPredictions: balance.inPredictions - originalAmount,
        lastUpdated: new Date().toISOString()
      };

      await kvStore.storeEntity('USER_BALANCE', userId, updatedBalance);
      return updatedBalance;
    } catch (error) {
      console.error(`Error updating balance for resolved prediction, user ${userId}:`, error);
      throw error;
    }
  },

  // Add funds to user balance (for deposit functionality)
  async addFunds(userId: string, amount: number) {
    try {
      const balance: any = await this.getUserBalance(userId);
      if (!balance) return null;

      const updatedBalance = {
        ...balance,
        availableBalance: balance.availableBalance + amount,
        totalDeposited: balance.totalDeposited + amount,
        lastUpdated: new Date().toISOString()
      };

      await kvStore.storeEntity('USER_BALANCE', userId, updatedBalance);
      return updatedBalance;
    } catch (error) {
      console.error(`Error adding funds for user ${userId}:`, error);
      throw error;
    }
  },

  // Withdraw funds from user balance
  async withdrawFunds(userId: string, amount: number) {
    try {
      const balance: any = await this.getUserBalance(userId);
      if (!balance) return null;

      // Check if user has enough balance
      if (balance.availableBalance < amount) {
        throw new Error('Insufficient balance');
      }

      const updatedBalance = {
        ...balance,
        availableBalance: balance.availableBalance - amount,
        totalWithdrawn: balance.totalWithdrawn + amount,
        lastUpdated: new Date().toISOString()
      };

      await kvStore.storeEntity('USER_BALANCE', userId, updatedBalance);
      return updatedBalance;
    } catch (error) {
      console.error(`Error withdrawing funds for user ${userId}:`, error);
      throw error;
    }
  }
};