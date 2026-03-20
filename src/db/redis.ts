/**
 * Redis Client
 * Manages connection to Redis for caching and session management
 */

import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';

export class RedisClient {
  private static instance: RedisClient;
  private client: Redis | null = null;

  static getInstance(): RedisClient {
    if (!RedisClient.instance) {
      RedisClient.instance = new RedisClient();
    }
    return RedisClient.instance;
  }

  getClient(): Redis {
    if (!this.client) {
      logger.info('Connecting to Redis', { url: config.redis.url });
      
      this.client = new Redis(config.redis.url, {
        retryStrategy(times) {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        reconnectOnError(err) {
          logger.error('Redis connection error', { error: err.message });
          return true;
        },
      });

      this.client.on('connect', () => {
        logger.info('Connected to Redis successfully');
      });

      this.client.on('error', (error) => {
        logger.error('Redis client error', { error: error.message });
      });
    }

    return this.client;
  }

  async get(key: string): Promise<string | null> {
    const client = this.getClient();
    try {
      const value = await client.get(key);
      logger.debug('Redis GET', { key, found: !!value });
      return value;
    } catch (error) {
      logger.error('Redis GET failed', { key, error });
      throw error;
    }
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    const client = this.getClient();
    try {
      if (ttl) {
        await client.setex(key, ttl, value);
      } else {
        await client.set(key, value);
      }
      logger.debug('Redis SET', { key, ttl });
    } catch (error) {
      logger.error('Redis SET failed', { key, error });
      throw error;
    }
  }

  async del(key: string): Promise<void> {
    const client = this.getClient();
    try {
      await client.del(key);
      logger.debug('Redis DEL', { key });
    } catch (error) {
      logger.error('Redis DEL failed', { key, error });
      throw error;
    }
  }

  async sadd(key: string, ...members: string[]): Promise<void> {
    const client = this.getClient();
    try {
      await client.sadd(key, ...members);
      logger.debug('Redis SADD', { key, count: members.length });
    } catch (error) {
      logger.error('Redis SADD failed', { key, error });
      throw error;
    }
  }

  async smembers(key: string): Promise<string[]> {
    const client = this.getClient();
    try {
      const members = await client.smembers(key);
      logger.debug('Redis SMEMBERS', { key, count: members.length });
      return members;
    } catch (error) {
      logger.error('Redis SMEMBERS failed', { key, error });
      throw error;
    }
  }

  async srem(key: string, ...members: string[]): Promise<void> {
    const client = this.getClient();
    try {
      await client.srem(key, ...members);
      logger.debug('Redis SREM', { key, count: members.length });
    } catch (error) {
      logger.error('Redis SREM failed', { key, error });
      throw error;
    }
  }

  async hget(key: string, field: string): Promise<string | null> {
    const client = this.getClient();
    try {
      const value = await client.hget(key, field);
      logger.debug('Redis HGET', { key, field, found: !!value });
      return value;
    } catch (error) {
      logger.error('Redis HGET failed', { key, field, error });
      throw error;
    }
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    const client = this.getClient();
    try {
      await client.hset(key, field, value);
      logger.debug('Redis HSET', { key, field });
    } catch (error) {
      logger.error('Redis HSET failed', { key, field, error });
      throw error;
    }
  }

  async expire(key: string, seconds: number): Promise<void> {
    const client = this.getClient();
    try {
      await client.expire(key, seconds);
      logger.debug('Redis EXPIRE', { key, seconds });
    } catch (error) {
      logger.error('Redis EXPIRE failed', { key, error });
      throw error;
    }
  }

  /**
   * Acquire distributed lock using Redis SETNX
   * Prevents cache stampede by ensuring only one process refreshes cache at a time
   * 
   * @param lockKey - Unique lock key (e.g., "lock:templates:refresh")
   * @param ttlSeconds - Lock TTL to prevent deadlocks (default: 30s)
   * @returns true if lock acquired, false if already locked
   */
  async acquireLock(lockKey: string, ttlSeconds: number = 30): Promise<boolean> {
    const client = this.getClient();
    try {
      // SET NX EX: Set if Not eXists, with EXpiration
      const result = await client.set(lockKey, '1', 'EX', ttlSeconds, 'NX');
      const acquired = result === 'OK';
      logger.debug('Redis LOCK acquire', { lockKey, ttlSeconds, acquired });
      return acquired;
    } catch (error) {
      logger.error('Redis LOCK acquire failed', { lockKey, error });
      throw error;
    }
  }

  /**
   * Release distributed lock
   * 
   * @param lockKey - Lock key to release
   */
  async releaseLock(lockKey: string): Promise<void> {
    const client = this.getClient();
    try {
      await client.del(lockKey);
      logger.debug('Redis LOCK release', { lockKey });
    } catch (error) {
      logger.error('Redis LOCK release failed', { lockKey, error });
      throw error;
    }
  }

  /**
   * Execute function with distributed lock (cache stampede prevention)
   * If lock is already held, waits and returns cached value
   * 
   * @param lockKey - Lock key
   * @param cacheKey - Cache key to check after waiting
   * @param fn - Function to execute if lock acquired
   * @param lockTTL - Lock TTL in seconds (default: 30s)
   * @returns Result from fn() or cached value
   */
  async withLock<T>(
    lockKey: string,
    cacheKey: string,
    fn: () => Promise<T>,
    lockTTL: number = 30
  ): Promise<T> {
    const lockAcquired = await this.acquireLock(lockKey, lockTTL);

    if (lockAcquired) {
      try {
        // Execute function and cache result
        logger.debug('Lock acquired, executing function', { lockKey });
        const result = await fn();
        return result;
      } finally {
        // Always release lock, even if fn() throws
        await this.releaseLock(lockKey);
      }
    } else {
      // Lock held by another process - wait briefly and check cache
      logger.debug('Lock held by another process, waiting for cache refresh', { lockKey });
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms

      // Check if cache was populated by lock holder
      const cached = await this.get(cacheKey);
      if (cached) {
        logger.debug('Cache refreshed by lock holder', { cacheKey });
        return JSON.parse(cached) as T;
      }

      // Cache still empty - fall through to query without lock
      logger.warn('Cache refresh failed, falling through to query', { cacheKey });
      return await fn();
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      logger.info('Closed Redis connection');
    }
  }
}

// Singleton instance
export const redis = new RedisClient();
