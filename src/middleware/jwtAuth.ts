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

import { createHash, timingSafeEqual } from 'node:crypto';
import { Context, Next } from 'hono';
import { createAuthenticatedClient } from '../db/surreal';
import { validateApiKeyWithFallback, generateJwtToken } from '../services/auth';
import { logger } from '../utils/logger';
import { getOrFetchValidatedApiKey, isTransientlyUnavailable } from './auth-cache';

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
 * CONNECTED MARKER — evidence for the `connected` readiness level.
 *
 * `connected` means a client configured with the emitted key has actually reached
 * this fleet through a published port. That cannot be judged from inside the
 * container by probing: the only proof is a request that arrives from outside.
 * So authenticated requests whose remote address is not loopback (vessels in the
 * container call each other over 127.0.0.1; a host client arrives through the
 * engine's port forward with a non-loopback source) are recorded in
 * `<install dir>/connected.json`, PER KEY. The container's own interface
 * addresses are deliberately NOT excluded: under rootless Podman's default
 * network a host client arrives from the host's address, which the container
 * shares as its own, so excluding them would hide every real client there.
 * The record:
 *   {
 *     first_at, remote, key_id, auth_type, emitted_key,  <- the emitted key's first
 *                                                           request once one arrives;
 *                                                           until then the first
 *                                                           external request's
 *     pid, process_started_at,
 *     by_key_id: { <key id>: { first_at, remote, key_id, auth_type, emitted_key } }
 *   }
 * The emitted key is the fleet's METABOB_API_KEY, the key substrate-connect hands a
 * client, recognised by comparing the presented key itself. Recording stops once
 * it has been seen; other keys (federated peers calling a hub, browser JWTs) are
 * recorded alongside and never displace it, so whichever key happens to arrive
 * first after a restart cannot hide the emitted key's arrival.
 * `first_at` values are this process's, and the file is replaced by the first
 * write of each process, so a reader can tell a connection observed since the
 * current boot from one left on the volume by an earlier container. Best-effort:
 * it never delays or fails a request, and a failed write is logged and retried on
 * a later request (bounded).
 *
 * The directory is fixed to the workspace volume, not WORKSPACE_ROOT, which the
 * shared env file points at the super-repo checkout.
 */
const PROCESS_STARTED_AT = new Date().toISOString();
const CONNECTED_MAX_FAILURES = 3;
// Distinct non-emitted keys recorded per process; a hub can see many peers.
const CONNECTED_MAX_KEYS = 32;
const connectedKeys = new Set<string>();
let connectedEmittedSeen = false;
let connectedFailures = 0;
let connectedWrite: Promise<void> = Promise.resolve();

export function isLoopbackAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  if (a === '::1' || a === '0:0:0:0:0:0:0:1' || a === 'localhost') return true;
  const v4 = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

function connectedMarkerPath(): string {
  const dir = (process.env['SUBSTRATE_INSTALL_DIR'] || '/workspace/.install').replace(/\/+$/, '');
  return `${dir}/connected.json`;
}

/** Remote address of the request, when the server exposes it (Bun passes itself as `c.env`). */
function remoteAddressOf(c: Context): string | null {
  const server = c.env as { requestIP?: (req: Request) => { address?: string } | null } | undefined;
  if (!server || typeof server.requestIP !== 'function') return null;
  const info = server.requestIP(c.req.raw);
  return info && typeof info.address === 'string' && info.address.length > 0 ? info.address : null;
}

/** True when the presented API key is this fleet's emitted key (METABOB_API_KEY), compared in constant time. */
function isEmittedKey(presented: string | undefined): boolean {
  const emitted = process.env['METABOB_API_KEY'] ?? '';
  if (!presented || !emitted) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(emitted).digest();
  return timingSafeEqual(a, b);
}

type ConnectedEntry = { first_at: string; remote: string; key_id: string | null; auth_type: string | null; emitted_key: boolean };

async function writeConnectedEntry(path: string, keyLabel: string, keyId: string | null, entry: ConnectedEntry): Promise<void> {
  const { mkdir, writeFile, rename, readFile } = await import('node:fs/promises');
  let current: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object') current = parsed as Record<string, unknown>;
  } catch {
    current = null;
  }
  // A record left by an earlier process (or an earlier container on this volume) is replaced.
  const ours = current && current['pid'] === process.pid && current['process_started_at'] === PROCESS_STARTED_AT;
  const byKeyId: Record<string, ConnectedEntry> = ours && current!['by_key_id'] && typeof current!['by_key_id'] === 'object'
    ? { ...(current!['by_key_id'] as Record<string, ConnectedEntry>) }
    : {};
  if (!byKeyId[keyLabel]) byKeyId[keyLabel] = entry;
  // The top-level fields name the emitted key's first request once it has arrived,
  // and until then the first external request of this process.
  const replaceTop = !ours || typeof current!['first_at'] !== 'string' || (entry.emitted_key && current!['emitted_key'] !== true);
  const top = replaceTop
    ? { first_at: entry.first_at, remote: entry.remote, key_id: keyId ?? keyLabel, auth_type: entry.auth_type, emitted_key: entry.emitted_key }
    : {};
  const record = {
    ...(ours ? current! : {}),
    ...top,
    pid: process.pid,
    process_started_at: PROCESS_STARTED_AT,
    by_key_id: byKeyId,
  };
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

function noteAuthenticatedRequest(c: Context, auth: JwtAuthContext, presentedApiKey?: string): void {
  if (connectedEmittedSeen || connectedFailures >= CONNECTED_MAX_FAILURES) return;
  try {
    const remote = remoteAddressOf(c);
    if (!remote || isLoopbackAddress(remote)) return;
    const emitted = isEmittedKey(presentedApiKey);
    const keyLabel = auth.keyId ?? `unidentified:${auth.authType ?? 'unknown'}`;
    if (!emitted && (connectedKeys.has(keyLabel) || connectedKeys.size >= CONNECTED_MAX_KEYS)) return;
    connectedKeys.add(keyLabel);
    if (emitted) connectedEmittedSeen = true;
    const path = connectedMarkerPath();
    const entry: ConnectedEntry = {
      first_at: new Date().toISOString(),
      remote,
      key_id: auth.keyId ?? null,
      auth_type: auth.authType ?? null,
      emitted_key: emitted,
    };
    // Serialised: each write merges into what the previous one left.
    connectedWrite = connectedWrite
      .then(() => writeConnectedEntry(path, keyLabel, auth.keyId ?? null, entry))
      .then(() => {
        logger.info('Connected marker recorded', { path, remote, keyId: auth.keyId ?? null, emittedKey: emitted });
      })
      .catch((error: unknown) => {
        connectedFailures += 1;
        // Forget the key so a later request retries it, until the failure budget is spent.
        connectedKeys.delete(keyLabel);
        if (emitted) connectedEmittedSeen = false;
        logger.warn('Connected marker write failed', {
          path,
          attempt: connectedFailures,
          error: (error as Error)?.message ?? String(error),
        });
      });
  } catch (error) {
    connectedFailures += 1;
    logger.warn('Connected marker check failed', { attempt: connectedFailures, error: (error as Error)?.message ?? String(error) });
  }
}

/** Test hook: reset the per-process state. */
export function _resetConnectedMarkerForTest(): void {
  connectedKeys.clear();
  connectedEmittedSeen = false;
  connectedFailures = 0;
  connectedWrite = Promise.resolve();
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
    logger.debug('API key authenticated', {
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
/**
 * SECURITY — fail closed on a Bearer credential that fails to authenticate.
 * A malformed / expired / unverifiable Bearer token must NOT proceed as an
 * anonymous request on a protected path. activities.ts's list routes query the
 * module-level ROOT client and drop the org predicate when jwtAuth is null
 * (`if (orgId)`), so a bad token becomes a cross-tenant read rather than a 401.
 * The ApiKey branch already fails closed (INVALID_API_KEY return); this extends
 * the same discipline to every Bearer failure branch, while keeping PUBLIC_PATHS
 * (health, /v2/auth, /ws, boredom polling) open.
 */
async function denyBearerUnlessPublic(c: Context, next: Next, reason: string): Promise<Response | void> {
  if (isPublicPath(c.req.path)) {
    c.set('jwtAuth', null);
    return next();
  }
  logger.warn('Bearer authentication failed on protected path', { path: c.req.path, reason });
  return c.json(
    { error: { code: 'INVALID_AUTH', message: reason } },
    401,
  );
}

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
      // A null verdict has TWO generators: identity rejected the key, or identity
      // could not be asked (429/5xx/network). Only the first is a revocation. Saying
      // "revoked" for the second sent the whole fleet chasing a credential that was
      // valid (2026-09-23: identity rate-limited the fleet; every vessel read it as
      // INVALID_API_KEY). Label the transient case as what it is.
      if (isTransientlyUnavailable(apiKey)) {
        logger.warn('API key validation unavailable (transient upstream failure)', { path: c.req.path });
        return c.json(
          { error: { code: 'IDENTITY_UNAVAILABLE', message: 'API key could not be validated: identity-vessel is rate-limiting or unavailable; retry' } },
          503,
        );
      }
      logger.warn('API key validation failed', { path: c.req.path });
      return c.json(
        { error: { code: 'INVALID_API_KEY', message: 'API key is invalid or has been revoked' } },
        401,
      );
    }

    logger.debug('API key authenticated', { orgId: jwtAuth.orgId, authType: jwtAuth.authType });
    noteAuthenticatedRequest(c, jwtAuth, apiKey);
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
          return denyBearerUnlessPublic(c, next, 'MiniBob token expired');
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
        noteAuthenticatedRequest(c, jwtAuth);
        await next();
        return;
      }
    } catch {
      // Not a valid MiniBob token - fall through
    }

    return denyBearerUnlessPublic(c, next, 'Bearer token is not a valid credential');
  }

  // Validate JWT structure (should have exactly 2 periods)
  const periodCount = (token.match(/\./g) || []).length;
  if (periodCount !== 2) {
    logger.warn('Malformed JWT token structure', { periodCount });
    return denyBearerUnlessPublic(c, next, 'Malformed JWT token structure');
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
      return denyBearerUnlessPublic(c, next, 'JWT valid but no auth claims found');
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
    noteAuthenticatedRequest(c, jwtAuth);

  } catch (error) {
    const err = error as Error;
    logger.debug('JWT authentication failed', { error: err.message });
    return denyBearerUnlessPublic(c, next, 'JWT authentication failed');
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
