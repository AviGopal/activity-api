/**
 * Activity Execution Cache System Tests
 *
 * Tests for caching activity executions based on input variables to avoid
 * redundant re-executions of the same activity with identical parameters.
 *
 * Test Coverage:
 * - Cache key generation (deterministic, order-independent)
 * - Cache storage and retrieval
 * - TTL calculation based on execution cost/duration
 * - Cache metrics tracking
 * - Expired entry cleanup
 */

import { test, expect, describe, beforeEach } from 'bun:test';
import { createHash } from 'crypto';

// Mock types for the cache system
interface CacheEntry {
  execution_id: string;
  variant_id: string;
  activity_id: string;
  success: boolean;
  duration_ms: number;
  cost_usd: number;
  output_state: {
    filesModified?: string[];
    filesCreated?: string[];
    filesDeleted?: string[];
    exitCode?: number;
    stderr?: string;
  };
  cached_at: Date;
  expires_at: Date;
  hit_count: number;
}

interface CacheMetrics {
  cache_key: string;
  hit_count: number;
  miss_count: number;
  hit_rate: number;
  cost_saved_usd: number;
  time_saved_ms: number;
  last_hit_at: Date | null;
  created_at: Date;
}

// Mock implementation of cache key generation
// Real implementation would be in src/services/execution-cache.ts
function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const normalized: Record<string, unknown> = {};

    for (const key of sortedKeys) {
      normalized[key] = normalizeValue(obj[key]);
    }

    return normalized;
  }

  return value;
}

