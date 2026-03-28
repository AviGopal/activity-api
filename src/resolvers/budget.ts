/**
 * Token Budget Management
 *
 * Manages LLM token budgets for API keys.
 * Uses Redis for fast real-time checking and SurrealDB for persistence.
 *
 * Features:
 * - Atomic check-and-deduct via Redis Lua script
 * - Periodic sync to SurrealDB
 * - Monthly budget reset
 * - Overage handling (optional)
 */

import { RedisClient } from '../db/redis';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

export interface TokenBudget {
  tokens_per_month: number;
  tokens_used: number;
  reset_at: string;
  overage_enabled: boolean;
}

export interface BudgetCheckResult {
  allowed: boolean;
  remaining: number;
  tokens_used: number;
  tokens_limit: number;
  reset_at?: string;
}

interface ApiKey {
  id: string;
  org_id: string;
  llm_budget: TokenBudget;
}

// ============================================================================
// Configuration
// ============================================================================

const BUDGET_CACHE_TTL = 86400; // 1 day TTL for budget cache
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BUDGET_PREFIX = 'budget:';

// ============================================================================
// Redis Budget Operations
// ============================================================================

/**
 * Get budget key for Redis
 */
function getBudgetKey(apiKeyId: string): string {
  return `${BUDGET_PREFIX}${apiKeyId}`;
}

/**
 * Check if tokens can be used and atomically deduct them.
 * Uses Redis for speed, falls back to database if cache miss.
 *
 * @param jwtToken - JWT for authenticated queries
 * @param tokensNeeded - Number of tokens to deduct
 * @param orgId - Organization ID for querying API keys
 * @returns Result indicating if allowed and remaining budget
 */
export async function checkAndDeductBudget(
  jwtToken: string,
  tokensNeeded: number,
  orgId: string
): Promise<BudgetCheckResult> {
  const redis = RedisClient.getInstance();
  const client = redis.getClient();

  // First, we need to find the API key for this org
  // In a real system, we'd pass the API key ID directly
  // For now, get the first active API key for the org
  const apiKeys = await queryWithAuth<ApiKey>(
    jwtToken,
    `SELECT * FROM api_keys WHERE org_id = $orgId AND is_active = true LIMIT 1`,
    { orgId: `organizations:${orgId}` }
  );

  if (apiKeys.length === 0) {
    logger.warn('[Budget] No API key found for org', { orgId });
    return {
      allowed: true, // Allow if no API key (shouldn't happen)
      remaining: 0,
      tokens_used: 0,
      tokens_limit: 0
    };
  }

  const apiKey = apiKeys[0];
  const budget = apiKey.llm_budget;
  const budgetKey = getBudgetKey(apiKey.id);

  // Initialize Redis cache if not exists
  const exists = await client.exists(budgetKey);
  if (!exists) {
    await client.set(budgetKey, budget.tokens_used.toString(), 'EX', BUDGET_CACHE_TTL);
  }

  // Atomic check-and-deduct using Lua script
  const luaScript = `
    local current = tonumber(redis.call('GET', KEYS[1]) or '0')
    local limit = tonumber(ARGV[1])
    local needed = tonumber(ARGV[2])
    local overage = ARGV[3] == 'true'

    if current + needed > limit and not overage then
      return {0, limit - current, current, limit}  -- Denied
    end

    redis.call('INCRBY', KEYS[1], needed)
    redis.call('EXPIRE', KEYS[1], ${BUDGET_CACHE_TTL})
    local newUsed = current + needed
    return {1, limit - newUsed, newUsed, limit}  -- Allowed
  `;

  const result = await client.eval(
    luaScript,
    1,
    budgetKey,
    budget.tokens_per_month.toString(),
    tokensNeeded.toString(),
    budget.overage_enabled ? 'true' : 'false'
  ) as number[];

  const allowed = result[0] === 1;
  const remaining = result[1];
  const tokensUsed = result[2];
  const tokensLimit = result[3];

  logger.debug('[Budget] Check result', {
    apiKeyId: apiKey!.id,
    allowed,
    tokensNeeded,
    remaining,
    tokensUsed,
    tokensLimit
  });

  return {
    allowed,
    remaining,
    tokens_used: tokensUsed,
    tokens_limit: tokensLimit,
    reset_at: budget.reset_at
  };
}

/**
 * Deduct tokens from budget (after successful LLM call)
 */
export async function deductBudget(
  apiKeyId: string,
  tokensUsed: number
): Promise<void> {
  const redis = RedisClient.getInstance();
  const client = redis.getClient();
  const budgetKey = getBudgetKey(apiKeyId);

  await client.incrby(budgetKey, tokensUsed);
  await client.expire(budgetKey, BUDGET_CACHE_TTL);

  logger.debug('[Budget] Tokens deducted', { apiKeyId, tokensUsed });
}

