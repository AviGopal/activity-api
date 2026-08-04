/**
 * JWT Authentication Middleware
 *
 * Supports two authentication header formats:
 * - Authorization: Bearer <jwt>  - JWT tokens (validated against SurrealDB)
 * - Authorization: ApiKey <key>  - API keys (validated via identity-vessel)
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
 * VESSEL PATTERN (2026-04-12):
 * - API key validation is delegated to identity-vessel via impulse pattern
 * - Identity-vessel is the single source of truth for API key operations
 * - If identity-vessel is unavailable, discovery-vessel finds another resolver
 * - NO direct SurrealDB queries for API key validation (violates vessel idiom)
 *
 * Auth Pattern History:
 * - 2026-04-03: Removed apikey_record SurrealDB ACCESS method
 * - 2026-04-06: Added direct SurrealDB fallback (now removed)
 * - 2026-04-12: Migrated to vessel pattern, removed direct fallback
 */

import { Context, Next } from 'hono';
import { createAuthenticatedClient } from '../db/surreal';
import { validateApiKeyWithFallback, generateJwtToken } from '../services/auth';
import { logger } from '../utils/logger';
import { getOrFetchValidatedApiKey } from './auth-cache';

export interface JwtAuthContext {
  jwtToken: string;
  orgId: string;
  /**
   * Phase A: canonical multi-tenant key from `$token.account_id` (JWT) or the
   * `accountId` field in identity-vessel's API-key validation response.
   *
   * Optional during Phase A — only populated when:
   *   * the JWT carries an `account_id` claim, OR
   *   * identity-vessel's `/v1/auth/resolve` payload includes `accountId`
   *     (post identity-vessel-account-id-upgrade, commit 134246a).
   *
   * Phase B handlers should consult this first and fall back to `orgId`
   * when undefined. Phase C PERMISSIONS clauses dual-check
   * (`account_id = $token.account_id OR (account_id IS NONE AND
   * org_id = $auth.org_id)`). When `config.auth.accountIdRequired === true`
   * (Phase D), requests with this field undefined are rejected upstream.
   *
   * See OpenSpec change activity-api-account-id-migration-2026-04-28.
   */
  accountId?: string;
  // For MiniBob instances: single project assignment
  projectId?: string;
  // For API key users: array of accessible projects (from project_members)
  projectIds?: string[];
  instanceId?: string;
  // Track auth type for debugging and metrics
  authType?: 'jwt' | 'apikey' | 'minibob_token';
  // For audit trail - API key ID or user ID
  keyId?: string;
  userId?: string;
  // Role claim from JWT (e.g. 'admin') — used for admin-only destructive ops
  role?: string;
  // Scopes from the token
  scopes?: string[];
}

/**
 * Paths that are publicly accessible without an Authorization header.
 * Exact match or prefix match (string ending with '/') is used.
 *
 * Keep this list minimal — the default posture is reject-by-default.
 * Any path NOT listed here will return 401 when called without auth.
 */
export const PUBLIC_PATHS: string[] = [
  '/health',
  '/v2/auth/', // all auth sub-paths (prefix)
  '/ws',       // WebSocket upgrade path
  '/boredom-tasks', // boredom polling (MiniBob workers)
];

/**
 * Validate API key via identity-vessel (vessel pattern)
 *
 * Sends AuthenticationImpulse to identity-vessel for validation.
 * If identity-vessel is unavailable, uses discovery-vessel to find another resolver.
 *
 * Returns JwtAuthContext on success, null on failure.
 */
/**
 * Cached + dedup'd public entry point.
 *
 * Audit (2026-05-16): every request previously hit identity-vessel directly,
 * tripping its 20 req/min IP rate-limit and cascading to 401s on
 * /v2/impulses/resolve. The cache (Fix A) absorbs steady-state load; the
 * in-flight dedupe (Fix B) absorbs bursts. See `auth-cache.ts` for layering
 * rationale.
 *
 * Public signature is preserved: callers see `Promise<JwtAuthContext | null>`
 * exactly as before. All existing behavior is unchanged on cache miss.
 */
async function validateApiKey(apiKey: string): Promise<JwtAuthContext | null> {
  return getOrFetchValidatedApiKey(apiKey, _validateApiKeyUncached);
}

