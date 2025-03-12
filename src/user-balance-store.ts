import { fetchCallReadOnlyFunction, Cl, ClarityType } from '@stacks/transactions';
import { STACKS_MAINNET } from '@stacks/network';
import { createClerkClient } from '@clerk/backend';

const CONTRACT_ADDRESS = 'SP2ZNGJ85ENDY6QRHQ5P2D4FXKGZWCKTB2T0Z55KS';
const CONTRACT_NAME = 'blaze-welsh-v1';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY
});

// User balance store with Clerk integration
export const userBalanceStore = {
  /**
   * Get the user's Stacks address from Clerk's publicMetadata
   */
  async getUserStacksAddress(userId: string): Promise<string | null> {
    try {
      // Get the user from Clerk
      const user = await clerkClient.users.getUser(userId);

      // Check for Stacks address in public metadata
      if (user.publicMetadata && typeof user.publicMetadata === 'object') {
        const metadata = user.publicMetadata as Record<string, any>;
        if (metadata.stacksAddress) {
          return metadata.stacksAddress as string;
        }
      }

      // No Stacks address found
      console.warn(`No Stacks address found for user ${userId}`);
      return null;
    } catch (error) {
      console.error(`Error getting Stacks address for user ${userId}:`, error);
      return null;
    }
  },

  /**
   * Fetch a user's on-chain balance from the contract
   */
  async fetchContractBalance(user: string): Promise<number> {
    try {
      const result = await fetchCallReadOnlyFunction({
        contractAddress: CONTRACT_ADDRESS,
        contractName: CONTRACT_NAME,
        functionName: 'get-balance',
        functionArgs: [Cl.principal(user)],
        network: STACKS_MAINNET,
        senderAddress: user
      });
      const balance = result.type === ClarityType.UInt ? Number(result.value) : 0;

      return balance;
    } catch (error: unknown) {
      console.error('Failed to fetch contract balance:', error);
      return 0;
    }
  },

  /**
   * Get user balance using their Clerk ID
   * Fetches directly from blockchain if Stacks address is available
   */
  async getUserBalance(userId: string) {
    try {
      if (!userId) return null;

      // Get stacks address from Clerk
      const stacksAddress = await this.getUserStacksAddress(userId);

      // Get stored balance data
      let balance = await kvStore.getEntity('USER_BALANCE', userId);

      // If no balance exists, initialize it
      if (!balance) {
        balance = {
          userId,
          availableBalance: 0,
          totalDeposited: 0,
          totalWithdrawn: 0,
          inPredictions: 0,
          lastUpdated: new Date().toISOString(),
          stacksAddress: null
        };
      }

      // If we have a Stacks address, update with real blockchain balance
      if (stacksAddress) {
        balance.stacksAddress = stacksAddress;
        const contractBalance = await this.fetchContractBalance(stacksAddress);
        balance.availableBalance = contractBalance;
      }

      return balance;
    } catch (error) {
      console.error(`Error getting user balance for ${userId}:`, error);
      return null;
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
  },

  // Force refresh a user's balance from the blockchain
  async refreshBalance(userId: string) {
    try {
      const stacksAddress = await this.getUserStacksAddress(userId);
      if (!stacksAddress) {
        throw new Error(`No Stacks address found for user ${userId}`);
      }

      const contractBalance = await this.fetchContractBalance(stacksAddress);
      const balance = await kvStore.getEntity('USER_BALANCE', userId) || {
        userId,
        availableBalance: 0,
        totalDeposited: 0,
        totalWithdrawn: 0,
        inPredictions: 0,
        lastUpdated: new Date().toISOString()
      };

      const updatedBalance = {
        ...balance,
        availableBalance: contractBalance,
        stacksAddress,
        lastUpdated: new Date().toISOString()
      };

      await kvStore.storeEntity('USER_BALANCE', userId, updatedBalance);
      return updatedBalance;
    } catch (error) {
      console.error(`Error refreshing balance for user ${userId}:`, error);
      throw error;
    }
  }
};

const kvStore = {
  async getEntity(collection: string, id: string) {
    console.log({ collection, id });
    // Get the user's Stacks address
    const stacksAddress = await userBalanceStore.getUserStacksAddress(id);

    let availableBalance = 0;
    if (stacksAddress) {
      availableBalance = await userBalanceStore.fetchContractBalance(stacksAddress);
    }

    const balance = {
      userId: id,
      availableBalance,
      totalDeposited: 0,
      totalWithdrawn: 0,
      inPredictions: 0,
      lastUpdated: new Date().toISOString(),
      stacksAddress
    };
    return balance;
  },

  async storeEntity(collection: string, id: string, entity: any) {
    console.log({ collection, id, entity });
    return null;
  }
};