/**
 * Get current budget usage from Redis
 */
export async function getBudgetUsage(apiKeyId: string): Promise<number> {
  const redis = RedisClient.getInstance();
  const used = await redis.get(getBudgetKey(apiKeyId));
  return parseInt(used || '0', 10);
}

// ============================================================================
// Database Sync
// ============================================================================

/**
 * Sync Redis budget counters to SurrealDB.
 * Should be run periodically (every 5 minutes).
 */
export async function syncBudgetToDatabase(): Promise<void> {
  const redis = RedisClient.getInstance();
  const client = redis.getClient();

  try {
    // Get all budget keys
    const keys = await client.keys(`${BUDGET_PREFIX}*`);

    if (keys.length === 0) {
      logger.debug('[Budget] No budgets to sync');
      return;
    }

    for (const key of keys) {
      const apiKeyId = key.replace(BUDGET_PREFIX, '');
      const used = await client.get(key);

      if (used !== null) {
        try {
          await surrealDB.query(
            `UPDATE $apiKeyId SET
              llm_budget.tokens_used = $used,
              updated_at = time::now()`,
            {
              apiKeyId,
              used: parseInt(used, 10)
            }
          );
        } catch (error) {
          logger.warn('[Budget] Failed to sync budget for key', { apiKeyId, error });
        }
      }
    }

    logger.info('[Budget] Budget sync complete', { keysProcessed: keys.length });

  } catch (error) {
    logger.error('[Budget] Budget sync failed', { error });
  }
}

/**
 * Reset budgets that have passed their reset date.
 * Should be run daily or on a schedule.
 */
export async function resetBudgets(): Promise<void> {
  const redis = RedisClient.getInstance();
  const client = redis.getClient();

  try {
    // Find API keys that need reset
    const keysToReset = await surrealDB.query<ApiKey>(
      `SELECT * FROM api_keys
       WHERE llm_budget.reset_at < time::now()
         AND is_active = true`
    );

    if (keysToReset.length === 0) {
      logger.debug('[Budget] No budgets to reset');
      return;
    }

    for (const apiKey of keysToReset) {
      // Calculate next reset date (30 days from now)
      const nextReset = new Date();
      nextReset.setDate(nextReset.getDate() + 30);

      // Reset in database
      await surrealDB.query(
        `UPDATE $apiKeyId SET
          llm_budget.tokens_used = 0,
          llm_budget.reset_at = $resetAt,
          updated_at = time::now()`,
        {
          apiKeyId: apiKey.id,
          resetAt: nextReset.toISOString()
        }
      );

      // Reset in Redis
      const budgetKey = getBudgetKey(apiKey.id);
      await client.set(budgetKey, '0', 'EX', BUDGET_CACHE_TTL);

      logger.info('[Budget] Budget reset', {
        apiKeyId: apiKey.id,
        nextReset: nextReset.toISOString()
      });
    }

    logger.info('[Budget] Budget reset complete', { keysReset: keysToReset.length });

  } catch (error) {
    logger.error('[Budget] Budget reset failed', { error });
  }
}

// ============================================================================
// Budget Worker
// ============================================================================

let syncInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

/**
 * Start the budget sync worker
 */
export function startBudgetWorker(): void {
  if (isRunning) {
    logger.warn('[Budget] Worker already running');
    return;
  }

  isRunning = true;

  // Sync every 5 minutes
  syncInterval = setInterval(syncBudgetToDatabase, SYNC_INTERVAL_MS);

  // Initial sync after 10 seconds
  setTimeout(syncBudgetToDatabase, 10000);

  logger.info('[Budget] Worker started', { syncIntervalMs: SYNC_INTERVAL_MS });
}

/**
 * Stop the budget sync worker
 */
export function stopBudgetWorker(): void {
  if (!isRunning) {
    return;
  }

  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }

  isRunning = false;
  logger.info('[Budget] Worker stopped');
}

/**
 * Check if worker is running
 */
export function isBudgetWorkerRunning(): boolean {
  return isRunning;
}

// ============================================================================
// Budget Exceeded Error
// ============================================================================

export class BudgetExceededError extends Error {
  public tokens_used: number;
  public tokens_limit: number;
  public reset_at?: string;

  constructor(tokensUsed: number, tokensLimit: number, resetAt?: string) {
    super('Monthly LLM token budget exhausted');
    this.name = 'BudgetExceededError';
    this.tokens_used = tokensUsed;
    this.tokens_limit = tokensLimit;
    this.reset_at = resetAt;
  }
}
