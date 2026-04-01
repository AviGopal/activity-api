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

        // SurrealDB v3.0.0: Use namespace and database before signin
        await this.db.use({
          namespace: config.surrealdb.namespace,
          database: config.surrealdb.database,
        });

        // Root user signin (after USE to establish context)
        if (config.surrealdb.authEnabled) {
          await this.db.signin({
            username: config.surrealdb.username,
            password: config.surrealdb.password,
          });
          logger.info('Signed in to SurrealDB as root user', {
            username: config.surrealdb.username,
            namespace: config.surrealdb.namespace,
            database: config.surrealdb.database
          });
        } else {
          logger.info('SurrealDB auth disabled, skipping signin');
        }

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
      logger.info('Executing SurrealDB query', {
        sql,
        params,
        paramsStringified: JSON.stringify(params),
        namespace: config.surrealdb.namespace,
        database: config.surrealdb.database
      });
      const result = await this.db.query(sql, params);

      logger.info('Raw SurrealDB query result', {
        resultType: typeof result,
        resultIsArray: Array.isArray(result),
        resultLength: Array.isArray(result) ? result.length : 'N/A',
        firstElement: Array.isArray(result) && result.length > 0 ? result[0] : null,
      });

      // SurrealDB returns array of result sets, we typically want the first one
      const firstResult = Array.isArray(result) && result.length > 0 ? result[0] : [];

      logger.info('Extracted first result', {
        firstResultType: typeof firstResult,
        firstResultIsArray: Array.isArray(firstResult),
        firstResultLength: Array.isArray(firstResult) ? firstResult.length : 'N/A',
      });

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

  /**
   * Get the underlying Surreal instance for direct access to auth methods
   * @returns The connected Surreal instance
   */
  async getInstance(): Promise<Surreal> {
    await this.connect();
    if (!this.db) {
      throw new Error('SurrealDB not connected');
    }
    return this.db;
  }
}

// Singleton instance
export const surrealDB = new SurrealDBClient();

/**
 * Create a request-scoped SurrealDB client authenticated with a JWT token.
 * This enables database-level RBAC via $auth.org_id, $auth.project_id.
 *
 * Use this for user-scoped operations where PERMISSIONS should be enforced.
 * Use surrealDB (root) for system operations (migrations, health checks).
 *
 * @param jwtToken - JWT token from MiniBob signin or user auth
 * @returns Authenticated Surreal instance with $auth populated
 */
export async function createAuthenticatedClient(jwtToken: string): Promise<Surreal> {
  const db = new Surreal();

  await db.connect(config.surrealdb.url);
  await db.use({
    namespace: config.surrealdb.namespace,
    database: config.surrealdb.database,
  });

  // Authenticate with JWT - this populates $auth for PERMISSIONS
  await db.authenticate(jwtToken);

  return db;
}

/**
 * Execute a query with user-scoped authentication.
 * Uses the JWT token to enforce RBAC permissions at the database level.
 *
 * @param jwtToken - JWT token from request header
 * @param sql - SurrealQL query
 * @param params - Query parameters
 * @returns Query results (filtered by PERMISSIONS automatically)
 */
export async function queryWithAuth<T = any>(
  jwtToken: string,
  sql: string,
  params?: Record<string, any>
): Promise<T[]> {
  const db = await createAuthenticatedClient(jwtToken);

  try {
    logger.info('Executing authenticated query', {
      sql,
      params,
      namespace: config.surrealdb.namespace,
      database: config.surrealdb.database,
    });

    const result = await db.query(sql, params);

    logger.info('Authenticated query result', {
      resultType: typeof result,
      resultIsArray: Array.isArray(result),
      resultLength: Array.isArray(result) ? result.length : 'N/A',
      firstElement: Array.isArray(result) && result.length > 0 ? (Array.isArray(result[0]) ? `array(${result[0].length})` : typeof result[0]) : 'N/A',
    });

    const firstResult = Array.isArray(result) && result.length > 0 ? result[0] : [];
    return firstResult as T[];
  } finally {
    await db.close();
  }
}
