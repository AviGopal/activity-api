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
import { broadcaster } from './websocket/broadcaster';
import type { ServerWebSocket } from 'bun';

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
  origin: '*', // Allow all origins for development
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Internal-Api-Key'],
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
  // JWT auth only (no Redis session fallback)
  await jwtAuthMiddleware(c, next);
});

// ============================================================================
// Routes
// ============================================================================

// Health check endpoint (no auth required)
// Deep health check: verifies Redis and SurrealDB connectivity
app.get('/health', async (c) => {
  const healthStatus: any = {
    service: 'metabob-activity-api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    checks: {
      redis: { status: 'unknown', latency_ms: 0 },
      surrealdb: { status: 'unknown', latency_ms: 0 }
    }
  };

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

  healthStatus.status = allHealthy ? 'healthy' : 'unhealthy';

  // Return 503 Service Unavailable if any dependency is unhealthy
  // This signals Kubernetes to remove pod from load balancer
  return c.json(healthStatus, allHealthy ? 200 : 503);
});

// Authentication routes - DEPRECATED (vessel alignment 2026-04-02)
// MiniBob auth moved to identity-vessel: POST https://identity.metabob.local/v1/auth/minibob/signin
// This empty router is kept for documentation and to return 404 for legacy auth calls
app.route('/v2/auth', authRoutes);

// Activity routes (GET /v2/activities/templates, etc.)
app.route('/v2/activities', activitiesRoutes);
  
// Goal paths routes (Phase 1.7: Thompson Sampling over paths)
app.route('/v2/activities/goal-paths', goalPathsRoutes);

// Impulse routes (POST /v2/impulses, GET /v2/impulses/:id, GET /v2/impulses)
app.route('/v2/impulses', impulsesRoutes);

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
  fetch(req, server) {
    // Handle WebSocket upgrade for /ws endpoint
    const url = new URL(req.url);
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
          // CRITICAL: Validate JWT token before marking as authenticated
          const { validateJwtToken } = await import('./services/auth');
          const validation = await validateJwtToken(data.token);

          if (!validation.valid || !validation.payload) {
            logger.warn('[WebSocket] Authentication failed', {
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
          const orgId = validation.payload.org_id?.toString().replace('organizations:', '') || '';

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
