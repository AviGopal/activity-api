/**
 * Centralized Authentication Service
 *
 * Provides JWT token validation, generation, and authentication utilities.
 *
 * VESSEL PATTERN (2026-04-12):
 * - API key validation is delegated to identity-vessel via impulse pattern
 * - Identity-vessel owns the api_key table and validation logic
 * - This service does NOT directly query SurrealDB for API key validation
 * - JWT tokens for SurrealDB access are validated via createAuthenticatedClient()
 *
 * Note: Uses 'jose' library for JWT operations since SurrealDB 3.x removed
 * the crypto::jwt::encode/decode functions.
 */

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

/**
 * Authentication result from identity-vessel impulse resolution.
 *
 * IMPORTANT: keyId is REQUIRED for API key authentication.
 * All audit trails depend on having a valid keyId.
 */
export interface AuthContext {
  authenticated: boolean;
  orgId?: string;
  userId?: string;
  /** API key ID - REQUIRED for api_key authType, used for audit trails */
  keyId?: string;
  scopes?: string[];
  reason?: string;
  /** Which method resolved the authentication */
  authMethod?: 'identity-vessel' | 'discovery';
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

    logger.debug('[auth] Generating JWT token', {
      orgId: context.orgId,
      userId: context.userId,
      keyId: context.keyId,
      expirySeconds,
      secretLength: config.auth.jwtSecret.length,
    });