async function _validateApiKeyUncached(apiKey: string): Promise<JwtAuthContext | null | undefined> {
  try {
    const result = await validateApiKeyWithFallback(apiKey);

    if (!result.authenticated) {
      logger.warn('API key validation failed', {
        reason: result.reason,
        transient: result.transient === true,
      });
      // `undefined` (vs null) tells auth-cache this was a transient upstream
      // failure (429/5xx/network) — cache it only briefly, not for the full
      // negative TTL, so a rate-limit blip can't lock callers out for 30s.
      return result.transient ? undefined : null;
    }

    // Validate that keyId is present for API key auth
    // This is required for audit trails using `api_key:${jwtAuth.keyId}`
    if (!result.keyId) {
      logger.error('API key validation succeeded but keyId is missing', {
        method: result.authMethod || 'unknown',
        orgId: result.orgId,
      });
      return null;
    }

    // Log which method was used
    logger.info('API key authenticated', {
      method: result.authMethod || 'unknown',
      orgId: result.orgId,
      keyId: result.keyId,
    });

    // Generate a real JWT token for downstream use
    // This enables queryWithAuth() to work with RBAC permissions
    const jwtToken = await generateJwtToken({
      orgId: result.orgId!,
      userId: result.userId || 'apikey-user',
      keyId: result.keyId || 'unknown',
      scopes: result.scopes || ['read', 'write'],
      projectIds: result.projectIds || [], // Include project access for PERMISSIONS
      expirySeconds: 900, // 15 minutes
    });

    // Do NOT reject the request when generateJwtToken returns null. The API
    // key has already been validated by identity-vessel, so the caller IS
    // authenticated — they just can't get a SurrealDB-issued JWT (typically
    // because JWT_SECRET is misaligned between this process and the ACCESS
    // schema, see CLAUDE.md §"JWT Secret"). Returning null here would make
    // the downstream `requireAuthenticated()` gate reject every API-key
    // POST /v2/impulses/resolve as 401 — even read-only resolves work fine via
    // the executeAsAuth root-credentials fallback when authType==='apikey' and
    // an empty jwtToken is propagated.
    //
    // Falling through with `jwtToken: ''` makes the per-route gate fire as
    // intended (it accepts any JwtAuthContext, regardless of jwtToken). Per-
    // case destructive resolvers (`*_write`, `*_update`, `*_delete`,
    // `*_deprecate`, `templateAuditReport`) still gate writes properly via
    // `requireAuthenticated()` — and SurrealDB PERMISSIONS layer enforces
    // org_id scoping inside `executeAsAuth` (root-creds path adds explicit
    // `org_id = $orgId` predicates per resolver case).
    //
    // This is defense-in-depth against JWT_SECRET drift: even when ACCESS-bound
    // queries are unavailable, valid API-key holders can still hit read-side
    // resolves through the root-creds fallback path.
    if (!jwtToken) {
      logger.warn('JWT generation failed for API key — falling through with empty jwtToken', {
        orgId: result.orgId,
        keyId: result.keyId,
      });
    }

    return {
      jwtToken: jwtToken || '',
      orgId: result.orgId!,
      // Phase A: pass through if identity-vessel emitted it. Older identity-vessel
      // deployments leave this undefined — Phase B handlers fall back to orgId.
      accountId: result.accountId,
      keyId: result.keyId,
      userId: result.userId,
      authType: 'apikey',
      scopes: result.scopes || ['read', 'write'],
    };
  } catch (error) {
    const err = error as Error;
    logger.error('API key validation error', { error: err.message });
    // A thrown error is a transient infrastructure failure, not proof the
    // key is invalid — signal short negative caching.
    return undefined;
  }
}

/**
 * Returns true if the given path is in the PUBLIC_PATHS allowlist.
 * Exact match or prefix match (path starts with a listed prefix that ends in '/').
 */
function isPublicPath(path: string): boolean {
  for (const allowed of PUBLIC_PATHS) {
    if (allowed.endsWith('/')) {
      if (path.startsWith(allowed) || path === allowed.slice(0, -1)) return true;
    } else {
      if (path === allowed) return true;
    }
  }
  return false;
}

/**
 * JWT authentication middleware
 *
 * Extracts token from Authorization header and validates based on header prefix:
 * - Bearer: JWT token validated against SurrealDB
 * - ApiKey: API key validated via identity-vessel HMAC
 *
 * Reject-by-default: if no Authorization header is present and the path is not
 * in PUBLIC_PATHS, returns 401. Route handlers should keep their existing
 * requireAuthenticated() calls as defense-in-depth.
 */
