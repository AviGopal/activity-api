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
 * Authenticate MiniBob instance using RECORD access
 */
export async function authenticateMiniBob(
  instanceId: string,
  apiKey: string
): Promise<AuthContext> {
  try {
    const db = new Surreal();
    await db.connect(config.surrealdb.url);
    await db.use({
      namespace: config.surrealdb.namespace,
      database: config.surrealdb.database,
    });

    // Authenticate using RECORD access
    const authResult = await db.signin({
      access: 'minibob_record',
      variables: {
        instance_id: instanceId,
        api_key: apiKey,
      },
    });

    if (!authResult) {
      await db.close();
      return {
        authenticated: false,
        reason: 'Invalid instance_id or api_key',
      };
    }

    // Extract JWT string from SDK response
    const jwtToken =
      typeof authResult === 'string'
        ? authResult
        : (authResult as { access: string }).access;

    // Query $auth to get org_id and project_id
    const authQuery = await db.query<
      [
        {
          org_id: string;
          project_id?: string;
        }
      ]
    >(`RETURN {
      org_id: $auth.org_id,
      project_id: $auth.project_id
    }`);

    await db.close();

    const instance = authQuery[0];
    if (!instance || !instance.org_id) {
      return {
        authenticated: false,
        reason: 'Instance authenticated but $auth not populated',
      };
    }

    return {
      authenticated: true,
      orgId: instance.org_id,
      keyId: instanceId,
    };
  } catch (error) {
    logger.error('[auth] MiniBob authentication error', {
      error: error instanceof Error ? error.message : String(error),
    });

    const errorMessage = error instanceof Error ? error.message : String(error);

    if (
      errorMessage.includes('No access method found') ||
      errorMessage.includes('Signin failed') ||
      errorMessage.includes('Invalid credentials')
    ) {
      return {
        authenticated: false,
        reason: 'Invalid instance_id or api_key',
      };
    }

    return {
      authenticated: false,
      reason: 'Authentication failed',
    };
  }
}

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
// LEGACY FUNCTION REMOVED: authenticateApiKeyViaSurrealDB (2026-04-03)
// =============================================================================
// The SurrealDB apikey_record ACCESS method has been removed in favor of
// HMAC-based API key validation via identity-vessel.
//
// Use validateApiKeyViaIdentityVessel() instead for API key authentication.
// Benefits:
// - Faster (~2ms vs ~50ms for Argon2 hash comparison)
// - Stateless (no database lookup required for validation)
// - Centralized (identity-vessel is the single source of truth for auth)
// =============================================================================
