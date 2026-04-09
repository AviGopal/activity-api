/**
 * Centralized Authentication Service
 *
 * Provides JWT token validation, generation, and authentication utilities.
 * Handles both MiniBob RECORD access and API key authentication.
 *
 * Note: Uses 'jose' library for JWT operations since SurrealDB 3.x removed
 * the crypto::jwt::encode/decode functions.
 */

import { Surreal } from 'surrealdb';
import * as jose from 'jose';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface JwtPayload {
  NS: string;
  DB: string;
  AC: string;
  exp: number;
  iat: number;
  nbf: number;
  id: string;
  org_id: string;
  user_id?: string;
  scopes?: string[];
}

export interface AuthContext {
  authenticated: boolean;
  orgId?: string;
  userId?: string;
  keyId?: string;
  scopes?: string[];
  reason?: string;
}

export interface ValidatedToken {
  valid: boolean;
  payload?: JwtPayload;
  error?: string;
}

/**
 * Validate JWT token without making database calls
 * Uses jose library for JWT verification (SurrealDB 3.x compatible)
 */
export async function validateJwtToken(token: string): Promise<ValidatedToken> {
  try {
    // Encode the secret key for jose
    const secretKey = new TextEncoder().encode(config.auth.jwtSecret);

    // Verify and decode the token
    const { payload } = await jose.jwtVerify(token, secretKey, {
      algorithms: ['HS256', 'HS384', 'HS512'],
    });

    // Map jose payload to our JwtPayload format
    const jwtPayload: JwtPayload = {
      NS: (payload.NS as string) || config.surrealdb.namespace,
      DB: (payload.DB as string) || config.surrealdb.database,
      AC: (payload.AC as string) || '',
      exp: payload.exp || 0,
      iat: payload.iat || 0,
      nbf: payload.nbf || 0,
      id: (payload.id as string) || '',
      org_id: (payload.org_id as string) || '',
      user_id: payload.user_id as string | undefined,
      scopes: payload.scopes as string[] | undefined,
    };

    return {
      valid: true,
      payload: jwtPayload,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Handle specific jose errors
    if (errorMessage.includes('expired')) {
      return {
        valid: false,
        error: 'Token expired',
      };
    }

    if (errorMessage.includes('not yet valid') || errorMessage.includes('nbf')) {
      return {
        valid: false,
        error: 'Token not yet valid',
      };
    }

    logger.error('[auth] JWT validation error', {
      error: errorMessage,
    });

    return {
      valid: false,
      error: 'Token validation failed',
    };
  }
}

/**
 * Generate JWT token for authenticated context
 * Uses jose library for JWT creation (SurrealDB 3.x compatible)
 */
export async function generateJwtToken(context: {
  orgId: string;
  userId: string;
  keyId: string;
  scopes: string[];
  expirySeconds?: number;
}): Promise<string | null> {
  try {
    const secretKey = new TextEncoder().encode(config.auth.jwtSecret);
    const expirySeconds = context.expirySeconds || 900; // Default 15 minutes

    const now = Math.floor(Date.now() / 1000);

    // Generate JWT token with custom claims
    const token = await new jose.SignJWT({
      NS: config.surrealdb.namespace,
      DB: config.surrealdb.database,
      AC: 'apikey_token',
      id: context.keyId,
      org_id: `organizations:${context.orgId}`,
      user_id: `users:${context.userId}`,
      scopes: context.scopes,
    })
      .setProtectedHeader({ alg: 'HS512' })
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + expirySeconds)
      .sign(secretKey);

    return token;
  } catch (error) {
    logger.error('[auth] JWT generation error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * DEPRECATED: authenticateMiniBob
 *
 * MiniBob instances now authenticate using standard API keys via:
 * - validateApiKeyWithFallback() (primary method)
 * - Identity service validation with SurrealDB fallback
 *
 * This function is kept for reference but should not be used.
 * Remove after confirming all clients use API key authentication.
 */

/**
 * Validate API key via identity-vessel
 */
export async function validateApiKeyViaIdentityVessel(
  apiKey: string
): Promise<AuthContext> {
  const identityVesselUrl =
    process.env.IDENTITY_VESSEL_URL ||
    'http://identity-vessel.activity-system.svc.cluster.local:8080';

  try {
    logger.debug('[auth] Validating API key via identity-vessel');

    const response = await fetch(`${identityVesselUrl}/v1/auth/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impulse: {
          type: 'authentication',
          pointer: {
            type: 'apiKey',
            apiKey,
          },
        },
      }),
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    if (!response.ok) {
      logger.warn('[auth] Identity vessel validation failed', {
        status: response.status,
      });
      return {
        authenticated: false,
        reason: `Identity vessel returned ${response.status}`,
      };
    }

    const result = (await response.json()) as {
      success: boolean;
      data?: {
        authenticated: boolean;
        orgId: string;
        userId: string;
        keyId: string;
        scopes: string[];
        reason?: string;
      };
    };

    if (!result.success || !result.data?.authenticated) {
      return {
        authenticated: false,
        reason: result.data?.reason || 'Validation failed',
      };
    }

    logger.info('[auth] Identity vessel validated key', {
      userId: result.data.userId,
    });

    return {
      authenticated: true,
      orgId: result.data.orgId,
      userId: result.data.userId,
      keyId: result.data.keyId,
      scopes: result.data.scopes,
    };
  } catch (error) {
    logger.error('[auth] Identity vessel validation error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      authenticated: false,
      reason: error instanceof Error ? error.message : 'Network error',
    };
  }
}

// =============================================================================
// Direct API Key Validation (Fallback)
// =============================================================================
// When identity-vessel is unavailable, validate API keys directly via SurrealDB.
// Uses SHA-256 hash for fast O(1) lookup (no Argon2, which is slow by design).
//
// This is a FALLBACK mechanism. Primary auth should go through identity-vessel.
// =============================================================================

/**
 * Compute SHA-256 hash of an API key for direct validation.
 * Uses Web Crypto API (available in Bun).
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate API key directly via SurrealDB lookup.
 * This is a fallback when identity-vessel is unavailable.
 *
 * @param apiKey - Raw API key from Authorization header
 * @returns AuthContext with validation result
 */
export async function validateApiKeyDirect(apiKey: string): Promise<AuthContext> {
  try {
    logger.debug('[auth] Validating API key directly via SurrealDB');

    // Hash the API key for lookup
    const keyHash = await hashApiKey(apiKey);

    // Import surrealDB here to avoid circular dependency
    const { surrealDB } = await import('../db/surreal');

    // Query api_key table with hash lookup
    // Check is_active and expiration in the query
    const result = await surrealDB.query<{
      id: string;
      org_id: string;
      user_id?: string;
      scopes: string[];
      expires_at?: string;
      is_active: boolean;
    }>(
      `SELECT id, org_id, user_id, scopes, expires_at, is_active
       FROM api_key
       WHERE key_hash = $key_hash
         AND is_active = true
         AND (expires_at IS NONE OR expires_at > time::now())
       LIMIT 1`,
      { key_hash: keyHash }
    );

    if (!result || result.length === 0) {
      logger.debug('[auth] API key not found or inactive');
      return {
        authenticated: false,
        reason: 'API key not found or inactive',
      };
    }

    const keyRecord = result[0];

    // Update last_used_at asynchronously (don't await to avoid blocking)
    surrealDB
      .query(
        `UPDATE api_key SET last_used_at = time::now() WHERE id = $id`,
        { id: keyRecord.id }
      )
      .catch(err => {
        logger.warn('[auth] Failed to update api_key last_used_at', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

    logger.info('[auth] API key validated directly via SurrealDB', {
      keyId: keyRecord.id,
      orgId: keyRecord.org_id,
    });

    return {
      authenticated: true,
      orgId: keyRecord.org_id,
      userId: keyRecord.user_id,
      keyId: String(keyRecord.id),
      scopes: keyRecord.scopes || ['read', 'write'],
    };
  } catch (error) {
    logger.error('[auth] Direct API key validation error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      authenticated: false,
      reason: error instanceof Error ? error.message : 'Validation failed',
    };
  }
}

/**
 * Validate API key with fallback strategy:
 * 1. Try identity-vessel first (primary)
 * 2. Fall back to direct SurrealDB lookup if identity-vessel fails
 *
 * @param apiKey - Raw API key from Authorization header
 * @returns AuthContext with validation result and method used
 */
export async function validateApiKeyWithFallback(
  apiKey: string
): Promise<AuthContext & { authMethod?: 'identity-vessel' | 'direct' }> {
  // Try identity-vessel first
  const identityResult = await validateApiKeyViaIdentityVessel(apiKey);

  if (identityResult.authenticated) {
    logger.info('[auth] API key validated via identity-vessel');
    return {
      ...identityResult,
      authMethod: 'identity-vessel',
    };
  }

  // Check if identity-vessel returned a specific error (vs network failure)
  // Network failures have reasons like "Network error" or timeout messages
  const isNetworkError =
    identityResult.reason?.includes('Network error') ||
    identityResult.reason?.includes('fetch') ||
    identityResult.reason?.includes('timeout') ||
    identityResult.reason?.includes('ECONNREFUSED') ||
    identityResult.reason?.includes('returned 5');

  if (isNetworkError) {
    logger.info('[auth] Identity-vessel unavailable, trying direct validation', {
      reason: identityResult.reason,
    });

    // Fall back to direct validation
    const directResult = await validateApiKeyDirect(apiKey);

    if (directResult.authenticated) {
      return {
        ...directResult,
        authMethod: 'direct',
      };
    }

    // Both methods failed
    return {
      authenticated: false,
      reason: `Identity-vessel unavailable and direct validation failed: ${directResult.reason}`,
    };
  }

  // Identity-vessel returned a definitive "invalid key" response
  // Don't fall back in this case - the key is genuinely invalid
  return {
    authenticated: false,
    reason: identityResult.reason || 'API key validation failed',
  };
}
