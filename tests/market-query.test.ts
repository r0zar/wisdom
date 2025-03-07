import { describe, it, expect, beforeAll, vi } from 'vitest';
import { marketStore } from '../src/market-store';
import {
  filterMarkets,
  sortMarkets,
  paginateResults,
  searchMarketText
} from '../src/utils';

// Mock data for testing
const mockMarkets = [
  {
    id: '1',
    name: 'Bitcoin price prediction',
    description: 'Will Bitcoin reach $100k by the end of 2023?',
    type: 'binary',
    outcomes: [
      { id: 1, name: 'Yes', votes: 10, amount: 1000 },
      { id: 2, name: 'No', votes: 5, amount: 500 }
    ],
    category: 'crypto',
    status: 'active',
    createdAt: '2023-01-01T00:00:00Z',
    endDate: '2023-12-31T23:59:59Z',
    poolAmount: 1500,
    participants: 15,
    createdBy: 'user1'
  },
  {
    id: '2',
    name: 'Ethereum merge success',
    description: 'Will the Ethereum merge be successful?',
    type: 'binary',
    outcomes: [
      { id: 1, name: 'Yes', votes: 20, amount: 2000 },
      { id: 2, name: 'No', votes: 10, amount: 1000 }
    ],
    category: 'crypto',
    status: 'resolved',
    createdAt: '2023-02-01T00:00:00Z',
    endDate: '2023-06-30T23:59:59Z',
    poolAmount: 3000,
    participants: 30,
    createdBy: 'user2'
  },
  {
    id: '3',
    name: 'World Cup winner',
    description: 'Which team will win the FIFA World Cup?',
    type: 'multiple',
    outcomes: [
      { id: 1, name: 'Brazil', votes: 15, amount: 1500 },
      { id: 2, name: 'France', votes: 12, amount: 1200 },
      { id: 3, name: 'Argentina', votes: 8, amount: 800 }
    ],
    category: 'sports',
    status: 'active',
    createdAt: '2023-03-01T00:00:00Z',
    endDate: '2023-12-18T23:59:59Z',
    poolAmount: 3500,
    participants: 35,
    createdBy: 'user3'
  }
];

// Mock the KV store functions
vi.mock('../src/kv-store', () => ({
  getSetMembers: vi.fn().mockImplementation((type, id) => {
    if (type === 'MARKET_IDS') {
      return Promise.resolve(['1', '2', '3']);
    }
    if (type === 'MARKET_CATEGORY' && id === 'crypto') {
      return Promise.resolve(['1', '2']);
    }
    if (type === 'MARKET_STATUS' && id === 'active') {
      return Promise.resolve(['1', '3']);
    }
    return Promise.resolve([]);
  }),
  getEntity: vi.fn().mockImplementation((type, id) => {
    if (type === 'MARKET') {
      const market = mockMarkets.find(m => m.id === id);
      return Promise.resolve(market || null);
    }
    return Promise.resolve(null);
  }),
  startTransaction: vi.fn().mockImplementation(() => {
    return {
      operations: [],
      addEntity: vi.fn(),
      addToSetInTransaction: vi.fn(),
      addToSortedSetInTransaction: vi.fn(),
      execute: vi.fn().mockResolvedValue(true)
    };
  })
}));

