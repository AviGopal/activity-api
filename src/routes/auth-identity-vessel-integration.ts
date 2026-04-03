/**
 * Identity Vessel Integration for API Key Authentication
 *
 * API key authentication is now handled exclusively by identity-vessel:
 * - Uses HMAC-based key validation (fast, stateless)
 * - No SurrealDB fallback (apikey_record ACCESS removed 2026-04-03)
 *
 * For API key validation, use the Authorization header:
 *   Authorization: ApiKey <key>
 *
 * The jwtAuth middleware handles validation via identity-vessel automatically.
 */

import { Hono } from 'hono'
import { signinRateLimiter } from '../middleware/rateLimiter'
import {
  validateApiKeyViaIdentityVessel,
  generateJwtToken
} from '../services/auth'
import { logger } from '../utils/logger'

const auth = new Hono()

// Apply rate limiting
auth.use('/apikey', signinRateLimiter)

// =============================================================================
// ENDPOINT: POST /v2/auth/apikey (Identity Vessel Only)
// =============================================================================

/**
 * POST /v2/auth/apikey
 *
 * Authenticate user via API key using identity-vessel HMAC validation.
 *
 * NOTE (2026-04-03): SurrealDB apikey_record fallback has been removed.
 * All API keys must be validated via identity-vessel HMAC pattern.
 *
 * Request body:
 * {
 *   api_key: string   // Format: mb_{env}_{org}_{keyId}_{hmac}
 * }
 *
 * Response:
 * {
 *   token: string         // JWT token with org_id, user_id, scopes
 *   expires_at: string    // ISO timestamp when token expires
 *   expires_in: number    // Seconds until expiry (900 = 15 min)
 *   org_id: string        // Organization ID
 *   user_id: string       // User ID
 *   scopes: string[]      // API key scopes
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
    if (!api_key.startsWith('mb_') && !api_key.match(/^[A-Za-z0-9_-]+$/)) {
      return c.json({
        error: 'invalid_api_key',
        message: 'API key format is invalid'
      }, 400)
    }

    // Validate API key via identity-vessel HMAC pattern
    const validation = await validateApiKeyViaIdentityVessel(api_key)

    if (!validation.authenticated || !validation.orgId || !validation.userId) {
      return c.json({
        error: 'invalid_api_key',
        message: validation.reason || 'API key is invalid, expired, or revoked'
      }, 401)
    }

    logger.info('[auth] API key validated via identity-vessel', {
      userId: validation.userId,
    })

    // Generate JWT token with validated auth context
    const token = await generateJwtToken({
      orgId: validation.orgId,
      userId: validation.userId,
      keyId: validation.keyId || 'unknown',
      scopes: validation.scopes || ['read', 'write'],
      expirySeconds: 900,
    })

    if (!token) {
      logger.error('[auth] Failed to generate JWT token')
      return c.json({
        error: 'internal_error',
        message: 'Failed to generate authentication token'
      }, 500)
    }

    // Calculate expiry (15 minutes)
    const expiresIn = 900
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

    return c.json({
      token,
      expires_at: expiresAt,
      expires_in: expiresIn,
      org_id: validation.orgId,
      user_id: validation.userId,
      scopes: validation.scopes || ['read', 'write'],
    })

  } catch (error) {
    logger.error('[auth] API key auth error', {
      error: error instanceof Error ? error.message : String(error),
    })

    return c.json({
      error: 'internal_error',
      message: 'Authentication failed',
      details: process.env.NODE_ENV === 'development'
        ? (error instanceof Error ? error.message : String(error))
        : undefined
    }, 500)
  }
})

export default auth
