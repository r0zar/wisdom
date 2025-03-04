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