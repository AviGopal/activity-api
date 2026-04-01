/**
 * Authentication Routes
 *
 * Handles MiniBob instance authentication via SurrealDB RECORD access.
 * Returns JWT tokens with org_id populated for RBAC enforcement.
 *
 * User/API key authentication is delegated to identity-vessel.
 *
 * Rate limited to prevent brute force attacks:
 * - /minibob/signin: 5 requests/minute
 */

import { Hono } from 'hono'
import { surrealDB } from '../db/surreal'
import { authRateLimiter, signinRateLimiter } from '../middleware/rateLimiter'

const auth = new Hono()

// Apply rate limiting to all auth routes
auth.use('/*', authRateLimiter)

// Stricter rate limiting for signin endpoint
auth.use('/minibob/signin', signinRateLimiter)

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

    // Query $auth to get org_id and project_id from the authenticated session
    // After RECORD signin, $auth contains the minibob_instance record
    const authQuery = await db.query<[{
      org_id: string;
      project_id?: string;
    }]>(
      `RETURN {
        org_id: $auth.org_id,
        project_id: $auth.project_id
      }`
    )

    const instance = authQuery[0]
    if (!instance || !instance.org_id) {
      return c.json({
        error: 'Instance authenticated but session details not found',
        message: 'Authentication succeeded but $auth not populated'
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



export default auth
