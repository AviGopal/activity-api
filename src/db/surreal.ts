/**
 * SurrealDB Client
 * Manages connection to SurrealDB and provides query interface
 */

import Surreal from 'surrealdb.js';
import { config } from '../config';
import { logger } from '../utils/logger';

class SurrealDBClient {
  private db: Surreal | null = null;
  private connecting: Promise<void> | null = null;

  async connect(): Promise<void> {
    if (this.db) {
      return; // Already connected
    }

    if (this.connecting) {
      return this.connecting; // Connection in progress
    }

    this.connecting = (async () => {
      try {
        logger.info('Connecting to SurrealDB', {
          url: config.surrealdb.url,
          namespace: config.surrealdb.namespace,
          database: config.surrealdb.database,
        });

        this.db = new Surreal();
        await this.db.connect(config.surrealdb.url);
        
        await this.db.signin({
          username: config.surrealdb.username,
          password: config.surrealdb.password,
        });

        await this.db.use({
          namespace: config.surrealdb.namespace,
          database: config.surrealdb.database,
        });

        logger.info('Connected to SurrealDB successfully');
      } catch (error) {
        logger.error('Failed to connect to SurrealDB', { error });
        this.db = null;
        throw error;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  async query<T = any>(sql: string, params?: Record<string, any>): Promise<T[]> {
    await this.connect();
    
    if (!this.db) {
      throw new Error('SurrealDB not connected');
    }

    try {
      logger.debug('Executing SurrealDB query', { sql, params });
      const result = await this.db.query<T[]>(sql, params);
      
      // SurrealDB returns array of result sets, we typically want the first one
      return Array.isArray(result) && result.length > 0 ? result[0] : [];
    } catch (error) {
      logger.error('SurrealDB query failed', { sql, params, error });
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      logger.info('Closed SurrealDB connection');
    }
  }
}

// Singleton instance
export const surrealDB = new SurrealDBClient();
