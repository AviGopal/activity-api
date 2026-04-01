/**
 * Centralized Authentication Service
 *
 * Provides JWT token validation, generation, and authentication utilities.
 * Handles both MiniBob RECORD access and API key authentication.
 */

import { Surreal } from 'surrealdb';
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
 * Uses SurrealDB's crypto::jwt::decode to verify signature and expiry
 */
export async function validateJwtToken(token: string): Promise<ValidatedToken> {
  try {
    // Create temporary connection for validation
    const db = new Surreal();
    await db.connect(config.surrealdb.url);
    await db.use({
      namespace: config.surrealdb.namespace,
      database: config.surrealdb.database,
    });

    // Sign in with root to validate token
    await db.signin({
      username: config.surrealdb.username,
      password: config.surrealdb.password,
    });

    // Validate token signature and expiry
    const result = await db.query<[JwtPayload | null]>(
      `RETURN crypto::jwt::decode($token, $jwt_secret)`,
      {
        token,
        jwt_secret: config.auth.jwtSecret,
      }
    );

    await db.close();

    const payload = result[0];
    if (!payload) {
      return {
        valid: false,
        error: 'Invalid token signature or format',
      };
    }

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return {
        valid: false,
        error: 'Token expired',
      };
    }

    // Check not-before
    if (payload.nbf && payload.nbf > now) {
      return {
        valid: false,
        error: 'Token not yet valid',
      };
    }

    return {
      valid: true,
      payload,
    };
  } catch (error) {
    logger.error('[auth] JWT validation error', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      valid: false,
      error: 'Token validation failed',
    };
  }
}

/**
 * Generate JWT token for authenticated context
 * Used after validating credentials via identity-vessel or SurrealDB
 */
export async function generateJwtToken(context: {
  orgId: string;
  userId: string;
  keyId: string;
  scopes: string[];
  expirySeconds?: number;
}): Promise<string | null> {
  try {
    const db = new Surreal();
    await db.connect(config.surrealdb.url);
    await db.use({
      namespace: config.surrealdb.namespace,
      database: config.surrealdb.database,
    });

    // Sign in with root to generate token
    await db.signin({
      username: config.surrealdb.username,
      password: config.surrealdb.password,
    });

    const expirySeconds = context.expirySeconds || 900; // Default 15 minutes

    // Generate JWT token with custom claims
    const tokenQuery = await db.query<[string]>(
      `RETURN crypto::jwt::encode(
        {
          NS: $namespace,
          DB: $database,
          AC: "apikey_token",
          exp: time::unix() + $expiry,
          iat: time::unix(),
          nbf: time::unix(),
          id: $key_id,
          org_id: $org_id,
          user_id: $user_id,
          scopes: $scopes
        },
        $jwt_secret
      )`,
      {
        namespace: config.surrealdb.namespace,
        database: config.surrealdb.database,
        expiry: expirySeconds,
        key_id: context.keyId,
        org_id: `organizations:${context.orgId}`,
        user_id: `users:${context.userId}`,
        scopes: context.scopes,
        jwt_secret: config.auth.jwtSecret,
      }
    );

    await db.close();

    const token = tokenQuery[0];
    if (!token) {
      logger.error('[auth] Failed to generate JWT token');
      return null;
    }

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

/**
 * Authenticate API key via SurrealDB (legacy fallback)
 */
export async function authenticateApiKeyViaSurrealDB(
  apiKey: string
): Promise<AuthContext & { token?: string }> {
  try {
    const db = new Surreal();
    await db.connect(config.surrealdb.url);
    await db.use({
      namespace: config.surrealdb.namespace,
      database: config.surrealdb.database,
    });

    // Authenticate using RECORD access for API keys
    const authResult = await db.signin({
      access: 'apikey_record',
      variables: { api_key: apiKey },
    });

    if (!authResult) {
      await db.close();
      return {
        authenticated: false,
        reason: 'API key is invalid, expired, or revoked',
      };
    }

    // Extract JWT string from SDK response
    const jwtToken =
      typeof authResult === 'string'
        ? authResult
        : (authResult as { access: string }).access;

    // Query $auth to get API key details
    const authQuery = await db.query<
      [
        {
          id: string;
          org_id: string;
          user_id: string;
          scopes: string[];
        }
      ]
    >(`RETURN {
      id: $auth.id,
      org_id: $auth.org_id,
      user_id: $auth.user_id,
      scopes: $auth.scopes
    }`);

    await db.close();

    const keyInfo = authQuery[0];
    if (!keyInfo || !keyInfo.org_id) {
      return {
        authenticated: false,
        reason: 'API key authenticated but session details not found',
      };
    }

    logger.info('[auth] SurrealDB validated API key (legacy)', {
      keyId: keyInfo.id,
    });

    return {
      authenticated: true,
      token: jwtToken,
      orgId: keyInfo.org_id.toString().replace('organizations:', ''),
      userId: keyInfo.user_id.toString().replace('users:', ''),
      keyId: keyInfo.id,
      scopes: keyInfo.scopes || [],
    };
  } catch (error) {
    logger.error('[auth] SurrealDB API key authentication error', {
      error: error instanceof Error ? error.message : String(error),
    });

    const errorMessage = error instanceof Error ? error.message : String(error);

    if (
      errorMessage.includes('No access method found') ||
      errorMessage.includes('Signin failed') ||
      errorMessage.includes('Invalid credentials') ||
      errorMessage.includes('No record found')
    ) {
      return {
        authenticated: false,
        reason: 'API key is invalid, expired, or revoked',
      };
    }

    return {
      authenticated: false,
      reason: 'Authentication failed',
    };
  }
}
