/**
 * Identity Vessel Integration for API Key Authentication
 *
 * This file shows the updated /v2/auth/apikey endpoint that:
 * 1. First tries identity-vessel validation (HMAC-based keys)
 * 2. Falls back to SurrealDB validation (legacy keys)
 * 3. Returns JWT token for authenticated requests
 *
 * Usage: Replace the /apikey route in auth.ts with this implementation
 */

import { Hono } from 'hono'
import { surrealDB } from '../db/surreal'
import { signinRateLimiter } from '../middleware/rateLimiter'
import {
  validateApiKeyViaIdentityVessel,
  authenticateApiKeyViaSurrealDB,
  generateJwtToken
} from '../services/auth'
import { logger } from '../utils/logger'

const auth = new Hono()

// Apply rate limiting
auth.use('/apikey', signinRateLimiter)

// =============================================================================
// ENDPOINT: POST /v2/auth/apikey (Updated with Identity Vessel Integration)
// =============================================================================

/**
 * POST /v2/auth/apikey
 *
 * Authenticate user via API key. Supports both:
 * 1. Identity-vessel HMAC keys (preferred)
 * 2. SurrealDB stored keys (legacy, fallback)
 *
 * Request body:
 * {
 *   api_key: string   // Format: mb_<type>_<random> (base64 encoded)
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
 *   source: string        // 'identity-vessel' or 'surrealdb' (for debugging)
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

    // ==========================================================================
    // PATH 1: Try identity-vessel validation (for HMAC-based keys)
    // ==========================================================================

    const validation = await validateApiKeyViaIdentityVessel(api_key)

    if (validation.authenticated && validation.orgId && validation.userId) {
      logger.info('[auth] Using identity-vessel validated key', {
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
        source: 'identity-vessel'
      })
    }

    // ==========================================================================
    // PATH 2: Fallback to SurrealDB validation (for legacy keys)
    // ==========================================================================

    logger.info('[auth] Identity vessel validation failed, trying SurrealDB fallback')

    const surrealResult = await authenticateApiKeyViaSurrealDB(api_key)

    if (!surrealResult.authenticated || !surrealResult.token) {
      return c.json({
        error: 'invalid_api_key',
        message: surrealResult.reason || 'API key is invalid, expired, or revoked'
      }, 401)
    }

    // Update last_used_at using root connection (fire and forget)
    if (surrealResult.keyId) {
      surrealDB.query(
        `UPDATE $key_id SET last_used_at = time::now()`,
        { key_id: surrealResult.keyId }
      ).catch(err => {
        logger.warn('[auth] Failed to update last_used_at', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }

    const expiresIn = 900
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

    logger.info('[auth] Using SurrealDB validated key (legacy)', {
      keyId: surrealResult.keyId,
    })

    return c.json({
      token: surrealResult.token,
      expires_at: expiresAt,
      expires_in: expiresIn,
      org_id: surrealResult.orgId,
      user_id: surrealResult.userId,
      scopes: surrealResult.scopes || [],
      source: 'surrealdb'
    })

  } catch (error) {
    logger.error('[auth] API key auth error', {
      error: error instanceof Error ? error.message : String(error),
    })

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

export default auth
