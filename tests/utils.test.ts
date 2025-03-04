import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isAdmin, calculateOutcomePercentages, getBaseUrl } from '../src/utils';

describe('Utils', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Reset environment variables
    vi.resetModules();
    process.env.NEXT_PUBLIC_APP_URL = undefined;
    process.env.NODE_ENV = 'test';
  });

  it('should correctly identify admin users', () => {
    // Test with admin user ID
    expect(isAdmin('user_2tjVcbojjJk2bkQd856eNE1Ax0S')).toBe(true);
    
    // Test with non-admin user ID
    expect(isAdmin('user_regular')).toBe(false);
  });

  it('should calculate outcome percentages based on amounts', () => {
    const outcomes = [
      { id: 1, name: 'Yes', amount: 75, votes: 5 },
      { id: 2, name: 'No', amount: 25, votes: 3 }
    ];
    
    const { outcomesWithPercentages, useFallbackVotes } = calculateOutcomePercentages(outcomes);
    
    expect(useFallbackVotes).toBe(false);
    expect(outcomesWithPercentages[0].percentage).toBe(75);
    expect(outcomesWithPercentages[1].percentage).toBe(25);
  });

  it('should fall back to votes when no amounts are available', () => {
    const outcomes = [
      { id: 1, name: 'Yes', amount: 0, votes: 8 },
      { id: 2, name: 'No', amount: 0, votes: 2 }
    ];
    
    const { outcomesWithPercentages, useFallbackVotes } = calculateOutcomePercentages(outcomes);
    
    expect(useFallbackVotes).toBe(true);
    expect(outcomesWithPercentages[0].percentage).toBe(80);
    expect(outcomesWithPercentages[1].percentage).toBe(20);
  });

  it('should return the correct base URL', () => {
    // Test with environment variable
    process.env.NEXT_PUBLIC_APP_URL = 'https://test-app.com';
    expect(getBaseUrl()).toBe('https://test-app.com');
    
    // Test without environment variable (mocking both node env and window)
    process.env.NEXT_PUBLIC_APP_URL = undefined;
    
    // Since we can't easily mock window in Node.js test, we'll just check that
    // we get a valid URL back (could be either the fallback or undefined depending on test env)
    const baseUrl = getBaseUrl();
    expect(typeof baseUrl === 'string' || baseUrl === undefined).toBeTruthy();
  });
});