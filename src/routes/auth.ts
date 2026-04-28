/**
 * Authentication Routes — DEPRECATED (Phase B3b dead-code cleanup, 2026-04-28)
 *
 * Dashboard auth (POST /login, GET /me) used to query phantom tables (`users`,
 * `org_members`) — neither table is defined in any migration or schema file.
 * The /login query path could never succeed; /me read `$auth` claims and then
 * issued a `type::table($user_id)` lookup against the same missing schema.
 *
 * Identity-vessel (https://identity.metabob.com) now owns user authentication
 * and JWT issuance. Dashboard clients should call identity-vessel directly.
 * The mounts here are kept so legacy callers receive a clear 410 Gone with a
 * migration pointer instead of an opaque 500.
 *
 * /minibob/signin was already 410 since 2026-04-08 and remains 410.
 */

import { Hono } from 'hono'
import { logger } from '../utils/logger'
import type { JwtAuthContext } from '../middleware/jwtAuth'

// Define app-wide environment type (preserved for compatibility with index.ts)
type AppEnv = {
  Variables: {
    jwtAuth: JwtAuthContext | null;
  };
};

const auth = new Hono<AppEnv>()

const IDENTITY_VESSEL_URL = 'https://identity.metabob.com'

/**
 * POST /v2/auth/login — 410 Gone (was: dashboard email/password login)
 * Backing tables `users` + `org_members` never existed in this codebase.
 */
auth.post('/login', (c) => {
  logger.warn('[auth] Deprecated endpoint called', { endpoint: '/v2/auth/login' })
  return c.json({
    error: {
      code: 'ENDPOINT_DEPRECATED',
      message: 'Dashboard login moved to identity-vessel',
      details: {
        deprecated_since: '2026-04-28',
        replacement: `${IDENTITY_VESSEL_URL}/v1/auth/login`,
      },
    },
  }, 410)
})

/**
 * GET /v2/auth/me — 410 Gone (was: return current authenticated user)
 * Backing `users` table never existed; relied on phantom `type::table($user_id)` lookup.
 */
auth.get('/me', (c) => {
  logger.warn('[auth] Deprecated endpoint called', { endpoint: '/v2/auth/me' })
  return c.json({
    error: {
      code: 'ENDPOINT_DEPRECATED',
      message: 'User profile endpoint moved to identity-vessel',
      details: {
        deprecated_since: '2026-04-28',
        replacement: `${IDENTITY_VESSEL_URL}/v1/auth/me`,
      },
    },
  }, 410)
})

/**
 * POST /v2/auth/minibob/signin
 *
 * Returns 410 Gone. This endpoint was removed on 2026-04-08.
 * MiniBob instances now use API key authentication.
 */
auth.post('/minibob/signin', (c) => {
  logger.warn('[auth] Deprecated endpoint called', {
    endpoint: '/v2/auth/minibob/signin',
    ip: c.req.header('x-forwarded-for') || 'unknown'
  })

  return c.json({
    error: {
      code: 'ENDPOINT_DEPRECATED',
      message: 'MiniBob instance authentication has been deprecated',
      details: {
        deprecated_since: '2026-04-08',
        removal_date: '2026-04-08',
        old_method: 'POST /v2/auth/minibob/signin with instance_id + api_key',
        new_method: 'Use API key authentication with Authorization: ApiKey <key> header',
        migration_guide: 'All endpoints now accept API key authentication directly. No signin required.',
        example: 'curl -H "Authorization: ApiKey <your-key>" https://activity.metabob.com/v2/activities/templates'
      },
      documentation: 'See README.md Authentication section for details'
    }
  }, 410)
})

export default auth
