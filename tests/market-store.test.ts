import { describe, it, expect, vi, beforeEach } from 'vitest';
import { marketStore, Market } from '../src/market-store';
import * as kvStore from '../src/kv-store';

// Mock the kv-store module
vi.mock('../src/kv-store', () => ({
  getSetMembers: vi.fn(),
  getEntity: vi.fn(),
  storeEntity: vi.fn(),
  addToSet: vi.fn(),
  removeFromSet: vi.fn(),
  isSetMember: vi.fn(),
  deleteEntity: vi.fn()
}));

// Mock crypto for deterministic UUIDs
vi.mock('crypto', () => ({
  default: {
    randomUUID: () => 'mocked-uuid'
  }
}));

describe('Market Store', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should have required methods', () => {
    expect(typeof marketStore.getMarkets).toBe('function');
    expect(typeof marketStore.getMarket).toBe('function');
    expect(typeof marketStore.createMarket).toBe('function');
    expect(typeof marketStore.updateMarket).toBe('function');
    expect(typeof marketStore.deleteMarket).toBe('function');
  });

  it('should calculate similarity between markets', () => {
    const market1: Market = {
      id: '1',
      type: 'binary',
      name: 'Bitcoin price prediction',
      description: 'Will Bitcoin reach $100,000?',
      createdBy: 'user1',
      outcomes: [{ id: 1, name: 'Yes' }, { id: 2, name: 'No' }],
      category: 'crypto',
      endDate: '2025-01-01',
      createdAt: '2023-01-01',
      status: 'active'
    };

    const market2: Market = {
      id: '2',
      type: 'binary',
      name: 'Bitcoin prediction',
      description: 'Will BTC reach $90,000?',
      createdBy: 'user2',
      outcomes: [{ id: 1, name: 'Yes' }, { id: 2, name: 'No' }],
      category: 'crypto',
      endDate: '2025-01-01',
      createdAt: '2023-01-01',
      status: 'active'
    };

    const similarity = marketStore.calculateSimilarity(market1, market2);
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThanOrEqual(1);
  });
});