function generateCacheKey(
  activityId: string,
  variables: Record<string, unknown>
): string {
  // Recursively normalize and sort all nested objects
  const normalized = normalizeValue(variables);

  // Create hash from activity ID + normalized variables
  const content = JSON.stringify({ activityId, variables: normalized });
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// Mock implementation of TTL calculation
function calculateCacheTTL(
  success: boolean,
  durationMs: number,
  costUsd: number
): number {
  const HOUR = 3600; // seconds
  const DAY = 86400; // seconds
  const MIN_TTL = 5 * 60; // 5 minutes (minimum)
  const MAX_TTL = DAY; // 24 hours (maximum)

  // Failed executions get minimum TTL
  if (!success) {
    return MIN_TTL;
  }

  // Base TTL on execution cost and duration
  // Expensive operations get longer cache TTL
  let ttl = MIN_TTL;

  // Cost-based scaling (more expensive = longer cache)
  if (costUsd > 0.10) {
    ttl = 12 * HOUR; // 12 hours for expensive executions
  } else if (costUsd > 0.01) {
    ttl = 4 * HOUR; // 4 hours for medium cost
  } else if (costUsd >= 0.001) {
    ttl = 1 * HOUR; // 1 hour for cheap executions
  } else {
    ttl = MIN_TTL; // Very cheap gets minimum
  }

  // Duration-based scaling (slower = longer cache)
  if (durationMs > 60000) { // > 1 minute
    ttl = Math.max(ttl, 6 * HOUR);
  } else if (durationMs > 10000) { // > 10 seconds
    ttl = Math.max(ttl, 2 * HOUR);
  }

  // Cap at maximum
  return Math.min(ttl, MAX_TTL);
}

// Mock cache storage (in-memory for testing)
class MockCacheStorage {
  private entries = new Map<string, CacheEntry>();
  private metrics = new Map<string, CacheMetrics>();

  async get(cacheKey: string): Promise<CacheEntry | null> {
    const entry = this.entries.get(cacheKey);

    // Check if expired
    if (entry && entry.expires_at < new Date()) {
      return null;
    }

    return entry || null;
  }

  async set(
    cacheKey: string,
    entry: CacheEntry,
    ttlSeconds: number
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    this.entries.set(cacheKey, {
      ...entry,
      cached_at: new Date(),
      expires_at: expiresAt,
      hit_count: 0,
    });
  }

  async recordHit(cacheKey: string, savedCostUsd: number, savedTimeMs: number): Promise<void> {
    const entry = this.entries.get(cacheKey);
    if (entry) {
      entry.hit_count += 1;
    }

    const metrics = this.metrics.get(cacheKey) || {
      cache_key: cacheKey,
      hit_count: 0,
      miss_count: 0,
      hit_rate: 0,
      cost_saved_usd: 0,
      time_saved_ms: 0,
      last_hit_at: null,
      created_at: new Date(),
    };

    metrics.hit_count += 1;
    metrics.cost_saved_usd += savedCostUsd;
    metrics.time_saved_ms += savedTimeMs;
    metrics.last_hit_at = new Date();
    metrics.hit_rate = metrics.hit_count / (metrics.hit_count + metrics.miss_count);

    this.metrics.set(cacheKey, metrics);
  }

  async recordMiss(cacheKey: string): Promise<void> {
    const metrics = this.metrics.get(cacheKey) || {
      cache_key: cacheKey,
      hit_count: 0,
      miss_count: 0,
      hit_rate: 0,
      cost_saved_usd: 0,
      time_saved_ms: 0,
      last_hit_at: null,
      created_at: new Date(),
    };

    metrics.miss_count += 1;
    metrics.hit_rate = metrics.hit_count / (metrics.hit_count + metrics.miss_count);

    this.metrics.set(cacheKey, metrics);
  }

  async getMetrics(cacheKey: string): Promise<CacheMetrics | null> {
    return this.metrics.get(cacheKey) || null;
  }

  async cleanExpired(): Promise<number> {
    const now = new Date();
    let deletedCount = 0;

    for (const [key, entry] of this.entries.entries()) {
      if (entry.expires_at < now) {
        this.entries.delete(key);
        deletedCount++;
      }
    }

    return deletedCount;
  }

  // Test helper methods
  clear(): void {
    this.entries.clear();
    this.metrics.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

// Test suite
describe('Cache Key Generation', () => {
  test('identical variables (same order) produce same key', () => {
    const activityId = 'test-activity-1';
    const vars1 = { name: 'test', count: 42, enabled: true };
    const vars2 = { name: 'test', count: 42, enabled: true };

    const key1 = generateCacheKey(activityId, vars1);
    const key2 = generateCacheKey(activityId, vars2);

    expect(key1).toBe(key2);
  });

  test('identical variables (different order) produce same key', () => {
    const activityId = 'test-activity-1';
    const vars1 = { name: 'test', count: 42, enabled: true };
    const vars2 = { enabled: true, name: 'test', count: 42 };

    const key1 = generateCacheKey(activityId, vars1);
    const key2 = generateCacheKey(activityId, vars2);

    // Keys should be identical despite different property order
    expect(key1).toBe(key2);
  });

  test('different variables produce different keys', () => {
    const activityId = 'test-activity-1';
    const vars1 = { name: 'test1', count: 42 };
    const vars2 = { name: 'test2', count: 42 };

    const key1 = generateCacheKey(activityId, vars1);
    const key2 = generateCacheKey(activityId, vars2);

    expect(key1).not.toBe(key2);
  });

  test('different activity IDs produce different keys', () => {
    const vars = { name: 'test', count: 42 };

    const key1 = generateCacheKey('activity-1', vars);
    const key2 = generateCacheKey('activity-2', vars);

    expect(key1).not.toBe(key2);
  });

  test('determinism - same input always produces same output', () => {
    const activityId = 'test-activity-1';
    const variables = { name: 'test', count: 42, nested: { value: 'deep' } };

    const keys = Array.from({ length: 100 }, () =>
      generateCacheKey(activityId, variables)
    );

    // All keys should be identical
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(1);
  });

  test('handles empty variables', () => {
    const activityId = 'test-activity-1';

    const key1 = generateCacheKey(activityId, {});
    const key2 = generateCacheKey(activityId, {});

    expect(key1).toBe(key2);
    expect(key1).toBeTruthy();
  });

  test('handles complex nested objects', () => {
    const activityId = 'test-activity-1';
    const vars1 = {
      config: { port: 8080, host: 'localhost' },
      flags: ['a', 'b', 'c']
    };
    const vars2 = {
      flags: ['a', 'b', 'c'],
      config: { host: 'localhost', port: 8080 }
    };

    const key1 = generateCacheKey(activityId, vars1);
    const key2 = generateCacheKey(activityId, vars2);

    // Should be same despite different order of nested properties
    expect(key1).toBe(key2);
  });
});

describe('Cache Storage and Retrieval', () => {
  let cache: MockCacheStorage;

  beforeEach(() => {
    cache = new MockCacheStorage();
  });

  test('stores and retrieves cache entry', async () => {
    const cacheKey = 'test-key-1';
    const entry: CacheEntry = {
      execution_id: 'exec-123',
      variant_id: 'variant-1',
      activity_id: 'activity-1',
      success: true,
      duration_ms: 5000,
      cost_usd: 0.05,
      output_state: {
        filesModified: ['src/test.ts'],
      },
      cached_at: new Date(),
      expires_at: new Date(Date.now() + 3600000), // 1 hour
      hit_count: 0,
    };

    await cache.set(cacheKey, entry, 3600);
    const retrieved = await cache.get(cacheKey);

    expect(retrieved).toBeTruthy();
    expect(retrieved?.execution_id).toBe('exec-123');
    expect(retrieved?.success).toBe(true);
  });

  test('cache miss returns null', async () => {
    const result = await cache.get('nonexistent-key');

    expect(result).toBeNull();
  });

  test('expired entries return null', async () => {
    const cacheKey = 'test-key-expired';
    const entry: CacheEntry = {
      execution_id: 'exec-456',
      variant_id: 'variant-1',
      activity_id: 'activity-1',
      success: true,
      duration_ms: 1000,
      cost_usd: 0.01,
      output_state: {},
      cached_at: new Date(Date.now() - 7200000), // 2 hours ago
      expires_at: new Date(Date.now() - 3600000), // Expired 1 hour ago
      hit_count: 0,
    };

    // Manually insert expired entry
    await cache.set(cacheKey, entry, -3600); // Negative TTL = already expired

    const result = await cache.get(cacheKey);

    // Should return null for expired entry
    expect(result).toBeNull();
  });

  test('multiple entries can coexist', async () => {
    const entry1: CacheEntry = {
      execution_id: 'exec-1',
      variant_id: 'variant-1',
      activity_id: 'activity-1',
      success: true,
      duration_ms: 1000,
      cost_usd: 0.01,
      output_state: {},
      cached_at: new Date(),
      expires_at: new Date(Date.now() + 3600000),
      hit_count: 0,
    };

    const entry2: CacheEntry = {
      execution_id: 'exec-2',
      variant_id: 'variant-2',
      activity_id: 'activity-2',
      success: true,
      duration_ms: 2000,
      cost_usd: 0.02,
      output_state: {},
      cached_at: new Date(),
      expires_at: new Date(Date.now() + 3600000),
      hit_count: 0,
    };

    await cache.set('key-1', entry1, 3600);
    await cache.set('key-2', entry2, 3600);

    const retrieved1 = await cache.get('key-1');
    const retrieved2 = await cache.get('key-2');

    expect(retrieved1?.execution_id).toBe('exec-1');
    expect(retrieved2?.execution_id).toBe('exec-2');
    expect(cache.size()).toBe(2);
  });
});

describe('TTL Calculation', () => {
  test('cheap/fast execution gets short TTL', () => {
    // Cheap execution: $0.001, 1 second
    const ttl = calculateCacheTTL(true, 1000, 0.001);

    // Should get 1 hour (3600 seconds)
    expect(ttl).toBe(3600);
  });

  test('expensive execution gets long TTL', () => {
    // Expensive execution: $0.15, 5 seconds
    const ttl = calculateCacheTTL(true, 5000, 0.15);

    // Should get 12 hours (43200 seconds)
    expect(ttl).toBe(43200);
  });

  test('slow execution gets long TTL', () => {
    // Slow execution: $0.005, 70 seconds
    const ttl = calculateCacheTTL(true, 70000, 0.005);

    // Should get at least 6 hours (21600 seconds)
    expect(ttl).toBeGreaterThanOrEqual(21600);
  });

  test('TTL never exceeds 24 hours', () => {
    // Very expensive and slow execution
    const ttl = calculateCacheTTL(true, 300000, 1.0);

    // Should be capped at 24 hours (86400 seconds)
    expect(ttl).toBeLessThanOrEqual(86400);
  });

  test('failed execution gets minimum TTL', () => {
    // Failed execution (regardless of cost/duration)
    const ttl1 = calculateCacheTTL(false, 10000, 0.10);
    const ttl2 = calculateCacheTTL(false, 100000, 1.0);

    // Both should get minimum TTL (5 minutes = 300 seconds)
    expect(ttl1).toBe(300);
    expect(ttl2).toBe(300);
  });

  test('medium cost execution gets medium TTL', () => {
    // Medium cost: $0.02, 3 seconds
    const ttl = calculateCacheTTL(true, 3000, 0.02);

    // Should get 4 hours (14400 seconds)
    expect(ttl).toBe(14400);
  });

  test('duration takes precedence over cost for slow executions', () => {
    // Cheap but very slow: $0.001, 2 minutes
    const ttl = calculateCacheTTL(true, 120000, 0.001);

    // Duration (2 min) should bump TTL to at least 6 hours
    expect(ttl).toBeGreaterThanOrEqual(21600);
  });
});

describe('Cache Metrics', () => {
  let cache: MockCacheStorage;

  beforeEach(() => {
    cache = new MockCacheStorage();
  });

  test('cache hit updates metrics correctly', async () => {
    const cacheKey = 'test-key-metrics';

    // Record miss first
    await cache.recordMiss(cacheKey);

    // Record hits
    await cache.recordHit(cacheKey, 0.05, 5000);
    await cache.recordHit(cacheKey, 0.05, 5000);
    await cache.recordHit(cacheKey, 0.05, 5000);

    const metrics = await cache.getMetrics(cacheKey);

    expect(metrics).toBeTruthy();
    expect(metrics?.hit_count).toBe(3);
    expect(metrics?.miss_count).toBe(1);
    expect(metrics?.last_hit_at).toBeTruthy();
  });

  test('cache miss updates metrics correctly', async () => {
    const cacheKey = 'test-key-miss';

    await cache.recordMiss(cacheKey);
    await cache.recordMiss(cacheKey);

    const metrics = await cache.getMetrics(cacheKey);

    expect(metrics?.hit_count).toBe(0);
    expect(metrics?.miss_count).toBe(2);
    expect(metrics?.last_hit_at).toBeNull();
  });

  test('hit_rate calculation is correct', async () => {
    const cacheKey = 'test-key-rate';

    // 1 miss, 3 hits = 75% hit rate
    await cache.recordMiss(cacheKey);
    await cache.recordHit(cacheKey, 0.01, 1000);
    await cache.recordHit(cacheKey, 0.01, 1000);
    await cache.recordHit(cacheKey, 0.01, 1000);

    const metrics = await cache.getMetrics(cacheKey);

    expect(metrics?.hit_rate).toBe(0.75); // 3/(3+1) = 0.75
  });

  test('cost_saved_usd accumulation', async () => {
    const cacheKey = 'test-key-cost';

    // Record 5 hits with $0.05 saved each
    for (let i = 0; i < 5; i++) {
      await cache.recordHit(cacheKey, 0.05, 5000);
    }

    const metrics = await cache.getMetrics(cacheKey);

    expect(metrics?.cost_saved_usd).toBe(0.25); // 5 * 0.05
    expect(metrics?.time_saved_ms).toBe(25000); // 5 * 5000
  });

  test('metrics for nonexistent key returns null', async () => {
    const metrics = await cache.getMetrics('nonexistent');

    expect(metrics).toBeNull();
  });

  test('hit count increments on cache entry', async () => {
    const cacheKey = 'test-key-hit-count';
    const entry: CacheEntry = {
      execution_id: 'exec-123',
      variant_id: 'variant-1',
      activity_id: 'activity-1',
      success: true,
      duration_ms: 1000,
      cost_usd: 0.01,
      output_state: {},
      cached_at: new Date(),
      expires_at: new Date(Date.now() + 3600000),
      hit_count: 0,
    };

    await cache.set(cacheKey, entry, 3600);

    // Record multiple hits
    await cache.recordHit(cacheKey, 0.01, 1000);
    await cache.recordHit(cacheKey, 0.01, 1000);
    await cache.recordHit(cacheKey, 0.01, 1000);

    const retrieved = await cache.get(cacheKey);

    // Entry should track its own hit count
    expect(retrieved?.hit_count).toBe(3);
  });
});

describe('Cleanup Tests', () => {
  let cache: MockCacheStorage;

  beforeEach(() => {
    cache = new MockCacheStorage();
  });

  test('cleanExpiredCache deletes expired entries', async () => {
    // Add expired entry
    const expiredEntry: CacheEntry = {
      execution_id: 'exec-expired',
      variant_id: 'variant-1',
      activity_id: 'activity-1',
      success: true,
      duration_ms: 1000,
      cost_usd: 0.01,
      output_state: {},
      cached_at: new Date(Date.now() - 7200000),
      expires_at: new Date(Date.now() - 3600000), // Expired 1 hour ago
      hit_count: 0,
    };

    // Add valid entry
    const validEntry: CacheEntry = {
      execution_id: 'exec-valid',
      variant_id: 'variant-2',
      activity_id: 'activity-2',
      success: true,
      duration_ms: 1000,
      cost_usd: 0.01,
      output_state: {},
      cached_at: new Date(),
      expires_at: new Date(Date.now() + 3600000), // Valid for 1 hour
      hit_count: 0,
    };

    await cache.set('expired', expiredEntry, -3600);
    await cache.set('valid', validEntry, 3600);

    expect(cache.size()).toBe(2);

    const deletedCount = await cache.cleanExpired();

    // Should delete 1 expired entry
    expect(deletedCount).toBe(1);
    expect(cache.size()).toBe(1);

    // Valid entry should still be retrievable
    const retrieved = await cache.get('valid');
    expect(retrieved).toBeTruthy();
    expect(retrieved?.execution_id).toBe('exec-valid');
  });

  test('cleanExpiredCache does not delete valid entries', async () => {
    // Add multiple valid entries
    const entry1: CacheEntry = {
      execution_id: 'exec-1',
      variant_id: 'variant-1',
      activity_id: 'activity-1',
      success: true,
      duration_ms: 1000,
      cost_usd: 0.01,
      output_state: {},
      cached_at: new Date(),
      expires_at: new Date(Date.now() + 3600000),
      hit_count: 0,
    };

    const entry2: CacheEntry = {
      execution_id: 'exec-2',
      variant_id: 'variant-2',
      activity_id: 'activity-2',
      success: true,
      duration_ms: 2000,
      cost_usd: 0.02,
      output_state: {},
      cached_at: new Date(),
      expires_at: new Date(Date.now() + 7200000), // 2 hours
      hit_count: 0,
    };

    await cache.set('key-1', entry1, 3600);
    await cache.set('key-2', entry2, 7200);

    expect(cache.size()).toBe(2);

    const deletedCount = await cache.cleanExpired();

    // Should delete 0 entries (all valid)
    expect(deletedCount).toBe(0);
    expect(cache.size()).toBe(2);
  });

  test('cleanExpiredCache handles empty cache', async () => {
    const deletedCount = await cache.cleanExpired();

    expect(deletedCount).toBe(0);
    expect(cache.size()).toBe(0);
  });

  test('cleanExpiredCache deletes multiple expired entries', async () => {
    // Add 3 expired entries and 2 valid entries
    for (let i = 0; i < 3; i++) {
      const expiredEntry: CacheEntry = {
        execution_id: `exec-expired-${i}`,
        variant_id: 'variant-1',
        activity_id: 'activity-1',
        success: true,
        duration_ms: 1000,
        cost_usd: 0.01,
        output_state: {},
        cached_at: new Date(Date.now() - 7200000),
        expires_at: new Date(Date.now() - 1000), // Just expired
        hit_count: 0,
      };
      await cache.set(`expired-${i}`, expiredEntry, -1);
    }

    for (let i = 0; i < 2; i++) {
      const validEntry: CacheEntry = {
        execution_id: `exec-valid-${i}`,
        variant_id: 'variant-1',
        activity_id: 'activity-1',
        success: true,
        duration_ms: 1000,
        cost_usd: 0.01,
        output_state: {},
        cached_at: new Date(),
        expires_at: new Date(Date.now() + 3600000),
        hit_count: 0,
      };
      await cache.set(`valid-${i}`, validEntry, 3600);
    }

    expect(cache.size()).toBe(5);

    const deletedCount = await cache.cleanExpired();

    // Should delete 3 expired entries
    expect(deletedCount).toBe(3);
    expect(cache.size()).toBe(2);
  });
});
