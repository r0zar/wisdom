/**
 * Utility functions for OP Predict
 */

// Admin user IDs
export const ADMIN_USER_IDS = [
  'user_2tjVcbojjJk2bkQd856eNE1Ax0S', // rozar
  'user_2tkBcBEVGanm3LHkg6XK7j91DRj', // kraken
];

// Check if a user is an admin
export function isAdmin(userId: string): boolean {
  return ADMIN_USER_IDS.includes(userId);
}

/**
 * Generates a UUID using the Web Crypto API which is available in both
 * Node.js and edge runtime environments. This replaces the Node.js-specific
 * crypto.randomUUID() function.
 * 
 * @returns A UUID v4 string
 */
export function generateUUID(): string {
  // Use crypto.randomUUID() from Web Crypto API if available (modern browsers and Node.js 16+)
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  
  // Fallback implementation for environments where crypto.randomUUID() is not available
  // Based on the RFC4122 specification for UUID v4
  const getRandomBytes = (n: number): Uint8Array => {
    const bytes = new Uint8Array(n);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
    } else {
      // Final fallback for extremely unlikely case - not cryptographically secure
      for (let i = 0; i < n; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return bytes;
  };

  const randomBytes = getRandomBytes(16);
  
  // Set version (4) and variant bits
  // Use non-null assertion as we know index 6 and 8 exist in our 16-byte array
  randomBytes[6] = (randomBytes[6]! & 0x0f) | 0x40; // version 4
  randomBytes[8] = (randomBytes[8]! & 0x3f) | 0x80; // variant 10
  
  // Convert to hex string with proper formatting
  let hex = '';
  for (let i = 0; i < 16; i++) {
    // We know all indexes exist in our 16-byte array
    hex += randomBytes[i]!.toString(16).padStart(2, '0');
    if (i === 3 || i === 5 || i === 7 || i === 9) {
      hex += '-';
    }
  }
  
  return hex;
}

/**
 * Calculate outcome percentages based on staked amounts with fallback to votes
 * @param outcomes Market outcomes
 * @returns Outcomes with percentages and a flag indicating if vote-based fallback was used
 */
export function calculateOutcomePercentages(outcomes: { id: number; name: string; amount?: number; votes?: number }[]) {
  // Calculate total amount staked for percentage
  const totalAmount = outcomes.reduce((sum, outcome) => sum + (outcome.amount || 0), 0);
  const useFallbackVotes = totalAmount === 0;

  // If no amount data is available, fall back to votes
  const totalVotes = useFallbackVotes
    ? outcomes.reduce((sum, outcome) => sum + (outcome.votes || 0), 0)
    : 0;

  // Update percentages
  const outcomesWithPercentages = outcomes.map(outcome => ({
    ...outcome,
    percentage: useFallbackVotes
      ? (totalVotes > 0 ? Math.round(((outcome.votes || 0) / totalVotes) * 100) : 0)
      : (totalAmount > 0 ? Math.round(((outcome.amount || 0) / totalAmount) * 100) : 0)
  }));

  return {
    outcomesWithPercentages,
    useFallbackVotes
  };
}

/**
 * Safely get the base URL of the application without causing SSR issues
 * with window access
 */
export function getBaseUrl(): string {
  // Check for environment variable first
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL;
  }

  // Then check if window is available (client-side only)
  if (typeof window !== 'undefined') {
    // In development, use window.location.origin
    if (process.env.NODE_ENV === 'development') {
      return window.location.origin;
    }
  }

  // Default fallback for SSR and production without env var
  return 'https://oppredict.com';
}

// Market query and search utilities

export type MarketStatus = 'active' | 'resolved' | 'cancelled' | 'all';
export type MarketType = 'binary' | 'multiple' | 'all';
export type SortField = 'createdAt' | 'endDate' | 'poolAmount' | 'participants';
export type SortDirection = 'asc' | 'desc';

export interface MarketQueryOptions {
  status?: MarketStatus;
  category?: string;
  type?: MarketType;
  search?: string;
  creatorId?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
  sortBy?: SortField;
  sortDirection?: SortDirection;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
}

/**
 * Simple text search for markets
 * Searches for terms in name and description
 */
export function searchMarketText(market: any, searchText: string): boolean {
  if (!searchText) return true;
  
  const text = `${market.name} ${market.description}`.toLowerCase();
  const terms = searchText.toLowerCase().split(/\s+/).filter(Boolean);
  
  return terms.every(term => text.includes(term));
}

/**
 * Filter markets by multiple criteria
 */
export function filterMarkets(markets: any[], options: MarketQueryOptions = {}): any[] {
  return markets.filter(market => {
    // Status filter
    if (options.status && options.status !== 'all' && market.status !== options.status) {
      return false;
    }
    
    // Category filter
    if (options.category && market.category !== options.category) {
      return false;
    }
    
    // Type filter
    if (options.type && options.type !== 'all' && market.type !== options.type) {
      return false;
    }
    
    // Creator filter
    if (options.creatorId && market.createdBy !== options.creatorId) {
      return false;
    }
    
    // Text search
    if (options.search && !searchMarketText(market, options.search)) {
      return false;
    }
    
    return true;
  });
}

/**
 * Sort markets by specified field and direction
 */
export function sortMarkets(markets: any[], sortBy: SortField = 'createdAt', sortDirection: SortDirection = 'desc'): any[] {
  return [...markets].sort((a, b) => {
    let comparison = 0;
    
    // Handle different field types
    if (sortBy === 'createdAt' || sortBy === 'endDate') {
      const dateA = new Date(a[sortBy] || 0).getTime();
      const dateB = new Date(b[sortBy] || 0).getTime();
      comparison = dateA - dateB;
    } else {
      // Numeric fields
      const valA = a[sortBy] || 0;
      const valB = b[sortBy] || 0;
      comparison = valA - valB;
    }
    
    // Apply sort direction
    return sortDirection === 'asc' ? comparison : -comparison;
  });
}

/**
 * Apply pagination to results
 */
export function paginateResults<T>(items: T[], options: { limit?: number; offset?: number }): PaginatedResult<T> {
  const limit = options.limit || 20;
  const offset = options.offset || 0;
  const paginatedItems = items.slice(offset, offset + limit);
  
  return {
    items: paginatedItems,
    total: items.length,
    hasMore: offset + paginatedItems.length < items.length,
    nextCursor: offset + paginatedItems.length < items.length 
      ? `${offset + limit}` 
      : undefined
  };
}