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
import { Surreal } from 'surrealdb'
import { surrealDB } from '../db/surreal'
import { config } from '../config'
import { signinRateLimiter } from '../middleware/rateLimiter'

const auth = new Hono()

// Apply rate limiting
auth.use('/apikey', signinRateLimiter)

// =============================================================================
// HELPER: Validate API Key via Identity Vessel
// =============================================================================

interface IdentityVesselValidation {
  authenticated: boolean
  orgId?: string
  userId?: string
  keyId?: string
  scopes?: string[]
  reason?: string
}

async function validateApiKeyViaIdentityVessel(apiKey: string): Promise<IdentityVesselValidation> {
  const identityVesselUrl = process.env.IDENTITY_VESSEL_URL ||
    'http://identity-vessel.activity-system.svc.cluster.local:8080'

  try {
    console.log('[auth] Validating API key via identity-vessel')

    const response = await fetch(`${identityVesselUrl}/v1/auth/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impulse: {
          type: 'authentication',
          pointer: {
            type: 'apiKey',
            apiKey
          }
        }
      }),
      signal: AbortSignal.timeout(5000) // 5s timeout
    })

    if (!response.ok) {
      console.warn(`[auth] Identity vessel returned ${response.status}`)
      return {
        authenticated: false,
        reason: `Identity vessel returned ${response.status}`
      }
    }

    const result = await response.json() as {
      success: boolean
      data?: {
        authenticated: boolean
        orgId: string
        userId: string
        keyId: string
        scopes: string[]
        reason?: string
      }
    }

    if (!result.success || !result.data?.authenticated) {
      return {
        authenticated: false,
        reason: result.data?.reason || 'Validation failed'
      }
    }

    console.log(`[auth] ✓ Identity vessel validated key for user ${result.data.userId}`)

    return {
      authenticated: true,
      orgId: result.data.orgId,
      userId: result.data.userId,
      keyId: result.data.keyId,
      scopes: result.data.scopes
    }
  } catch (error) {
    console.error('[auth] Identity vessel validation error:', error)
    return {
      authenticated: false,
      reason: error instanceof Error ? error.message : 'Network error'
    }
  }
}

// =============================================================================
// HELPER: Generate JWT Token from Auth Context
// =============================================================================

async function generateJwtForAuthContext(context: {
  orgId: string
  userId: string
  keyId: string
  scopes: string[]
}): Promise<string | null> {
  try {
    // Create a dedicated connection for token generation
    const db = new Surreal()
    await db.connect(config.surrealdb.url)
    await db.use({
      namespace: config.surrealdb.namespace,
      database: config.surrealdb.database,
    })

    // Sign in with root to generate token
    await db.signin({
      username: config.surrealdb.username,
      password: config.surrealdb.password
    })

    // Generate JWT token manually using SurrealDB's token generation
    // This uses the same mechanism as RECORD access but allows us to
    // set custom claims from identity-vessel validation
    const tokenQuery = await db.query<[string]>(`
      RETURN crypto::jwt::encode(
        {
          NS: "${config.surrealdb.namespace}",
          DB: "${config.surrealdb.database}",
          AC: "apikey_token",
          exp: time::unix() + 900,
          iat: time::unix(),
          nbf: time::unix(),
          id: $key_id,
          org_id: $org_id,
          user_id: $user_id,
          scopes: $scopes
        },
        $jwt_secret
      )
    `, {
      key_id: context.keyId,
      org_id: `organizations:${context.orgId}`,
      user_id: `users:${context.userId}`,
      scopes: context.scopes,
      jwt_secret: process.env.JWT_SECRET || 'dev-secret-change-in-production'
    })

    await db.close()

    const token = tokenQuery[0]
    if (!token) {
      console.error('[auth] Failed to generate JWT token')
      return null
    }

    return token
  } catch (error) {
    console.error('[auth] JWT generation error:', error)
    return null
  }
}

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
      console.log('[auth] Using identity-vessel validated key')

      // Generate JWT token with validated auth context
      const token = await generateJwtForAuthContext({
        orgId: validation.orgId,
        userId: validation.userId,
        keyId: validation.keyId || 'unknown',
        scopes: validation.scopes || ['read', 'write']
      })

      if (!token) {
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

    console.log('[auth] Identity vessel validation failed, trying SurrealDB fallback')

    const db = new Surreal()
    await db.connect(config.surrealdb.url)
    await db.use({
      namespace: config.surrealdb.namespace,
      database: config.surrealdb.database,
    })

    try {
      // Authenticate using RECORD access for API keys
      const authResult = await db.signin({
        access: 'apikey_record',
        variables: { api_key }
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
      const authQuery = await db.query<[{
        id: string
        org_id: string
        user_id: string
        scopes: string[]
      }]>(`RETURN {
        id: $auth.id,
        org_id: $auth.org_id,
        user_id: $auth.user_id,
        scopes: $auth.scopes
      }`)

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

      await db.close()

      const expiresIn = 900
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

      console.log('[auth] Using SurrealDB validated key (legacy)')

      return c.json({
        token: jwtToken,
        expires_at: expiresAt,
        expires_in: expiresIn,
        org_id: keyInfo.org_id.toString().replace('organizations:', ''),
        user_id: keyInfo.user_id.toString().replace('users:', ''),
        scopes: keyInfo.scopes || [],
        source: 'surrealdb'
      })

    } finally {
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

export default auth
