/**
 * Impulse Management Routes
 * 
 * Implements impulse endpoints matching Python RPC API:
 * - POST /v2/impulses - Store impulse data with project-scoped isolation
 * - GET /v2/impulses/:id - Retrieve impulse by impulse_id with tenant filtering
 * - GET /v2/impulses - List impulses with pagination
 * 
 * Reference: repos/metabob-rpc-api/server/routes/impulse.py
 * Database: repos/metabob-rpc-api/server/db/operations/impulse_data.py
 * 
 * Multi-tenant isolation enforced via composite key: (api_key, project_id, impulse_id)
 */

import { Hono } from 'hono';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import {
  ImpulseCreateRequestSchema,
  type ImpulseResponse,
  type ImpulseListResponse,
  type SessionData,
} from '../models/schemas';

const router = new Hono();

/**
 * POST /v2/impulses
 * Create impulse with project-scoped isolation
 * 
 * Matches Python implementation:
 * repos/metabob-rpc-api/server/routes/impulse.py:104-189
 * repos/metabob-rpc-api/server/db/operations/impulse_data.py:create_impulse
 * 
 * Flow:
 * 1. Extract session from context (authMiddleware provides api_key, project_id)
 * 2. Parse request body with ImpulseCreateRequestSchema
 * 3. Check if impulse already exists (composite key lookup)
 * 4. If exists, return 400 error
 * 5. Create impulse in SurrealDB impulse_data table
 * 6. Return 201 with impulse data
 */
