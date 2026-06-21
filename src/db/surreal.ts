/**
 * SurrealDB Client
 * Manages connection to SurrealDB and provides query interface
 */

import { Surreal } from 'surrealdb';
import { config } from '../config';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// DB throughput / contention instrumentation (single chokepoint: every root
// query passes through SurrealDBClient.query). Low overhead: O(1) per query;
// the only sort is over a bounded rolling window at scrape time. Exposed via
// getDbStats() -> GET /metrics/db so the substrate can self-detect contention
// (the class of issue that pinned SurrealDB on 2026-06-20).
// ---------------------------------------------------------------------------
interface DbOpStat { count: number; sumMs: number; }
class DbStats {
  inFlight = 0;
  total = 0;
  errors = 0;
  slow = 0; // queries slower than SLOW_MS
  sumMs = 0;
  maxMs = 0;
  startedAt = Date.now();
  byOp: Record<string, DbOpStat> = {};
  private recent: number[] = [];
  private readonly RECENT_CAP = 500;
  static readonly SLOW_MS = 1000;

  record(sql: string, ms: number, ok: boolean): void {
    this.total++;
    this.sumMs += ms;
    if (ms > this.maxMs) this.maxMs = ms;
    if (!ok) this.errors++;
    if (ms > DbStats.SLOW_MS) this.slow++;
    const op = (sql.trim().split(/\s+/, 1)[0] || 'OTHER').toUpperCase();
    const e = this.byOp[op] ?? (this.byOp[op] = { count: 0, sumMs: 0 });
    e.count++; e.sumMs += ms;
    this.recent.push(ms);
    if (this.recent.length > this.RECENT_CAP) this.recent.shift();
  }

  snapshot() {
    const sorted = [...this.recent].sort((a, b) => a - b);
    const pct = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0;
    const uptimeS = Math.max(1, (Date.now() - this.startedAt) / 1000);
    return {
      in_flight: this.inFlight,
      total_queries: this.total,
      errors: this.errors,
      error_rate: this.total ? +(this.errors / this.total).toFixed(4) : 0,
      slow_queries: this.slow, // > 1000ms
      qps: +(this.total / uptimeS).toFixed(2),
      latency_ms: {
        mean: this.total ? +(this.sumMs / this.total).toFixed(1) : 0,
        p50: +pct(0.5).toFixed(1),
        p95: +pct(0.95).toFixed(1),
        p99: +pct(0.99).toFixed(1),
        max: +this.maxMs.toFixed(1),
        window: sorted.length,
      },
      by_op: Object.fromEntries(Object.entries(this.byOp).map(([k, v]) => [k, { count: v.count, mean_ms: +(v.sumMs / v.count).toFixed(1) }])),
      uptime_s: Math.round(uptimeS),
    };
  }
}
export const dbStats = new DbStats();
export function getDbStats() { return dbStats.snapshot(); }

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

  async query<T = any>(sql: string, params?: Record<string, any>, _isRetry = false, _conflictRetries = 0): Promise<T[]> {
    await this.connect();

    if (!this.db) {
      throw new Error('SurrealDB not connected');
    }

    const __t0 = performance.now();
    dbStats.inFlight++;
    try {
      // Per-statement logging is on the hot path (every query); keep it at debug
      // and drop the JSON.stringify(params) + raw-result serialization that fired
      // 3x per statement and flooded journald under load.
      logger.debug('Executing SurrealDB query', { sql });
      const result = await this.db.query(sql, params);

      // SurrealDB returns array of result sets, we typically want the first one
      const firstResult = Array.isArray(result) && result.length > 0 ? result[0] : [];

      dbStats.record(sql, performance.now() - __t0, true);
      dbStats.inFlight--;
      return firstResult as T[];
    } catch (error) {
      dbStats.record(sql, performance.now() - __t0, false);
      dbStats.inFlight--;
      const err = error as Error;

      // SurrealDB WebSocket reconnects without re-authenticating, leaving the root
      // connection in anonymous mode. Detect this and force a fresh connect+signin,
      // then retry the query once. Without this guard, every query fails until the
      // pod is restarted by the liveness probe.
      if (
        !_isRetry &&
        (err.message.includes('Anonymous access not allowed') ||
          err.message.includes('Not enough permissions to perform this action'))
      ) {
        logger.warn('SurrealDB root connection lost auth — resetting and reconnecting', {
          sql,
          error: err.message,
        });
        try { await this.db.close(); } catch {}
        this.db = null;
        this.connecting = null;
        return await this.query<T>(sql, params, true);
      }

      // Optimistic-concurrency write conflicts ("Failed to commit transaction due to
      // a read or write conflict. This transaction can be retried") happen when
      // concurrent transactions touch the same rows — posterior updates, the v1
      // context_thompson_scores cells, and trace ingest all converge on hot rows
      // under load. SurrealDB aborts (full rollback) and explicitly marks these
      // RETRYABLE; the increment did NOT apply, so a retry is safe and idempotent.
      // Without it the write is dropped (callers swallow it non-blocking), so the
      // LEARNING STORE silently fails to accumulate under contention — variant
      // posteriors and the state-signature cells never land, and the topology cannot
      // self-assemble. Retry a few times with small exponential backoff so the
      // learning writes win instead of losing the race.
      if (
        _conflictRetries < 4 &&
        (err.message.includes('read or write conflict') ||
          err.message.includes('Failed to commit transaction'))
      ) {
        const backoffMs = 25 * Math.pow(2, _conflictRetries); // 25, 50, 100, 200ms
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return await this.query<T>(sql, params, _isRetry, _conflictRetries + 1);
      }

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
  // Phase 12: route through the auth-session pool when enabled. Saves
  // the connect/use/authenticate handshake (~200-300ms cold) on every
  // queryWithAuth call. Pool stays disabled (legacy path) when
  // DB_POOL_ENABLED=false until canary validation flips the default.
  const { authSessionPool } = await import('./auth-session-pool');
  if (authSessionPool.enabled()) {
    const session = await authSessionPool.acquire(
      jwtToken,
      config.surrealdb.namespace,
      config.surrealdb.database,
    );
    try {
      logger.info('Executing authenticated query (pooled)', {
        sql,
        params,
        namespace: config.surrealdb.namespace,
        database: config.surrealdb.database,
      });
      const result = await session.db.query(sql, params);
      const firstResult = Array.isArray(result) && result.length > 0 ? result[0] : [];
      return firstResult as T[];
    } finally {
      authSessionPool.release(session);
    }
  }

  // Legacy path: open and close on every query.
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
