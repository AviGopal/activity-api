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
import { authenticateMiniBob } from '../services/auth'
import { logger } from '../utils/logger'

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

    // Use centralized authentication service
    const result = await authenticateMiniBob(instance_id, api_key)

    if (!result.authenticated || !result.orgId) {
      logger.warn('[auth] MiniBob authentication failed', {
        instanceId: instance_id,
        reason: result.reason,
      })
      return c.json({
        error: 'Authentication failed',
        message: result.reason || 'Invalid instance_id or api_key'
      }, 401)
    }

    // Get JWT token from SurrealDB after successful RECORD access
    const db = await surrealDB.getInstance()
    const authResult = await db.signin({
      access: 'minibob_record',
      variables: {
        instance_id,
        api_key,
      },
    })

    if (!authResult) {
      logger.error('[auth] Failed to get JWT token after authentication')
      return c.json({
        error: 'Internal server error',
        message: 'Failed to generate authentication token'
      }, 500)
    }

    // Extract JWT string from SDK v2 response format
    const jwtToken = typeof authResult === 'string'
      ? authResult
      : (authResult as { access: string }).access

    logger.info('[auth] MiniBob signed in successfully', {
      instanceId: instance_id,
      orgId: result.orgId,
    })

    return c.json({
      token: jwtToken,
      org_id: result.orgId,
    })

  } catch (error) {
    logger.error('[auth] MiniBob signin error', {
      error: error instanceof Error ? error.message : String(error),
    })

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
      details: process.env.NODE_ENV === 'development' ? errorMessage : undefined
    }, 500)
  }
})



export default auth
