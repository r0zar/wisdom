// Export all public API

// Type definitions
export * from './types.js';

// Service registry
export * from './services.js';

// KV Store
export * from './kv-store.js';

// Import and initialize all services to register them
import { marketStore } from './market-store.js';
import { predictionStore } from './prediction-store.js';
import { userStatsStore } from './user-stats-store.js';
import { userBalanceStore } from './user-balance-store.js';
import { bugReportStore } from './bug-report-store.js';

// Register services with the service registry
import { 
  registerMarketStore,
  registerPredictionStore,
  registerUserStatsStore,
  registerUserBalanceStore,
  registerBugReportStore
} from './services.js';

// Initialize all services
registerMarketStore(marketStore);
registerPredictionStore(predictionStore);
registerUserStatsStore(userStatsStore);
registerUserBalanceStore(userBalanceStore);
registerBugReportStore(bugReportStore);

// Export individual stores for convenience
export { marketStore } from './market-store.js';
export { predictionStore } from './prediction-store.js';
export { userStatsStore } from './user-stats-store.js';
export { userBalanceStore } from './user-balance-store.js';
export { bugReportStore } from './bug-report-store.js';

// Utilities
export * from './utils.js';
export * from './logger.js';