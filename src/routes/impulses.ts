/**
 * Impulse Management Routes
 *
 * Implements impulse endpoints using the new `impulse` table schema:
 * - POST /v2/impulses - Create impulse with org-scoped isolation
 * - GET /v2/impulses/:id - Retrieve impulse by ID
 * - GET /v2/impulses - List impulses with pagination
 * - POST /v2/impulses/resolve - Resolve impulse pointers to content
 * - POST /v2/impulses/:id/usage - Track impulse usage for analytics
 *
 * Multi-tenant isolation enforced via SurrealDB PERMISSIONS (org_id from JWT auth).
 */

import { Hono } from 'hono';
import { surrealDB, queryWithAuth, createAuthenticatedClient } from '../db/surreal';
import { logger } from '../utils/logger';
import {
  ImpulseCreateRequestSchema,
  ImpulseResolveRequestSchema,
  type ImpulseResponse,
  type ImpulseListResponse,
  type ImpulseResolveResponse,
  type SessionData,
} from '../models/schemas';
import { config } from '../config';
import {
  formatToolRiskProfileAsMarkdown,
  formatCompositionSuccessAsMarkdown,
  formatImpulseRelevanceAsMarkdown,
  formatPreValidationResultAsMarkdown,
} from '../services/impulse-formatters';
import { getJwtAuthFromContext, type JwtAuthContext } from '../middleware/jwtAuth';
import { normalizeRecordId } from '../utils/surrealdb-types';
import activitiesRouter from './activities';
import executionTracesRouter from './execution-traces';
import { runTemplateAuditReport, type TemplateAuditInput } from './template-audit';
import { runExecutionTraceWithSignatures } from './execution-trace-with-signatures';
import {
  runDiscoverByShapes,
  validateDiscoverByShapesInput,
  type DiscoverByShapesMode,
} from '../services/discover-by-shapes';
import { z } from 'zod';

const router = new Hono();

/**
 * Delegate a write resolver to the appropriate REST handler, forwarding auth.
 * Used by `*_write` impulse shapes so activities can invoke learning-loop
 * writes through POST /v2/impulses/resolve instead of hardcoding REST calls.
 *
 * Returns the raw JSON body from the target handler along with its status.
 * Callers wrap this into the impulse-resolve envelope.
 */
async function delegateWriteToRouter(
  c: any,
  target: Hono,
  path: string,
  body: unknown,
): Promise<{ status: number; data: any }> {
  const jwtAuth = getJwtAuthFromContext(c);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jwtAuth?.jwtToken) headers['Authorization'] = `Bearer ${jwtAuth.jwtToken}`;

  const internalApiKey = c.req.header('x-internal-api-key');
  if (internalApiKey) headers['X-Internal-Api-Key'] = internalApiKey;

  const sessionId = c.req.header('x-session-id');
  if (sessionId) headers['X-Session-ID'] = sessionId;

  const req = new Request(`http://internal${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });

  const res = await target.fetch(req);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/**
 * Early-reject unauthenticated requests for destructive resolvers. The
 * authoritative admin check happens at SurrealDB PERMISSIONS level for JWT
 * auth (`$auth.role = 'admin'` on UPDATE/DELETE). For API key auth we rely
 * on the key being admin-scoped — PERMISSIONS are bypassed because API keys
 * use self-signed JWTs SurrealDB can't validate against its ACCESS methods.
 *
 * "Authenticated" here means *some* JwtAuthContext was set by the middleware
 * (API key, JWT, or MiniBob token). We deliberately do NOT require
 * `jwtToken` to be non-empty — for API-key auth, generateJwtToken can fail
 * silently when the canary JWT_SECRET is misaligned (see
 * `repos/metabob-activity-api/CLAUDE.md` §"JWT Secret"), but the API-key
 * org_id has already been validated by identity-vessel and is usable for
 * org-scoped reads via the executeAsAuth root-credentials fallback.
 *
 * Returns null if the caller should proceed, or {status, error} to emit.
 */
function requireAuthenticated(c: any): { status: 401; error: string } | null {
  const jwtAuth = getJwtAuthFromContext(c);
  if (!jwtAuth) {
    return { status: 401, error: 'Authentication required for destructive operations' };
  }
  return null;
}

/**
 * Execute a query with the right auth context.
 *
 * - For API key auth, the JWT is self-signed and SurrealDB cannot validate it
 *   against the ACCESS method — queryWithAuth returns "The access method
 *   cannot be used in the requested operation". Fall back to root credentials
 *   with manual org_id filtering (caller is responsible for including
 *   `org_id = $orgId` in the WHERE clause).
 * - For real JWT auth (SurrealDB ACCESS), use queryWithAuth so PERMISSIONS
 *   fire (which is also where the admin role check lives).
 *
 * Matches the pattern already used in POST /v2/impulses (executeQuery).
 */
async function executeAsAuth<T>(
  jwtAuth: JwtAuthContext,
  sql: string,
  params: Record<string, unknown>,
): Promise<T[]> {
  if (jwtAuth.authType === 'apikey') {
    return surrealDB.query<T>(sql, params);
  }
  return queryWithAuth<T>(jwtAuth.jwtToken, sql, params);
}

/**
 * Emit an upkeepAuditLog impulse for a destructive operation. Non-blocking —
 * a failure to audit never fails the operation (the log is best-effort, the
 * underlying op has already succeeded in SQL). See migration 077 for schema.
 */
async function emitUpkeepAudit(payload: {
  operation: 'delete' | 'update' | 'deprecate';
  target_table: string;
  target_ids: string[];
  filter_used: Record<string, unknown>;
  dry_run: boolean;
  count: number;
  performed_by: string;
  org_id: string;
  reason?: string;
  diff?: Record<string, unknown>;
}): Promise<string | null> {
  const auditId = `upkeep-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const audit = { ...payload, performed_at: new Date().toISOString() };
  try {
    await surrealDB.query(
      `INSERT INTO impulse {
        id: $id,
        shape: 'upkeepAuditLog',
        pointer: $pointer,
        org_id: $org_id,
        created_at: time::now()
      }`,
      { id: auditId, pointer: audit, org_id: payload.org_id },
    );
    return auditId;
  } catch (err) {
    logger.warn('upkeepAuditLog emit failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
      operation: payload.operation,
    });
    return null;
  }
}

/**
 * Build a standard impulse-resolve envelope for a successful write resolver.
 * Write resolvers return structured JSON (not markdown), with the shape tag
 * suffixed `_result` so clients can distinguish write-ack from read-content.
 */
function buildWriteResolverResponse(
  pointerType: string,
  delegated: { status: number; data: any },
  summary?: string,
): { success: boolean; content?: string; metadata?: any; error?: string } {
  if (delegated.status >= 200 && delegated.status < 300) {
    return {
      success: true,
      content: JSON.stringify(delegated.data),
      metadata: {
        shape: `${pointerType}_result`,
        summary: summary ?? `${pointerType} delegated successfully`,
      },
    };
  }
  return {
    success: false,
    error: (delegated.data && (delegated.data.error || delegated.data.message)) || `write resolver failed (status ${delegated.status})`,
  };
}

/**
 * POST /v2/impulses
 * Create impulse with org-scoped isolation
 *
 * Uses the new `impulse` table from 020-paradigm-core-tables.surql.
 * Multi-tenant isolation via org_id from JWT auth context.
 * SurrealDB PERMISSIONS handle RBAC filtering automatically.
 *
 * Flow:
 * 1. Extract org_id from JWT auth context
 * 2. Parse request body with ImpulseCreateRequestSchema
 * 3. Check if impulse already exists (by id and org_id)
 * 4. If exists, return 400 error
 * 5. Create impulse in SurrealDB impulse table
 * 6. Return 201 with impulse data
 */
