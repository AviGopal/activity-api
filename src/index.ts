/**
 * Main Server Entry Point
 * TypeScript v2 Activity API Server
 * 
 * Replaces Python RPC API with identical v2 endpoint dataflows
 * Maintains compatibility with metabob-cli MCP tools
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { config } from './config';
import { logger } from './utils/logger';
import { jwtAuthMiddleware, JwtAuthContext } from './middleware/jwtAuth';
import authRoutes from './routes/auth';
import activitiesRoutes from './routes/activities';
import { handleSelectActivityForGoal } from './selectActivityForGoal';
import impulsesRoutes from './routes/impulses';
import goalPathsRoutes from './routes/goal-paths';
import boredomRoutes from './routes/boredom';
import ciRoutes from './routes/ci';
import executionTracesRoutes from './routes/execution-traces';
import codeVariantsRoutes from './routes/code-variants';
import vesselsRoutes from './routes/vessels';
import vesselRegistryRoutes from './routes/vessel-registry';
import connectionsRoutes from './routes/connections';
import ribosomeRoutes from './routes/ribosome';
import shapesRoutes from './routes/shapes';
import clusterRoutes from './routes/cluster';
import eventsRoutes from './routes/events';
import tuningParamsRoutes from './routes/tuning-params';
import llmRouterRoutes from './routes/llm-router';
import { broadcaster } from './websocket/broadcaster';
import type { ServerWebSocket } from 'bun';
import packageJson from '../package.json';
import { discoveryClient } from './services/discovery-client';
import { localEmbeddingService } from './services/embedding-service';
import { surrealDB as surrealDBForBackfill } from './db/surreal';

// Define app-wide environment type with jwtAuth context variable
type AppEnv = {
  Variables: {
    jwtAuth: JwtAuthContext | null;
  };
};

const app = new Hono<AppEnv>();

// ============================================================================
// Middleware
// ============================================================================

// CORS configuration for cross-origin requests
app.use('/*', cors({
  origin: process.env.CORS_ORIGINS?.split(',') || [
    'https://activity.metabob.com',
    'https://internal.metabob.com',
    'https://app.metabob.com',
    'https://metabobproject.github.io',  // Dashboard on GitHub Pages
  ],
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: [
    'Content-Type',
    'Authorization',
    'X-Internal-Api-Key',
    'X-Trace-Session',   // Dashboard tracing
    'X-Trace-Source',    // Dashboard tracing
  ],
}));

// Request logging
app.use('/*', honoLogger());

// Authentication middleware (applies to all routes except /health and /v2/auth)
// JWT auth only (Redis session auth removed)
app.use('/v2/*', async (c, next) => {
  // Skip auth middleware for authentication endpoints
  if (c.req.path.startsWith('/v2/auth/')) {
    await next();
    return;
  }
  // Phase 12: pool-stats endpoint is operational, unauthenticated
  // (parallel to /health). Spec requires this for ops scraping.
  if (c.req.path === '/v2/health/db-pool') {
    await next();
    return;
  }
  // JWT auth only (no Redis session fallback)
  // Must return the middleware's result so the Response from a 401
  // c.json(...) propagates back to Hono. Without this, when
  // jwtAuthMiddleware short-circuits (e.g. missing Authorization header on a
  // protected path), Hono sees the wrapper finish without c.finalized=true
  // and emits "Context is not finalized" (HTTP 500).
  return jwtAuthMiddleware(c, next);
});

// ============================================================================
// Routes
// ============================================================================

// Health check endpoint (no auth required)
// Deep health check: verifies Redis and SurrealDB connectivity
let healthCache: { at: number; body: any; code: number } | null = null;
app.get('/health', async (c) => {
  if (healthCache && Date.now() - healthCache.at < 10_000) { return c.json({ ...healthCache.body, cached: true }, healthCache.code as 200 | 503); }
  const healthStatus: any = {
    service: 'activity-api',
    version: packageJson.version,
    timestamp: new Date().toISOString(),
    checks: {
      redis: { status: 'unknown', latency_ms: 0 },
      surrealdb: { status: 'unknown', latency_ms: 0 },
      discovery: { status: 'unknown', registered: false },
      embedding: localEmbeddingService.getStatus(),
      pool: { size: 0, max_size: 0, hit_rate: null as number | null },
    }
  };

  // Phase 12: include pool stats in /health (size, max_size, hit_rate).
  try {
    const { authSessionPool } = await import('./db/auth-session-pool');
    const stats = authSessionPool.poolStats();
    const total = stats.acquire_hits + stats.acquire_misses;
    healthStatus.checks.pool = {
      size: stats.size,
      max_size: stats.max_size,
      hit_rate: total >= 100 ? Math.round((stats.acquire_hits / total) * 100) / 100 : null,
    };
  } catch {
    // Pool stats are advisory; never fail the health check on them.
  }

  let allHealthy = true;

  // Check Redis connectivity
  try {
    const redisStart = Date.now();
    const { RedisClient } = await import('./db/redis');
    const redis = RedisClient.getInstance();
    await redis.getClient().ping();
    healthStatus.checks.redis = {
      status: 'healthy',
      latency_ms: Date.now() - redisStart
    };
  } catch (error: any) {
    logger.error('Redis health check failed', { error: error.message });
    healthStatus.checks.redis = {
      status: 'unhealthy',
      error: error.message
    };
    allHealthy = false;
  }

  // Check SurrealDB connectivity
  try {
    const surrealStart = Date.now();
    const { surrealDB } = await import('./db/surreal');
    await surrealDB.query('SELECT * FROM activity LIMIT 1');
    healthStatus.checks.surrealdb = {
      status: 'healthy',
      latency_ms: Date.now() - surrealStart
    };
  } catch (error: any) {
    logger.error('SurrealDB health check failed', { error: error.message });
    healthStatus.checks.surrealdb = {
      status: 'unhealthy',
      error: error.message
    };
    allHealthy = false;
  }

  // Check Discovery registration status
  if (discoveryClient.isEnabled()) {
    const isRegistered = discoveryClient.isRegistered();
    const lastError = discoveryClient.getLastError();

    healthStatus.checks.discovery = {
      status: isRegistered ? 'healthy' : (lastError ? 'unhealthy' : 'pending'),
      registered: isRegistered,
      error: lastError || undefined
    };

    // Discovery is optional, don't fail health check if it's down
    // (graceful degradation)
  } else {
    healthStatus.checks.discovery = {
      status: 'disabled',
      registered: false
    };
  }

  healthStatus.status = allHealthy ? 'healthy' : 'unhealthy';

  // Return 503 Service Unavailable if any critical dependency is unhealthy
  // Discovery is non-critical, so it won't affect health status
  healthCache = { at: Date.now(), body: healthStatus, code: allHealthy ? 200 : 503 };
  return c.json({ ...healthStatus, cached: false }, allHealthy ? 200 : 503);
});

// Phase 12: full pool stats. Unauthenticated (parallel to /health) so
// operators can scrape without minting credentials.
app.get('/v2/health/db-pool', async (c) => {
  try {
    const { authSessionPool } = await import('./db/auth-session-pool');
    return c.json(authSessionPool.poolStats());
  } catch (e) {
    return c.json({ error: 'pool unavailable', message: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// DB throughput/contention chokepoint instrumentation (see src/db/surreal.ts
// DbStats). Read by development-vessel's db_contention_observer resolver.
// Unauthenticated (parallel to /health and /v2/health/db-pool) so in-container
// observers can scrape without minting credentials.
//
// Also surfaces `traceStore` (row_count / cap / last_reconciled_at) from the
// single-row trace_store_counters:activity_execution_traces counter
// (migration 156, openspec/changes/2026-07-08-substrate-self-managed-db-reconciliation)
// — an O(1) read, NEVER a COUNT() over activity_execution_traces.
app.get('/metrics/db', async (c) => {
  try {
    const { getDbStats, surrealDB } = await import('./db/surreal');
    const { TRACE_STORE_COUNTER_ID } = await import('./lib/trace-store-counters');
    const stats = getDbStats();

    let traceStore: { row_count: number; cap: number; last_reconciled_at: string | null } = {
      row_count: 0,
      cap: config.traceStore.cap,
      last_reconciled_at: null,
    };
    try {
      const rows = await surrealDB.query<any>(`SELECT * FROM ${TRACE_STORE_COUNTER_ID}`);
      const row = (Array.isArray(rows) ? rows : [])[0];
      if (row) {
        traceStore = {
          row_count: typeof row.row_count === 'number' ? row.row_count : 0,
          cap: typeof row.cap === 'number' ? row.cap : config.traceStore.cap,
          last_reconciled_at: row.last_reconciled_at ?? null,
        };
      }
    } catch (e) {
      // Counters row is advisory metadata; never fail /metrics/db on it.
      logger.warn('trace_store_counters read failed for /metrics/db', {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    return c.json({ ...stats, traceStore });
  } catch (e) {
    return c.json({ error: 'db metrics unavailable', message: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// Authentication routes - DEPRECATED (vessel alignment 2026-04-02)
// MiniBob auth moved to identity-vessel: POST https://identity.metabob.local/v1/auth/minibob/signin
// This empty router is kept for documentation and to return 404 for legacy auth calls
app.route('/v2/auth', authRoutes);

// Activity routes (GET /v2/activities/templates, etc.)
app.route('/v2/activities', activitiesRoutes);

// Goal paths routes (Thompson Sampling over paths)
app.route('/v2/goal-paths', goalPathsRoutes);

// Impulse routes (POST /v2/impulses, GET /v2/impulses/:id, GET /v2/impulses)
app.route('/v2/impulses', impulsesRoutes);

// Shape registry routes (POST /v2/shapes, GET /v2/shapes, GET /v2/shapes/:name, etc.)
app.route('/v2/shapes', shapesRoutes);

// Substrate event bus publish endpoint (POST /v2/events/publish). The router
// existed in src/routes/events.ts since 2026-05-27 but was never mounted, so
// every BusForwardingEventSink publish from goal-host and vessel-daemon 404'd
// and all lifecycle bus events were dropped. Mounted 2026-07-05
// (gap trace-persistence-loss-2026-07-05 investigation).
app.route('/v2/events', eventsRoutes);

// Hierarchical signature clustering status (D3.4) — GET /v2/cluster/status.
// Auth: gated by the global /v2/* jwtAuthMiddleware above.
app.route('/v2/cluster', clusterRoutes);

// Tuning-param write seam (POST /v2/tuning-params) — the write-back that lets a
// learning-policy recommendation actuate on the learner. Auth: gated by the
// global /v2/* jwtAuthMiddleware above.
app.route('/v2/tuning-params', tuningParamsRoutes);
app.route('/v2/llm-router', llmRouterRoutes);

// Boredom queue routes (GET /boredom-tasks, POST /v2/activities/boredom/enqueue, POST /v2/vessels/register)
app.route('/', boredomRoutes);

// CI/CD integration routes (POST /v2/activities/ci-result, GET /v2/activities/ci-results)
app.route('/v2/activities', ciRoutes);

// Execution traces routes (GET /v2/activities/execution-traces)
app.route('/v2/activities/execution-traces', executionTracesRoutes);

// Code variants routes (GET /v2/activities/code-variants)
app.route('/v2/activities/code-variants', codeVariantsRoutes);

// Vessel registry routes (SPEC-004: POST /v2/vessels/register, GET /v2/vessels/discover, etc.)
// MOUNTED FIRST to take precedence over legacy vessel status routes
app.route('/v2/vessels', vesselRegistryRoutes);

// Vessel status routes (GET /v2/vessels/status, POST /v2/vessels/heartbeat)
// Legacy routes - mounted after SPEC-004 routes
app.route('/v2/vessels', vesselsRoutes);

// Connection slot routes (POST /v2/connections/acquire, heartbeat, reconnect, release)
app.route('/v2/connections', connectionsRoutes);

// Ribosome routes (T9: POST /v2/ribosome/extract, POST /v2/ribosome/extract-from-session, GET /v2/ribosome/candidates)
app.route('/v2/ribosome', ribosomeRoutes);

// ============================================================================
// Admin: learning-track classification status
// GET /v2/admin/learning-tracks?activity_id=<id>&limit=100&offset=0
// Admin-scope required.
// ============================================================================
app.get('/v2/admin/learning-tracks', async (c) => {
  try {
    const { getJwtAuthFromContext } = await import('./middleware/jwtAuth');
    const jwtAuth = getJwtAuthFromContext(c);
    if (!jwtAuth?.scopes?.includes('admin')) {
      return c.json({ error: 'admin scope required' }, 403);
    }

    const activityId = c.req.query('activity_id');
    const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 500);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    const { surrealDB: db } = await import('./db/surreal');
    const rows = await db.query<{
      id: string;
      learning_track: string | null;
      last_classified_at: string | null;
      output_shapes: string[] | null;
    }>(
      activityId
        ? `SELECT id, learning_track, last_classified_at, output_shapes FROM activity WHERE id = $id LIMIT 1`
        : `SELECT id, learning_track, last_classified_at, output_shapes FROM activity WHERE execution_type = 'template' ORDER BY id LIMIT $limit START $offset`,
      activityId ? { id: activityId } : { limit, offset }
    );

    // Enrich with trace_digest signal counts
    const enriched = await Promise.all((rows ?? []).map(async (row) => {
      const sigRows = await db.query<{
        avg_task_count: number;
        avg_output_shape_count: number;
        sample_count: number;
      }>(
        `SELECT
           math::mean(array::len(task_summaries ?? [])) AS avg_task_count,
           math::mean(array::len(output_impulse_shapes ?? [])) AS avg_output_shape_count,
           count() AS sample_count
         FROM trace_digest WHERE activity_id = $id GROUP ALL`,
        { id: String(row.id) }
      ).catch(() => null);
      const sig = sigRows?.[0];
      return {
        activity_id: row.id,
        learning_track: row.learning_track ?? 'unclassified',
        last_classified_at: row.last_classified_at ?? null,
        signals: {
          avg_task_count: sig?.avg_task_count ?? null,
          avg_output_shape_count: sig?.avg_output_shape_count ?? null,
          declared_output_shapes_count: row.output_shapes?.length ?? 0,
          sample_count: sig?.sample_count ?? 0,
        },
      };
    }));

    return c.json({ items: enriched, count: enriched.length });
  } catch (err) {
    return c.json({ error: 'internal error', detail: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ============================================================================
// Error Handling
// ============================================================================

app.onError((err, c) => {
  logger.error('Unhandled error', { 
    error: err.message, 
    stack: err.stack,
    path: c.req.path,
    method: c.req.method
  });
  
  return c.json({ 
    error: 'Internal server error',
    message: err.message,
    timestamp: new Date().toISOString()
  }, 500);
});

app.notFound((c) => {
  return c.json({ 
    error: 'Not found',
    path: c.req.path,
    method: c.req.method
  }, 404);
});

// ============================================================================
// Server Startup
// ============================================================================

const port = parseInt(process.env.PORT || '8080', 10);

logger.info('Starting Metabob Activity API', {
  port,
  redis: config.redis.url,
  surrealdb: config.surrealdb.url
});

// WebSocket data type
interface WebSocketData {
  sessionId?: string;
  orgId?: string;
  authenticated: boolean;
}

// Start server with WebSocket support
const server = Bun.serve<WebSocketData>({
  port,
  idleTimeout: 60,
  fetch(req, server) {
    // Handle WebSocket upgrade for /ws endpoint
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/v2/activities/select-activity-for-goal') {
      return handleSelectActivityForGoal(req as import('bun').BunRequest);
    }
    if (url.pathname === '/ws') {
      const success = server.upgrade(req, {
        data: { authenticated: false }
      });
      if (success) {
        return undefined; // Upgrade successful, handled by websocket handlers
      }
      return new Response('WebSocket upgrade failed', { status: 500 });
    }
    
    // Regular HTTP requests
    return app.fetch(req, server);
  },
  websocket: {
    open(ws) {
      broadcaster.addClient(ws as any);
      logger.info('[WebSocket] Client connected, awaiting authentication');
    },
    
    async message(ws, message) {
      try {
        const data = JSON.parse(message.toString());

        // Handle authentication
        if (data.type === 'authenticate' && data.token) {
          const { validateJwtToken, validateApiKeyViaIdentityVessel } = await import('./services/auth');

          let orgId: string | undefined;
          let authMethod: string;

          // Determine if token is JWT (contains two dots) or API key
          const isJwt = data.token.split('.').length === 3;

          if (isJwt) {
            // Validate as JWT token
            authMethod = 'jwt';
            const validation = await validateJwtToken(data.token);

            if (!validation.valid || !validation.payload) {
              logger.warn('[WebSocket] JWT authentication failed', {
                error: validation.error || 'Invalid token',
              });

              ws.send(JSON.stringify({
                type: 'auth_error',
                error: 'Authentication failed',
                message: validation.error || 'Invalid or expired token',
                timestamp: new Date().toISOString(),
              }));

              ws.close(1008, 'Authentication failed');
              return;
            }

            // Extract org_id from validated JWT payload
            orgId = validation.payload.org_id?.toString().replace('organizations:', '') || '';
          } else {
            // Validate as API key via identity-vessel
            authMethod = 'apikey';
            logger.debug('[WebSocket] Validating API key via identity-vessel');

            const authContext = await validateApiKeyViaIdentityVessel(data.token);

            if (!authContext.authenticated) {
              logger.warn('[WebSocket] API key authentication failed', {
                reason: authContext.reason,
              });

              ws.send(JSON.stringify({
                type: 'auth_error',
                error: 'Authentication failed',
                message: authContext.reason || 'Invalid API key',
                timestamp: new Date().toISOString(),
              }));

              ws.close(1008, 'Authentication failed');
              return;
            }

            orgId = authContext.orgId;
          }

          if (!orgId) {
            logger.warn('[WebSocket] Token missing org_id claim');
            ws.send(JSON.stringify({
              type: 'auth_error',
              error: 'Invalid token claims',
              message: 'Token must contain org_id',
              timestamp: new Date().toISOString(),
            }));
            ws.close(1008, 'Invalid token claims');
            return;
          }

          // Mark as authenticated with validated claims
          ws.data.authenticated = true;
          ws.data.sessionId = data.sessionId || `session-${Date.now()}`;
          ws.data.orgId = orgId;

          logger.info('[WebSocket] Client authenticated', {
            sessionId: ws.data.sessionId,
            orgId: ws.data.orgId,
            method: authMethod,
          });

          // Send auth confirmation
          ws.send(JSON.stringify({
            type: 'authenticated',
            timestamp: new Date().toISOString(),
          }));
        }
        
        // Handle ping/pong for keepalive
        if (data.type === 'ping') {
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: new Date().toISOString(),
          }));
        }

        // Handle catchup request after reconnection
        if (data.type === 'catchup' && typeof data.lastSeenSequence === 'number') {
          if (!ws.data.authenticated) {
            ws.send(JSON.stringify({
              type: 'error',
              error: 'Not authenticated',
              timestamp: new Date().toISOString(),
            }));
            return;
          }

          const sentCount = broadcaster.sendCatchup(ws as any, data.lastSeenSequence);
          ws.send(JSON.stringify({
            type: 'catchup_complete',
            sentCount,
            currentSequence: broadcaster.getCurrentSequence(),
            timestamp: new Date().toISOString(),
          }));
        }
      } catch (error: any) {
        logger.error('[WebSocket] Failed to parse message', {
          error: error.message,
        });
      }
    },
    
    close(ws) {
      broadcaster.removeClient(ws as any);
    },
    
    drain(ws) {
      // Handle backpressure (optional, for high-volume scenarios)
      logger.debug('[WebSocket] Drain event', {
        bufferedAmount: ws.getBufferedAmount?.() || 0,
      });
    },
  },
});

logger.info(`Server running at http://localhost:${server.port}`);
logger.info(`WebSocket endpoint available at ws://localhost:${server.port}/ws`);

// ============================================================================
// FTS Scorer Maintenance
// ============================================================================
// SurrealDB 3.0.0 BM25 bug (F-V45/F-V46): any write to an FTS-indexed table
// invalidates all BM25 scorer state for that table. The previous fix removed
// the high-frequency Thompson α/β writes to `activity`. The remaining writes
// are: startup learning-track classifier (~30s burst), rare variant creation,
// and minibob template registration at startup.
//
// The three FTS indexes take ~80-140s each to REBUILD against the 2800-row
// corpus. Running sequentially totals ~350s.
//
// SurrealDB 3.x rejects concurrent REBUILD INDEX calls on the same table
// ("Database index `X` is currently building"), so Promise.all does not help.
// Sequential REBUILD is the correct approach.
//
// With a 30-minute interval, the scorer is warm for ~27 of every 30 minutes
// (~350s / 1800s = 81% cold; but in practice queries during the rebuild window
// still return results — only `search::score()` returns 0 while building).
//
// The startup delay stays at 5 minutes to let the learning-track classifier
// finish its ~2800-row UPDATE burst before the first REBUILD fires.

const FTS_REBUILD_INTERVAL_MS = parseInt(
  process.env.FTS_REBUILD_INTERVAL_MS ?? String(30 * 60 * 1000), 10,
);

// Use the shared rebuild job so the HTTP endpoint and periodic scheduler share
// the same in-process concurrency guard (prevents partial-rebuild races).
import('./jobs/fts-rebuild').then(({ rebuildFtsIndexes }) => {
  // Initial rebuild — delayed 5 min to let the startup classifier cycle finish
  // (it writes last_classified_at to all activity rows and takes ~30s). If we
  // rebuild at t=15s the index build races the classifier writes and the scorer
  // ends up cold until the next periodic cycle.
  setTimeout(() => {
    void rebuildFtsIndexes()
      .then(() => logger.info('[FTS] Initial FTS scorer rebuild complete'))
      .catch(err => logger.warn('[FTS] Initial FTS scorer rebuild failed', { error: String(err) }));
  }, 5 * 60 * 1000);

  // Periodic rebuild every FTS_REBUILD_INTERVAL_MS (default 30 min).
  setInterval(() => {
    void rebuildFtsIndexes()
      .then(() => logger.info('[FTS] Periodic FTS scorer rebuild complete'))
      .catch(err => logger.warn('[FTS] Periodic FTS scorer rebuild failed', { error: String(err) }));
  }, FTS_REBUILD_INTERVAL_MS);
}).catch(err => {
  logger.error('[FTS] Failed to load fts-rebuild job', { error: String(err) });
});

// ============================================================================
// Trace-Retention Sweep
// ============================================================================
// Bounds activity_execution_traces via stratified reservoir sampling
// (src/services/trace-retention.ts). The service was built + env-plumbed on
// 2026-06-16 but this startup call was never wired — the store re-bloated to
// 423k rows and SurrealDB pegged (2026-07-02). Env-gated: TRACE_RETENTION_ENABLED.
import('./services/trace-retention').then(({ startTraceRetentionSweep }) => {
  startTraceRetentionSweep();
}).catch(err => {
  logger.error('[trace-retention] Failed to load trace-retention job', { error: String(err) });
});

// ============================================================================
// Signature Clustering Tick (D3.2)
// ============================================================================
// Periodic pass that clusters state-space signatures (via concept-db delegation)
// and UPSERTs signature_cluster_assignment + a signature_cluster_run log row.
// Registered the same way as the FTS rebuild above: an initial delayed run plus a
// fixed-interval setInterval. Advisory — the tick never throws fatally.
const SIGNATURE_CLUSTER_INTERVAL_MS = parseInt(
  process.env.SIGNATURE_CLUSTER_INTERVAL_MS ?? String(6 * 60 * 60 * 1000), 10, // 6h
);

import('./jobs/accelerator-flag-tick').then(({ runAcceleratorFlagTick }) => {
  setTimeout(() => {
    void runAcceleratorFlagTick().catch(err => logger.warn('[FlagPolicy] initial tick failed', { error: String(err) }));
  }, 10 * 60 * 1000);
  setInterval(() => {
    void runAcceleratorFlagTick().catch(err => logger.warn('[FlagPolicy] periodic tick failed', { error: String(err) }));
  }, parseInt(process.env.ACCELERATOR_FLAG_INTERVAL_MS ?? String(60 * 60 * 1000), 10));
}).catch(err => {
  logger.error('[FlagPolicy] Failed to load accelerator-flag-tick job', { error: String(err) });
});

import('./jobs/accelerator-flag-tick').then(({ runAcceleratorFlagTick }) => {
  setTimeout(() => {
    void runAcceleratorFlagTick().catch(err => logger.warn('[FlagPolicy] initial tick failed', { error: String(err) }));
  }, 10 * 60 * 1000);
  setInterval(() => {
    void runAcceleratorFlagTick().catch(err => logger.warn('[FlagPolicy] periodic tick failed', { error: String(err) }));
  }, parseInt(process.env.ACCELERATOR_FLAG_INTERVAL_MS ?? String(60 * 60 * 1000), 10));
}).catch(err => {
  logger.error('[FlagPolicy] Failed to load accelerator-flag-tick job', { error: String(err) });
});

import('./jobs/signature-cluster-tick').then(({ runSignatureClusterTick }) => {
  // Initial run delayed 5 min so the embedding backfill has a chance to populate
  // signature_embedding on a fresh start before the first clustering pass.
  setTimeout(() => {
    void runSignatureClusterTick()
      .then(() => logger.info('[Cluster] Initial signature clustering tick complete'))
      .catch(err => logger.warn('[Cluster] Initial signature clustering tick failed', { error: String(err) }));
  }, 5 * 60 * 1000);

  // Periodic every SIGNATURE_CLUSTER_INTERVAL_MS (default 6h).
  setInterval(() => {
    void runSignatureClusterTick()
      .then(() => logger.info('[Cluster] Periodic signature clustering tick complete'))
      .catch(err => logger.warn('[Cluster] Periodic signature clustering tick failed', { error: String(err) }));
  }, SIGNATURE_CLUSTER_INTERVAL_MS);
}).catch(err => {
  logger.error('[Cluster] Failed to load signature-cluster-tick job', { error: String(err) });
});

import('./jobs/trace-replication-tick').then(({ runTraceReplicationTick }) => {
  // Intra-identity-group pull replication: converge `execution` across peers.
  const intervalMs = parseInt(process.env.REPLICATION_INTERVAL_MS ?? String(2 * 60 * 1000), 10);
  // Initial run delayed 90s so discovery registration + the federation transport
  // are up before the first pull.
  setTimeout(() => {
    void runTraceReplicationTick()
      .then(() => logger.info('[Replication] Initial trace replication tick complete'))
      .catch(err => logger.warn('[Replication] Initial trace replication tick failed', { error: String(err) }));
  }, 90 * 1000);
  setInterval(() => {
    void runTraceReplicationTick()
      .then(() => logger.debug('[Replication] Periodic trace replication tick complete'))
      .catch(err => logger.warn('[Replication] Periodic trace replication tick failed', { error: String(err) }));
  }, intervalMs);
}).catch(err => {
  logger.error('[Replication] Failed to load trace-replication-tick job', { error: String(err) });
});

// ============================================================================
// Discovery Vessel Integration
// ============================================================================

if (discoveryClient.isEnabled()) {
  // Initial registration
  discoveryClient.register()
    .then((success) => {
      if (success) {
        logger.info('[Discovery] Initial registration successful');
      } else {
        logger.warn('[Discovery] Initial registration failed (will retry)');
      }
    })
    .catch((error) => {
      logger.error('[Discovery] Initial registration error', { error: error.message });
    });

  // Start heartbeat manager
  discoveryClient.startHeartbeatManager();
  logger.info('[Discovery] Heartbeat manager started');
} else {
  logger.info('[Discovery] Discovery integration disabled');
}

// ============================================================================
// Local Embedding Service — async init + optional backfill
// ============================================================================

// Non-blocking: start embedding model load in the background.
// HTTP listener is already up; any search that arrives before init completes
// will degrade to BM25-only (localEmbeddingService.isReady() === false).
localEmbeddingService.init().then(async () => {
  if (!localEmbeddingService.isReady()) return; // Model files absent, skip backfill

  const backfillEnabled = process.env.DENSE_BACKFILL_ENABLED !== 'false';
  if (!backfillEnabled) {
    logger.info('[LocalEmbedding] Backfill disabled (DENSE_BACKFILL_ENABLED=false)');
    return;
  }

  logger.info('[LocalEmbedding] Starting backfill for activities without embeddings');
  let offset = 0;
  const batchSize = 50;
  let totalProcessed = 0;

  for (;;) {
    let rows: any[];
    try {
      rows = await surrealDBForBackfill.query<any>(
        `SELECT id, name, description FROM activity WHERE name_embedding IS NONE LIMIT $limit START $offset`,
        { limit: batchSize, offset }
      );
    } catch (err) {
      logger.warn('[LocalEmbedding] Backfill query failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }

    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      try {
        const rawId = typeof row.id === 'object' ? JSON.stringify(row.id) : String(row.id);
        const plainId = rawId.replace(/^activity:/, '').replace(/[⟨⟩`"]/g, '');
        const nameText = row.name || plainId;
        const nameVec = await localEmbeddingService.embed(nameText);
        const updates: Record<string, any> = { name_embedding: Array.from(nameVec) };
        if (row.description) {
          const descVec = await localEmbeddingService.embed(row.description);
          updates.description_embedding = Array.from(descVec);
        }
        const setClause = Object.keys(updates).map(k => `${k} = $${k}`).join(', ');
        await surrealDBForBackfill.query(
          `UPDATE type::record("activity", $id) SET ${setClause}`,
          { id: plainId, ...updates }
        );
        totalProcessed++;
        if (totalProcessed % 250 === 0) {
          logger.info('[LocalEmbedding] Backfill progress', { totalProcessed });
        }
      } catch (err) {
        logger.warn('[LocalEmbedding] Backfill row failed, skipping', {
          id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    offset += batchSize;
    if (rows.length < batchSize) break; // Last page
  }

  logger.info('[LocalEmbedding] Backfill complete', { totalProcessed });
}).catch((err) => {
  logger.error('[LocalEmbedding] Unexpected error during init/backfill', {
    error: err instanceof Error ? err.message : String(err),
  });
});

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  logger.info('[Server] SIGTERM received, shutting down gracefully');

  // Stop heartbeat and deregister
  await discoveryClient.shutdown();

  // Phase 12: drain auth-session pool
  try {
    const { authSessionPool } = await import('./db/auth-session-pool');
    await authSessionPool.drain(5000);
  } catch (e) {
    logger.warn('[Server] auth-session-pool drain failed', { error: e instanceof Error ? e.message : String(e) });
  }

  // Stop other workers
  logger.info('[Server] Graceful shutdown complete');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('[Server] SIGINT received, shutting down gracefully');
  await discoveryClient.shutdown();
  try {
    const { authSessionPool } = await import('./db/auth-session-pool');
    await authSessionPool.drain(5000);
  } catch (e) {
    logger.warn('[Server] auth-session-pool drain failed', { error: e instanceof Error ? e.message : String(e) });
  }
  logger.info('[Server] Graceful shutdown complete');
  process.exit(0);
});

// ============================================================================
// Heartbeat Worker (Connection Slot Management)
// ============================================================================

const heartbeatWorkerEnabled = process.env.HEARTBEAT_WORKER_ENABLED !== 'false';
if (heartbeatWorkerEnabled) {
  import('./workers/heartbeat').then(({ startHeartbeatWorker }) => {
    startHeartbeatWorker();
    logger.info('[Server] Heartbeat worker started');
  }).catch(err => {
    logger.error('[Server] Failed to start heartbeat worker', { error: err.message });
  });
}

// ============================================================================
// Scheduled Task Generation (Self-Development Loop)
// ============================================================================

const TASK_GENERATION_INTERVAL = 5 * 60 * 1000; // 5 minutes

async function runTaskGeneration() {
  try {
    const { taskGenerator } = await import('./services/task-generator');
    const { enqueueTask } = await import('./routes/boredom');

    const opportunities = await taskGenerator.detectOpportunities();

    let enqueued = 0;
    for (const task of opportunities) {
      try {
        await enqueueTask(task);
        enqueued++;
      } catch (e) {
        logger.error('[TaskGenerator] Failed to enqueue task', { taskId: task.id, error: e });
      }
    }

    if (enqueued > 0) {
      logger.info('[TaskGenerator] Generated self-development tasks', {
        detected: opportunities.length,
        enqueued,
      });
    }
  } catch (error) {
    logger.error('[TaskGenerator] Scheduled run failed', { error });
  }
}

// Start scheduled task generation
const taskGenerationEnabled = process.env.TASK_GENERATION_ENABLED !== 'false';
if (taskGenerationEnabled) {
  // Initial run after 30 seconds (let system stabilize)
  setTimeout(() => {
    runTaskGeneration();

    // Then run every 5 minutes
    setInterval(runTaskGeneration, TASK_GENERATION_INTERVAL);
    logger.info('[TaskGenerator] Scheduled task generation started', {
      intervalMs: TASK_GENERATION_INTERVAL,
    });
  }, 30000);
}

// ============================================================================
// Vessel Cleanup Job (SPEC-004)
// ============================================================================

const vesselCleanupEnabled = process.env.VESSEL_CLEANUP_ENABLED !== 'false';
if (vesselCleanupEnabled) {
  import('./jobs/cleanup-vessels').then(({ startCleanupJob }) => {
    startCleanupJob();
    logger.info('[Server] Vessel cleanup job started');
  }).catch(err => {
    logger.error('[Server] Failed to start vessel cleanup job', { error: err.message });
  });
}

// Exemplar selector — nightly job to refresh execution_exemplar table.
// Interval: EXEMPLAR_SELECTOR_INTERVAL_MS (default 24h).
const exemplarSelectorEnabled = process.env.EXEMPLAR_SELECTOR_ENABLED !== 'false';
if (exemplarSelectorEnabled) {
  import('./services/exemplar-selector').then(({ selectExemplarsForAllActiveActivities }) => {
    const intervalMs = parseInt(process.env.EXEMPLAR_SELECTOR_INTERVAL_MS ?? String(24 * 60 * 60 * 1000), 10);
    if (process.env.EXEMPLAR_SELECTOR_RUN_ON_BOOT === 'true') {
      setTimeout(() => {
        void selectExemplarsForAllActiveActivities().catch((err) => {
          logger.error('[exemplar-selector] startup run failed', { error: String(err) });
        });
      }, 30_000);
    }
    setInterval(() => {
      void selectExemplarsForAllActiveActivities().catch(err => {
        logger.warn('[Server] Exemplar selector cycle failed', { error: err.message });
      });
    }, intervalMs);
    logger.info('[Server] Exemplar selector job started', { intervalMs });
  }).catch(err => {
    logger.error('[Server] Failed to start exemplar selector job', { error: err.message });
  });
}

import('./jobs/successor-features-backfill').then(({ runSuccessorFeaturesBackfill }) => {
  setTimeout(() => {
    runSuccessorFeaturesBackfill(surrealDBForBackfill).then((r) => logger.info('[SF-backfill] done', r)).catch((err) => logger.warn('[SF-backfill] failed', { error: String(err) }));
  }, 3 * 60 * 1000);
});

// Learning-track classifier — runs immediately on startup then every 6h (default).
// Classifies activity templates as 'learning' | 'system' | 'unclassified' based on
// observed trace signals. Env: LEARNING_TRACK_CADENCE_MS, LEARNING_TRACK_CLASSIFIER_ENABLED.
const classifierEnabled = process.env.LEARNING_TRACK_CLASSIFIER_ENABLED !== 'false';
if (classifierEnabled) {
  import('./jobs/learning-track-classifier').then(({ runClassifierCycle }) => {
    const cadenceMs = parseInt(process.env.LEARNING_TRACK_CADENCE_MS ?? String(6 * 60 * 60 * 1000), 10);
    // Immediate first run so a fresh deploy classifies without waiting for the full cadence
    void runClassifierCycle().catch(err => {
      logger.warn('[Server] Initial learning-track classifier cycle failed', { error: err.message });
    });
    setInterval(() => {
      void runClassifierCycle().catch(err => {
        logger.warn('[Server] Learning-track classifier cycle failed', { error: err.message });
      });
    }, cadenceMs);
    logger.info('[Server] Learning-track classifier job started', { cadenceMs });
  }).catch(err => {
    logger.error('[Server] Failed to start learning-track classifier job', { error: err.message });
  });
}
