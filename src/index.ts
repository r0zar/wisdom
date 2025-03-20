// Export all public API

// KV Store
export * from './kv-store';

// Export individual stores for convenience
export { marketStore } from './market-store';
export { predictionStore } from './prediction-store';
export { userStatsStore } from './user-stats-store';
export { userBalanceStore } from './user-balance-store';
export { bugReportStore } from './bug-report-store';
export { custodyStore } from './custody-store';
export { predictionContractStore } from './prediction-contract-store';


// Utilities
export * from './utils';
export * from './logger';

// Re-export store types for better IntelliSense
export type * from './market-store';
export type * from './prediction-store';
export type * from './user-stats-store';
export type * from './user-balance-store';
export type * from './bug-report-store';
export type * from './custody-store';
export type * from './prediction-contract-store';

// Export query types
export type {
  MarketQueryOptions,
  PaginatedResult,
  MarketStatus,
  MarketType,
  SortField,
  SortDirection,
} from './utils';

// Export query functions
export {
  filterMarkets,
  sortMarkets,
  paginateResults,
  searchMarketText
} from './utils';