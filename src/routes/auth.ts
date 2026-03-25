/**
 * Authentication Routes
 *
 * Handles MiniBob instance authentication via SurrealDB RECORD access.
 * Returns JWT tokens with org_id populated for RBAC enforcement.
 *
 * Rate limited to prevent brute force attacks:
 * - /apikey: 10 requests/minute
 * - /minibob/signin: 5 requests/minute
 */

import { Hono } from 'hono'
import { Surreal } from 'surrealdb'
import { surrealDB } from '../db/surreal'
import { config } from '../config'
import { authRateLimiter, signinRateLimiter } from '../middleware/rateLimiter'

const auth = new Hono()

// Apply rate limiting to all auth routes
auth.use('/*', authRateLimiter)

// Stricter rate limiting for signin endpoints
auth.use('/minibob/signin', signinRateLimiter)
auth.use('/apikey', signinRateLimiter)

/**
 * POST /v2/auth/minibob/signin
 *
 * Authenticate MiniBob instance using RECORD access.
 *
 * Request body:
 * {
 *   instance_id: string   // MiniBob instance ID (from minibob_instance table)
 *   api_key: string       // Plain text API key (will be verified against argon2 hash)
 * }
 *
 * Response:
 * {
 *   token: string         // JWT token with $auth.org_id populated
 *   org_id: string        // Organization ID from instance
 *   project_id?: string   // Project ID if instance is project-scoped
 * }
 *
 * Error codes:
 * - 400: Missing required fields
 * - 401: Invalid credentials
 * - 500: Database error
 */
auth.post('/minibob/signin', async (c) => {
  try {
    const { instance_id, api_key } = await c.req.json()

    if (!instance_id || !api_key) {
      return c.json({
        error: 'Missing required fields',
        message: 'Both instance_id and api_key are required'
      }, 400)
    }

    const db = await surrealDB.getInstance()

    // Authenticate using RECORD access
    // This will verify the API key hash and return a JWT token
    // SurrealDB SDK v2 returns { access: "JWT..." } object
    const authResult = await db.signin({
      access: 'minibob_record',
      variables: {
        instance_id,
        api_key,
      },
    })

    if (!authResult) {
      return c.json({
        error: 'Authentication failed',
        message: 'Invalid instance_id or api_key'
      }, 401)
    }

    // Extract JWT string from SDK v2 response format
    const jwtToken = typeof authResult === 'string'
      ? authResult
      : (authResult as { access: string }).access

    // Query the instance to get org_id and project_id for response
    // (The JWT token already has these in $auth, but we return them for client convenience)
    const instanceResult = await db.query<[{ org_id: string; project_id?: string }[]]>(
      `SELECT org_id, project_id FROM minibob_instance WHERE instance_id = $instance_id LIMIT 1`,
      { instance_id }
    )

    const instance = instanceResult[0]?.[0]
    if (!instance) {
      return c.json({
        error: 'Instance not found after authentication',
        message: 'This should not happen - instance authenticated but not found'
      }, 500)
    }

    return c.json({
      token: jwtToken,
      org_id: instance.org_id.toString().replace('organizations:', ''),
      project_id: instance.project_id ? instance.project_id.toString().replace('projects:', '') : undefined,
    })

  } catch (error) {
    console.error('[auth] MiniBob signin error:', error)

    // SurrealDB returns specific error messages for auth failures
    const errorMessage = error instanceof Error ? error.message : String(error)

    if (errorMessage.includes('No access method found') ||
        errorMessage.includes('Signin failed') ||
        errorMessage.includes('Invalid credentials')) {
      return c.json({
        error: 'Authentication failed',
        message: 'Invalid instance_id or api_key'
      }, 401)
    }

    return c.json({
      error: 'Internal server error',
      message: 'Failed to authenticate MiniBob instance',
      details: errorMessage
    }, 500)
  }
})

/**
 * POST /v2/auth/apikey
 *
 * Authenticate user via API key. Returns JWT token for RBAC enforcement.
 * API keys are org-scoped and user-scoped - no additional context needed.
 *
 * Request body:
 * {
 *   api_key: string   // Format: mb_<type>_<random> (e.g., mb_live_xxx, mb_test_xxx)
 * }
 *
 * Response:
 * {
 *   token: string         // JWT token with org_id, user_id, role
 *   expires_at: string    // ISO timestamp when token expires
 *   expires_in: number    // Seconds until expiry (900 = 15 min)
 *   org_id: string        // Organization ID
 *   user_id: string       // User ID
 *   scopes: string[]      // API key scopes (e.g., ["read", "write"])
 * }
 */
