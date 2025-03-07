import { kv } from '@vercel/kv';
import { AppError, logger } from './logger';

/**
 * Centralized KV Store Helper
 * 
 * This provides standardized methods for interacting with Vercel KV storage,
 * ensuring consistent key formats, serialization/deserialization, and error handling.
 * 
 * Also provides transaction support to ensure data consistency for complex operations.
 */

// Create a logger instance for this module
const kvLogger = logger.child({ context: 'kv-store' });

// Define constant prefixes for all entity types
export const KV_PREFIXES = {
  MARKET: 'market',
  MARKET_IDS: 'market_ids',
  USER_MARKETS: 'user_markets',
  MARKET_PARTICIPANTS: 'market_participants',
  MARKET_CATEGORY: 'market_category',  // Index for markets by category
  MARKET_STATUS: 'market_status',      // Index for markets by status
  PREDICTION: 'prediction',
  USER_PREDICTIONS: 'user_predictions',
  MARKET_PREDICTIONS: 'market_predictions',
  PREDICTION_NFT: 'prediction_nft',
  USER_BALANCE: 'user_balance',
  USER_STATS: 'user_stats',
  LEADERBOARD: 'leaderboard',
  LEADERBOARD_EARNINGS: 'leaderboard_earnings',
  LEADERBOARD_ACCURACY: 'leaderboard_accuracy',
  BUG_REPORT: 'bug_report',
  BUG_REPORT_IDS: 'bug_report_ids',
  USER_BUG_REPORTS: 'user_bug_reports'
} as const;

// Type safety for valid entity types
export type EntityType = keyof typeof KV_PREFIXES;

/**
 * Get a formatted key for a specific entity
 */
export function getKey(entityType: EntityType, id?: string): string {
  const prefix = KV_PREFIXES[entityType];

  // Special handling for MARKET_IDS - it doesn't use a colon format
  if (entityType === 'MARKET_IDS' && !id) {
    return prefix;
  }

  return id ? `${prefix}:${id}` : prefix;
}

/**
 * Store an entity in KV
 */
export async function storeEntity<T>(entityType: EntityType, id: string, data: T): Promise<T> {
  try {
    const key = getKey(entityType, id);
    await kv.set(key, JSON.stringify(data));
    return data;
  } catch (error) {
    throw new AppError({
      message: `Failed to store ${entityType} with ID ${id}`,
      context: 'kv-store',
      code: 'KV_STORE_ERROR',
      originalError: error instanceof Error ? error : new Error(String(error)),
      data: { entityType, id, operation: 'store' }
    }).log();
  }
}

/**
 * Get an entity from KV - with backward compatibility
 */
export async function getEntity<T>(entityType: EntityType, id: string): Promise<T | null> {
  try {
    // Try with new key format
    const key = getKey(entityType, id);
    let data = await kv.get<string>(key);

    // If not found and it's a MARKET, try the old plural format (markets:id)
    if (!data && entityType === 'MARKET') {
      data = await kv.get<string>(`markets:${id}`);
    }

    if (!data) {
      // Not an error, just not found
      kvLogger.debug({ entityType, id }, `Entity not found: ${entityType}:${id}`);
      return null;
    }

    // If data is already in object format (newer KV might handle JSON automatically)
    if (typeof data !== 'string') {
      return data as unknown as T;
    }

    // Parse JSON string
    try {
      return JSON.parse(data) as T;
    } catch (e) {
      throw new AppError({
        message: `Error parsing JSON for ${entityType} with ID ${id}`,
        context: 'kv-store',
        code: 'KV_JSON_PARSE_ERROR',
        originalError: e instanceof Error ? e : new Error(String(e)),
        data: { entityType, id, operation: 'parse' }
      }).log();
    }
  } catch (error) {
    // Only throw AppError if it's not already one
    if (error instanceof AppError) {
      throw error;
    }
    
    throw new AppError({
      message: `Failed to retrieve ${entityType} with ID ${id}`,
      context: 'kv-store',
      code: 'KV_RETRIEVE_ERROR',
      originalError: error instanceof Error ? error : new Error(String(error)),
      data: { entityType, id, operation: 'get' }
    }).log();
  }
}

/**
 * Delete an entity from KV
 */
export async function deleteEntity(entityType: EntityType, id: string): Promise<boolean> {
  try {
    const key = getKey(entityType, id);
    await kv.del(key);

    // If it's a MARKET, also try to delete the legacy format
    if (entityType === 'MARKET') {
      await kv.del(`markets:${id}`);
    }

    return true;
  } catch (error) {
    // Log error but don't throw - deletion errors are often non-critical
    new AppError({
      message: `Failed to delete ${entityType} with ID ${id}`,
      context: 'kv-store',
      code: 'KV_DELETE_ERROR',
      originalError: error instanceof Error ? error : new Error(String(error)),
      data: { entityType, id, operation: 'delete' }
    }).log();
    
    return false;
  }
}

