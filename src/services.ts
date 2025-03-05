/**
 * Service registry to break circular dependencies
 * 
 * This module provides a central access point to all services in the application.
 * It breaks circular dependencies by allowing modules to import services from here
 * rather than directly from each other.
 */

import { 
  IMarketStore, 
  IPredictionStore, 
  IUserBalanceStore, 
  IUserStatsStore, 
  IBugReportStore
} from './types.js';

// Singleton instances of each service
let _marketStore: IMarketStore | null = null;
let _predictionStore: IPredictionStore | null = null;
let _userBalanceStore: IUserBalanceStore | null = null;
let _userStatsStore: IUserStatsStore | null = null;
let _bugReportStore: IBugReportStore | null = null;

// Register service instances (called by each module during initialization)
export function registerMarketStore(instance: IMarketStore): void {
  _marketStore = instance;
}

export function registerPredictionStore(instance: IPredictionStore): void {
  _predictionStore = instance;
}

export function registerUserBalanceStore(instance: IUserBalanceStore): void {
  _userBalanceStore = instance;
}

export function registerUserStatsStore(instance: IUserStatsStore): void {
  _userStatsStore = instance;
}

export function registerBugReportStore(instance: IBugReportStore): void {
  _bugReportStore = instance;
}

// Access services safely with proper error handling
export function getMarketStore(): IMarketStore {
  if (!_marketStore) {
    throw new Error('MarketStore not initialized. Make sure registerMarketStore has been called.');
  }
  return _marketStore;
}

export function getPredictionStore(): IPredictionStore {
  if (!_predictionStore) {
    throw new Error('PredictionStore not initialized. Make sure registerPredictionStore has been called.');
  }
  return _predictionStore;
}

export function getUserBalanceStore(): IUserBalanceStore {
  if (!_userBalanceStore) {
    throw new Error('UserBalanceStore not initialized. Make sure registerUserBalanceStore has been called.');
  }
  return _userBalanceStore;
}

export function getUserStatsStore(): IUserStatsStore {
  if (!_userStatsStore) {
    throw new Error('UserStatsStore not initialized. Make sure registerUserStatsStore has been called.');
  }
  return _userStatsStore;
}

export function getBugReportStore(): IBugReportStore {
  if (!_bugReportStore) {
    throw new Error('BugReportStore not initialized. Make sure registerBugReportStore has been called.');
  }
  return _bugReportStore;
}