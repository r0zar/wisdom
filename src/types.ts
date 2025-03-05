/**
 * Centralized type definitions to eliminate circular dependencies
 * 
 * This file contains all shared types used across multiple modules.
 * No implementation code should be in this file - only type definitions.
 */

// Market-related types
export interface MarketOutcome {
  id: number;
  name: string;
  votes?: number;
  amount?: number; // Total amount staked on this outcome
  isWinner?: boolean;
}

export interface Market {
  id: string;
  type: 'binary' | 'multiple';
  name: string;
  description: string;
  createdBy: string;
  outcomes: MarketOutcome[];
  category: string;
  endDate: string;
  createdAt: string;
  updatedAt?: string;
  imageUrl?: string;
  participants?: number;
  poolAmount?: number;
  status: 'draft' | 'active' | 'resolved' | 'cancelled';
  resolvedOutcomeId?: number; // The ID of the winning outcome
  resolvedAt?: string; // When the market was resolved
  resolvedBy?: string; // Admin who resolved the market
  adminFee?: number; // 5% fee taken by admin on resolution
  remainingPot?: number; // Pot after admin fee
  totalWinningAmount?: number; // Total amount staked on winning outcome
}

// Prediction-related types
export interface PredictionNFTReceipt {
  id: string;
  tokenId: string;
  image: string;
  predictionId: string;
  marketName: string;
  outcomeName: string;
  amount: number;
  createdAt: string;
}

export interface Prediction {
  id: string;
  marketId: string;
  outcomeId: number;
  outcomeName: string;
  userId: string;
  amount: number;
  createdAt: string;
  nftReceipt: PredictionNFTReceipt;
  status: 'active' | 'won' | 'lost' | 'redeemed' | 'cancelled';
  potentialPayout?: number;
  resolvedAt?: string;
  redeemedAt?: string;
}

// User balance types
export interface UserBalance {
  userId: string;
  availableBalance: number;
  totalDeposited: number;
  totalWithdrawn: number;
  inPredictions: number;
  lastUpdated: string;
}

// User stats types
export interface UserStats {
  userId: string;
  username?: string;
  totalPredictions: number;
  correctPredictions: number;
  accuracy: number;
  totalAmount: number;
  totalEarnings: number;
  lastUpdated: string;
}

export interface LeaderboardEntry extends UserStats {
  rank?: number;
  score?: number;
}

// Bug report types
export interface BugReport {
  id: string;
  title: string;
  description: string;
  severity: string;
  url?: string;
  createdBy: string;
  createdAt: string;
  status: 'open' | 'in-progress' | 'resolved' | 'closed';
  updatedAt?: string;
  updatedBy?: string;
  resolution?: string;
  // Reward-related fields
  initialRewardPaid?: boolean;
  confirmationRewardPaid?: boolean;
  // Confirmation-related fields
  confirmedBy?: string;
  confirmedAt?: string;
}

// Service interfaces - these define the shape of each service without implementation details
export interface IMarketStore {
  getMarkets(): Promise<Market[]>;
  getMarket(id: string): Promise<Market | undefined>;
  createMarket(data: any): Promise<Market>;
  updateMarket(id: string, data: Partial<Market>): Promise<Market | undefined>;
  deleteMarket(id: string): Promise<boolean>;
  resolveMarketWithPayouts(
    marketId: string,
    winningOutcomeId: number,
    adminId: string
  ): Promise<{
    success: boolean;
    market?: Market;
    adminFee?: number;
    error?: string;
    predictions?: Record<string, unknown>[];
  }>;
}

export interface IPredictionStore {
  createPrediction(data: any): Promise<Prediction>;
  getUserPredictions(userId: string): Promise<Prediction[]>;
  getMarketPredictions(marketId: string): Promise<Prediction[]>;
  getPrediction(id: string): Promise<Prediction | undefined>;
  updatePrediction(predictionId: string, data: Partial<Prediction>): Promise<Prediction | null>;
}

export interface IUserBalanceStore {
  getUserBalance(userId: string): Promise<UserBalance | null>;
  addFunds(userId: string, amount: number): Promise<UserBalance | null>;
}

export interface IUserStatsStore {
  getUserStats(userId: string): Promise<UserStats | null>;
  updateStatsForNewPrediction(userId: string, prediction: Prediction): Promise<UserStats>;
  updateStatsForResolvedPrediction(
    userId: string,
    prediction: Prediction,
    isCorrect: boolean,
    earnings: number
  ): Promise<UserStats>;
}

export interface IBugReportStore {
  getBugReport(id: string): Promise<BugReport | null>;
}