    // Generate JWT token with custom claims
    const token = await new jose.SignJWT({
      NS: config.surrealdb.namespace,
      DB: config.surrealdb.database,
      AC: 'jwt_external', // Must match DEFINE ACCESS name in schema (001-auth-access.surql)
      id: `api_key:${context.keyId}`,
      org_id: `organizations:${context.orgId}`,
      user_id: `users:${context.userId}`,
      scopes: context.scopes,
    })
      .setProtectedHeader({ alg: 'HS256' }) // Must match ALGORITHM in 001-auth-access.surql
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + expirySeconds)
      .sign(secretKey);

    logger.debug('[auth] JWT token generated successfully', { tokenLength: token.length });
    return token;
  } catch (error) {
    logger.error('[auth] JWT generation error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context,
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
 *
 * Tries the configured URL first, then falls back to external URL if internal fails.
 */
export async function validateApiKeyViaIdentityVessel(
  apiKey: string
): Promise<AuthContext> {
  // Try primary (internal) URL first
  const primaryUrl =
    process.env.IDENTITY_VESSEL_URL ||
    'http://identity-vessel.activity-system.svc.cluster.local:8080';

  // External fallback URL (public endpoint)
  const fallbackUrl =
    process.env.IDENTITY_VESSEL_EXTERNAL_URL ||
    'https://identity.metabob.com';

  // Try primary URL
  const primaryResult = await tryIdentityVesselValidation(apiKey, primaryUrl);
  if (primaryResult.authenticated) {
    return primaryResult;
  }

  // If primary failed due to network error, try external fallback
  const isNetworkError =
    primaryResult.reason?.includes('Network error') ||
    primaryResult.reason?.includes('fetch') ||
    primaryResult.reason?.includes('timeout') ||
    primaryResult.reason?.includes('ECONNREFUSED') ||
    primaryResult.reason?.includes('returned 5') ||
    primaryResult.reason?.includes('getaddrinfo');

  if (isNetworkError && primaryUrl !== fallbackUrl) {
    logger.info('[auth] Primary identity-vessel unavailable, trying external URL', {
      primaryUrl,
      fallbackUrl,
      reason: primaryResult.reason,
    });

    const fallbackResult = await tryIdentityVesselValidation(apiKey, fallbackUrl);
    if (fallbackResult.authenticated) {
      return fallbackResult;
    }

    // Both failed - return the fallback error (more likely to be meaningful)
    return fallbackResult;
  }

  // Primary returned a definitive error (not network), return as-is
  return primaryResult;
}

/**
 * Try to validate API key against a specific identity-vessel URL
 */
async function tryIdentityVesselValidation(
  apiKey: string,
  identityVesselUrl: string
): Promise<AuthContext> {
  try {
    logger.debug('[auth] Validating API key via identity-vessel', { url: identityVesselUrl });

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
        url: identityVesselUrl,
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
      url: identityVesselUrl,
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
      url: identityVesselUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      authenticated: false,
      reason: error instanceof Error ? error.message : 'Network error',
    };
  }
}

// =============================================================================
// Direct API Key Validation - REMOVED (Vessel Pattern)
// =============================================================================
//
// REMOVED 2026-04-12: Direct SurrealDB validation violates the vessel idiom.
//
// The foundation principle states: "Resolvers live where data lives"
// - Identity-vessel owns the api_key table
// - Identity-vessel resolves authentication impulses
// - Other vessels should NOT duplicate validation logic
//
// If identity-vessel is unavailable:
// - Use discovery-vessel to find another identity resolver
// - Or fail the authentication (fail-safe behavior)
//
// DO NOT add direct SurrealDB queries here. If you need to change auth logic,
// update identity-vessel's resolvers/auth.ts instead.
// =============================================================================

/**
 * Validate API key via identity-vessel (vessel pattern)
 *
 * VESSEL PATTERN (2026-04-12):
 * - Identity-vessel is the single source of truth for API key validation
 * - This function sends an AuthenticationImpulse to identity-vessel
 * - If identity-vessel is unavailable, use discovery-vessel to find it
 * - Do NOT fall back to direct SurrealDB queries (violates vessel idiom)
 *
 * @param apiKey - Raw API key from Authorization header
 * @returns AuthContext with validation result
 */
export async function validateApiKeyWithFallback(
  apiKey: string
): Promise<AuthContext> {
  // Try configured identity-vessel first
  const identityResult = await validateApiKeyViaIdentityVessel(apiKey);

  if (identityResult.authenticated) {
    logger.info('[auth] API key validated via identity-vessel');
    return {
      ...identityResult,
      authMethod: 'identity-vessel',
    };
  }

  // Check if identity-vessel returned a specific error (vs network failure)
  const isNetworkError =
    identityResult.reason?.includes('Network error') ||
    identityResult.reason?.includes('fetch') ||
    identityResult.reason?.includes('timeout') ||
    identityResult.reason?.includes('ECONNREFUSED') ||
    identityResult.reason?.includes('returned 5');

  if (isNetworkError) {
    // Try discovery-vessel to find identity-vessel
    logger.info('[auth] Identity-vessel unavailable, trying discovery', {
      reason: identityResult.reason,
    });

    const discoveryResult = await validateApiKeyViaDiscovery(apiKey);
    if (discoveryResult.authenticated) {
      return discoveryResult;
    }

    // Discovery also failed - fail the authentication
    // This is fail-safe: if we can't validate, we don't authenticate
    logger.warn('[auth] Both identity-vessel and discovery unavailable', {
      identityReason: identityResult.reason,
      discoveryReason: discoveryResult.reason,
    });

    return {
      authenticated: false,
      reason: 'Authentication service unavailable',
    };
  }

  // Identity-vessel returned a definitive "invalid key" response
  // Don't retry - the key is genuinely invalid
  return {
    authenticated: false,
    reason: identityResult.reason || 'API key validation failed',
  };
}

/**
 * Try to find identity-vessel via discovery and validate API key
 */
async function validateApiKeyViaDiscovery(apiKey: string): Promise<AuthContext> {
  const discoveryUrl =
    process.env.DISCOVERY_VESSEL_ENDPOINT ||
    'http://discovery-vessel.activity-system.svc.cluster.local:8080';

  try {
    logger.debug('[auth] Discovering identity-vessel via discovery-vessel');

    // Query discovery-vessel for vessels that resolve 'authentication' shape
    const discoverResponse = await fetch(`${discoveryUrl}/v1/discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shape: 'authentication',
        capabilities: ['api_key_validation'],
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!discoverResponse.ok) {
      return {
        authenticated: false,
        reason: `Discovery failed: ${discoverResponse.status}`,
      };
    }

    const discovered = (await discoverResponse.json()) as {
      vessels?: Array<{ endpoint: string; vesselId: string }>;
    };

    if (!discovered.vessels || discovered.vessels.length === 0) {
      return {
        authenticated: false,
        reason: 'No identity vessels discovered',
      };
    }

    // Try first discovered vessel
    const vessel = discovered.vessels[0];
    logger.info('[auth] Found identity-vessel via discovery', {
      vesselId: vessel.vesselId,
      endpoint: vessel.endpoint,
    });

    // Send authentication impulse to discovered vessel
    const authResponse = await fetch(`${vessel.endpoint}/v1/auth/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impulse: {
          type: 'authentication',
          pointer: { type: 'apiKey', apiKey },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!authResponse.ok) {
      return {
        authenticated: false,
        reason: `Discovered vessel returned ${authResponse.status}`,
      };
    }

    const result = (await authResponse.json()) as {
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

    return {
      authenticated: true,
      orgId: result.data.orgId,
      userId: result.data.userId,
      keyId: result.data.keyId,
      scopes: result.data.scopes,
      authMethod: 'discovery',
    };
  } catch (error) {
    logger.warn('[auth] Discovery-based validation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      authenticated: false,
      reason: error instanceof Error ? error.message : 'Discovery failed',
    };
  }
}
