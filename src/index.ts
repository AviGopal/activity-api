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
import { authMiddleware } from './middleware/auth';
import sessionRoutes from './routes/session';
import activitiesRoutes from './routes/activities';
import impulsesRoutes from './routes/impulses';
import { broadcaster } from './websocket/broadcaster';
import type { ServerWebSocket } from 'bun';

const app = new Hono();

// ============================================================================
// Middleware
// ============================================================================

// CORS configuration for cross-origin requests
app.use('/*', cors({
  origin: '*', // Allow all origins for development
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Request logging
app.use('/*', honoLogger());

// Authentication middleware (applies to all routes except /health)
app.use('/v2/*', authMiddleware);

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
    await surrealDB.query('SELECT * FROM variant_performance_metrics LIMIT 1');
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

// Session routes (POST /v2/session, GET /v2/session)
app.route('/v2/session', sessionRoutes);

// Activity routes (GET /v2/activities/templates, etc.)
app.route('/v2/activities', activitiesRoutes);

// Impulse routes (POST /v2/impulses, GET /v2/impulses/:id, GET /v2/impulses)
app.route('/v2/impulses', impulsesRoutes);

// Execution routes (POST /v2/activities/executions)
// TODO: Implement in Phase 3
// app.route('/v2/activities/executions', executionsRoutes);

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
    
    message(ws, message) {
      try {
        const data = JSON.parse(message.toString());
        
        // Handle authentication
        if (data.type === 'authenticate' && data.token) {
          // TODO: Validate token against session store
          // For now, mark as authenticated (will implement proper auth in next iteration)
          ws.data.authenticated = true;
          ws.data.sessionId = data.sessionId || 'default';
          ws.data.orgId = data.orgId || 'default';
          
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
