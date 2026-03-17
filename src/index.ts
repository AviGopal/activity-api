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
app.get('/health', (c) => {
  return c.json({ 
    status: 'ok', 
    service: 'metabob-activity-api',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
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

export default {
  port,
  fetch: app.fetch,
};

// CLI execution
if (import.meta.main) {
  const server = Bun.serve({
    port,
    fetch: app.fetch,
  });

  logger.info(`Server running at http://localhost:${server.port}`);
}
