/**
 * JWT Authentication Middleware
 *
 * Supports two authentication header formats:
 * - Authorization: Bearer <jwt>  - JWT tokens (from SurrealDB signin or identity-vessel)
 * - Authorization: ApiKey <key>  - API keys (validated via identity-vessel HMAC)
 *
 * JWT tokens contain claims that are validated against SurrealDB:
 * - org_id: Organization the caller belongs to
 * - project_id: Optional project scope (MiniBob instances)
 * - project_ids: Array of accessible projects (API key users)
 * - instance_id: MiniBob instance identifier (if applicable)
 *
 * When authenticated, routes should use queryWithAuth() to let SurrealDB
 * enforce RBAC via PERMISSIONS clauses using $auth.org_id.
 *
 * Auth Pattern Consolidation (2026-04-03):
 * - Removed apikey_record SurrealDB ACCESS method (legacy)
 * - API keys now validated via identity-vessel HMAC pattern
 * - Use explicit header prefixes instead of eyJ detection heuristic
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
  // Track auth type for debugging and metrics
  authType?: 'jwt' | 'apikey' | 'minibob_token';
}

/**
 * Validate API key via identity-vessel HMAC
 */
async function validateApiKeyViaIdentityVessel(apiKey: string): Promise<JwtAuthContext | null> {
  const identityVesselUrl =
    process.env.IDENTITY_VESSEL_URL ||
    'http://identity-vessel.activity-system.svc.cluster.local:8080';

  try {
    const response = await fetch(`${identityVesselUrl}/v1/auth/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impulse: {
          type: 'authentication',
          pointer: { type: 'apiKey', apiKey },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      logger.warn('Identity vessel API key validation failed', { status: response.status });
      return null;
    }

    const result = await response.json() as {
      success: boolean;
      data?: {
        authenticated: boolean;
        orgId: string;
        userId: string;
        keyId: string;
        scopes: string[];
      };
    };

    if (!result.success || !result.data?.authenticated) {
      return null;
    }

    // For API keys, we don't have a JWT token - identity-vessel validates via HMAC
    // We create a synthetic token for the context that includes the validated claims
    const syntheticToken = Buffer.from(JSON.stringify({
      type: 'apikey_validated',
      orgId: result.data.orgId,
      userId: result.data.userId,
      keyId: result.data.keyId,
      scopes: result.data.scopes,
      validatedAt: Date.now(),
    })).toString('base64');

    return {
      jwtToken: syntheticToken,
      orgId: result.data.orgId,
      authType: 'apikey',
    };
  } catch (error) {
    const err = error as Error;
    logger.error('Identity vessel API key validation error', { error: err.message });
    return null;
  }
}

/**
 * JWT authentication middleware
 *
 * Extracts token from Authorization header and validates based on header prefix:
 * - Bearer: JWT token validated against SurrealDB
 * - ApiKey: API key validated via identity-vessel HMAC
 *
 * Allows requests without auth header to proceed (falls back to Redis session auth).
 */
export async function jwtAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  logger.debug('Auth middleware called', {
    path: c.req.path,
    hasAuthHeader: !!authHeader,
    authHeaderPrefix: authHeader ? authHeader.substring(0, 20) + '...' : 'none'
  });

  if (!authHeader) {
    c.set('jwtAuth', null);
    await next();
    return;
  }

  // Check for ApiKey prefix first (API keys validated via identity-vessel)
  const apiKeyMatch = authHeader.match(/^ApiKey\s+(.+)$/i);
  if (apiKeyMatch) {
    const apiKey = apiKeyMatch[1];
    logger.debug('Processing ApiKey auth header');

    const jwtAuth = await validateApiKeyViaIdentityVessel(apiKey);
    c.set('jwtAuth', jwtAuth);

    if (jwtAuth) {
      logger.info('API key authenticated via identity-vessel', { orgId: jwtAuth.orgId });
    } else {
      logger.warn('API key validation failed');
    }

    await next();
    return;
  }

  // Check for Bearer prefix (JWT tokens)
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch) {
    logger.debug('Unrecognized auth header format');
    c.set('jwtAuth', null);
    await next();
    return;
  }

  const token = bearerMatch[1];

  // Handle simple base64 token (MiniBob simplified auth)
  if (!token.includes('.')) {
    try {
      const decoded = JSON.parse(Buffer.from(token, 'base64').toString());
      if (decoded.instanceId && decoded.orgId && decoded.expiresAt) {
        if (decoded.expiresAt < Date.now()) {
          logger.warn('MiniBob token expired', { expiresAt: new Date(decoded.expiresAt) });
          c.set('jwtAuth', null);
          await next();
          return;
        }

        const jwtAuth: JwtAuthContext = {
          jwtToken: token,
          orgId: decoded.orgId,
          projectId: decoded.projectId,
          instanceId: decoded.instanceId,
          authType: 'minibob_token',
        };
        c.set('jwtAuth', jwtAuth);
        logger.info('MiniBob simple token authenticated', { orgId: decoded.orgId, instanceId: decoded.instanceId });
        await next();
        return;
      }
    } catch {
      // Not a valid MiniBob token - fall through
    }

    c.set('jwtAuth', null);
    await next();
    return;
  }

  // Validate JWT structure (should have exactly 2 periods)
  const periodCount = (token.match(/\./g) || []).length;
  if (periodCount !== 2) {
    logger.warn('Malformed JWT token structure', { periodCount });
    c.set('jwtAuth', null);
    await next();
    return;
  }

  try {
    logger.info('JWT auth: attempting to validate token', { tokenLength: token.length });
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
      authType: 'jwt',
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