auth.post('/apikey', async (c) => {
  try {
    const { api_key } = await c.req.json()

    if (!api_key) {
      return c.json({
        error: 'invalid_request',
        message: 'api_key is required'
      }, 400)
    }

    // Validate API key format (optional but helps catch obvious errors)
    if (!api_key.startsWith('mb_')) {
      return c.json({
        error: 'invalid_api_key',
        message: 'API key must start with mb_ prefix'
      }, 400)
    }

    // Create a DEDICATED connection for auth flow
    // IMPORTANT: Don't use shared surrealDB.getInstance() - it causes race conditions
    // where another request resets the auth context before we can query $auth
    const db = new Surreal()
    await db.connect(config.surrealdb.url)
    await db.use({
      namespace: config.surrealdb.namespace,
      database: config.surrealdb.database,
    })

    try {
      // Authenticate using RECORD access for API keys
      // This verifies the key hash and returns JWT
      // SurrealDB SDK v2 returns { access: "JWT..." } object
      const authResult = await db.signin({
        access: 'apikey_record',
        variables: {
          api_key,
        },
      })

      if (!authResult) {
        return c.json({
          error: 'invalid_api_key',
          message: 'API key is invalid, expired, or revoked'
        }, 401)
      }

      // Extract JWT string from SDK v2 response format
      const jwtToken = typeof authResult === 'string'
        ? authResult
        : (authResult as { access: string }).access

      // Query $auth to get API key details from the authenticated session
      // This is more reliable than re-querying api_keys (avoids RBAC issues)
      const authQuery = await db.query<[{
        id: string
        org_id: string
        user_id: string
        scopes: string[]
        project_ids: string[]
      }]>(
        `RETURN {
          id: $auth.id,
          org_id: $auth.org_id,
          user_id: $auth.user_id,
          scopes: $auth.scopes,
          project_ids: $auth.project_ids
        }`
      )

    const keyInfo = authQuery[0]
    if (!keyInfo || !keyInfo.org_id) {
      console.error('[auth] API key authenticated but $auth fields not populated')
      await db.close()
      return c.json({
        error: 'internal_error',
        message: 'API key authenticated but session details not found'
      }, 500)
    }

    // Update last_used_at using root connection (fire and forget)
    surrealDB.query(
      `UPDATE $key_id SET last_used_at = time::now()`,
      { key_id: keyInfo.id }
    ).catch(err => {
      console.warn('[auth] Failed to update last_used_at:', err)
    })

    // Calculate expiry (15 minutes from now as per apikey_record DURATION)
    const expiresIn = 900 // 15 minutes in seconds
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

    // Close the dedicated connection before returning
    await db.close()

    return c.json({
      token: jwtToken,
      expires_at: expiresAt,
      expires_in: expiresIn,
      org_id: keyInfo.org_id.toString().replace('organizations:', ''),
      user_id: keyInfo.user_id.toString().replace('users:', ''),
      scopes: keyInfo.scopes || [],
      project_ids: (keyInfo.project_ids || []).map((p: string) => p.toString().replace('projects:', '')),
    })
    } finally {
      // Ensure connection is closed even on error
      try { await db.close() } catch {}
    }

  } catch (error) {
    console.error('[auth] API key auth error:', error)

    const errorMessage = error instanceof Error ? error.message : String(error)

    // SurrealDB auth error messages
    if (errorMessage.includes('No access method found') ||
        errorMessage.includes('Signin failed') ||
        errorMessage.includes('Invalid credentials') ||
        errorMessage.includes('No record found')) {
      return c.json({
        error: 'invalid_api_key',
        message: 'API key is invalid, expired, or revoked'
      }, 401)
    }

    return c.json({
      error: 'internal_error',
      message: 'Authentication failed',
      details: process.env.NODE_ENV === 'development' ? errorMessage : undefined
    }, 500)
  }
})

/**
 * POST /v2/auth/minibob/verify
 *
 * Verify a MiniBob JWT token and extract claims.
 *
 * Request body:
 * {
 *   token: string   // JWT token from signin
 * }
 *
 * Response:
 * {
 *   valid: boolean
 *   org_id?: string
 *   project_id?: string
 *   instance_id?: string
 * }
 */
auth.post('/minibob/verify', async (c) => {
  try {
    const { token } = await c.req.json()

    if (!token) {
      return c.json({ valid: false, error: 'No token provided' }, 400)
    }

    const db = await surrealDB.getInstance()

    // Authenticate with the token - if valid, SurrealDB will set session
    await db.authenticate(token)

    // Query the authenticated session info
    // $auth is populated by SurrealDB from the JWT token
    const result = await db.query<[{ id: string; org_id: string; project_id?: string; instance_id: string }[]]>(
      `SELECT * FROM $auth`
    )

    const auth = result[0]?.[0]
    if (!auth) {
      return c.json({ valid: false, error: 'Token valid but no auth info found' }, 500)
    }

    return c.json({
      valid: true,
      org_id: auth.org_id.toString().replace('organizations:', ''),
      project_id: auth.project_id ? auth.project_id.toString().replace('projects:', '') : undefined,
      instance_id: auth.instance_id,
    })

  } catch (error) {
    console.error('[auth] Token verification error:', error)
    return c.json({ valid: false, error: 'Invalid or expired token' }, 401)
  }
})

export default auth