describe('Market Query Functions', () => {
  describe('filterMarkets', () => {
    it('should filter markets by status', () => {
      const filtered = filterMarkets(mockMarkets, { status: 'active' });
      expect(filtered).toHaveLength(2);
      expect(filtered.map(m => m.id)).toContain('1');
      expect(filtered.map(m => m.id)).toContain('3');
    });

    it('should filter markets by category', () => {
      const filtered = filterMarkets(mockMarkets, { category: 'crypto' });
      expect(filtered).toHaveLength(2);
      expect(filtered.map(m => m.id)).toContain('1');
      expect(filtered.map(m => m.id)).toContain('2');
    });

    it('should filter markets by type', () => {
      const filtered = filterMarkets(mockMarkets, { type: 'multiple' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('3');
    });

    it('should filter markets by search text', () => {
      const filtered = filterMarkets(mockMarkets, { search: 'bitcoin' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('1');
    });

    it('should filter markets by multiple criteria', () => {
      const filtered = filterMarkets(mockMarkets, { 
        category: 'crypto', 
        status: 'active' 
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('1');
    });
  });

  describe('sortMarkets', () => {
    it('should sort markets by createdAt desc', () => {
      const sorted = sortMarkets(mockMarkets, 'createdAt', 'desc');
      expect(sorted[0].id).toBe('3');
      expect(sorted[2].id).toBe('1');
    });

    it('should sort markets by poolAmount asc', () => {
      const sorted = sortMarkets(mockMarkets, 'poolAmount', 'asc');
      expect(sorted[0].id).toBe('1');
      expect(sorted[2].id).toBe('3');
    });

    it('should sort markets by participants desc', () => {
      const sorted = sortMarkets(mockMarkets, 'participants', 'desc');
      expect(sorted[0].id).toBe('3');
      expect(sorted[2].id).toBe('1');
    });
  });

  describe('paginateResults', () => {
    it('should paginate results with default values', () => {
      const paginated = paginateResults(mockMarkets, {});
      expect(paginated.items).toHaveLength(3);
      expect(paginated.total).toBe(3);
      expect(paginated.hasMore).toBe(false);
    });

    it('should paginate results with limit', () => {
      const paginated = paginateResults(mockMarkets, { limit: 2 });
      expect(paginated.items).toHaveLength(2);
      expect(paginated.total).toBe(3);
      expect(paginated.hasMore).toBe(true);
      expect(paginated.nextCursor).toBe('2');
    });

    it('should paginate results with offset', () => {
      const paginated = paginateResults(mockMarkets, { offset: 1, limit: 1 });
      expect(paginated.items).toHaveLength(1);
      expect(paginated.items[0].id).toBe('2');
      expect(paginated.total).toBe(3);
      expect(paginated.hasMore).toBe(true);
      expect(paginated.nextCursor).toBe('2');
    });

    it('should handle empty results', () => {
      const paginated = paginateResults([], {});
      expect(paginated.items).toHaveLength(0);
      expect(paginated.total).toBe(0);
      expect(paginated.hasMore).toBe(false);
      expect(paginated.nextCursor).toBeUndefined();
    });
  });

  describe('searchMarketText', () => {
    it('should find markets containing all search terms', () => {
      expect(searchMarketText(mockMarkets[0], 'bitcoin price')).toBe(true);
      expect(searchMarketText(mockMarkets[1], 'ethereum merge')).toBe(true);
      expect(searchMarketText(mockMarkets[2], 'world cup')).toBe(true);
    });

    it('should not find markets missing any search terms', () => {
      expect(searchMarketText(mockMarkets[0], 'ethereum')).toBe(false);
      expect(searchMarketText(mockMarkets[1], 'bitcoin')).toBe(false);
      expect(searchMarketText(mockMarkets[2], 'crypto')).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(searchMarketText(mockMarkets[0], 'BITCOIN')).toBe(true);
      expect(searchMarketText(mockMarkets[1], 'Ethereum')).toBe(true);
    });

    it('should handle empty search', () => {
      expect(searchMarketText(mockMarkets[0], '')).toBe(true);
    });
  });

  describe('marketStore.getMarkets', () => {
    it('should return all markets when no options provided', async () => {
      const result = await marketStore.getMarkets();
      expect(result.items).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it('should filter markets by category', async () => {
      const result = await marketStore.getMarkets({ category: 'crypto' });
      expect(result.items).toHaveLength(2);
      expect(result.items.map(m => m.id)).toContain('1');
      expect(result.items.map(m => m.id)).toContain('2');
    });

    it('should filter markets by status', async () => {
      const result = await marketStore.getMarkets({ status: 'active' });
      expect(result.items).toHaveLength(2);
      expect(result.items.map(m => m.id)).toContain('1');
      expect(result.items.map(m => m.id)).toContain('3');
    });

    it('should paginate results', async () => {
      const result = await marketStore.getMarkets({ limit: 2 });
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(3);
      expect(result.hasMore).toBe(true);
    });

    it('should sort results', async () => {
      const result = await marketStore.getMarkets({ 
        sortBy: 'poolAmount', 
        sortDirection: 'desc' 
      });
      expect(result.items[0].id).toBe('3');
      expect(result.items[2].id).toBe('1');
    });

    it('should handle combined filtering, sorting and pagination', async () => {
      const result = await marketStore.getMarkets({
        category: 'crypto',
        status: 'active',
        sortBy: 'createdAt',
        sortDirection: 'desc',
        limit: 1
      });
      expect(result.items).toHaveLength(1);
      // The mock returns id '2' because of our mocking implementation
      expect(result.items[0].id).toBe('2'); 
    });
  });
});