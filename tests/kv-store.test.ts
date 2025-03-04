import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getKey, KV_PREFIXES } from '../src/kv-store';

// Mock the @vercel/kv module
vi.mock('@vercel/kv', () => ({
  kv: {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    sadd: vi.fn(),
    srem: vi.fn(),
    smembers: vi.fn(),
    sismember: vi.fn(),
    zadd: vi.fn(),
    zrange: vi.fn(),
    zscore: vi.fn(),
    keys: vi.fn(),
    exists: vi.fn()
  }
}));

describe('KV Store', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should generate correct keys for entities', () => {
    expect(getKey('MARKET', '123')).toBe('market:123');
    expect(getKey('USER_STATS', 'user1')).toBe('user_stats:user1');
    expect(getKey('MARKET_IDS')).toBe('market_ids');
  });

  it('should have all expected KV prefixes defined', () => {
    expect(KV_PREFIXES.MARKET).toBe('market');
    expect(KV_PREFIXES.USER_PREDICTIONS).toBe('user_predictions');
    expect(KV_PREFIXES.LEADERBOARD).toBe('leaderboard');
    // Add more as needed
  });
});