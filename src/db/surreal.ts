/**
 * SurrealDB Client
 * Manages connection to SurrealDB and provides query interface
 */

import { Surreal } from 'surrealdb';
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
        
        // SurrealDB v3.0.0: Use RootAuth for root user, then switch namespace
        await this.db.signin({
          username: config.surrealdb.username,
          password: config.surrealdb.password,
        });

        await this.db.use({
          namespace: config.surrealdb.namespace,
          database: config.surrealdb.database,
        });

        // Verify namespace access by attempting a simple query
        try {
          await this.db.query('INFO FOR NS');
          logger.info('Connected to SurrealDB successfully', {
            namespace: config.surrealdb.namespace,
            database: config.surrealdb.database,
            verified: true
          });
        } catch (verifyError) {
          const err = verifyError as Error;
          this.db = null;
          throw new Error(
            `Cannot access namespace '${config.surrealdb.namespace}': ${err.message}. ` +
            `Ensure the namespace exists and credentials have appropriate permissions.`
          );
        }
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
      logger.debug('Executing SurrealDB query', { 
        sql, 
        params,
        namespace: config.surrealdb.namespace,
        database: config.surrealdb.database 
      });
      const result = await this.db.query(sql, params);
      
      // SurrealDB returns array of result sets, we typically want the first one
      const firstResult = Array.isArray(result) && result.length > 0 ? result[0] : [];
      return firstResult as T[];
    } catch (error) {
      const err = error as Error;
      logger.error('SurrealDB query failed', { 
        sql, 
        params, 
        namespace: config.surrealdb.namespace,
        database: config.surrealdb.database,
        error: err.message 
      });
      
      // Enrich error with namespace context
      throw new Error(
        `Query failed in ${config.surrealdb.namespace}.${config.surrealdb.database}: ${err.message}`
      );
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
