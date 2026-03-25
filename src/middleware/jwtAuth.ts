/**
 * JWT Authentication Middleware
 *
 * Detects MiniBob JWT tokens from Authorization header and extracts claims.
 * Works alongside Redis session-based auth - JWT takes precedence when present.
 *
 * JWT tokens are obtained via POST /v2/auth/minibob/signin and contain:
 * - org_id: Organization the MiniBob instance belongs to
 * - project_id: Optional project scope
 * - instance_id: MiniBob instance identifier
 *
 * When JWT is present, routes should use queryWithAuth() to let SurrealDB
 * enforce RBAC via PERMISSIONS clauses using $auth.org_id.
 */

import { Context, Next } from 'hono';
import { createAuthenticatedClient } from '../db/surreal';
import { logger } from '../utils/logger';

export interface JwtAuthContext {
  jwtToken: string;
  orgId: string;
  // For MiniBob instances: single project assignment
  projectId?: string;
  // For API key users: array of accessible projects (from project_members)
  projectIds?: string[];
  instanceId?: string;
}

/**
 * JWT authentication middleware
 *
 * Extracts JWT token from Authorization header and validates it against SurrealDB.
 * If valid, sets jwtAuth context with token and claims for downstream use.
 *
 * Allows requests without JWT to proceed (falls back to Redis session auth).
 */
export async function jwtAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader) {
    c.set('jwtAuth', null);
    await next();
    return;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    c.set('jwtAuth', null);
    await next();
    return;
  }

  const token = match[1];

  // Detect if this is a JWT token (contains periods) vs a Base64 Redis session key
  // JWT format: header.payload.signature (3 parts separated by .)
  // Base64 Redis key: no periods, typically shorter
  if (!token.includes('.')) {
    // Not a JWT - let Redis session auth handle it
    c.set('jwtAuth', null);
    await next();
    return;
  }

  // Count periods to verify JWT structure (should have exactly 2)
  const periodCount = (token.match(/\./g) || []).length;
  if (periodCount !== 2) {
    // Malformed JWT - reject
    logger.warn('Malformed JWT token structure', { periodCount });
    c.set('jwtAuth', null);
    await next();
    return;
  }

  try {
    // Validate token by attempting to authenticate with SurrealDB
    const db = await createAuthenticatedClient(token);

    // Query $auth to get claims
    // NOTE: SELECT * FROM $auth doesn't work in SurrealDB - must use RETURN with explicit fields
    const result = await db.query<[{
      id: string;
      org_id?: string;
      user_id?: string;
      scopes?: string[];
      project_ids?: string[];
      project_id?: string;
      instance_id?: string;
      role?: string;
    }]>(`RETURN {
      id: $auth.id,
      org_id: $auth.org_id,
      user_id: $auth.user_id,
      scopes: $auth.scopes,
      project_ids: $auth.project_ids,
      project_id: $auth.project_id,
      instance_id: $auth.instance_id,
      role: $auth.role
    }`);
    const auth = result[0] || null;

    await db.close();

    if (!auth) {
      logger.warn('JWT valid but no auth claims found');
      c.set('jwtAuth', null);
      await next();
      return;
    }

    // Extract claims, handling SurrealDB record ID format (organizations:xyz -> xyz)
    // MiniBob instances have project_id (singular), API key users have project_ids (array)
    const jwtAuth: JwtAuthContext = {
      jwtToken: token,
      orgId: String(auth.org_id || '').replace(/^organizations:/, ''),
      // MiniBob instances: singular project assignment
      projectId: auth.project_id ? String(auth.project_id).replace(/^projects:/, '') : undefined,
      // API key users: array of accessible projects from project_members
      projectIds: Array.isArray(auth.project_ids)
        ? auth.project_ids.map((p: unknown) => String(p).replace(/^projects:/, ''))
        : undefined,
      instanceId: auth.instance_id,
    };

    logger.debug('JWT authentication successful', {
      orgId: jwtAuth.orgId,
      projectId: jwtAuth.projectId,
      projectIds: jwtAuth.projectIds,
      instanceId: jwtAuth.instanceId,
    });

    c.set('jwtAuth', jwtAuth);

  } catch (error) {
    const err = error as Error;
    logger.debug('JWT authentication failed', { error: err.message });
    c.set('jwtAuth', null);
  }

  await next();
}

/**
 * Helper to extract JWT auth context from request
 */
export function getJwtAuthFromContext(c: Context): JwtAuthContext | null {
  return c.get('jwtAuth') as JwtAuthContext | null;
}

/**
 * Check if request has valid JWT authentication
 */
export function hasJwtAuth(c: Context): boolean {
  const jwtAuth = getJwtAuthFromContext(c);
  return jwtAuth !== null && jwtAuth.jwtToken !== undefined;
}
