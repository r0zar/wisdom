import { describe, it, expect, vi, beforeEach } from 'vitest';
import { userBalanceStore, UserBalance } from '../src/user-balance-store';
import * as kvStore from '../src/kv-store';

// Mock the kv-store module
vi.mock('../src/kv-store', () => ({
  getEntity: vi.fn(),
  storeEntity: vi.fn()
}));

describe('User Balance Store', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should have required methods', () => {
    expect(typeof userBalanceStore.getUserBalance).toBe('function');
    expect(typeof userBalanceStore.initializeUserBalance).toBe('function');
    expect(typeof userBalanceStore.updateBalanceForPrediction).toBe('function');
    expect(typeof userBalanceStore.updateBalanceForResolvedPrediction).toBe('function');
    expect(typeof userBalanceStore.addFunds).toBe('function');
    expect(typeof userBalanceStore.withdrawFunds).toBe('function');
  });

  it('should initialize new users with default balance', async () => {
    // Setup mock
    const mockUserId = 'user123';
    vi.mocked(kvStore.storeEntity).mockResolvedValueOnce({ userId: mockUserId } as any);
    
    const result = await userBalanceStore.initializeUserBalance(mockUserId);
    
    expect(result).toHaveProperty('userId', mockUserId);
    expect(result).toHaveProperty('availableBalance', 1000);
    expect(result).toHaveProperty('totalDeposited', 1000);
    expect(result).toHaveProperty('inPredictions', 0);
    expect(kvStore.storeEntity).toHaveBeenCalledWith('USER_BALANCE', mockUserId, expect.anything());
  });
});