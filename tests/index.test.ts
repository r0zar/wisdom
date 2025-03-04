import { describe, it, expect } from 'vitest';
import * as sdk from '../src/index';

describe('SDK Exports', () => {
  it('should export all required modules', () => {
    // Stores
    expect(sdk.marketStore).toBeDefined();
    expect(sdk.predictionStore).toBeDefined();
    expect(sdk.userStatsStore).toBeDefined();
    expect(sdk.userBalanceStore).toBeDefined();
    expect(sdk.bugReportStore).toBeDefined();
    
    // KV Store utilities
    expect(sdk.getKey).toBeDefined();
    expect(sdk.KV_PREFIXES).toBeDefined();
    expect(sdk.storeEntity).toBeDefined();
    expect(sdk.getEntity).toBeDefined();
    
    // Utilities
    expect(sdk.isAdmin).toBeDefined();
    expect(sdk.calculateOutcomePercentages).toBeDefined();
    expect(sdk.getBaseUrl).toBeDefined();
    
    // Logger
    expect(sdk.logger).toBeDefined();
    expect(sdk.getContextLogger).toBeDefined();
    expect(sdk.AppError).toBeDefined();
  });
});