router.post('/', async (c) => {
  try {
    const session = (c.get as any)('session') as SessionData | null;
    
    if (!session || !session.api_key) {
      return c.json({ error: 'Unauthorized - valid session required' }, 401);
    }

    // Parse request body
    const body = await c.req.json();
    const request = ImpulseCreateRequestSchema.parse(body);
    
    const { impulse_id, project_id, impulse_data } = request;
    const api_key = session.api_key;
    
    logger.info('POST /v2/impulses', { 
      impulse_id, 
      project_id, 
      api_key: api_key.substring(0, 8) + '...',
      impulse_type: impulse_data.type 
    });

    // Check if impulse already exists (composite key: api_key, project_id, impulse_id)
    const existsQuery = `
      SELECT * FROM impulse_data
      WHERE impulse_id = $impulse_id
        AND api_key = $api_key
        AND project_id = $project_id
      LIMIT 1
    `;
    
    const existing = await surrealDB.query<any>(existsQuery, {
      impulse_id,
      api_key,
      project_id,
    });

    if (existing.length > 0) {
      logger.warn('Impulse already exists', { impulse_id, project_id });
      return c.json({
        error: 'Impulse already exists',
        impulse_id,
        project_id,
      }, 400);
    }

    // Create impulse record with timestamps
    const now = new Date().toISOString();
    const createQuery = `
      CREATE impulse_data CONTENT {
        impulse_id: $impulse_id,
        api_key: $api_key,
        project_id: $project_id,
        impulse_data: $impulse_data,
        created_at: $created_at,
        updated_at: $updated_at
      }
    `;

    const result = await surrealDB.query<any>(createQuery, {
      impulse_id,
      api_key,
      project_id,
      impulse_data,
      created_at: now,
      updated_at: now,
    });

    if (!result || result.length === 0) {
      throw new Error('Failed to create impulse in SurrealDB');
    }

    logger.info('Impulse created', {
      impulse_id,
      project_id,
      created_at: now,
    });

    // Return response matching Python ImpulseResponse schema
    const response: ImpulseResponse = {
      impulse_id,
      api_key,
      project_id,
      impulse_data,
      created_at: now,
      updated_at: now,
    };

    return c.json(response, 201);

  } catch (error: any) {
    logger.error('POST /v2/impulses failed', {
      error: error.message,
      stack: error.stack,
    });

    // Handle Zod validation errors
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Invalid request body',
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to create impulse',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/impulses/:impulseId
 * Retrieve impulse by ID with multi-tenant isolation
 * 
 * Matches Python implementation:
 * repos/metabob-rpc-api/server/routes/impulse.py:192-231
 * repos/metabob-rpc-api/server/db/operations/impulse_data.py:get_impulse
 * 
 * Flow:
 * 1. Extract session (api_key) from context
 * 2. Extract impulse_id from URL params
 * 3. Extract project_id from query params (required)
 * 4. Query SurrealDB with composite key (api_key, project_id, impulse_id)
 * 5. Return 200 with impulse data or 404 if not found
 */
router.get('/:impulseId', async (c) => {
  try {
    const session = (c.get as any)('session') as SessionData | null;
    
    if (!session || !session.api_key) {
      return c.json({ error: 'Unauthorized - valid session required' }, 401);
    }

    const impulse_id = c.req.param('impulseId');
    const project_id = c.req.query('project_id');
    
    if (!project_id) {
      return c.json({
        error: 'Missing required query parameter: project_id',
      }, 400);
    }

    const api_key = session.api_key;

    logger.info('GET /v2/impulses/:impulseId', {
      impulse_id,
      project_id,
      api_key: api_key.substring(0, 8) + '...',
    });

    // Query with composite key for multi-tenant isolation
    const query = `
      SELECT * FROM impulse_data
      WHERE impulse_id = $impulse_id
        AND api_key = $api_key
        AND project_id = $project_id
      LIMIT 1
    `;

    const result = await surrealDB.query<any>(query, {
      impulse_id,
      api_key,
      project_id,
    });

    if (result.length === 0) {
      logger.debug('Impulse not found', { impulse_id, project_id });
      return c.json({
        error: 'Impulse not found',
        impulse_id,
        project_id,
      }, 404);
    }

    const impulse = result[0];

    logger.info('Impulse retrieved', { impulse_id, project_id });

    // Return response matching Python ImpulseResponse schema
    const response: ImpulseResponse = {
      impulse_id: impulse.impulse_id,
      api_key: impulse.api_key,
      project_id: impulse.project_id,
      impulse_data: impulse.impulse_data,
      created_at: impulse.created_at,
      updated_at: impulse.updated_at,
    };

    return c.json(response, 200);

  } catch (error: any) {
    logger.error('GET /v2/impulses/:impulseId failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to retrieve impulse',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/impulses
 * List impulses with pagination and multi-tenant filtering
 * 
 * Matches Python implementation:
 * repos/metabob-rpc-api/server/routes/impulse.py:234-283
 * repos/metabob-rpc-api/server/db/operations/impulse_data.py:list_impulses
 * 
 * Flow:
 * 1. Extract session (api_key) from context
 * 2. Extract query params: project_id (required), limit (default=100, max=1000), offset (default=0)
 * 3. Query SurrealDB with composite key (api_key, project_id) and pagination
 * 4. Return 200 with array of impulses
 */
router.get('/', async (c) => {
  try {
    const session = (c.get as any)('session') as SessionData | null;
    
    if (!session || !session.api_key) {
      return c.json({ error: 'Unauthorized - valid session required' }, 401);
    }

    const project_id = c.req.query('project_id');
    
    if (!project_id) {
      return c.json({
        error: 'Missing required query parameter: project_id',
      }, 400);
    }

    const api_key = session.api_key;
    
    // Parse pagination params (match Python defaults)
    const limitStr = c.req.query('limit') || '100';
    const offsetStr = c.req.query('offset') || '0';
    
    let limit = parseInt(limitStr, 10);
    let offset = parseInt(offsetStr, 10);
    
    // Validate and cap limit (Python max=1000)
    if (isNaN(limit) || limit < 1) {
      limit = 100;
    }
    if (limit > 1000) {
      limit = 1000;
    }
    
    if (isNaN(offset) || offset < 0) {
      offset = 0;
    }

    logger.info('GET /v2/impulses', {
      project_id,
      limit,
      offset,
      api_key: api_key.substring(0, 8) + '...',
    });

    // Query with composite key and pagination (ORDER BY created_at DESC matches Python)
    const query = `
      SELECT * FROM impulse_data
      WHERE api_key = $api_key
        AND project_id = $project_id
      ORDER BY created_at DESC
      LIMIT $limit
      START $offset
    `;

    const result = await surrealDB.query<any>(query, {
      api_key,
      project_id,
      limit,
      offset,
    });

    logger.info('Impulses retrieved', {
      count: result.length,
      project_id,
      limit,
      offset,
    });

    // Map to ImpulseResponse schema
    const impulses: ImpulseResponse[] = result.map((impulse: any) => ({
      impulse_id: impulse.impulse_id,
      api_key: impulse.api_key,
      project_id: impulse.project_id,
      impulse_data: impulse.impulse_data,
      created_at: impulse.created_at,
      updated_at: impulse.updated_at,
    }));

    // Return response matching Python ImpulseListResponse schema
    const response: ImpulseListResponse = {
      impulses,
      total: impulses.length,
      limit,
      offset,
    };

    return c.json(response, 200);

  } catch (error: any) {
    logger.error('GET /v2/impulses failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to list impulses',
      message: error.message,
    }, 500);
  }
});

export default router;