/**
 * Add an ID to a set - with backward compatibility
 */
export async function addToSet(setType: EntityType, id: string, memberId: string): Promise<boolean> {
  try {
    const key = getKey(setType, id);
    await kv.sadd(key, memberId);

    // If it's MARKET_IDS, also add to the old format for backward compatibility
    if (setType === 'MARKET_IDS') {
      await kv.sadd('market_ids', memberId);
    }

    return true;
  } catch (error) {
    new AppError({
      message: `Failed to add member ${memberId} to set ${setType}:${id}`,
      context: 'kv-store',
      code: 'KV_SET_ADD_ERROR',
      originalError: error instanceof Error ? error : new Error(String(error)),
      data: { setType, id, memberId, operation: 'sadd' }
    }).log();
    
    return false;
  }
}

/**
 * Remove an ID from a set
 */
export async function removeFromSet(setType: EntityType, id: string, memberId: string): Promise<boolean> {
  try {
    const key = getKey(setType, id);
    await kv.srem(key, memberId);

    // If it's MARKET_IDS, also remove from the old format for backward compatibility
    if (setType === 'MARKET_IDS') {
      await kv.srem('market_ids', memberId);
    }

    return true;
  } catch (error) {
    new AppError({
      message: `Failed to remove member ${memberId} from set ${setType}:${id}`,
      context: 'kv-store',
      code: 'KV_SET_REMOVE_ERROR',
      originalError: error instanceof Error ? error : new Error(String(error)),
      data: { setType, id, memberId, operation: 'srem' }
    }).log();
    
    return false;
  }
}

/**
 * Get all members of a set - with backward compatibility
 */
export async function getSetMembers(setType: EntityType, id: string): Promise<string[]> {
  try {
    const key = getKey(setType, id);
    let members = await kv.smembers(key) as string[];

    // For backward compatibility with market_ids
    if (setType === 'MARKET_IDS' && members.length === 0) {
      const legacyMembers = await kv.smembers('market_ids') as string[];
      if (legacyMembers.length > 0) {
        // Migrate the data to the new format
        for (const marketId of legacyMembers) {
          await addToSet('MARKET_IDS', '', marketId);
        }
        members = legacyMembers;
      }
    }

    return members;
  } catch (error) {
    new AppError({
      message: `Failed to get members from set ${setType}:${id}`,
      context: 'kv-store',
      code: 'KV_SET_MEMBERS_ERROR',
      originalError: error instanceof Error ? error : new Error(String(error)),
      data: { setType, id, operation: 'smembers' }
    }).log();
    
    return [];
  }
}

/**
 * Check if a member is in a set
 */
export async function isSetMember(setType: EntityType, id: string, memberId: string): Promise<boolean> {
  try {
    const key = getKey(setType, id);
    const result = await kv.sismember(key, memberId);
    return !!result;
  } catch (error) {
    console.error(`Error checking set membership for ${setType} with ID ${id}:`, error);
    return false;
  }
}

/**
 * Add a member to a sorted set with score
 */
export async function addToSortedSet(setType: EntityType, memberId: string, score: number): Promise<boolean> {
  try {
    const key = getKey(setType);
    await kv.zadd(key, { score, member: memberId });
    return true;
  } catch (error) {
    console.error(`Error adding to sorted set ${setType}:`, error);
    return false;
  }
}

/**
 * Get top members from a sorted set
 */
export async function getTopFromSortedSet(setType: EntityType, limit: number = 10, reverse: boolean = true): Promise<string[]> {
  try {
    const key = getKey(setType);
    return await kv.zrange(key, 0, limit - 1, { rev: reverse }) as string[];
  } catch (error) {
    console.error(`Error getting top members from sorted set ${setType}:`, error);
    return [];
  }
}

/**
 * Get scores for specific members from a sorted set
 * Returns a map of memberId -> score
 */
export async function getScoresFromSortedSet(setType: EntityType, memberIds: string[]): Promise<Record<string, number>> {
  try {
    const key = getKey(setType);
    const result: Record<string, number> = {};
        
    // Process members in batches if there are many
    const batchSize = 50;
    for (let i = 0; i < memberIds.length; i += batchSize) {
      const batch = memberIds.slice(i, i + batchSize);
            
      // Get scores for this batch
      const batchScores = await Promise.all(
        batch.map(async (memberId) => {
          const score = await kv.zscore(key, memberId);
          return { memberId, score: score ? Number(score) : null };
        })
      );
            
      // Add scores to result map
      batchScores.forEach(({ memberId, score }) => {
        if (score !== null) {
          result[memberId] = score;
        }
      });
    }
        
    return result;
  } catch (error) {
    console.error(`Error getting scores from sorted set ${setType}:`, error);
    return {};
  }
}

