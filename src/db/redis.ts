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
