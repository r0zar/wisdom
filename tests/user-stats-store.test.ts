import { describe, it, expect, vi, beforeEach } from 'vitest';
import { userStatsStore, UserStats } from '../src/user-stats-store';
import * as kvStore from '../src/kv-store';

// Mock the kv-store module
vi.mock('../src/kv-store', () => ({
  getEntity: vi.fn(),
  storeEntity: vi.fn(),
  addToSortedSet: vi.fn(),
  getTopFromSortedSet: vi.fn(),
  getScoresFromSortedSet: vi.fn()
}));

describe('User Stats Store', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should have required methods', () => {
    expect(typeof userStatsStore.getUserStats).toBe('function');
    expect(typeof userStatsStore.updateStatsForNewPrediction).toBe('function');
    expect(typeof userStatsStore.updateStatsForResolvedPrediction).toBe('function');
    expect(typeof userStatsStore.getLeaderboard).toBe('function');
    expect(typeof userStatsStore.getTopEarners).toBe('function');
    expect(typeof userStatsStore.getTopAccuracy).toBe('function');
  });

  it('should calculate user score correctly', () => {
    const mockStats: UserStats = {
      userId: 'user123',
      totalPredictions: 20,
      correctPredictions: 15,
      accuracy: 75,
      totalAmount: 1000,
      totalEarnings: 500,
      lastUpdated: new Date().toISOString()
    };
    
    const score = userStatsStore.calculateUserScore(mockStats);
    
    expect(score).toBeGreaterThan(0);
    expect(typeof score).toBe('number');
  });

  it('should handle users with few predictions properly in score calculation', () => {
    const newUserStats: UserStats = {
      userId: 'newUser',
      totalPredictions: 2,
      correctPredictions: 2,
      accuracy: 100,  // High accuracy but few predictions
      totalAmount: 100,
      totalEarnings: 50,
      lastUpdated: new Date().toISOString()
    };
    
    const experiencedUserStats: UserStats = {
      userId: 'expUser',
      totalPredictions: 50,
      correctPredictions: 35,
      accuracy: 70,  // Lower accuracy but more predictions
      totalAmount: 5000,
      totalEarnings: 2500,
      lastUpdated: new Date().toISOString()
    };
    
    const newUserScore = userStatsStore.calculateUserScore(newUserStats);
    const expUserScore = userStatsStore.calculateUserScore(experiencedUserStats);
    
    // Experienced user should have higher score because of volume factors
    expect(expUserScore).toBeGreaterThan(newUserScore);
  });
});