/**
 * Get all keys matching a pattern
 */
export async function getKeys(pattern: string): Promise<string[]> {
  try {
    return await kv.keys(pattern) as string[];
  } catch (error) {
    console.error(`Error getting keys with pattern ${pattern}:`, error);
    return [];
  }
}

/**
 * Check if a key exists
 */
export async function keyExists(entityType: EntityType, id: string): Promise<boolean> {
  try {
    const key = getKey(entityType, id);
    const result = await kv.exists(key);
    return result === 1;
  } catch (error) {
    console.error(`Error checking if key exists for ${entityType} with ID ${id}:`, error);
    return false;
  }
}

/**
 * Debug function to get information about KV store
 */
export async function getDebugInfo(): Promise<Record<string, unknown>> {
  try {
    const allKeys = await kv.keys('*');
    const patterns = [
      'market:*',
      'markets:*',
      'market_ids',
      'prediction:*',
      'predictions:*',
      'user_predictions:*',
      'market_predictions:*',
      'prediction_nft:*',
      'prediction_nfts:*'
    ];

    const result: Record<string, unknown> = {
      totalKeys: allKeys.length,
      keysByPattern: {} as Record<string, { count: number; sample: string[] }>
    };

    const keysByPattern = result.keysByPattern as Record<string, { count: number; sample: string[] }>;
    
    for (const pattern of patterns) {
      const keys = await kv.keys(pattern);
      keysByPattern[pattern] = {
        count: keys.length,
        sample: keys.slice(0, 5) as string[]
      };
    }

    return result;
  } catch (error) {
    console.error('Error getting debug info:', error);
    return { error: String(error) };
  }
}

/**
 * Transaction interface for atomic operations
 */
export interface KvTransaction {
  operations: Array<{
    type: 'entity' | 'set' | 'sortedSet';
    entityType: EntityType;
    id: string;
    data?: unknown;
  }>;
  addEntity<T>(entityType: EntityType, id: string, data: T): Promise<void>;
  addToSetInTransaction(setType: EntityType, id: string, memberId: string): Promise<void>;
  addToSortedSetInTransaction(setType: EntityType, memberId: string, score: number): Promise<void>;
  execute(): Promise<boolean>;
}

/**
 * Start a Redis transaction for atomic operations
 * @returns A transaction object with methods that queue commands to be executed atomically
 */
export async function startTransaction(): Promise<KvTransaction> {
  try {
    // @vercel/kv supports Redis transactions via the multi() method
    const transaction = kv.multi();
    
    // Track operations for potential rollback planning
    const operations: Array<{
      type: 'entity' | 'set' | 'sortedSet';
      entityType: EntityType;
      id: string;
      data?: unknown;
    }> = [];
    
    const txObject: KvTransaction = {
      operations,
      
      // Add entity to transaction
      async addEntity<T>(entityType: EntityType, id: string, data: T): Promise<void> {
        const key = getKey(entityType, id);
        transaction.set(key, JSON.stringify(data));
        operations.push({ type: 'entity', entityType, id, data });
      },
      
      // Add to set in transaction
      async addToSetInTransaction(setType: EntityType, id: string, memberId: string): Promise<void> {
        const key = getKey(setType, id);
        transaction.sadd(key, memberId);
        operations.push({ type: 'set', entityType: setType, id: memberId });
        
        // Handle backward compatibility if needed
        if (setType === 'MARKET_IDS') {
          transaction.sadd('market_ids', memberId);
        }
      },
      
      // Add to sorted set in transaction
      async addToSortedSetInTransaction(setType: EntityType, memberId: string, score: number): Promise<void> {
        const key = getKey(setType);
        transaction.zadd(key, { score, member: memberId });
        operations.push({ type: 'sortedSet', entityType: setType, id: memberId, data: score });
      },
      
      // Execute all queued commands atomically
      async execute(): Promise<boolean> {
        try {
          kvLogger.debug(
            { operationCount: operations.length }, 
            `Executing transaction with ${operations.length} operations`
          );
          
          await transaction.exec();
          return true;
        } catch (error) {
          const appError = new AppError({
            message: 'Transaction execution failed',
            context: 'kv-store',
            code: 'TRANSACTION_FAILED',
            originalError: error instanceof Error ? error : new Error(String(error)),
            data: { operationCount: operations.length }
          });
          
          appError.log();
          
          // Note: Redis transactions are atomic - they either all succeed or all fail
          // No manual rollback is needed as failed transactions don't apply any changes
          
          return false;
        }
      }
    };
    
    return txObject;
  } catch (error) {
    throw new AppError({
      message: 'Failed to start transaction',
      context: 'kv-store',
      code: 'TRANSACTION_START_ERROR',
      originalError: error instanceof Error ? error : new Error(String(error))
    }).log();
  }
}