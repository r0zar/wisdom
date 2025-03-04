import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bugReportStore, BugReport } from '../src/bug-report-store';
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
    randomUUID: () => 'mocked-uuid'
  }
}));

// Mock user-balance-store to avoid circular dependencies
vi.mock('../src/user-balance-store', () => ({
  userBalanceStore: {
    addFunds: vi.fn().mockResolvedValue({ userId: 'user1', balance: 100 })
  }
}));

describe('Bug Report Store', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should have required methods', () => {
    expect(typeof bugReportStore.getBugReports).toBe('function');
    expect(typeof bugReportStore.getBugReport).toBe('function');
    expect(typeof bugReportStore.createBugReport).toBe('function');
    expect(typeof bugReportStore.updateBugReport).toBe('function');
    expect(typeof bugReportStore.deleteBugReport).toBe('function');
    expect(typeof bugReportStore.processRewardPayment).toBe('function');
  });

  it('should return an empty array when no bug reports exist', async () => {
    vi.mocked(kvStore.getSetMembers).mockResolvedValue([]);
    
    const reports = await bugReportStore.getBugReports();
    
    expect(reports).toEqual([]);
    expect(kvStore.getSetMembers).toHaveBeenCalledWith('BUG_REPORT_IDS', '');
  });
});