router.post('/', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);

    // Allow internal service calls with X-Internal-Api-Key header
    const internalApiKey = c.req.header('X-Internal-Api-Key');

    // Debug: log all headers
    logger.debug('POST /v2/impulses headers', {
      hasJwtAuth: !!jwtAuth,
      hasInternalKey: !!internalApiKey,
      internalKeyPrefix: internalApiKey ? internalApiKey.substring(0, 10) + '...' : 'none',
      authorization: c.req.header('Authorization') ? 'present' : 'missing',
    });

    // Get org_id from JWT auth or internal header
    let org_id: string;
    let created_by: string;

    if (jwtAuth) {
      // JWT auth from MiniBob instances or users
      org_id = jwtAuth.orgId;
      // Use keyId or userId for audit trail
      // Schema expects: option<string | record<users> | record<api_key>>
      if (jwtAuth.keyId) {
        created_by = jwtAuth.keyId;
      } else if (jwtAuth.userId) {
        created_by = `users:${jwtAuth.userId}`;
      } else {
        // For legacy auth without keyId/userId, leave as empty to use NONE
        created_by = '';
      }
      logger.debug('Using JWT auth', { orgId: jwtAuth.orgId, projectId: jwtAuth.projectId, createdBy: created_by || 'NONE' });
    } else if (internalApiKey) {
      // Use plain string for org_id (impulse schema expects TYPE string, not record<organizations>)
      org_id = 'metabob'; // Default for internal services
      // Internal services don't have a user/instance, leave as NONE (omit field)
      created_by = '';
      logger.debug('Using internal service api_key', { key: internalApiKey.substring(0, 8) + '...' });
    } else {
      logger.warn('POST /v2/impulses: no auth', { hasJwtAuth: !!jwtAuth, hasInternalKey: !!internalApiKey });
      return c.json({ error: 'Unauthorized - valid JWT token or X-Internal-Api-Key required' }, 401);
    }

    // Parse request body
    const body = await c.req.json();
    const request = ImpulseCreateRequestSchema.parse(body);

    const { impulse_id, project_id, impulse_data } = request;

    logger.info('POST /v2/impulses', {
      impulse_id,
      project_id,
      org_id: org_id.substring(0, 20) + '...',
      impulse_type: impulse_data.type
    });

    // Helper to execute queries with proper auth context
    // For API key auth, use root credentials (JWT token is self-signed, not valid for SurrealDB)
    // For real JWT auth (from SurrealDB ACCESS), use queryWithAuth for RBAC
    const executeQuery = async <T>(sql: string, params: Record<string, any>): Promise<T[]> => {
      // API key auth generates self-signed JWTs that SurrealDB can't validate
      // Use root credentials instead, filtering is done via query params
      if (jwtAuth?.authType === 'apikey') {
        logger.debug('Using root query for API key auth (self-signed JWT)', { orgId: jwtAuth.orgId });
        return surrealDB.query<T>(sql, params);
      }
      // Real JWT auth (from SurrealDB ACCESS method) can use queryWithAuth for RBAC
      // Note: After the apikey check above, authType is narrowed to 'jwt' | 'minibob_token' | undefined
      if (jwtAuth?.jwtToken) {
        logger.debug('Using authenticated query with JWT', { hasToken: true, authType: jwtAuth.authType });
        return queryWithAuth<T>(jwtAuth.jwtToken, sql, params);
      }
      return surrealDB.query<T>(sql, params);
    };

    // Derive shape from impulse_data.type, use pointer directly from impulse_data
    const shape = impulse_data.type || 'unknown';
    // Use the pointer from impulse_data directly (already has proper structure)
    const pointer = impulse_data.pointer;

    // Generate summary for metadata-first resolution
    // Priority: metadata summary > pointer path/type > shape
    let summary = '';
    if (impulse_data.metadata?.summary) {
      summary = impulse_data.metadata.summary.substring(0, 100);
    } else if ((pointer as any).path || (pointer as any).file_path) {
      const path = (pointer as any).path || (pointer as any).file_path;
      summary = `${shape}: ${path}`.substring(0, 100);
    } else if ((pointer as any).type) {
      summary = `${shape} (${(pointer as any).type})`.substring(0, 100);
    } else {
      summary = shape.substring(0, 100);
    }

    // Build query params dynamically to avoid sending null for optional fields
    // SurrealDB's option<T> expects either a value or the field to be omitted, not null
    const params: Record<string, any> = {
      impulse_id,
      pointer,
      shape,
      summary,
      metadata: impulse_data.metadata || {},
      token_estimate: impulse_data.budget || 0,
      org_id,
      // Note: created_at will be set via time::now() in SQL query (not passed as parameter)
      // JavaScript Date objects serialize to ISO strings which SurrealDB can't coerce to datetime
    };

    // Only include content if it has a value (avoid null → NULL coercion issue)
    const contentField = pointer.content ? 'content: $content,' : '';
    if (pointer.content) {
      params.content = pointer.content;
    }

    // Only include project_id if it has a value (avoid null → NULL coercion issue)
    // Convert to record reference if it's a plain string
    const projectIdField = project_id ? 'project_id: $project_id,' : '';
    if (project_id) {
      // Check if it's already a record reference (contains ':')
      params.project_id = project_id.includes(':') ? project_id : `projects:${project_id}`;
    }

    // Only include created_by if it has a value (empty string means internal service)
    const createdByField = created_by ? 'created_by: $created_by,' : '';
    if (created_by) {
      params.created_by = created_by;
    }

    // Use INSERT for impulse creation
    // INSERT works with root credentials (no org_id permission checks required)
    // Use time::now() instead of Date parameter to avoid datetime coercion errors
    const insertQuery = `
      INSERT INTO impulse {
        id: $impulse_id,
        pointer: $pointer,
        shape: $shape,
        summary: $summary,
        ${contentField}
        metadata: $metadata,
        token_estimate: $token_estimate,
        org_id: $org_id,
        ${projectIdField}
        ${createdByField}
        created_at: time::now()
      }
    `;

    let result: any;
    try {
      [result] = await executeQuery<any>(insertQuery, params);

      if (!result) {
        logger.error('Failed to create impulse - no record returned', { impulse_id });
        throw new Error('Failed to create impulse in SurrealDB');
      }
    } catch (err: any) {
      // Handle duplicate ID errors gracefully
      // SurrealDB index conflicts say "Database index ... already contains"
      const isDuplicate = err.message?.includes('already exists') ||
                          err.message?.includes('duplicate') ||
                          (err.message?.includes('Database index') && err.message?.includes('already contains'));
      if (isDuplicate) {
        logger.info('Impulse already exists, fetching existing record', { impulse_id });

        // Fetch the existing impulse
        const fetchQuery = `SELECT * FROM type::record('impulse', $impulse_id) LIMIT 1`;
        const [existing] = await executeQuery<any>(fetchQuery, { impulse_id });

        if (existing) {
          result = existing;
        } else {
          logger.error('Failed to fetch existing impulse after duplicate error', { impulse_id });
          throw new Error('Failed to create or fetch impulse');
        }
      } else {
        // Re-throw other errors
        throw err;
      }
    }

    const created = result;

    logger.info('Impulse created', {
      impulse_id,
      project_id,
      created_at: created.created_at,
    });

    // Return response matching ImpulseResponse schema
    // Map new schema fields back to legacy response format for compatibility
    const response: ImpulseResponse = {
      impulse_id: created.id,
      api_key: created_by, // Legacy field - use created_by
      project_id: created.project_id,
      impulse_data: {
        type: created.shape,
        content: created.content,
        ...created.pointer,
        ...created.metadata,
      },
      created_at: created.created_at,
      updated_at: created.created_at, // New schema doesn't have updated_at
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

    // Handle duplicate impulse (already exists) - return 409 Conflict instead of 500
    // This allows clients to treat duplicates as successful idempotent operations
    // SurrealDB index conflicts say "Database index ... already contains"
    const isDuplicateError = error.message &&
      (error.message.includes('already exists') ||
       (error.message.includes('Database index') && error.message.includes('already contains')));
    if (isDuplicateError) {
      // Extract impulse ID from error message if possible
      const idMatch = error.message.match(/already contains (?:impulse:)?[`']?([^`',\s]+)/);
      const extractedId = idMatch?.[1] || 'unknown';

      logger.info('Impulse already exists (deduplication)', {
        impulse_id: extractedId,
        message: error.message,
      });
      return c.json({
        success: true,
        impulse_id: extractedId,
        message: 'Impulse already exists',
      }, 409);
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
 * Uses the new `impulse` table from 020-paradigm-core-tables.surql.
 * SurrealDB PERMISSIONS handle org_id filtering automatically via JWT auth.
 *
 * Flow:
 * 1. Extract JWT auth context
 * 2. Extract impulse_id from URL params
 * 3. Query SurrealDB (RBAC handles org_id filtering)
 * 4. Return 200 with impulse data or 404 if not found
 */
router.get('/:impulseId', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const internalApiKey = c.req.header('X-Internal-Api-Key');

    if (!jwtAuth && !internalApiKey) {
      return c.json({ error: 'Unauthorized - valid JWT token or X-Internal-Api-Key required' }, 401);
    }

    const impulse_id = c.req.param('impulseId');
    const project_id = c.req.query('project_id'); // Optional filter

    logger.info('GET /v2/impulses/:impulseId', {
      impulse_id,
      project_id: project_id || 'not specified',
    });

    // Query impulse by id.
    // - Use record::id(id) = $impulse_id because SurrealDB stores ids as
    //   composite `impulse:\`strid\``; a plain `id = $impulse_id` never
    //   matches when callers pass a bare id (same bug fixed elsewhere).
    // - Add `org_id = $org_id` explicitly for callers on the API-key path
    //   where PERMISSIONS aren't enforced (self-signed JWT can't pass the
    //   ACCESS method). JWT-auth path sees the predicate as a no-op since
    //   PERMISSIONS already scope to `$auth.org_id`.
    let query = `SELECT * FROM impulse WHERE record::id(id) = $impulse_id`;
    const params: Record<string, any> = { impulse_id };
    if (jwtAuth?.orgId) {
      query += ` AND org_id = $org_id`;
      params.org_id = jwtAuth.orgId;
    }

    // Add optional project_id filter
    if (project_id) {
      query += ` AND project_id = $project_id`;
      params.project_id = project_id;
    }
    query += ` LIMIT 1`;

    // executeAsAuth routes apikey auth -> surrealDB.query (root) and real
    // JWT auth -> queryWithAuth (PERMISSIONS-enforced).
    let result: any[];
    if (jwtAuth) {
      result = await executeAsAuth<any>(jwtAuth, query, params);
    } else {
      result = await surrealDB.query<any>(query, params);
    }

    if (result.length === 0) {
      logger.debug('Impulse not found', { impulse_id, project_id });
      return c.json({
        error: 'Impulse not found',
        impulse_id,
        project_id,
      }, 404);
    }

    const impulse = result[0];

    logger.info('Impulse retrieved', { impulse_id, project_id: impulse.project_id });

    // Return response mapping new schema to legacy ImpulseResponse format
    const response: ImpulseResponse = {
      impulse_id: impulse.id,
      api_key: impulse.created_by || 'unknown', // Legacy field
      project_id: impulse.project_id,
      impulse_data: {
        type: impulse.shape,
        content: impulse.content,
        ...impulse.pointer,
        ...impulse.metadata,
      },
      created_at: impulse.created_at,
      updated_at: impulse.created_at, // New schema doesn't have updated_at
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
 * Uses the new `impulse` table from 020-paradigm-core-tables.surql.
 * SurrealDB PERMISSIONS handle org_id filtering automatically via JWT auth.
 *
 * Flow:
 * 1. Extract JWT auth context
 * 2. Extract query params: project_id (optional), limit (default=100, max=1000), offset (default=0)
 * 3. Query SurrealDB with RBAC-enforced filtering
 * 4. Return 200 with array of impulses
 */
router.get('/', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const internalApiKey = c.req.header('X-Internal-Api-Key');

    if (!jwtAuth && !internalApiKey) {
      return c.json({ error: 'Unauthorized - valid JWT token or X-Internal-Api-Key required' }, 401);
    }

    const project_id = c.req.query('project_id'); // Now optional

    // Parse pagination params
    const limitStr = c.req.query('limit') || '100';
    const offsetStr = c.req.query('offset') || '0';

    let limit = parseInt(limitStr, 10);
    let offset = parseInt(offsetStr, 10);

    // Validate and cap limit (max=1000)
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
      project_id: project_id || 'all',
      limit,
      offset,
    });

    // Build query. Org scope is added explicitly for callers on the API-key
    // path (self-signed JWT cannot pass SurrealDB ACCESS validation so
    // PERMISSIONS do not fire). JWT auth callers get the same predicate as a
    // no-op since PERMISSIONS already scope to `$auth.org_id`.
    const whereParts: string[] = [];
    const params: Record<string, any> = { limit, offset };
    if (jwtAuth?.orgId) {
      whereParts.push('org_id = $org_id');
      params.org_id = jwtAuth.orgId;
    }
    if (project_id) {
      whereParts.push('project_id = $project_id');
      params.project_id = project_id;
    }
    let query = 'SELECT * FROM impulse';
    if (whereParts.length > 0) query += ' WHERE ' + whereParts.join(' AND ');
    query += ' ORDER BY created_at DESC LIMIT $limit START $offset';

    let result: any[];
    if (jwtAuth) {
      result = await executeAsAuth<any>(jwtAuth, query, params);
    } else {
      result = await surrealDB.query<any>(query, params);
    }

    logger.info('Impulses retrieved', {
      count: result.length,
      project_id: project_id || 'all',
      limit,
      offset,
    });

    // Map new schema to legacy ImpulseResponse format
    const impulses: ImpulseResponse[] = result.map((impulse: any) => ({
      impulse_id: impulse.id,
      api_key: impulse.created_by || 'unknown', // Legacy field
      project_id: impulse.project_id,
      impulse_data: {
        type: impulse.shape,
        content: impulse.content,
        ...impulse.pointer,
        ...impulse.metadata,
      },
      created_at: impulse.created_at,
      updated_at: impulse.created_at, // New schema doesn't have updated_at
    }));

    // Return response matching ImpulseListResponse schema
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

/**
 * POST /v2/impulses/resolve
 * Resolve impulse pointer to content string
 * 
 * This endpoint enables MiniBob to delegate non-local impulse resolution to the backend.
 * 
 * Architecture (Phase 1.8 - Unified Impulse-Driven):
 * - MiniBob handles local pointers: memo, file
 * - Backend handles all others: activityExecutionTrace, activityTemplate, activityMetrics, etc.
 * - This enables backend to add new pointer types without MiniBob code changes
 * 
 * Pointer types supported:
 * - activityExecutionTrace: Format trace as markdown for debugging
 * - activityTemplate: Format template as markdown for review
 * - activityMetrics: Format metrics as structured data
 * - (Backend can add more types without MiniBob changes)
 * 
 * Flow:
 * 1. Receive pointer object { type, executionId?, templateId?, ... }
 * 2. Switch on pointer.type
 * 3. Load data from appropriate table (execution_traces, activity_template, etc.)
 * 4. Format as markdown/structured text
 * 5. Return content string
 */
router.post('/resolve', async (c) => {
  try {
    // Auth check — reject unauthenticated callers before parsing body.
    // Spec 4: all shapes in this endpoint are org-scoped; no public carveout.
    const authCheck = requireAuthenticated(c);
    if (authCheck) {
      return c.json({ success: false, error: authCheck.error } as ImpulseResolveResponse, authCheck.status);
    }
    const jwtAuthCtx = getJwtAuthFromContext(c)!;

    const body = await c.req.json();
    const validated = ImpulseResolveRequestSchema.parse(body);

    logger.info('POST /v2/impulses/resolve', {
      pointer_type: validated.pointer.type,
      has_execution_id: !!validated.pointer.executionId,
      has_template_id: !!validated.pointer.templateId,
    });

    const { pointer } = validated;
    let content: string;

    switch (pointer.type) {
      case 'activityExecutionTrace': {
        if (!pointer.executionId) {
          return c.json({
            success: false,
            error: 'executionId required for activityExecutionTrace pointer',
          } as ImpulseResolveResponse, 400);
        }

        // PARADIGM PATH: Try new execution table first (schema-paradigm-alignment)
        let trace: any = null;
        let queryPath: 'new' | 'legacy' = 'legacy';

        try {
          const newQuery = `
            SELECT * FROM execution
            WHERE id = $execution_id
            AND org_id = $orgId
            LIMIT 1
          `;

          const newResult = await executeAsAuth<any>(jwtAuthCtx, newQuery, {
            execution_id: pointer.executionId,
            orgId: jwtAuthCtx.orgId,
          });

          if (newResult && newResult.length > 0) {
            trace = newResult[0];
            queryPath = 'new';

            // Load referenced impulses if includeImpulses=true
            if (pointer.includeImpulses && trace.input_impulses?.length > 0) {
              const impulseQuery = `
                SELECT id, shape, summary, content FROM impulse
                WHERE id IN $impulse_ids
                AND org_id = $orgId
              `;
              const impulses = await executeAsAuth<any>(jwtAuthCtx, impulseQuery, {
                impulse_ids: trace.input_impulses,
                orgId: jwtAuthCtx.orgId,
              });
              trace.resolved_impulses = impulses;
            }

            logger.debug('[paradigm] Execution trace resolved from new schema', {
              execution_id: pointer.executionId,
              path: queryPath,
              has_impulses: !!trace.resolved_impulses,
            });
          }
        } catch (error) {
          logger.warn('[paradigm] New execution table query failed, falling back', {
            execution_id: pointer.executionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Fall back to legacy activity_execution_traces table
        if (!trace) {
          const legacyQuery = `
            SELECT * FROM activity_execution_traces
            WHERE execution_id = $execution_id
            AND org_id = $orgId
            LIMIT 1
          `;

          const legacyResult = await executeAsAuth<any>(jwtAuthCtx, legacyQuery, {
            execution_id: pointer.executionId,
            orgId: jwtAuthCtx.orgId,
          });

          if (legacyResult && legacyResult.length > 0) {
            trace = legacyResult[0];
            queryPath = 'legacy';
          }
        }

        if (!trace) {
          return c.json({
            success: false,
            error: `Execution trace not found: ${pointer.executionId}`,
          } as ImpulseResolveResponse, 404);
        }

        logger.info('Execution trace resolved', {
          execution_id: pointer.executionId,
          path: queryPath,
        });

        // Format execution trace as markdown
        content = formatExecutionTraceAsMarkdown(trace, queryPath === 'new');
        break;
      }

      case 'activityTemplate': {
        if (!pointer.templateId) {
          return c.json({
            success: false,
            error: 'templateId required for activityTemplate pointer',
          } as ImpulseResolveResponse, 400);
        }

        // Load template from canonical 'activity' table. Use record::id(id)
        // to extract the string portion of the composite record id (e.g.
        // `activity:\`cleanup-stale-traces-v1\`` -> 'cleanup-stale-traces-v1')
        // since callers pass the bare id. Matches the pattern used by the
        // *_update/_deprecate write resolvers.
        // Org scoping: allow caller's org templates OR global/system templates.
        const query = `
          SELECT * FROM activity
          WHERE record::id(id) = $activity_id
          AND (org_id = $orgId OR scope = 'global' OR org_id IS NONE)
          LIMIT 1
        `;

        const result = await executeAsAuth<any>(jwtAuthCtx, query, {
          activity_id: pointer.templateId,
          orgId: jwtAuthCtx.orgId,
        });

        if (result.length === 0) {
          return c.json({
            success: false,
            error: `Activity template not found: ${pointer.templateId}`,
          } as ImpulseResolveResponse, 404);
        }

        const template = result[0];

        // Format template as markdown
        content = formatTemplateAsMarkdown(template);
        break;
      }

      case 'activityMetrics': {
        if (!pointer.activityId) {
          return c.json({
            success: false,
            error: 'activityId required for activityMetrics pointer',
          } as ImpulseResolveResponse, 400);
        }

        // Load metrics for all variants of activity — org scoped
        const query = `
          SELECT * FROM variant_performance_metrics
          WHERE activity_id = $activity_id
          AND (org_id = $orgId OR org_id IS NONE)
          ORDER BY success_rate DESC
        `;

        const result = await executeAsAuth<any>(jwtAuthCtx, query, {
          activity_id: pointer.activityId,
          orgId: jwtAuthCtx.orgId,
        });

        if (result.length === 0) {
          return c.json({
            success: false,
            error: `Activity metrics not found: ${pointer.activityId}`,
          } as ImpulseResolveResponse, 404);
        }

        // Format metrics as markdown table
        content = formatMetricsAsMarkdown(result);
        break;
      }

      case 'executionTraceList': {
        // Metadata-first impulse type: returns trace pointers with rich metadata
        // Replaces: recentExecutions (clean removal)
        const filter = pointer.filter || 'all';
        const activityId = pointer.activityId;
        const templateId = pointer.templateId;
        const since = pointer.since;
        const limit = pointer.limit || 50;

        // Build WHERE clause dynamically — always include org_id scoping
        const conditions: string[] = ['org_id = $orgId'];
        const params: Record<string, any> = { limit, orgId: jwtAuthCtx.orgId };

        if (filter === 'successful') {
          conditions.push('success = true');
        } else if (filter === 'failed') {
          conditions.push('success = false');
        }

        if (activityId) {
          conditions.push('activity_id = $activityId');
          params.activityId = activityId;
        }

        if (templateId) {
          conditions.push('activity_id = $templateId');
          params.templateId = templateId;
        }

        if (since) {
          conditions.push('executed_at >= type::datetime($since)');
          params.since = since;
        }

        const whereClause = 'WHERE ' + conditions.join(' AND ');

        // Query execution table
        const query = `
          SELECT
            id,
            activity_id,
            success,
            duration_ms,
            cost_usd,
            executed_at
          FROM execution
          ${whereClause}
          ORDER BY executed_at DESC
          LIMIT $limit
        `;

        const traces = await executeAsAuth<any>(jwtAuthCtx, query, params);

        // Compute metadata
        const successCount = traces.filter(t => t.success === true).length;
        const failureCount = traces.filter(t => t.success === false).length;
        const totalDuration = traces.reduce((sum, t) => sum + (t.duration_ms || 0), 0);
        const totalCost = traces.reduce((sum, t) => sum + (t.cost_usd || 0), 0);

        // Get unique templates and activities
        const uniqueTemplates = [...new Set(traces.map(t => t.activity_id))];
        const uniqueActivities = [...new Set(traces.map(t => t.activity_id))];

        // Format metadata-first response
        const metadata = {
          rowCount: traces.length,
          dateRange: {
            start: traces[traces.length - 1]?.executed_at || null,
            end: traces[0]?.executed_at || null
          },
          availableOps: ['filter', 'expand', 'group'],
          filterParams: {
            status: ['success', 'failure'],
            availableTemplates: uniqueTemplates,
            availableActivities: uniqueActivities
          },
          summary: {
            successCount,
            failureCount,
            totalDuration,
            totalCost
          }
        };

        // Add pointers to full traces
        const tracesWithPointers = traces.map(t => ({
          id: t.id,
          templateId: t.activity_id,
          activityId: t.activity_id,
          status: t.success ? 'success' : 'failure',
          duration_ms: t.duration_ms,
          cost_usd: t.cost_usd,
          created_at: t.executed_at,
          pointer: { type: 'activityExecutionTrace', executionId: t.id }
        }));

        content = JSON.stringify({
          loaded: false,
          metadata,
          content: { traces: tracesWithPointers }
        }, null, 2);
        break;
      }

      case 'variantMetricsSummary': {
        // Metadata-first impulse type: returns pre-computed metrics per variant
        // Replaces: templateComparison (clean removal)
        if (!pointer.activityId) {
          return c.json({
            success: false,
            error: 'variantMetricsSummary requires activityId',
          } as ImpulseResolveResponse, 400);
        }

        // Query execution table directly and compute per-variant metrics
        // Note: v_activity_score groups by activity_id only, not variant_id
        const query = `
          SELECT
            activity_id,
            count() AS total_executions,
            count(success = true) AS successful_executions,
            count(success = false) AS failed_executions,
            count(success = true) + 1 AS thompson_alpha,
            count(success = false) + 1 AS thompson_beta,
            <float> count(success = true) / <float> count() AS success_rate,
            math::mean(<float> duration_ms) AS avg_duration_ms,
            math::mean(<float> cost_usd) AS avg_cost_usd
          FROM execution
          WHERE activity_id CONTAINS $activityId
          AND org_id = $orgId
          GROUP BY activity_id
          ORDER BY success_rate DESC
        `;

        const variants = await executeAsAuth<any>(jwtAuthCtx, query, {
          activityId: pointer.activityId,
          orgId: jwtAuthCtx.orgId,
        });

        if (variants.length === 0) {
          content = JSON.stringify({
            loaded: false,
            metadata: { rowCount: 0, baseActivityId: pointer.activityId, variantCount: 0 },
            content: { variants: [] }
          }, null, 2);
          break;
        }

        // Compute metadata
        const bestVariant = variants[0];
        const worstVariant = variants[variants.length - 1];
        const avgSuccessRate = variants.reduce((sum, v) => sum + v.success_rate, 0) / variants.length;

        const metadata = {
          rowCount: variants.length,
          baseActivityId: pointer.activityId,
          variantCount: variants.length,
          availableOps: ['filter', 'compare', 'resolve'],
          summary: {
            bestVariant: { id: bestVariant.activity_id, successRate: bestVariant.success_rate },
            worstVariant: { id: worstVariant.activity_id, successRate: worstVariant.success_rate },
            avgSuccessRate
          }
        };

        // Add pointers to full templates
        const variantsWithPointers = variants.map(v => ({
          variantId: v.activity_id,
          successRate: v.success_rate,
          executionCount: v.successful_executions + v.failed_executions,
          avgDuration: v.avg_duration_ms,
          avgCost: v.avg_cost_usd,
          thompsonAlpha: v.thompson_alpha,
          thompsonBeta: v.thompson_beta,
          pointer: { type: 'activityTemplate', templateId: v.activity_id }
        }));

        content = JSON.stringify({
          loaded: false,
          metadata,
          content: { variants: variantsWithPointers }
        }, null, 2);
        break;
      }

      // =============================================================================
      // ANALYSIS API POINTER TYPES (M3 - Impulse Bridge) [DEPRECATED]
      // TODO: These cases violate "Resolvers live WHERE THE DATA IS"
      // Analysis API should provide its own /v2/impulses/resolve endpoint
      // Vessels should call Analysis API directly, not proxy through activity-api
      // =============================================================================

      case 'analysisResult':
      case 'cochangeSuggestions':
      case 'impactAnalysis':
      case 'codebaseSearch': {
        // Return helpful error directing vessels to Analysis API
        return c.json({
          success: false,
          error: 'resolver_moved',
          message: `Analysis API impulse types (${pointer.type}) should be resolved by calling ` +
                   `the Analysis API directly, not through activity-api. ` +
                   `This follows the "Resolvers live WHERE THE DATA IS" principle.`,
          todo: 'Analysis API should implement /v2/impulses/resolve endpoint',
          analysis_api_url: config.analysisApi.url,
          pointer_type: pointer.type,
          suggested_approach: 'Vessels should include Analysis API client code to resolve these impulse types locally'
        } as ImpulseResolveResponse, 410); // 410 Gone - permanent deprecation
      }

      case 'problemCluster': {
        // Return helpful error directing vessels to Analysis API
        return c.json({
          success: false,
          error: 'resolver_moved',
          message: `Analysis API impulse types (${pointer.type}) should be resolved by calling ` +
                   `the Analysis API directly, not through activity-api. ` +
                   `This follows the "Resolvers live WHERE THE DATA IS" principle.`,
          todo: 'Analysis API should implement /v2/impulses/resolve endpoint',
          analysis_api_url: config.analysisApi.url,
          pointer_type: pointer.type,
          suggested_approach: 'Vessels should include Analysis API client code to resolve these impulse types locally'
        } as ImpulseResolveResponse, 410); // 410 Gone - permanent deprecation
      }

      // =============================================================================
      // BOOTSTRAP TEMPLATE POINTER TYPES
      // These support the self-hosting genesis and trailblazer templates
      // =============================================================================

      case 'activityTemplateRecommendation': {
        // Search for templates similar to a goal/query
        // Used by genesis template to learn from existing templates
        const query_text = pointer.query || '';
        const category = pointer.category;
        const limit = pointer.limit || 3;

        logger.info('Resolving activityTemplateRecommendation', { query_text, category, limit });

        // Query templates with optional category filter
        let whereClause = '';
        const params: Record<string, any> = { limit };

        // Handle category filter - can be string or array
        const categoryValue = Array.isArray(category) ? category[0] : category;
        // NOTE: Category is now a soft boost in Thompson Sampling, not a hard filter
        // The /recommend endpoint handles category as a preference signal
        // if (categoryValue && categoryValue !== 'tool') {
        //   whereClause = 'WHERE category = $category';
        //   params.category = categoryValue;
        // }

        // Org-scope: show caller's templates and global/system templates
        const orgCondition = whereClause
          ? whereClause + ' AND (org_id = $orgId OR scope = \'global\' OR org_id IS NONE)'
          : 'WHERE (org_id = $orgId OR scope = \'global\' OR org_id IS NONE)';
        params.orgId = jwtAuthCtx.orgId;

        const templatesQuery = `
          SELECT variant_id, variant_name, description, category, task_steps, created_at
          FROM activity_template
          ${orgCondition}
          ORDER BY created_at DESC
          LIMIT $limit
        `;

        const templates = await executeAsAuth<any>(jwtAuthCtx, templatesQuery, params);

        if (templates.length === 0) {
          content = `# Similar Templates\n\nNo templates found matching query: "${query_text}"`;
        } else {
          content = formatTemplateListAsMarkdown(templates, `Templates similar to: "${query_text}"`);
        }
        break;
      }

      case 'activityTemplatesByMetrics': {
        // Get top-performing templates by metrics
        // Used by genesis template to learn task structure from successful templates
        const sortBy = pointer.sortBy || 'success_rate';
        const minExecutions = pointer.minExecutions || 5;
        const limit = pointer.limit || 2;

        logger.info('Resolving activityTemplatesByMetrics', { sortBy, minExecutions, limit });

        // First get metrics for top-performing templates
        const orderField = sortBy === 'success_rate' ? 'success_rate' : 'total_executions';
        const metricsQuery = `
          SELECT variant_id, total_executions, success_rate, avg_duration_ms, avg_cost_usd
          FROM variant_performance_metrics
          WHERE total_executions >= $min_executions
          AND (org_id = $orgId OR org_id IS NONE)
          ORDER BY ${orderField} DESC
          LIMIT $limit
        `;

        const metrics = await executeAsAuth<any>(jwtAuthCtx, metricsQuery, {
          min_executions: minExecutions,
          limit,
          orgId: jwtAuthCtx.orgId,
        });

        if (metrics.length === 0) {
          content = `# Top Performing Templates\n\nNo templates found with at least ${minExecutions} executions.`;
        } else {
          // Fetch template details for the top performers.
          //
          // F-NN-D (2026-04-27): `activity_template` is queried polymorphically
          // on canary — depending on which schema migrations have been applied,
          // `variant_id` may be a plain `string` (schemafull table at
          // `sql/001-init-schema.surql:46`) OR a SurrealDB `RecordId` object
          // (paradigm view `v_paradigm_activity_template` at
          // `sql/migrations/069-paradigm-compat-views.surql:23-46`, which
          // aliases `id AS variant_id`).
          //
          // Hot-fix (caa86b5 follow-up): the prior fix used
          // `meta::id(variant_id) IN $variant_ids` unconditionally, which
          // throws `Incorrect arguments for function meta::id(). Argument 1
          // was the wrong type. Expected record but found '<id>'` whenever a
          // schemafull row (string variant_id) is returned, producing a hard
          // 500 on canary.
          //
          // Polymorphic comparison: gate `meta::id()` behind
          // `type::is_record(variant_id)` and use a plain string match for
          // the schemafull form. Both branches feed the same `$variant_ids`
          // (already in bare-name form). SurrealDB short-circuits boolean
          // expressions, so `meta::id` only runs when the value is a record.
          const stripActivityPrefix = (id: unknown): string =>
            normalizeRecordId(id).replace(/^activity:/, '').replace(/[⟨⟩`]/g, '');

          const variantIds = metrics.map((m: any) => stripActivityPrefix(m.variant_id));
          const templateQuery = `
            SELECT variant_id, variant_name, description, category, task_steps
            FROM activity_template
            WHERE (
              (type::is_record(variant_id) AND meta::id(variant_id) IN $variant_ids)
              OR (type::is_string(variant_id) AND variant_id IN $variant_ids)
            )
            AND (org_id = $orgId OR scope = 'global' OR org_id IS NONE)
          `;
          const templateDetails = await executeAsAuth<any>(jwtAuthCtx, templateQuery, {
            variant_ids: variantIds,
            orgId: jwtAuthCtx.orgId,
          });

          // Build a normalized-key lookup so RecordId vs. string comparisons
          // collapse to the same key on both sides of the merge.
          const detailsByKey = new Map<string, any>();
          for (const t of templateDetails) {
            detailsByKey.set(stripActivityPrefix(t.variant_id), t);
          }

          // Merge metrics with template details
          const templates = metrics.map((m: any) => {
            const key = stripActivityPrefix(m.variant_id);
            const template = detailsByKey.get(key) || {};
            return {
              ...template,
              // Ensure variant_id renders as the canonical plain-string id even
              // when the view returned a RecordId object (avoids "undefined"
              // in the markdown "ID" column).
              variant_id: key || normalizeRecordId(template.variant_id) || normalizeRecordId(m.variant_id),
              total_executions: m.total_executions,
              success_rate: m.success_rate,
              avg_duration_ms: m.avg_duration_ms,
              avg_cost_usd: m.avg_cost_usd,
            };
          });

          content = formatTemplateListWithMetricsAsMarkdown(templates);
        }
        break;
      }

      case 'executionTraces': {
        // Get multiple execution traces for a template
        // Used by trailblazer template to analyze failure patterns
        const templateId = pointer.templateId;
        const success = pointer.success; // boolean or undefined
        const limit = pointer.limit || 5;

        if (!templateId) {
          return c.json({
            success: false,
            error: 'templateId required for executionTraces pointer',
          } as ImpulseResolveResponse, 400);
        }

        logger.info('Resolving executionTraces', { templateId, success, limit });

        let whereClause = 'WHERE variant_id = $template_id AND org_id = $orgId';
        const params: Record<string, any> = {
          template_id: templateId,
          limit,
          orgId: jwtAuthCtx.orgId,
        };

        if (success === true) {
          whereClause += ' AND status = "success"';
        } else if (success === false) {
          whereClause += ' AND (status = "failure" OR status = "failed")';
        }

        const tracesQuery = `
          SELECT execution_id, variant_id, status, duration_ms, cost_usd,
                 error_message, failed_task_id, execution_trace, created_at
          FROM activity_execution_traces
          ${whereClause}
          ORDER BY created_at DESC
          LIMIT $limit
        `;

        const traces = await executeAsAuth<any>(jwtAuthCtx, tracesQuery, params);

        if (traces.length === 0) {
          const filterDesc = success === true ? 'successful' : success === false ? 'failed' : 'any';
          content = `# Execution Traces\n\nNo ${filterDesc} executions found for template: ${templateId}`;
        } else {
          content = formatMultipleTracesAsMarkdown(traces, templateId, success);
        }
        break;
      }

      case 'goal': {
        // Goal impulse resolver: Returns activity recommendations via Thompson Sampling
        // Used by MiniBob to get recommendations based on goal description + impulse context
        // NOTE: impulseRefs, excludeActivities, and expectedOutputShapes are extended pointer fields not in base schema
        const extendedPointer = pointer as typeof pointer & {
          impulseRefs?: string[];
          excludeActivities?: string[];
          expectedOutputShapes?: string[];  // Expected output shapes from goal enrichment
        };

        const goalDescription = pointer.content;
        const category = pointer.category;
        const impulseRefs = extendedPointer.impulseRefs || [];
        const limit = pointer.limit || 3;
        const excludeActivities = extendedPointer.excludeActivities || [];
        const expectedOutputShapes = extendedPointer.expectedOutputShapes || [];

        // Validate required fields
        if (!goalDescription) {
          return c.json({
            success: false,
            error: 'content (goal description) required for goal pointer',
          } as ImpulseResolveResponse, 400);
        }

        logger.info('Resolving goal impulse', {
          goal: goalDescription.substring(0, 100),
          category,
          impulseRefsCount: impulseRefs.length,
          expectedOutputShapes,
          limit,
        });

        // Get session data for multi-tenant filtering
        const sessionData = (c.get as any)('session') as SessionData | undefined;
        const jwtAuth = getJwtAuthFromContext(c);
        const orgId = jwtAuth?.orgId || sessionData?.org_id || null;
        const projectId = jwtAuth?.projectId || sessionData?.project_id || null;

        // Load impulse metadata for context (optional - used by Thompson Sampling for relevance scoring)
        let impulseContext: any[] = [];
        let impulseShapes: string[] = [];
        if (impulseRefs.length > 0) {
          try {
            const contextQuery = `
              SELECT id, shape, summary FROM impulse
              WHERE id IN $impulse_ids
              AND org_id = $orgId
            `;
            impulseContext = await executeAsAuth(jwtAuthCtx, contextQuery, {
              impulse_ids: impulseRefs,
              orgId: jwtAuthCtx.orgId,
            });
            impulseShapes = impulseContext.map((i: any) => i.shape).filter(Boolean);
            logger.debug('Loaded impulse context for goal', {
              count: impulseContext.length,
              shapes: impulseShapes,
            });
          } catch (error) {
            logger.warn('Failed to load impulse context', {
              error: error instanceof Error ? error.message : String(error),
            });
            // Continue without context - not critical
          }
        }

        // Call internal recommendation logic (reusing existing /recommend endpoint logic)
        // This is essentially an internal API call to avoid code duplication
        try {
          const recommendRequest = new Request(`http://internal/recommend`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // Forward auth headers
              ...(jwtAuth?.jwtToken ? { 'Authorization': `Bearer ${jwtAuth.jwtToken}` } : {}),
            },
            body: JSON.stringify({
              task_description: goalDescription,
              category,
              loaded_impulses: impulseRefs,
              impulse_shapes: impulseShapes,
              expected_output_shapes: expectedOutputShapes,  // Pass expected output shapes for activity matching
              limit,
              exclude_activities: excludeActivities,
            }),
          });

          const recommendResponse = await activitiesRouter.fetch(recommendRequest);

          if (!recommendResponse.ok) {
            const errorData = await recommendResponse.json() as { error?: string };
            logger.error('Recommendation request failed', {
              status: recommendResponse.status,
              error: errorData,
            });
            return c.json({
              success: false,
              error: `Failed to get recommendations: ${errorData.error || 'Unknown error'}`,
            } as ImpulseResolveResponse, 500);
          }

          const recommendData = await recommendResponse.json() as { recommendations?: any[] };
          const recommendations = recommendData.recommendations || [];

          // Format as impulse content
          const contentData = {
            recommendations,
            metadata: {
              impulse_context_size: impulseRefs.length,
              impulse_context_shapes: impulseShapes,
              sampling_method: 'thompson',
              total_candidates: recommendations.length,
            },
          };

          content = JSON.stringify(contentData, null, 2);

          // Return with metadata
          logger.info('Goal impulse resolved successfully', {
            recommendationsCount: recommendations.length,
            topActivity: recommendations[0]?.template_id,
          });

          return c.json({
            success: true,
            content,
            metadata: {
              shape: 'activityRecommendations',
              rowCount: recommendations.length,
              summary: `${recommendations.length} activities recommended for: "${goalDescription.substring(0, 50)}..."`,
              availableOps: ['select', 'execute', 'compare'],
            },
          } as ImpulseResolveResponse, 200);

        } catch (error: any) {
          logger.error('Goal impulse resolution failed', {
            error: error.message,
            stack: error.stack,
          });
          return c.json({
            success: false,
            error: `Failed to resolve goal impulse: ${error.message}`,
          } as ImpulseResolveResponse, 500);
        }
      }

      // =============================================================================
      // UNIFIED LEARNING ARCHITECTURE POINTER TYPES
      // =============================================================================
      // These pointer types support the activity-driven learning system where backend
      // provides shapes via impulse resolution, and MiniBob drives execution via activities.
      // =============================================================================

      case 'toolRiskProfile': {
        // Query tool error rates and risk indicators
        // Extended pointer fields for filtering
        const extendedPointer = pointer as typeof pointer & {
          toolName?: string;
          activityId?: string;
        };

        const toolName = extendedPointer.toolName;
        const activityId = extendedPointer.activityId;
        const limit = pointer.limit || 50;

        logger.info('Resolving toolRiskProfile', { toolName, activityId, limit });

        // Build query for tool usage statistics
        let whereClause = '';
        const params: Record<string, any> = { limit };
        const conditions: string[] = [];

        if (toolName) {
          conditions.push('tool_name = $tool_name');
          params.tool_name = toolName;
        }

        if (activityId) {
          conditions.push('activity_id = $activity_id');
          params.activity_id = activityId;
        }

        if (conditions.length > 0) {
          whereClause = 'WHERE ' + conditions.join(' AND ');
        }

        // Query tool_usage table for aggregated stats
        const query = `
          SELECT
            tool_name,
            activity_id,
            math::sum(call_count) AS call_count,
            math::sum(success_count) AS success_count,
            math::sum(failure_count) AS failure_count,
            math::mean(avg_duration_ms) AS avg_duration_ms
          FROM tool_usage
          ${whereClause}
          GROUP BY tool_name, activity_id
          ORDER BY failure_count DESC
          LIMIT $limit
        `;

        const toolStats = await surrealDB.query<any>(query, params);

        // Calculate error rates and format
        const formattedStats = toolStats.map((t: any) => ({
          tool_name: t.tool_name,
          activity_id: t.activity_id,
          call_count: t.call_count || 0,
          success_count: t.success_count || 0,
          failure_count: t.failure_count || 0,
          avg_duration_ms: t.avg_duration_ms || 0,
          error_rate: t.call_count > 0 ? t.failure_count / t.call_count : 0,
        }));

        content = formatToolRiskProfileAsMarkdown(formattedStats, { activityId, toolName });
        break;
      }

      case 'compositionSuccess': {
        // Query parent→child success rates by shapes
        const extendedPointer = pointer as typeof pointer & {
          parentActivityId?: string;
          childActivityId?: string;
        };

        const parentActivityId = extendedPointer.parentActivityId;
        const childActivityId = extendedPointer.childActivityId;
        const limit = pointer.limit || 50;

        logger.info('Resolving compositionSuccess', { parentActivityId, childActivityId, limit });

        // Build query for composition graph
        let whereClause = '';
        const params: Record<string, any> = { limit };
        const conditions: string[] = [];

        if (parentActivityId) {
          conditions.push('parent_activity_id = $parent_activity_id');
          params.parent_activity_id = parentActivityId;
        }

        if (childActivityId) {
          conditions.push('child_activity_id = $child_activity_id');
          params.child_activity_id = childActivityId;
        }

        if (conditions.length > 0) {
          whereClause = 'WHERE ' + conditions.join(' AND ');
        }

        const query = `
          SELECT
            parent_activity_id,
            child_activity_id,
            execution_count,
            success_count,
            weight,
            goal_context,
            created_at,
            updated_at
          FROM activity_composition_graph
          ${whereClause}
          ORDER BY weight DESC, execution_count DESC
          LIMIT $limit
        `;

        const compositions = await surrealDB.query<any>(query, params);

        content = formatCompositionSuccessAsMarkdown(compositions, { parentActivityId, childActivityId });
        break;
      }

      case 'impulseRelevance': {
        // Query which impulse shapes help activities succeed
        const extendedPointer = pointer as typeof pointer & {
          activityId?: string;
          impulseShape?: string;
        };

        const activityId = extendedPointer.activityId;
        const impulseShape = extendedPointer.impulseShape;
        const limit = pointer.limit || 50;

        logger.info('Resolving impulseRelevance', { activityId, impulseShape, limit });

        // Build query for impulse relevance metrics
        let whereClause = '';
        const params: Record<string, any> = { limit };
        const conditions: string[] = [];

        if (activityId) {
          conditions.push('activity_variant_id = $activity_id');
          params.activity_id = activityId;
        }

        if (impulseShape) {
          // Join with impulse table to filter by shape
          conditions.push('impulse_id IN (SELECT id FROM impulse WHERE shape = $impulse_shape)');
          params.impulse_shape = impulseShape;
        }

        if (conditions.length > 0) {
          whereClause = 'WHERE ' + conditions.join(' AND ');
        }

        const query = `
          SELECT
            impulse_id,
            activity_variant_id,
            task_id,
            times_loaded,
            times_execution_succeeded,
            times_execution_failed,
            times_not_loaded_succeeded,
            times_not_loaded_failed,
            relevance_score,
            irrelevance_score,
            net_value_score,
            avg_content_size_tokens AS avg_tokens,
            created_at,
            updated_at
          FROM impulse_relevance_metrics
          ${whereClause}
          ORDER BY relevance_score DESC
          LIMIT $limit
        `;

        const relevanceData = await surrealDB.query<any>(query, params);

        // Backfill net_value_score and not_loaded_observations for pre-migration rows
        for (const item of relevanceData) {
          if (item.net_value_score === undefined || item.net_value_score === null) {
            const rs = item.relevance_score ?? 0;
            const is = item.irrelevance_score ?? 0;
            item.net_value_score = Math.max(-1, Math.min(1, rs - is * 0.5));
          }
          item.not_loaded_observations = (item.times_not_loaded_succeeded ?? 0) + (item.times_not_loaded_failed ?? 0);
        }

        // Try to enrich with shape info from impulse table
        const impulseIds = relevanceData.map((r: any) => r.impulse_id);
        if (impulseIds.length > 0) {
          const shapeQuery = `
            SELECT id, shape FROM impulse
            WHERE id IN $impulse_ids
          `;
          const shapes = await surrealDB.query<any>(shapeQuery, { impulse_ids: impulseIds });
          const shapeMap = new Map(shapes.map((s: any) => [s.id, s.shape]));

          for (const item of relevanceData) {
            item.shape = shapeMap.get(item.impulse_id);
          }
        }

        content = formatImpulseRelevanceAsMarkdown(relevanceData, { activityId, impulseShape });
        break;
      }

      case 'preValidationResult': {
        // Determine if a tool call can be skipped based on historical patterns
        const extendedPointer = pointer as typeof pointer & {
          toolName?: string;
          activityId?: string;
          argumentHash?: string;
          arguments?: Record<string, unknown>;
          minSuccessRate?: number;
          skipThreshold?: number;
        };

        const toolName = extendedPointer.toolName;
        const activityId = extendedPointer.activityId;
        const argumentHash = extendedPointer.argumentHash;
        const args = extendedPointer.arguments;
        const minSuccessRate = extendedPointer.minSuccessRate ?? 0.9;
        const skipThreshold = extendedPointer.skipThreshold ?? 0.85;

        // Validate required fields
        if (!toolName || !activityId) {
          return c.json({
            success: false,
            error: 'toolName and activityId required for preValidationResult pointer',
          } as ImpulseResolveResponse, 400);
        }

        logger.info('Resolving preValidationResult', {
          toolName,
          activityId,
          argumentHash: argumentHash ? argumentHash.substring(0, 12) : 'none',
          minSuccessRate,
          skipThreshold,
        });

        // Query matching patterns from tool_argument_pattern table
        let whereClause = 'WHERE tool_name = $tool_name AND activity_id = $activity_id';
        const params: Record<string, any> = {
          tool_name: toolName,
          activity_id: activityId,
        };

        // If argument hash provided, look for exact match
        if (argumentHash) {
          whereClause += ' AND argument_hash = $argument_hash';
          params.argument_hash = argumentHash;
        }

        const query = `
          SELECT
            argument_hash,
            argument_shape,
            arguments,
            times_used,
            times_succeeded,
            avg_execution_ms,
            last_used_at,
            (times_succeeded * 1.0 / times_used) AS success_rate
          FROM tool_argument_pattern
          ${whereClause}
          AND times_used >= 3
          ORDER BY success_rate DESC, times_used DESC
          LIMIT 10
        `;

        const patterns = await surrealDB.query<any>(query, params);

        // Determine if we can skip
        let canSkip = false;
        let confidence = 0;
        let reasoning = '';
        let matchingPatterns: any[] = [];

        if (patterns.length === 0) {
          canSkip = false;
          confidence = 0;
          reasoning = 'No historical patterns found for this tool/activity combination. Execute to build pattern history.';
        } else {
          // Check if we have a high-confidence pattern
          const topPattern = patterns[0];
          const successRate = topPattern.success_rate || 0;

          if (successRate >= minSuccessRate && topPattern.times_used >= 5) {
            canSkip = true;
            confidence = Math.min(successRate, skipThreshold + (topPattern.times_used / 100));
            reasoning = `Found high-confidence pattern with ${(successRate * 100).toFixed(1)}% success rate over ${topPattern.times_used} executions.`;
          } else if (successRate >= 0.7 && topPattern.times_used >= 10) {
            canSkip = false;
            confidence = successRate;
            reasoning = `Pattern has ${(successRate * 100).toFixed(1)}% success rate but below ${(minSuccessRate * 100).toFixed(0)}% threshold for skip. Execute with caution.`;
          } else {
            canSkip = false;
            confidence = successRate;
            reasoning = `Insufficient confidence: ${(successRate * 100).toFixed(1)}% success rate over ${topPattern.times_used} executions. Execute and monitor.`;
          }

          matchingPatterns = patterns.map((p: any) => ({
            argument_hash: p.argument_hash,
            success_rate: p.success_rate || 0,
            times_used: p.times_used,
            avg_execution_ms: p.avg_execution_ms,
          }));
        }

        const result = {
          canSkip,
          confidence,
          reasoning,
          matchingPatterns,
          tool_name: toolName,
          activity_id: activityId,
          argument_shape: patterns[0]?.argument_shape,
        };

        content = formatPreValidationResultAsMarkdown(result);
        break;
      }

      // =============================================================================
      // Write resolvers: expose learning-loop writes as impulse shapes so
      // activities can invoke them through POST /v2/impulses/resolve instead of
      // hardcoding REST knowledge. Each `*_write` case delegates to the same
      // underlying handler used by the REST endpoint, reusing all validation
      // and SQL in place. Returns structured JSON with metadata.shape
      // suffixed `_result`.
      // =============================================================================

      case 'activityExecutionTrace_write': {
        const writePointer = pointer as typeof pointer & { traceData?: unknown };
        if (!writePointer.traceData) {
          return c.json({ success: false, error: 'traceData required for activityExecutionTrace_write' } as ImpulseResolveResponse, 400);
        }
        const delegated = await delegateWriteToRouter(c, executionTracesRouter, '/', writePointer.traceData);
        return c.json(buildWriteResolverResponse('activityExecutionTrace_write', delegated, 'execution trace stored') as ImpulseResolveResponse, delegated.status >= 200 && delegated.status < 300 ? 200 : delegated.status as 400 | 401 | 403 | 404 | 500);
      }

      case 'activityFeedback_write': {
        const writePointer = pointer as typeof pointer & { feedbackData?: unknown };
        if (!writePointer.feedbackData) {
          return c.json({ success: false, error: 'feedbackData required for activityFeedback_write' } as ImpulseResolveResponse, 400);
        }
        const delegated = await delegateWriteToRouter(c, activitiesRouter, '/feedback', writePointer.feedbackData);
        return c.json(buildWriteResolverResponse('activityFeedback_write', delegated, 'feedback applied') as ImpulseResolveResponse, delegated.status >= 200 && delegated.status < 300 ? 200 : delegated.status as 400 | 401 | 403 | 404 | 500);
      }

      case 'activityComposition_write': {
        const writePointer = pointer as typeof pointer & { compositionData?: unknown };
        if (!writePointer.compositionData) {
          return c.json({ success: false, error: 'compositionData required for activityComposition_write' } as ImpulseResolveResponse, 400);
        }
        const delegated = await delegateWriteToRouter(c, activitiesRouter, '/composition', writePointer.compositionData);
        return c.json(buildWriteResolverResponse('activityComposition_write', delegated, 'composition edge recorded') as ImpulseResolveResponse, delegated.status >= 200 && delegated.status < 300 ? 200 : delegated.status as 400 | 401 | 403 | 404 | 500);
      }

      case 'activityTemplate_write': {
        const writePointer = pointer as typeof pointer & { templateData?: unknown };
        if (!writePointer.templateData) {
          return c.json({ success: false, error: 'templateData required for activityTemplate_write' } as ImpulseResolveResponse, 400);
        }
        const delegated = await delegateWriteToRouter(c, activitiesRouter, '/templates', writePointer.templateData);
        return c.json(buildWriteResolverResponse('activityTemplate_write', delegated, 'template proposed') as ImpulseResolveResponse, delegated.status >= 200 && delegated.status < 300 ? 200 : delegated.status as 400 | 401 | 403 | 404 | 500);
      }

      case 'activityVariant_write': {
        const writePointer = pointer as typeof pointer & { activityId?: string; variantData?: unknown };
        if (!writePointer.activityId || !writePointer.variantData) {
          return c.json({ success: false, error: 'activityId and variantData required for activityVariant_write' } as ImpulseResolveResponse, 400);
        }
        const delegated = await delegateWriteToRouter(c, activitiesRouter, `/${encodeURIComponent(writePointer.activityId)}/variants`, writePointer.variantData);
        return c.json(buildWriteResolverResponse('activityVariant_write', delegated, 'variant created') as ImpulseResolveResponse, delegated.status >= 200 && delegated.status < 300 ? 200 : delegated.status as 400 | 401 | 403 | 404 | 500);
      }

      case 'impulseRelevance_write': {
        const writePointer = pointer as typeof pointer & { relevanceData?: unknown };
        if (!writePointer.relevanceData) {
          return c.json({ success: false, error: 'relevanceData required for impulseRelevance_write' } as ImpulseResolveResponse, 400);
        }
        const delegated = await delegateWriteToRouter(c, activitiesRouter, '/impulse-relevance', writePointer.relevanceData);
        return c.json(buildWriteResolverResponse('impulseRelevance_write', delegated, 'impulse relevance recorded') as ImpulseResolveResponse, delegated.status >= 200 && delegated.status < 300 ? 200 : delegated.status as 400 | 401 | 403 | 404 | 500);
      }

      case 'toolUsage_write': {
        const writePointer = pointer as typeof pointer & { usageData?: unknown };
        if (!writePointer.usageData) {
          return c.json({ success: false, error: 'usageData required for toolUsage_write' } as ImpulseResolveResponse, 400);
        }
        const delegated = await delegateWriteToRouter(c, activitiesRouter, '/tool-usage', writePointer.usageData);
        return c.json(buildWriteResolverResponse('toolUsage_write', delegated, 'tool usage recorded') as ImpulseResolveResponse, delegated.status >= 200 && delegated.status < 300 ? 200 : delegated.status as 400 | 401 | 403 | 404 | 500);
      }

      case 'toolArgumentPattern_write': {
        const writePointer = pointer as typeof pointer & { patternData?: unknown };
        if (!writePointer.patternData) {
          return c.json({ success: false, error: 'patternData required for toolArgumentPattern_write' } as ImpulseResolveResponse, 400);
        }
        const delegated = await delegateWriteToRouter(c, activitiesRouter, '/tool-argument-patterns', writePointer.patternData);
        return c.json(buildWriteResolverResponse('toolArgumentPattern_write', delegated, 'tool argument pattern recorded') as ImpulseResolveResponse, delegated.status >= 200 && delegated.status < 300 ? 200 : delegated.status as 400 | 401 | 403 | 404 | 500);
      }

      case 'executionSequences_write': {
        const writePointer = pointer as typeof pointer & { sequenceData?: unknown };
        if (!writePointer.sequenceData) {
          return c.json({ success: false, error: 'sequenceData required for executionSequences_write' } as ImpulseResolveResponse, 400);
        }
        const delegated = await delegateWriteToRouter(c, activitiesRouter, '/execution-sequences', writePointer.sequenceData);
        return c.json(buildWriteResolverResponse('executionSequences_write', delegated, 'execution sequence recorded') as ImpulseResolveResponse, delegated.status >= 200 && delegated.status < 300 ? 200 : delegated.status as 400 | 401 | 403 | 404 | 500);
      }

      case 'shapeScore_write': {
        const writePointer = pointer as typeof pointer & { scoreData?: unknown };
        if (!writePointer.scoreData) {
          return c.json({ success: false, error: 'scoreData required for shapeScore_write' } as ImpulseResolveResponse, 400);
        }
        const delegated = await delegateWriteToRouter(c, activitiesRouter, '/shape-scores', writePointer.scoreData);
        return c.json(buildWriteResolverResponse('shapeScore_write', delegated, 'shape score updated') as ImpulseResolveResponse, delegated.status >= 200 && delegated.status < 300 ? 200 : delegated.status as 400 | 401 | 403 | 404 | 500);
      }

      case 'similarState_write': {
        const writePointer = pointer as typeof pointer & { stateData?: unknown };
        if (!writePointer.stateData) {
          return c.json({ success: false, error: 'stateData required for similarState_write' } as ImpulseResolveResponse, 400);
        }
        const delegated = await delegateWriteToRouter(c, activitiesRouter, '/similar-state', writePointer.stateData);
        return c.json(buildWriteResolverResponse('similarState_write', delegated, 'similar state recorded') as ImpulseResolveResponse, delegated.status >= 200 && delegated.status < 300 ? 200 : delegated.status as 400 | 401 | 403 | 404 | 500);
      }

      case 'goalSeeking_write': {
        const writePointer = pointer as typeof pointer & { goalData?: unknown };
        if (!writePointer.goalData) {
          return c.json({ success: false, error: 'goalData required for goalSeeking_write' } as ImpulseResolveResponse, 400);
        }
        const delegated = await delegateWriteToRouter(c, activitiesRouter, '/create-goal-seeking', writePointer.goalData);
        return c.json(buildWriteResolverResponse('goalSeeking_write', delegated, 'goal-seeking activity created') as ImpulseResolveResponse, delegated.status >= 200 && delegated.status < 300 ? 200 : delegated.status as 400 | 401 | 403 | 404 | 500);
      }

      case 'execution_write': {
        const writePointer = pointer as typeof pointer & { executionData?: unknown };
        if (!writePointer.executionData) {
          return c.json({ success: false, error: 'executionData required for execution_write' } as ImpulseResolveResponse, 400);
        }
        const delegated = await delegateWriteToRouter(c, activitiesRouter, '/executions', writePointer.executionData);
        return c.json(buildWriteResolverResponse('execution_write', delegated, 'execution recorded') as ImpulseResolveResponse, delegated.status >= 200 && delegated.status < 300 ? 200 : delegated.status as 400 | 401 | 403 | 404 | 500);
      }

      case 'compositionEdge_write': {
        const writePointer = pointer as typeof pointer & { edgeData?: unknown };
        if (!writePointer.edgeData) {
          return c.json({ success: false, error: 'edgeData required for compositionEdge_write' } as ImpulseResolveResponse, 400);
        }
        const delegated = await delegateWriteToRouter(c, activitiesRouter, '/composition/edges', writePointer.edgeData);
        return c.json(buildWriteResolverResponse('compositionEdge_write', delegated, 'composition edge recorded') as ImpulseResolveResponse, delegated.status >= 200 && delegated.status < 300 ? 200 : delegated.status as 400 | 401 | 403 | 404 | 500);
      }

      // =============================================================================
      // Destructive resolvers: DELETE, UPDATE, DEPRECATE. RBAC is enforced at the
      // SurrealDB PERMISSIONS layer (`$auth.role = 'admin'` on UPDATE/DELETE).
      // Each successful destructive op emits an upkeepAuditLog impulse so the
      // operation is traceable independent of app logs.
      // =============================================================================

      case 'activityTemplate_update': {
        const authCheck = requireAuthenticated(c);
        if (authCheck) return c.json({ success: false, error: authCheck.error } as ImpulseResolveResponse, authCheck.status);

        const updatePointer = pointer as typeof pointer & {
          templateId?: string;
          updates?: Record<string, unknown>;
        };
        if (!updatePointer.templateId || !updatePointer.updates) {
          return c.json({ success: false, error: 'templateId and updates (object) required for activityTemplate_update' } as ImpulseResolveResponse, 400);
        }

        const allowedFields = new Set(['name', 'description', 'tags', 'tasks', 'input_shapes', 'output_shapes', 'deprecated']);
        const rejected = Object.keys(updatePointer.updates).filter((k) => !allowedFields.has(k));
        if (rejected.length > 0) {
          return c.json({
            success: false,
            error: `Disallowed update fields: ${rejected.join(', ')}. Allowed: ${Array.from(allowedFields).join(', ')}`,
          } as ImpulseResolveResponse, 400);
        }

        const jwtAuth = getJwtAuthFromContext(c)!;
        const templateId = updatePointer.templateId;
        const updates = updatePointer.updates;

        // Helper: is this caller an admin?
        const isAdmin = jwtAuth.role === 'admin' ||
          (Array.isArray(jwtAuth.scopes) && jwtAuth.scopes.includes('admin'));

        try {
          // SurrealDB stores record ids as `table:`id`` composites. Use
          // record::id(id) to extract the string part for matching, matching
          // the pattern used elsewhere (execution-traces.ts:1063).
          // Spec 6: global templates may only be modified by admin callers.
          //
          // B-2-fix (2026-04-26): Split existence check from RBAC check so we
          // can return 404 vs 403 distinctly. The previous combined query
          // returned 404 both for missing rows AND for rows excluded by the
          // admin/org gate, which leaked no info but also misled callers.
          const existing = await executeAsAuth<any>(
            jwtAuth,
            `SELECT * FROM activity WHERE record::id(id) = $id LIMIT 1`,
            { id: templateId },
          );
          const beforeRow = (existing || [])[0];
          if (!beforeRow) {
            return c.json({ success: false, error: `Template not found: ${templateId}` } as ImpulseResolveResponse, 404);
          }

          const isGlobal = beforeRow.scope === 'global';
          const sameOrg = beforeRow.org_id === jwtAuth.orgId;
          if (isGlobal && !isAdmin) {
            return c.json({ success: false, error: 'Forbidden: admin scope required for global-scope templates' } as ImpulseResolveResponse, 403);
          }
          if (!isGlobal && !sameOrg) {
            return c.json({ success: false, error: 'Forbidden: template belongs to a different org' } as ImpulseResolveResponse, 403);
          }

          const after = await executeAsAuth<any>(
            jwtAuth,
            `UPDATE activity MERGE $updates WHERE record::id(id) = $id AND (org_id = $orgId OR (scope = 'global' AND $isAdmin = true)) RETURN AFTER`,
            { id: templateId, updates, orgId: jwtAuth.orgId, isAdmin },
          );
          const afterRow = (after || [])[0];

          const diff: Record<string, { before: unknown; after: unknown }> = {};
          for (const key of Object.keys(updates)) {
            diff[key] = { before: beforeRow[key], after: afterRow?.[key] };
          }

          const auditId = await emitUpkeepAudit({
            operation: 'update',
            target_table: 'activity',
            target_ids: [templateId],
            filter_used: { id: templateId },
            dry_run: false,
            count: 1,
            performed_by: jwtAuth.keyId || jwtAuth.userId || 'unknown',
            org_id: jwtAuth.orgId,
            diff,
          });

          return c.json({
            success: true,
            content: JSON.stringify({ template: afterRow, auditImpulseId: auditId }),
            metadata: { shape: 'activityTemplate_update_result', summary: `Updated ${Object.keys(updates).length} field(s) on ${templateId}` },
          } as ImpulseResolveResponse, 200);
        } catch (err: any) {
          logger.error('activityTemplate_update failed', { error: err?.message });
          return c.json({ success: false, error: err?.message || 'update failed' } as ImpulseResolveResponse, 500);
        }
      }

      case 'activityTemplate_deprecate': {
        const authCheck = requireAuthenticated(c);
        if (authCheck) return c.json({ success: false, error: authCheck.error } as ImpulseResolveResponse, authCheck.status);

        const deprecatePointer = pointer as typeof pointer & {
          templateId?: string;
          reason?: string;
        };
        if (!deprecatePointer.templateId) {
          return c.json({ success: false, error: 'templateId required for activityTemplate_deprecate' } as ImpulseResolveResponse, 400);
        }

        const jwtAuth = getJwtAuthFromContext(c)!;
        const templateId = deprecatePointer.templateId;
        const reason = deprecatePointer.reason;

        // Spec 6: admin check for global template deprecation
        const isAdminDep = jwtAuth.role === 'admin' ||
          (Array.isArray(jwtAuth.scopes) && jwtAuth.scopes.includes('admin'));

        try {
          // B-2-fix (2026-04-26): Split existence check from RBAC check so we
          // can return distinct status codes. Returning 404 on RBAC denial
          // leaks no info about whether the row exists, but it also confused
          // the iter-26 11.1 retry into chasing phantom id-format issues
          // before realizing the real cause was admin-scope RBAC. Now: row
          // missing → 404; row present but caller lacks permission → 403.
          const existing = await executeAsAuth<any>(
            jwtAuth,
            `SELECT id, scope, org_id FROM activity WHERE record::id(id) = $id LIMIT 1`,
            { id: templateId },
          );
          const existingRow = (existing || [])[0];
          if (!existingRow) {
            return c.json({ success: false, error: `Template not found: ${templateId}` } as ImpulseResolveResponse, 404);
          }

          const isGlobal = existingRow.scope === 'global';
          const sameOrg = existingRow.org_id === jwtAuth.orgId;
          if (isGlobal && !isAdminDep) {
            return c.json({ success: false, error: 'Forbidden: admin scope required for global-scope templates' } as ImpulseResolveResponse, 403);
          }
          if (!isGlobal && !sameOrg) {
            return c.json({ success: false, error: 'Forbidden: template belongs to a different org' } as ImpulseResolveResponse, 403);
          }

          const after = await executeAsAuth<any>(
            jwtAuth,
            `UPDATE activity SET deprecated = true, updated_at = time::now() WHERE record::id(id) = $id AND (org_id = $orgId OR (scope = 'global' AND $isAdmin = true)) RETURN AFTER`,
            { id: templateId, orgId: jwtAuth.orgId, isAdmin: isAdminDep },
          );
          const afterRow = (after || [])[0];

          const auditId = await emitUpkeepAudit({
            operation: 'deprecate',
            target_table: 'activity',
            target_ids: [templateId],
            filter_used: { id: templateId },
            dry_run: false,
            count: 1,
            performed_by: jwtAuth.keyId || jwtAuth.userId || 'unknown',
            org_id: jwtAuth.orgId,
            reason,
          });

          return c.json({
            success: true,
            content: JSON.stringify({ template: afterRow, auditImpulseId: auditId }),
            metadata: { shape: 'activityTemplate_deprecate_result', summary: `Deprecated ${templateId}${reason ? `: ${reason}` : ''}` },
          } as ImpulseResolveResponse, 200);
        } catch (err: any) {
          logger.error('activityTemplate_deprecate failed', { error: err?.message });
          return c.json({ success: false, error: err?.message || 'deprecate failed' } as ImpulseResolveResponse, 500);
        }
      }

      case 'activityExecutionTrace_delete': {
        // Auth check first so unauth'd callers get 401 instead of a hint about
        // required pointer fields.
        const authCheck = requireAuthenticated(c);
        if (authCheck) return c.json({ success: false, error: authCheck.error } as ImpulseResolveResponse, authCheck.status);

        const deletePointer = pointer as typeof pointer & {
          olderThan?: string;
          success?: boolean;
          limit?: number;
          dryRun?: boolean;
        };

        if (!deletePointer.olderThan) {
          return c.json({ success: false, error: 'olderThan (ISO datetime) required for activityExecutionTrace_delete' } as ImpulseResolveResponse, 400);
        }

        const olderThan = deletePointer.olderThan;
        const successFilter = deletePointer.success;
        const limit = Math.min(Math.max(1, deletePointer.limit ?? 100), 1000);
        const dryRun = deletePointer.dryRun !== false; // default true
        const jwtAuth = getJwtAuthFromContext(c)!;

        // For API-key auth we use root credentials (self-signed JWTs can't pass
        // SurrealDB ACCESS validation), so we must add org_id scoping ourselves.
        // For real JWT auth PERMISSIONS handle it but the extra predicate is
        // a no-op since the row will already be scoped.
        const conditions = ['org_id = $orgId', 'executed_at < type::datetime($olderThan)'];
        const params: Record<string, unknown> = { olderThan, lim: limit, orgId: jwtAuth.orgId };
        if (successFilter !== undefined) {
          conditions.push(`success = ${successFilter ? 'true' : 'false'}`);
        }
        const whereClause = 'WHERE ' + conditions.join(' AND ');

        try {
          if (dryRun) {
            const selectSql = `SELECT id, activity_id, executed_at, success FROM activity_execution_traces ${whereClause} LIMIT $lim`;
            const rows = await executeAsAuth<any>(jwtAuth, selectSql, params);
            const ids = (rows || []).map((r: any) => String(r.id));
            return c.json({
              success: true,
              content: JSON.stringify({ type: 'activityExecutionTrace', ids, count: ids.length, dryRun: true, olderThan, successFilter }),
              metadata: { shape: 'activityExecutionTrace_delete_result', summary: `Dry run: ${ids.length} trace(s) match` },
            } as ImpulseResolveResponse, 200);
          }

          const selectSql = `SELECT id FROM activity_execution_traces ${whereClause} LIMIT $lim`;
          const selected = await executeAsAuth<any>(jwtAuth, selectSql, params);
          const targetIds = (selected || []).map((r: any) => String(r.id));

          if (targetIds.length === 0) {
            return c.json({
              success: true,
              content: JSON.stringify({ type: 'activityExecutionTrace', count: 0, dryRun: false, olderThan, successFilter }),
              metadata: { shape: 'activityExecutionTrace_delete_result', summary: 'No matching traces to delete' },
            } as ImpulseResolveResponse, 200);
          }

          await executeAsAuth<any>(jwtAuth, `DELETE FROM activity_execution_traces WHERE id IN $ids AND org_id = $orgId`, { ids: targetIds, orgId: jwtAuth.orgId });

          const auditId = await emitUpkeepAudit({
            operation: 'delete',
            target_table: 'activity_execution_traces',
            target_ids: targetIds,
            filter_used: { olderThan, success: successFilter, limit },
            dry_run: false,
            count: targetIds.length,
            performed_by: jwtAuth.keyId || jwtAuth.userId || 'unknown',
            org_id: jwtAuth.orgId,
          });

          return c.json({
            success: true,
            content: JSON.stringify({ type: 'activityExecutionTrace', count: targetIds.length, dryRun: false, olderThan, successFilter, auditImpulseId: auditId }),
            metadata: { shape: 'activityExecutionTrace_delete_result', summary: `Deleted ${targetIds.length} trace(s)` },
          } as ImpulseResolveResponse, 200);
        } catch (err: any) {
          logger.error('activityExecutionTrace_delete failed', { error: err?.message });
          return c.json({ success: false, error: err?.message || 'delete failed' } as ImpulseResolveResponse, 500);
        }
      }

      // =============================================================================
      // templateAuditReport: READ-ONLY. Scans stored templates, returns a per-template
      // deficiency report (missing shapes/tags, default-shape placeholders, hardcoded
      // URLs, etc.) plus optional semantic-tags-derived backfill proposals. Feeds the
      // upcoming audit-and-backfill activity; never mutates.
      // =============================================================================

      case 'templateAuditReport': {
        const authCheck = requireAuthenticated(c);
        if (authCheck) return c.json({ success: false, error: authCheck.error } as ImpulseResolveResponse, authCheck.status);

        const jwtAuth = getJwtAuthFromContext(c)!;

        // Zod schema local to this case. The global pointer schema is
        // intentionally permissive; we validate the audit-specific fields here
        // so bad input produces a clean 400 instead of a cryptic downstream
        // error.
        const AuditInputSchema = z.object({
          filter: z
            .object({
              missingMarkers: z
                .array(
                  z.enum([
                    'input_shapes',
                    'output_shapes',
                    'tags',
                    'description',
                    'task_outputs',
                    'hardcoded_urls',
                  ]),
                )
                .optional(),
              taskFormat: z.enum(['all_llm', 'all_resolver', 'mixed', 'any']).optional(),
              scope: z.enum(['global', 'org', 'project']).optional(),
              limit: z.number().int().positive().optional(),
              offset: z.number().int().nonnegative().optional(),
            })
            .optional(),
          includeProposals: z.boolean().optional(),
          includeAliasWarnings: z.boolean().optional(),
        });

        let parsed: TemplateAuditInput;
        try {
          parsed = AuditInputSchema.parse({
            filter: (pointer as any).filter,
            includeProposals: (pointer as any).includeProposals,
            includeAliasWarnings: (pointer as any).includeAliasWarnings,
          }) as TemplateAuditInput;
        } catch (err: any) {
          return c.json({
            success: false,
            error: `Invalid templateAuditReport input: ${err?.message || 'validation failed'}`,
          } as ImpulseResolveResponse, 400);
        }

        try {
          // Pick the right DB client: for API-key auth the self-signed JWT
          // can't pass SurrealDB ACCESS validation, so we use the root client
          // (via surrealDB.getInstance()) and rely on runTemplateAuditReport's
          // app-side org filter. For real JWT auth we create an authenticated
          // Surreal instance so PERMISSIONS apply. runTemplateAuditReport
          // expects the raw Surreal client (shared with observeShapes).
          const db =
            jwtAuth.authType === 'apikey' || !jwtAuth.jwtToken
              ? await surrealDB.getInstance()
              : await createAuthenticatedClient(jwtAuth.jwtToken);

          const report = await runTemplateAuditReport(db, parsed, {
            orgId: jwtAuth.orgId,
            authType: jwtAuth.authType,
          });

          return c.json({
            success: true,
            content: JSON.stringify(report),
            metadata: {
              shape: 'templateAuditReport',
              summary: `Audited ${report.total_scanned} template(s), ${report.total_with_deficiencies} with deficiencies`,
            },
          } as ImpulseResolveResponse, 200);
        } catch (err: any) {
          logger.error('templateAuditReport failed', { error: err?.message });
          return c.json({
            success: false,
            error: err?.message || 'audit failed',
          } as ImpulseResolveResponse, 500);
        }
      }

      // =============================================================================
      // executionTraceWithSignatures: recent execution traces hydrated with
      // per-impulse (pointer_type, shape) signatures so the minibob
      // co-occurrence extractor can avoid a second round trip per impulse id.
      // Read-only. See src/routes/execution-trace-with-signatures.ts.
      // =============================================================================

      case 'executionTraceWithSignatures': {
        const authCheck = requireAuthenticated(c);
        if (authCheck) {
          return c.json(
            { success: false, error: authCheck.error } as ImpulseResolveResponse,
            authCheck.status,
          );
        }
        const jwtAuth = getJwtAuthFromContext(c)!;

        try {
          // Same auth-routing pattern as templateAuditReport: API-key auth uses
          // the root client with an app-side `org_id` filter (self-signed JWTs
          // can't pass SurrealDB PERMISSIONS); real JWT auth uses the
          // authenticated client and lets PERMISSIONS fire.
          const db =
            jwtAuth.authType === 'apikey' || !jwtAuth.jwtToken
              ? await surrealDB.getInstance()
              : await createAuthenticatedClient(jwtAuth.jwtToken);

          const report = await runExecutionTraceWithSignatures(
            db,
            pointer as unknown,
            {
              orgId: jwtAuth.orgId,
              authType: jwtAuth.authType,
            },
          );

          return c.json(
            {
              success: true,
              content: JSON.stringify(report),
              metadata: {
                shape: 'executionTraceWithSignatures',
                summary: `Hydrated ${report.count} execution trace(s) since ${report.filtered_by.since}`,
              },
            } as ImpulseResolveResponse,
            200,
          );
        } catch (err: any) {
          // parseInput throws {status, message} for bad input. Propagate as
          // 400 so callers see a clean validation error.
          if (err && typeof err === 'object' && err.status === 400) {
            return c.json(
              { success: false, error: err.message } as ImpulseResolveResponse,
              400,
            );
          }
          logger.error('executionTraceWithSignatures failed', {
            error: err?.message,
          });
          return c.json(
            {
              success: false,
              error: err?.message || 'executionTraceWithSignatures resolution failed',
            } as ImpulseResolveResponse,
            500,
          );
        }
      }

      // =============================================================================
      // mcpTool: discovery-to-tools bridge.
      // See docs/specs/discovery-to-tools-bridge.md.
      //
      // Activity-api today exposes its write surface through the `*_write`
      // impulse shapes above (`activityExecutionTrace_write`, etc.). Those
      // are the preferred dispatch path per the spec's "Relationship to
      // impulse-write resolver" section — every step is one impulse-resolve,
      // resolver-tier accounting falls out for free, and we don't duplicate
      // a parallel MCP tool catalog over the same operations.
      //
      // The resolver is wired so consumers can fan out to activity-api for
      // mcpTool without 4xx-ing; it returns an empty content array. If a
      // future use case calls for activity-api-specific MCP tools (e.g. an
      // operation with no write-shape equivalent), wrap them inline here.
      // =============================================================================

      case 'mcpTool': {
        return c.json(
          {
            success: true,
            content: JSON.stringify([]),
            metadata: {
              shape: 'mcpTool',
              summary: '0 tools (activity-api dispatches via *_write impulse shapes)',
              rowCount: 0,
              vessel_id: config.discovery.vesselId,
            },
          } as ImpulseResolveResponse,
          200,
        );
      }

      // discoverByShapesQuery (F-6 corrected, 2026-04-26): pure-vessel shape
      // wrapping POST /v2/activities/discover-by-shapes. Activity-api advertises
      // this shape via discovery-vessel; meta-activities reach it through the
      // existing generic `impulse-resolve` resolver in minibob — zero source
      // changes in the integrating vessel.
      //
      // Pointer fields mirror the route body: required_shapes (required),
      // mode (optional: forward|backward|candidates_with_scores),
      // output_shapes (optional, additive backward filter),
      // current_shapes (optional), limit (optional, default 10),
      // predecessor_activity_id (optional, candidates_with_scores edge selector).
      case 'discoverByShapesQuery': {
        const extendedPointer = pointer as typeof pointer & {
          required_shapes?: string[];
          mode?: DiscoverByShapesMode;
          output_shapes?: string[];
          current_shapes?: string[];
          predecessor_activity_id?: string;
        };

        const input = {
          required_shapes: extendedPointer.required_shapes ?? [],
          mode: extendedPointer.mode ?? 'forward',
          limit: extendedPointer.limit ?? 10,
          current_shapes: extendedPointer.current_shapes ?? [],
          output_shapes: extendedPointer.output_shapes ?? [],
          predecessor_activity_id: extendedPointer.predecessor_activity_id,
        };

        const validationError = validateDiscoverByShapesInput(input);
        if (validationError) {
          return c.json({
            success: false,
            error: validationError.error,
            // ImpulseResolveResponseSchema only declares { success, content, error, metadata, loaded };
            // surface the detail through `error` to keep the envelope canonical.
          } as ImpulseResolveResponse, 400);
        }

        const result = await runDiscoverByShapes(input);

        return c.json({
          success: true,
          content: JSON.stringify({
            activities: result.activities,
            total: result.total,
          }),
          metadata: {
            shape: 'discoverByShapesQuery',
            summary: `${result.total} activities discovered for shapes [${input.required_shapes.join(', ')}] (mode=${input.mode})`,
            rowCount: result.total,
          },
        } as ImpulseResolveResponse, 200);
      }

      default: {
        // Unknown shape - delegate to vessel discovery
        // This follows the "Resolvers live WHERE THE DATA IS" principle
        logger.info('Unknown impulse shape - routing to vessel discovery', {
          shape: pointer.type,
        });

        return c.json({
          success: false,
          error: 'use_vessel_discovery',
          message: `Unknown impulse shape "${pointer.type}" - use vessel discovery to find capable resolver`,
          shape: pointer.type,
          suggested_approach: 'Query GET /v2/vessels/discover?shape=' + pointer.type + ' to find vessels capable of resolving this impulse',
          hint: 'Vessels register their capabilities via POST /v2/vessels/register. The backend only resolves shapes it directly stores (execution traces, templates, metrics).'
        } as ImpulseResolveResponse, 404);
      }
    }

    logger.info('Impulse resolved successfully', {
      pointer_type: pointer.type,
      content_length: content.length,
    });

    return c.json({
      success: true,
      content,
    } as ImpulseResolveResponse, 200);

  } catch (error: any) {
    logger.error('POST /v2/impulses/resolve failed', {
      error: error.message,
      stack: error.stack,
    });

    if (error.name === 'ZodError') {
      return c.json({
        success: false,
        error: 'Validation failed',
      } as ImpulseResolveResponse, 400);
    }

    return c.json({
      success: false,
      error: error.message,
    } as ImpulseResolveResponse, 500);
  }
});

/**
 * Format execution trace as markdown for LLM consumption
 *
 * Supports both legacy activity_execution_traces schema and new execution table schema.
 *
 * @param trace - The execution trace record
 * @param isNewSchema - If true, trace is from new `execution` table (paradigm schema)
 */
function formatExecutionTraceAsMarkdown(trace: any, isNewSchema: boolean = false): string {
  if (isNewSchema) {
    // Format new paradigm schema execution
    return formatParadigmExecutionAsMarkdown(trace);
  }

  // Format legacy activity_execution_traces schema
  const { execution_id, template_id, status, duration_ms, cost_usd, execution_trace } = trace;

  let md = `# Execution Trace: ${execution_id}\n\n`;
  md += `**Template**: ${template_id}\n`;
  md += `**Status**: ${status}\n`;
  md += `**Duration**: ${duration_ms}ms\n`;
  md += `**Cost**: $${cost_usd?.toFixed?.(4) || cost_usd || 0}\n\n`;

  if (!execution_trace) {
    md += `_No detailed trace available_\n`;
    return md;
  }

  if (execution_trace.goalContext) {
    md += `## Goal Context\n\n`;
    md += `**Goal**: ${execution_trace.goalContext.goal}\n`;
    md += `**Intent**: ${execution_trace.goalContext.intent}\n\n`;
  }

  if (execution_trace.tasks && execution_trace.tasks.length > 0) {
    md += `## Task Execution\n\n`;

    for (const task of execution_trace.tasks) {
      md += `### Task: ${task.id || task.task_id}\n\n`;
      md += `**Description**: ${task.description}\n\n`;

      if (task.inputState) {
        md += `**Input State**:\n`;
        md += `- Files available: ${task.inputState.filesAvailable?.length || 0}\n`;
        md += `- Impulses: ${task.inputState.impulses?.join(', ') || 'none'}\n\n`;
      }

      if (task.actualPrompt) {
        md += `**Prompt**: \n\`\`\`\n${task.actualPrompt}\n\`\`\`\n\n`;
      }

      if (task.toolCalls && task.toolCalls.length > 0) {
        md += `**Tool Calls**:\n`;
        for (const toolCall of task.toolCalls) {
          md += `- ${toolCall.name}(${JSON.stringify(toolCall.arguments || {}).substring(0, 100)}...)\n`;
          if (toolCall.result) {
            md += `  - Success: ${toolCall.result.success}\n`;
            if (toolCall.result.error) {
              md += `  - Error: ${toolCall.result.error}\n`;
            }
          }
        }
        md += `\n`;
      }

      if (task.response) {
        md += `**Response**: \n\`\`\`\n${task.response.substring(0, 500)}...\n\`\`\`\n\n`;
      }

      if (task.outputState) {
        md += `**Output State**:\n`;
        md += `- Files modified: ${task.outputState.filesModified?.join(', ') || 'none'}\n`;
        md += `- Files created: ${task.outputState.filesCreated?.join(', ') || 'none'}\n`;
        if (task.outputState.stderr) {
          md += `- Stderr: ${task.outputState.stderr}\n`;
        }
        md += `\n`;
      }

      if (task.result) {
        md += `**Result**: ${task.result.status}\n`;
        if (task.result.error) {
          md += `**Error**: ${task.result.error}\n`;
        }
      }
      md += `\n---\n\n`;
    }
  }

  if (execution_trace.filesModified && execution_trace.filesModified.length > 0) {
    md += `## Files Modified\n\n`;
    md += execution_trace.filesModified.map((f: string) => `- ${f}`).join('\n');
    md += `\n\n`;
  }

  return md;
}

/**
 * Format new paradigm execution schema as markdown
 * Handles: execution table with input_impulses, output_impulses, trace, etc.
 */
function formatParadigmExecutionAsMarkdown(exec: any): string {
  const { id, activity_id, success, duration_ms, cost_usd, trace, error, executed_at } = exec;

  let md = `# Execution: ${id}\n\n`;
  md += `**Activity**: ${activity_id}\n`;
  md += `**Success**: ${success ? '✓' : '✗'}\n`;
  md += `**Duration**: ${duration_ms}ms\n`;
  md += `**Cost**: $${cost_usd?.toFixed?.(4) || cost_usd || 0}\n`;
  md += `**Executed**: ${executed_at}\n\n`;

  // Error details
  if (error) {
    md += `## Error\n\n`;
    md += `**Type**: ${error.type || 'unknown'}\n`;
    md += `**Message**: ${error.message || 'No message'}\n`;
    if (error.task_id) {
      md += `**Failed Task**: ${error.task_id}\n`;
    }
    md += `\n`;
  }

  // Input/Output impulses
  if (exec.input_impulses && exec.input_impulses.length > 0) {
    md += `## Input Impulses\n\n`;
    for (const impulseId of exec.input_impulses) {
      md += `- ${impulseId}\n`;
    }
    md += `\n`;
  }

  if (exec.output_impulses && exec.output_impulses.length > 0) {
    md += `## Output Impulses\n\n`;
    for (const impulseId of exec.output_impulses) {
      md += `- ${impulseId}\n`;
    }
    md += `\n`;
  }

  // Resolved impulses (if loaded via includeImpulses=true)
  if (exec.resolved_impulses && exec.resolved_impulses.length > 0) {
    md += `## Resolved Impulse Content\n\n`;
    for (const impulse of exec.resolved_impulses) {
      md += `### ${impulse.id} (${impulse.shape})\n\n`;
      if (impulse.summary) {
        md += `_${impulse.summary}_\n\n`;
      }
      if (impulse.content) {
        md += `\`\`\`\n${impulse.content.substring(0, 1000)}${impulse.content.length > 1000 ? '\n...(truncated)' : ''}\n\`\`\`\n\n`;
      }
    }
  }

  // Trace details (task-by-task)
  if (trace?.tasks && trace.tasks.length > 0) {
    md += `## Task Execution\n\n`;

    for (const task of trace.tasks) {
      md += `### Task: ${task.task_id || task.id}\n\n`;
      if (task.description) {
        md += `**Description**: ${task.description}\n`;
      }
      md += `**Status**: ${task.status}\n`;
      if (task.duration_ms) {
        md += `**Duration**: ${task.duration_ms}ms\n`;
      }
      md += `\n`;

      if (task.tool_calls && task.tool_calls.length > 0) {
        md += `**Tool Calls**:\n`;
        for (const call of task.tool_calls) {
          md += `- ${call.tool}: ${call.success ? '✓' : '✗'} (${call.duration_ms}ms)\n`;
        }
        md += `\n`;
      }

      md += `---\n\n`;
    }
  }

  // State transition
  if (trace?.state_snapshot) {
    md += `## State Transition\n\n`;
    const { input_state, output_state, stateTransition } = trace.state_snapshot;

    if (input_state?.filesAvailable?.length > 0) {
      md += `**Input Files**: ${input_state.filesAvailable.length} files\n`;
    }
    if (output_state?.filesModified?.length > 0) {
      md += `**Modified**: ${output_state.filesModified.join(', ')}\n`;
    }
    if (output_state?.filesCreated?.length > 0) {
      md += `**Created**: ${output_state.filesCreated.join(', ')}\n`;
    }
    md += `\n`;
  }

  return md;
}

/**
 * Format activity template as markdown
 * Uses canonical field names: id, name, tasks (not variant_id, variant_name, task_steps)
 */
function formatTemplateAsMarkdown(template: any): string {
  // Use canonical 'name' field, fall back to legacy 'variant_name'
  const name = template.name || template.variant_name;
  // Use canonical 'id' field, fall back to legacy 'variant_id'
  const id = template.id || template.variant_id;
  // Use canonical 'tasks' field, fall back to legacy 'task_steps'
  const tasks = template.tasks || template.task_steps;

  let md = `# Activity Template: ${name}\n\n`;
  md += `**ID**: ${id}\n`;
  md += `**Category**: ${template.category || 'uncategorized'}\n`;
  md += `**Description**: ${template.description}\n`;
  if (template.execution_type) {
    md += `**Execution Type**: ${template.execution_type}\n`;
  }
  if (template.input_shapes?.length) {
    md += `**Input Shapes**: ${template.input_shapes.join(', ')}\n`;
  }
  if (template.output_shapes?.length) {
    md += `**Output Shapes**: ${template.output_shapes.join(', ')}\n`;
  }
  md += `\n`;

  if (tasks && tasks.length > 0) {
    md += `## Tasks\n\n`;
    for (const task of tasks) {
      md += `### ${task.id}\n\n`;
      md += `**Description**: ${task.description}\n`;
      if (task.subagent) {
        md += `**Subagent**: ${task.subagent}\n`;
      }
      if (task.dependencies?.length > 0) {
        md += `**Dependencies**: ${task.dependencies.join(', ')}\n`;
      }
      md += `\n`;

      if (task.prompt?.variables && task.prompt.variables.length > 0) {
        md += `**Variables**:\n`;
        for (const v of task.prompt.variables) {
          md += `- ${v.name} (${v.type})${v.required ? ' *required*' : ''}: ${v.description || ''}\n`;
        }
        md += `\n`;
      }

      if (task.prompt?.template) {
        md += `**Prompt Template**:\n\`\`\`\n${task.prompt.template}\n\`\`\`\n\n`;
      }
    }
  }

  return md;
}

/**
 * Format metrics as markdown table
 */
function formatMetricsAsMarkdown(metrics: any[]): string {
  let md = `# Activity Metrics\n\n`;
  md += `| Variant | Success Rate | Executions | Avg Duration | Avg Cost | Thompson α/β |\n`;
  md += `|---------|--------------|------------|--------------|----------|-------------|\n`;

  for (const m of metrics) {
    md += `| ${m.variant_id} | ${(m.success_rate * 100).toFixed(1)}% | ${m.total_executions} | ${m.avg_duration_ms}ms | $${m.avg_cost_usd.toFixed(4)} | ${m.thompson_alpha.toFixed(1)}/${m.thompson_beta.toFixed(1)} |\n`;
  }

  return md;
}

/**
 * Format recent executions as summary markdown
 */
function formatRecentExecutionsAsMarkdown(executions: any[], filter: string): string {
  let md = `# Recent Executions (${filter})\n\n`;
  md += `Found ${executions.length} execution(s)\n\n`;
  md += `| ID | Template | Status | Duration | Cost | Time |\n`;
  md += `|----|----------|--------|----------|------|------|\n`;

  for (const exec of executions) {
    const id = exec.execution_id || exec.id;
    const template = exec.template_id || 'unknown';
    const status = exec.status || 'unknown';
    const duration = exec.duration_ms ? `${exec.duration_ms}ms` : '-';
    const cost = exec.cost_usd ? `$${exec.cost_usd.toFixed(4)}` : '-';
    const time = exec.created_at ? new Date(exec.created_at).toISOString().split('T')[0] : '-';

    md += `| ${id} | ${template} | ${status} | ${duration} | ${cost} | ${time} |\n`;
  }

  md += `\n## Execution Details\n\n`;

  for (const exec of executions.slice(0, 5)) {
    md += `### ${exec.execution_id || exec.id}\n\n`;

    if (exec.execution_trace?.goalContext) {
      md += `**Goal**: ${exec.execution_trace.goalContext.goal}\n\n`;
    }

    if (exec.status === 'failed' && exec.execution_trace?.tasks) {
      const failedTasks = exec.execution_trace.tasks.filter((t: any) => t.result?.status === 'failed');
      if (failedTasks.length > 0) {
        md += `**Failed Tasks**:\n`;
        for (const task of failedTasks) {
          md += `- ${task.id}: ${task.result?.error || 'unknown error'}\n`;
        }
        md += `\n`;
      }
    }

    md += `---\n\n`;
  }

  return md;
}

/**
 * Format failure patterns for analysis
 */
function formatFailurePatternsAsMarkdown(failures: any[]): string {
  let md = `# Failure Patterns Analysis\n\n`;
  md += `Analyzed ${failures.length} failed execution(s)\n\n`;

  // Group by template
  const byTemplate: Record<string, any[]> = {};
  for (const f of failures) {
    const template = f.template_id || 'unknown';
    if (!byTemplate[template]) {
      byTemplate[template] = [];
    }
    byTemplate[template].push(f);
  }

  md += `## Failures by Template\n\n`;
  md += `| Template | Failure Count | Most Common Error |\n`;
  md += `|----------|---------------|-------------------|\n`;

  for (const [template, executions] of Object.entries(byTemplate)) {
    // Extract errors
    const errors: string[] = [];
    for (const exec of executions) {
      if (exec.errors) {
        errors.push(...(Array.isArray(exec.errors) ? exec.errors.flat() : [exec.errors]));
      }
      if (exec.tool_errors) {
        errors.push(...(Array.isArray(exec.tool_errors) ? exec.tool_errors.flat().filter(Boolean) : []));
      }
    }

    // Find most common error
    const errorCounts: Record<string, number> = {};
    for (const err of errors.filter(Boolean)) {
      const errStr = String(err).substring(0, 50);
      errorCounts[errStr] = (errorCounts[errStr] || 0) + 1;
    }

    const sortedErrors = Object.entries(errorCounts).sort((a, b) => b[1] - a[1]);
    const mostCommon = sortedErrors.length > 0 ? sortedErrors[0][0] : 'N/A';

    md += `| ${template} | ${executions.length} | ${mostCommon}... |\n`;
  }

  md += `\n## Recommendations\n\n`;

  // Generate recommendations based on patterns
  const totalFailures = failures.length;
  const templateFailures = Object.entries(byTemplate).sort((a, b) => b[1].length - a[1].length);

  if (templateFailures.length > 0) {
    const [worstTemplate, worstFailures] = templateFailures[0];
    if (worstFailures.length > totalFailures * 0.5) {
      md += `1. **High-priority**: Template \`${worstTemplate}\` accounts for ${Math.round(worstFailures.length / totalFailures * 100)}% of failures. Consider creating a variant.\n`;
    }
  }

  md += `2. Create debug activity for templates with >3 failures\n`;
  md += `3. Review tool call patterns in failed executions\n`;

  return md;
}

/**
 * Format success patterns for analysis
 */
function formatSuccessPatternsAsMarkdown(successes: any[]): string {
  let md = `# Success Patterns Analysis\n\n`;
  md += `Analyzed ${successes.length} successful execution(s)\n\n`;

  // Calculate averages
  const totalDuration = successes.reduce((sum, s) => sum + (s.duration_ms || 0), 0);
  const totalCost = successes.reduce((sum, s) => sum + (s.cost_usd || 0), 0);
  const avgDuration = totalDuration / successes.length;
  const avgCost = totalCost / successes.length;

  md += `## Performance Summary\n\n`;
  md += `- **Average Duration**: ${avgDuration.toFixed(0)}ms\n`;
  md += `- **Average Cost**: $${avgCost.toFixed(4)}\n`;
  md += `- **Fastest Execution**: ${Math.min(...successes.map(s => s.duration_ms || Infinity))}ms\n`;
  md += `- **Slowest Execution**: ${Math.max(...successes.map(s => s.duration_ms || 0))}ms\n\n`;

  // Group by template for comparison
  const byTemplate: Record<string, any[]> = {};
  for (const s of successes) {
    const template = s.template_id || 'unknown';
    if (!byTemplate[template]) {
      byTemplate[template] = [];
    }
    byTemplate[template].push(s);
  }

  md += `## Template Performance\n\n`;
  md += `| Template | Executions | Avg Duration | Avg Cost |\n`;
  md += `|----------|------------|--------------|----------|\n`;

  for (const [template, executions] of Object.entries(byTemplate)) {
    const avgDur = executions.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / executions.length;
    const avgCst = executions.reduce((sum, e) => sum + (e.cost_usd || 0), 0) / executions.length;

    md += `| ${template} | ${executions.length} | ${avgDur.toFixed(0)}ms | $${avgCst.toFixed(4)} |\n`;
  }

  md += `\n## Tool Usage Patterns\n\n`;

  // Analyze tool usage across successes
  const toolCounts: Record<string, number> = {};
  for (const s of successes) {
    if (s.tool_usage) {
      const tools = Array.isArray(s.tool_usage) ? s.tool_usage.flat() : [];
      for (const toolCall of tools) {
        if (toolCall?.name) {
          toolCounts[toolCall.name] = (toolCounts[toolCall.name] || 0) + 1;
        }
      }
    }
  }

  const sortedTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (sortedTools.length > 0) {
    md += `Most used tools in successful executions:\n`;
    for (const [tool, count] of sortedTools) {
      md += `- ${tool}: ${count} calls\n`;
    }
  } else {
    md += `No tool usage data available.\n`;
  }

  return md;
}

/**
 * Format a list of templates as markdown
 * Used by activityTemplateRecommendation resolver
 */
function formatTemplateListAsMarkdown(templates: any[], heading: string): string {
  let md = `# ${heading}\n\n`;
  md += `Found ${templates.length} template(s)\n\n`;

  for (const template of templates) {
    md += `## ${template.variant_name || template.variant_id}\n\n`;
    md += `**ID**: \`${template.variant_id}\`\n`;
    md += `**Category**: ${template.category}\n`;
    md += `**Description**: ${template.description || 'No description'}\n\n`;

    if (template.task_steps && template.task_steps.length > 0) {
      md += `### Task Structure (${template.task_steps.length} tasks)\n\n`;
      for (const task of template.task_steps) {
        md += `#### ${task.id}\n`;
        md += `- **Description**: ${task.description}\n`;
        md += `- **Subagent**: ${task.subagent || 'default'}\n`;
        if (task.dependencies && task.dependencies.length > 0) {
          md += `- **Dependencies**: ${task.dependencies.join(', ')}\n`;
        }
        if (task.prompt?.variables && task.prompt.variables.length > 0) {
          md += `- **Variables**: ${task.prompt.variables.map((v: any) => `${v.name} (${v.type})`).join(', ')}\n`;
        }
        md += `\n**Prompt Template**:\n\`\`\`\n${task.prompt?.template?.substring(0, 500) || 'No template'}${task.prompt?.template?.length > 500 ? '\n...(truncated)' : ''}\n\`\`\`\n\n`;
      }
    }
    md += `---\n\n`;
  }

  return md;
}

/**
 * Format templates with performance metrics as markdown
 * Used by activityTemplatesByMetrics resolver
 */
function formatTemplateListWithMetricsAsMarkdown(templates: any[]): string {
  // F-NN-D defense in depth: variant_id may arrive as a SurrealDB RecordId
  // object from view-aliased columns. Coerce via normalizeRecordId so the
  // markdown never renders "[object Object]" or "undefined" for ids that
  // came back wrapped.
  const idStr = (v: unknown): string => {
    const s = normalizeRecordId(v);
    return s.replace(/^activity:/, '').replace(/[⟨⟩`]/g, '') || s;
  };

  let md = `# Top Performing Templates\n\n`;
  md += `Found ${templates.length} template(s) with sufficient execution history\n\n`;

  md += `## Performance Summary\n\n`;
  md += `| Template | Success Rate | Executions | Avg Duration | Avg Cost |\n`;
  md += `|----------|--------------|------------|--------------|----------|\n`;

  for (const t of templates) {
    const successRate = t.success_rate ? `${(t.success_rate * 100).toFixed(1)}%` : 'N/A';
    const avgDuration = t.avg_duration_ms ? `${t.avg_duration_ms.toFixed(0)}ms` : 'N/A';
    const avgCost = t.avg_cost_usd ? `$${t.avg_cost_usd.toFixed(4)}` : 'N/A';
    const displayName = t.variant_name || idStr(t.variant_id) || 'unknown';
    md += `| ${displayName} | ${successRate} | ${t.total_executions || 0} | ${avgDuration} | ${avgCost} |\n`;
  }
  md += `\n`;

  // Detailed task structure for learning
  for (const template of templates) {
    const displayName = template.variant_name || idStr(template.variant_id) || 'unknown';
    md += `## ${displayName}\n\n`;
    md += `**ID**: \`${idStr(template.variant_id) || 'unknown'}\`\n`;
    md += `**Category**: ${template.category ?? 'uncategorized'}\n`;
    md += `**Description**: ${template.description || 'No description'}\n`;
    md += `**Success Rate**: ${template.success_rate ? `${(template.success_rate * 100).toFixed(1)}%` : 'N/A'}\n\n`;

    if (template.task_steps && template.task_steps.length > 0) {
      md += `### Task Structure\n\n`;
      for (const task of template.task_steps) {
        md += `#### ${task.id}\n`;
        md += `**Description**: ${task.description}\n`;
        if (task.prompt?.template) {
          md += `\n**Prompt** (truncated):\n\`\`\`\n${task.prompt.template.substring(0, 300)}${task.prompt.template.length > 300 ? '\n...' : ''}\n\`\`\`\n`;
        }
        md += `\n`;
      }
    }
    md += `---\n\n`;
  }

  return md;
}

/**
 * Format multiple execution traces as markdown
 * Used by executionTraces resolver for trailblazer template
 */
function formatMultipleTracesAsMarkdown(traces: any[], templateId: string, successFilter?: boolean): string {
  const filterDesc = successFilter === true ? 'Successful' : successFilter === false ? 'Failed' : 'All';
  let md = `# ${filterDesc} Execution Traces for ${templateId}\n\n`;
  md += `Found ${traces.length} execution(s)\n\n`;

  // Summary table
  md += `## Summary\n\n`;
  md += `| Execution ID | Status | Duration | Cost | Time |\n`;
  md += `|--------------|--------|----------|------|------|\n`;

  for (const trace of traces) {
    const id = trace.execution_id?.substring(0, 12) || 'unknown';
    const status = trace.status || 'unknown';
    const duration = trace.duration_ms ? `${trace.duration_ms}ms` : 'N/A';
    const cost = trace.cost_usd ? `$${trace.cost_usd.toFixed(4)}` : 'N/A';
    const time = trace.created_at ? new Date(trace.created_at).toISOString().split('T')[0] : 'N/A';
    md += `| ${id}... | ${status} | ${duration} | ${cost} | ${time} |\n`;
  }
  md += `\n`;

  // Detailed traces
  for (const trace of traces) {
    md += `## Execution: ${trace.execution_id}\n\n`;
    md += `**Status**: ${trace.status}\n`;
    md += `**Duration**: ${trace.duration_ms || 'N/A'}ms\n`;
    md += `**Cost**: $${trace.cost_usd?.toFixed(4) || 'N/A'}\n\n`;

    // Error details for failed executions
    if (trace.status === 'failure' || trace.status === 'failed') {
      md += `### Error Details\n\n`;
      if (trace.error_message) {
        md += `**Error**: ${trace.error_message}\n`;
      }
      if (trace.failed_task_id) {
        md += `**Failed Task**: ${trace.failed_task_id}\n`;
      }
      md += `\n`;
    }

    // Task execution details
    if (trace.execution_trace?.tasks && trace.execution_trace.tasks.length > 0) {
      md += `### Task Execution Flow\n\n`;
      for (const task of trace.execution_trace.tasks) {
        const taskStatus = task.result?.status || task.status || 'unknown';
        const statusIcon = taskStatus === 'completed' || taskStatus === 'success' ? '✓' : taskStatus === 'failed' ? '✗' : '○';
        md += `#### ${statusIcon} ${task.id || task.task_id}\n`;

        if (task.description) {
          md += `${task.description}\n\n`;
        }

        // Tool calls
        if (task.toolCalls && task.toolCalls.length > 0) {
          md += `**Tool Calls**:\n`;
          for (const call of task.toolCalls.slice(0, 5)) { // Limit to 5 calls per task
            const callStatus = call.result?.success ? '✓' : '✗';
            md += `- ${callStatus} \`${call.name}\``;
            if (call.result?.error) {
              md += ` - Error: ${call.result.error.substring(0, 100)}`;
            }
            md += `\n`;
          }
          if (task.toolCalls.length > 5) {
            md += `- ... and ${task.toolCalls.length - 5} more calls\n`;
          }
          md += `\n`;
        }

        // Error for failed task
        if (task.result?.error) {
          md += `**Error**: ${task.result.error}\n\n`;
        }
      }
    }

    // Output state if available
    if (trace.execution_trace?.filesModified?.length > 0) {
      md += `### Files Modified\n\n`;
      for (const file of trace.execution_trace.filesModified) {
        md += `- ${file}\n`;
      }
      md += `\n`;
    }

    md += `---\n\n`;
  }

  // Pattern analysis for failed traces
  if (successFilter === false && traces.length > 1) {
    md += `## Failure Pattern Analysis\n\n`;

    // Group by failed task
    const failedTasks: Record<string, number> = {};
    const errorPatterns: Record<string, number> = {};

    for (const trace of traces) {
      if (trace.failed_task_id) {
        failedTasks[trace.failed_task_id] = (failedTasks[trace.failed_task_id] || 0) + 1;
      }
      if (trace.error_message) {
        const errorKey = trace.error_message.substring(0, 50);
        errorPatterns[errorKey] = (errorPatterns[errorKey] || 0) + 1;
      }
    }

    if (Object.keys(failedTasks).length > 0) {
      md += `**Most Common Failing Tasks**:\n`;
      const sortedTasks = Object.entries(failedTasks).sort((a, b) => b[1] - a[1]);
      for (const [task, count] of sortedTasks.slice(0, 3)) {
        md += `- \`${task}\`: ${count} failures (${Math.round(count / traces.length * 100)}%)\n`;
      }
      md += `\n`;
    }

    if (Object.keys(errorPatterns).length > 0) {
      md += `**Common Error Patterns**:\n`;
      const sortedErrors = Object.entries(errorPatterns).sort((a, b) => b[1] - a[1]);
      for (const [error, count] of sortedErrors.slice(0, 3)) {
        md += `- "${error}...": ${count} occurrences\n`;
      }
      md += `\n`;
    }
  }

  return md;
}

/**
 * Format template comparison
 */
function formatTemplateComparisonAsMarkdown(comparisons: any[], activityId: string): string {
  let md = `# Template Comparison: ${activityId}\n\n`;
  md += `Comparing ${comparisons.length} template variant(s)\n\n`;

  md += `| Template | Success Rate | Executions | Avg Duration | Avg Cost |\n`;
  md += `|----------|--------------|------------|--------------|----------|\n`;

  for (const c of comparisons) {
    const successRate = c.success_rate ? `${(c.success_rate * 100).toFixed(1)}%` : 'N/A';
    const avgDuration = c.avg_duration ? `${c.avg_duration.toFixed(0)}ms` : 'N/A';
    const avgCost = c.avg_cost ? `$${c.avg_cost.toFixed(4)}` : 'N/A';

    md += `| ${c.template_id} | ${successRate} | ${c.executions || 0} | ${avgDuration} | ${avgCost} |\n`;
  }

  md += `\n## Recommendations\n\n`;

  if (comparisons.length > 1) {
    const best = comparisons[0];
    md += `1. **Best performing variant**: \`${best.template_id}\` with ${((best.success_rate || 0) * 100).toFixed(1)}% success rate\n`;

    const worst = comparisons[comparisons.length - 1];
    if (worst.success_rate !== undefined && worst.success_rate < 0.5) {
      md += `2. **Consider deprecating**: \`${worst.template_id}\` (${((worst.success_rate || 0) * 100).toFixed(1)}% success rate)\n`;
    }

    md += `3. Use Thompson Sampling to automatically route to better variants\n`;
  } else {
    md += `1. Only one variant exists - consider creating variants for A/B testing\n`;
  }

  return md;
}

/**
 * POST /v2/impulses/:impulseId/usage
 * Track impulse usage for analytics and learning
 *
 * MiniBob calls this endpoint to record when an impulse is used in an activity.
 * This enables:
 * - Usage analytics (most/least used impulses)
 * - Cleanup of unused impulses
 * - Learning about impulse relevance
 * - Budget learning (impulse-budget-learning enhancement)
 *
 * Budget learning fields (optional):
 * - budgetRequested: original budget for this impulse
 * - wasTruncated: whether content was truncated to fit budget
 * - priorityLevel: impulse priority (critical, high, medium, low)
 * - truncationRatio: originalTokenCount / budget (>1.0 means truncation)
 *
 * Flow:
 * 1. Verify impulse exists in `impulse` table (404 if not found)
 * 2. Store usage record in impulse_usage_history (with budget metadata if provided)
 * 3. Return success (usage stats tracked via impulse_usage_history queries)
 */
router.post('/:impulseId/usage', async (c) => {
  try {
    const { impulseId } = c.req.param();
    const body = await c.req.json();

    // Core fields
    const { activityId, taskId, executionId, tokensUsed, success } = body;

    // Budget learning fields (impulse-budget-learning enhancement)
    const { budgetRequested, wasTruncated, priorityLevel, truncationRatio } = body;

    logger.info('POST /v2/impulses/:impulseId/usage', {
      impulse_id: impulseId,
      activity_id: activityId,
      task_id: taskId,
      tokens_used: tokensUsed,
      budget_requested: budgetRequested,
      was_truncated: wasTruncated,
    });

    // Check if impulse exists in new `impulse` table
    const checkQuery = `
      SELECT id FROM impulse
      WHERE id = $impulse_id
      LIMIT 1
    `;

    const existing = await surrealDB.query<any>(checkQuery, { impulse_id: impulseId });

    if (existing.length === 0) {
      return c.json({
        success: false,
        error: `Impulse not found: ${impulseId}`,
      }, 404);
    }

    // Create usage record in impulse_usage_history
    // Note: org_id and project_id would be set via $auth in RBAC context
    // Includes budget learning fields for impulse-budget-learning enhancement
    const usageQuery = `
      CREATE impulse_usage_history SET
        impulse_id = $impulse_id,
        activity_id = $activity_id,
        task_id = $task_id,
        execution_id = $execution_id,
        tokens_consumed = $tokens_consumed,
        success = $success,
        budget_requested = $budget_requested,
        was_truncated = $was_truncated,
        priority_level = $priority_level,
        truncation_ratio = $truncation_ratio,
        used_at = time::now()
    `;

    await surrealDB.query(usageQuery, {
      impulse_id: impulseId,
      activity_id: activityId || null,
      task_id: taskId || null,
      execution_id: executionId || null,
      tokens_consumed: tokensUsed || 0,
      success: success ?? true,
      // Budget learning fields (null if not provided)
      budget_requested: budgetRequested ?? null,
      was_truncated: wasTruncated ?? null,
      priority_level: priorityLevel ?? null,
      truncation_ratio: truncationRatio ?? null,
    });

    // Note: In new schema, usage stats are tracked via impulse_usage_history queries.
    // The `impulse` table does not have usage_count/last_used_at fields.
    // Usage analytics should query impulse_usage_history instead.

    logger.info('Impulse usage recorded', {
      impulse_id: impulseId,
      was_truncated: wasTruncated,
      truncation_ratio: truncationRatio,
    });

    return c.json({ success: true }, 200);

  } catch (error: any) {
    logger.error('POST /v2/impulses/:impulseId/usage failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      success: false,
      error: error.message,
    }, 500);
  }
});

export default router;
