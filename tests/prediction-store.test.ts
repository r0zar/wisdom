import { describe, it, expect, vi, beforeEach } from 'vitest';
import { predictionStore, Prediction } from '../src/prediction-store';
import * as kvStore from '../src/kv-store';

// Mock the kv-store module
vi.mock('../src/kv-store', () => ({
  getSetMembers: vi.fn(),
  getEntity: vi.fn(),
  storeEntity: vi.fn(),
  addToSet: vi.fn(),
  removeFromSet: vi.fn(),
  deleteEntity: vi.fn()
}));

// Mock crypto for deterministic UUIDs
vi.mock('crypto', () => ({
  default: {
    randomUUID: vi.fn().mockReturnValue('mocked-uuid')
  }
}));

// Mock dependent modules
vi.mock('../src/market-store', () => ({
  marketStore: {
    getMarket: vi.fn(),
    updateMarketStats: vi.fn()
  }
}));

vi.mock('../src/user-balance-store', () => ({
  userBalanceStore: {
    updateBalanceForPrediction: vi.fn(),
    updateBalanceForResolvedPrediction: vi.fn()
  }
}));

vi.mock('../src/user-stats-store', () => ({
  userStatsStore: {
    updateStatsForNewPrediction: vi.fn()
  }
}));

describe('Prediction Store', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should have required methods', () => {
    expect(typeof predictionStore.createPrediction).toBe('function');
    expect(typeof predictionStore.getUserPredictions).toBe('function');
    expect(typeof predictionStore.getMarketPredictions).toBe('function');
    expect(typeof predictionStore.getPrediction).toBe('function');
    expect(typeof predictionStore.deletePrediction).toBe('function');
  });

  it('should generate an NFT image', () => {
    const image = predictionStore.generateNftImage('Test Market', 'Yes', 100);
    expect(image).toContain('data:image/svg+xml');
    // Since the data is URL encoded, we'll check for general structure rather than exact content
    expect(image).toContain('svg');
    expect(image).toContain('Prediction');
  });
});