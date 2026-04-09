/**
 * Authentication Routes
 *
 * TEMPORARY DASHBOARD AUTH (2026-04-07):
 * Added /login endpoint for cloud dashboard until identity-vessel is deployed.
 * This provides password-based authentication for dashboard users.
 *
 * MiniBob instances should authenticate via:
 *   POST https://identity.metabob.local/v1/auth/minibob/signin
 *
 * JWT validation is handled by:
 * - src/middleware/jwtAuth.ts (HTTP requests)
 * - src/services/auth.ts validateJwtToken() (WebSocket)
 */

import { Hono } from 'hono'
import { surrealDB } from '../db/surreal'
import { generateJwtToken } from '../services/auth'
import { logger } from '../utils/logger'

const auth = new Hono()

/**
 * POST /v2/auth/login
 * Dashboard user login with email/password
 */
auth.post('/login', async (c) => {
  try {
    const { email, password } = await c.req.json()

    if (!email || !password) {
      return c.json({
        error: { message: 'Email and password are required' }
      }, 400)
    }

    // Find user by email
    const users = await surrealDB.query<{
      id: string
      email: string
      name: string
      password_hash: string
      is_active: boolean
      email_verified: boolean
    }>(
      `SELECT id, email, name, password_hash, is_active, email_verified
       FROM users
       WHERE email = $email
       LIMIT 1`,
      { email }
    )

    if (!users || users.length === 0) {
      logger.warn('[auth] Login failed - user not found', { email })
      return c.json({
        error: { message: 'Invalid credentials' }
      }, 401)
    }

    const user = users[0]

    // Check if user is active
    if (!user.is_active) {
      logger.warn('[auth] Login failed - user inactive', { email })
      return c.json({
        error: { message: 'Account is inactive' }
      }, 401)
    }

    // Verify password using SurrealDB's Argon2 verification
    const verifyResult = await surrealDB.query<boolean>(
      `RETURN crypto::argon2::compare($password_hash, $password)`,
      { password_hash: user.password_hash, password }
    )

    const passwordValid = verifyResult[0]

    if (!passwordValid) {
      logger.warn('[auth] Login failed - invalid password', { email })
      return c.json({
        error: { message: 'Invalid credentials' }
      }, 401)
    }

    // Get user's org_id from org_members
    const memberships = await surrealDB.query<{
      org_id: string
      role: string
    }>(
      `SELECT org_id, role
       FROM org_members
       WHERE user_id = $user_id
       LIMIT 1`,
      { user_id: user.id }
    )

    if (!memberships || memberships.length === 0) {
      logger.warn('[auth] Login failed - no org membership', { email, userId: user.id })
      return c.json({
        error: { message: 'User has no organization' }
      }, 401)
    }

    const membership = memberships[0]
    const orgId = String(membership.org_id).replace(/^organizations:/, '')

    // Generate JWT token (15 minute expiry)
    const token = await generateJwtToken({
      orgId,
      userId: String(user.id).replace(/^users:/, ''),
      keyId: String(user.id),
      scopes: ['read', 'write'],
      expirySeconds: 900,
    })

    if (!token) {
      logger.error('[auth] Failed to generate JWT token', { email })
      return c.json({
        error: { message: 'Failed to generate token' }
      }, 500)
    }

    logger.info('[auth] User logged in successfully', {
      email,
      userId: user.id,
      orgId: membership.org_id
    })

    return c.json({
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          org_id: membership.org_id,
          role: membership.role
        }
      }
    })

  } catch (error) {
    logger.error('[auth] Login error', {
      error: error instanceof Error ? error.message : String(error)
    })
    return c.json({
      error: { message: 'Login failed' }
    }, 500)
  }
})

/**
 * GET /v2/auth/me
 * Get current authenticated user
 */
auth.get('/me', async (c) => {
  const jwtAuth = c.get('jwtAuth')

  if (!jwtAuth) {
    return c.json({
      error: { message: 'Not authenticated' }
    }, 401)
  }

  try {
    // Extract user ID from JWT (format: users:xyz)
    const result = await surrealDB.query<{
      id: string
      email: string
      name: string
      is_active: boolean
    }>(
      `RETURN {
        id: $auth.id,
        user_id: $auth.user_id
      }`,
      {},
      jwtAuth.jwtToken
    )

    const auth = result[0]
    if (!auth) {
      return c.json({
        error: { message: 'User not found' }
      }, 404)
    }

    // Get user details
    const userId = auth.user_id || auth.id
    const users = await surrealDB.query<{
      id: string
      email: string
      name: string
      is_active: boolean
    }>(
      `SELECT id, email, name, is_active FROM type::table($user_id)`,
      { user_id: userId }
    )

    if (!users || users.length === 0) {
      return c.json({
        error: { message: 'User not found' }
      }, 404)
    }

    return c.json({
      data: users[0]
    })

  } catch (error) {
    logger.error('[auth] Failed to get current user', {
      error: error instanceof Error ? error.message : String(error)
    })
    return c.json({
      error: { message: 'Failed to get user' }
    }, 500)
    }
})

/**
 * POST /v2/auth/minibob/signin - DEPRECATED
 *
 * This endpoint was removed on 2026-04-08.
 * MiniBob instances now use API key authentication.
 */
auth.post('/minibob/signin', async (c) => {
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