export async function jwtAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  logger.debug('Auth middleware called', {
    path: c.req.path,
    hasAuthHeader: !!authHeader,
    authHeaderPrefix: authHeader ? authHeader.substring(0, 20) + '...' : 'none'
  });

  if (!authHeader) {
    if (isPublicPath(c.req.path)) {
      c.set('jwtAuth', null);
      await next();
      return;
    }
    // X-Internal-Api-Key is an alternative auth scheme used for
    // vessel-to-vessel impulse storage (POST /v2/impulses, GET
    // /v2/impulses/:id, GET /v2/impulses). The route handlers validate it
    // themselves and 401 on miss. Without this passthrough, the middleware
    // 401s before the handler ever runs — and minibob's pending-sync queue
    // grows indefinitely while logs spam "Context is not finalized" 500s
    // (the missing-return on the wrapper at index.ts compounded the bug).
    // SCOPED to the paths the fleet actually calls with this header. An unscoped
    // passthrough let ANY request carrying ANY value reach EVERY /v2/* handler with
    // jwtAuth=null - including activities.ts's 57 unguarded list routes. The header
    // is only presence-checked, never compared to a secret (`grep -c INTERNAL
    // /etc/substrate/env` = 0), so its safe blast radius is only where a handler
    // re-checks it or where the fleet genuinely depends on it:
    //   /v2/impulses                    - impulses.ts:350/627/734 each 401 on miss
    //   /v2/events/publish              - development-vessel substrate-gap.ts:454
    //   /v2/activities/execution-traces - identity-vessel trace.ts:54
    // The last two were found by grepping the OTHER vessels, not this repo: scoping
    // to /v2/impulses alone typechecked, left the suite at 962/192 unchanged, and
    // would still have silently 401'd gap-write events and auth traces fleet-wide.
    const INTERNAL_KEY_PATHS = ['/v2/impulses', '/v2/events/publish', '/v2/activities/execution-traces'];
    const internalApiKey = c.req.header('X-Internal-Api-Key');
    if (internalApiKey && INTERNAL_KEY_PATHS.some((prefix) => c.req.path.startsWith(prefix))) {
      c.set('jwtAuth', null);
      await next();
      return;
    }
    logger.warn('Missing Authorization header on protected path', { path: c.req.path });
    return c.json(
      { error: { code: 'MISSING_AUTH', message: 'Authorization header required' } },
      401,
    );
  }

  // Check for ApiKey prefix first (API keys validated via identity-vessel impulse pattern)
  const apiKeyMatch = authHeader.match(/^ApiKey\s+(.+)$/i);
  if (apiKeyMatch) {
    const apiKey = apiKeyMatch[1];
    logger.debug('Processing ApiKey auth header');

    const jwtAuth = await validateApiKey(apiKey);
    c.set('jwtAuth', jwtAuth);

    // FAIL CLOSED. This previously fell through to next() with jwtAuth=null, so a
    // revoked or forged key still reached the handlers. That is only survivable if
    // every handler re-checks, and they do not: `requireAuthenticated` appears 25
    // times in impulses.ts and ZERO times across activities.ts's 57 routes, which
    // query through the module-level ROOT surreal client. There the tenant
    // predicate sits inside `if (orgId)`, so a null org context does not narrow the
    // query - it REMOVES the filter. Falling through without an identity is
    // therefore not an unauthenticated read, it is a cross-tenant read.
    if (!jwtAuth) {
      logger.warn('API key validation failed', { path: c.req.path });
      return c.json(
        { error: { code: 'INVALID_API_KEY', message: 'API key is invalid or has been revoked' } },
        401,
      );
    }

    logger.info('API key authenticated', { orgId: jwtAuth.orgId, authType: jwtAuth.authType });
    await next();
    return;
  }

  // Check for Bearer prefix (JWT tokens)
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch) {
    // A header that is neither `ApiKey ...` nor `Bearer ...` is a malformed
    // credential, not an anonymous request: presenting one and being admitted with
    // jwtAuth=null was the cheapest of the three fall-throughs to exploit. Public
    // paths stay open so health and bootstrap probes are unaffected.
    logger.debug('Unrecognized auth header format', { path: c.req.path });
    if (isPublicPath(c.req.path)) {
      c.set('jwtAuth', null);
      await next();
      return;
    }
    return c.json(
      { error: { code: 'MALFORMED_AUTH', message: 'Authorization must be "ApiKey <key>" or "Bearer <token>"' } },
      401,
    );
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
          // Phase A: minibob simple-token may not yet carry accountId.
          // When present (post-MiniBob upgrade), pass it through; otherwise
          // leave undefined so Phase B handlers fall back to orgId.
          accountId: typeof (decoded as { accountId?: unknown }).accountId === 'string'
            ? (decoded as { accountId: string }).accountId
            : undefined,
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
    // Phase A: also pull $token.account_id (JWT claim, separate from $auth row).
    // SurrealDB binds JWT claims to $token; the access method may or may not
    // populate $auth.account_id depending on the access definition. Reading
    // both lets Phase B handlers consult $token.account_id directly via the
    // returned context without re-querying.
    // Read tenant claims from $token (JWT claims) AND $auth (SurrealDB
    // auth record), preferring $token. The apikey_token ACCESS schema
    // has no AUTHENTICATE clause that loads a record into $auth, so for
    // JWTs minted by identity-vessel `$auth` is NONE and only $token
    // carries the claims (org_id, user_id, role, project_ids). For
    // JWTs that DO populate $auth (legacy session-bound flows), $auth
    // wins because it can carry more recent revocation/role state.
    const result = await db.query<[{
      id: string;
      org_id?: string;
      account_id?: string;
      user_id?: string;
      scopes?: string[];
      project_ids?: string[];
      project_id?: string;
      instance_id?: string;
      role?: string;
    }]>(`RETURN {
      id: $auth.id ?? $token.id,
      org_id: $auth.org_id ?? $token.org_id,
      account_id: $auth.account_id ?? $token.account_id,
      user_id: $auth.user_id ?? $token.user_id,
      scopes: $auth.scopes ?? $token.scopes,
      project_ids: $auth.project_ids ?? $token.project_ids,
      project_id: $auth.project_id ?? $token.project_id,
      instance_id: $auth.instance_id ?? $token.instance_id,
      role: $auth.role ?? $token.role
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
    // The 'id' claim contains the keyId for API key-generated JWTs
    const jwtAuth: JwtAuthContext = {
      jwtToken: token,
      orgId: String(auth.org_id || '').replace(/^organizations:/, ''),
      // Phase A: account_id is optional during the rollout. Strip the
      // record-id prefix if present (e.g. "accounts:abc" -> "abc"); leave
      // undefined when the JWT claim is missing so Phase B handlers can
      // fall back to org_id.
      accountId: auth.account_id
        ? String(auth.account_id).replace(/^accounts:/, '')
        : undefined,
      // MiniBob instances: singular project assignment
      projectId: auth.project_id ? String(auth.project_id).replace(/^projects:/, '') : undefined,
      // API key users: array of accessible projects from project_members
      projectIds: Array.isArray(auth.project_ids)
        ? auth.project_ids.map((p: unknown) => String(p).replace(/^projects:/, ''))
        : undefined,
      instanceId: auth.instance_id,
      // For API key-generated JWTs, 'id' contains the keyId
      keyId: auth.id ? String(auth.id) : undefined,
      // Extract user_id if present
      userId: auth.user_id ? String(auth.user_id).replace(/^users:/, '') : undefined,
      authType: 'jwt',
      // Role and scopes from JWT claims (used for admin-only operations)
      role: auth.role ? String(auth.role) : undefined,
      scopes: Array.isArray(auth.scopes) ? auth.scopes.map(String) : undefined,
    };

    logger.debug('JWT authentication successful', {
      orgId: jwtAuth.orgId,
      hasAccountId: jwtAuth.accountId !== undefined,
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

// ---------------------------------------------------------------------------
// Phase 11: ExecutionScope — multi-account access context
// ---------------------------------------------------------------------------

/**
 * Derived view of the caller's access context.
 *
 * `accessible_account_ids` is the union of:
 *  - The primary account_id (from the JWT or orgId fallback)
 *  - Any additional accounts reachable via `account_<id>:` scope prefixes
 *
 * Used by buildPointerStateSpace (G2-blocked stub) to scope cross-vessel
 * shape discovery to the accounts the caller can see.
 */
export interface ExecutionScope {
  primary_account_id: string;
  accessible_account_ids: string[];
  scopes: string[];
  grants: Map<string, string[]>;
}

export function parseExecutionScope(jwtAuth: JwtAuthContext): ExecutionScope {
  const account_id = jwtAuth.accountId ?? jwtAuth.orgId ?? 'unknown';
  const scopes = jwtAuth.scopes ?? [];
  const accountPrefixRe = /^account_([^:]+):/;
  const grants = new Map<string, string[]>();
  for (const scope of scopes) {
    const m = scope.match(accountPrefixRe);
    if (m) {
      const acct = m[1];
      if (!grants.has(acct)) grants.set(acct, []);
      grants.get(acct)!.push(scope);
    }
  }
  const accessible_account_ids = [account_id, ...grants.keys()].filter(
    (v, i, a) => a.indexOf(v) === i
  );
  return { primary_account_id: account_id, accessible_account_ids, scopes, grants };
}

/**
 * Lazily derive an ExecutionScope from the jwtAuth already set on the Hono
 * context.  Returns null when the request is unauthenticated (public path).
 */
export function getExecutionScopeFromContext(c: Context): ExecutionScope | null {
  const jwtAuth = getJwtAuthFromContext(c);
  if (!jwtAuth) return null;
  return parseExecutionScope(jwtAuth);
}

/**
 * Check if request has valid JWT authentication
 */
export function hasJwtAuth(c: Context): boolean {
  const jwtAuth = getJwtAuthFromContext(c);
  return jwtAuth !== null && jwtAuth.jwtToken !== undefined;
}
