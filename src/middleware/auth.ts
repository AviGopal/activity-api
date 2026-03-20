import { Context, Next } from 'hono';
import { RedisClient } from '../db/redis';
import { SessionDataSchema, type SessionData } from '../models/schemas';
import { logger } from '../utils/logger';

/**
 * Bearer token authentication middleware
 * Matches Python implementation in repos/metabob-rpc-api/server/actions/auth.py
 * 
 * Flow:
 * 1. Extract Bearer token from Authorization header
 * 2. Decode Base64 token to get session key (sessions.{session_id})
 * 3. Fetch session data from Redis
 * 4. Attach session data to context for downstream use
 */
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  
  // Auth is optional - if no header, continue without session
  if (!authHeader) {
    c.set('session', null);
    await next();
    return;
  }

  // Extract Bearer token
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    logger.warn('Invalid Authorization header format');
    c.set('session', null);
    await next();
    return;
  }

  const token = match[1];
  
  try {
    // Decode Base64 token to get Redis key
    // Python: name = standard_b64decode(session_token)
    const sessionKey = Buffer.from(token, 'base64').toString('utf-8');
    
    // Fetch session data from Redis
    // Python: tx.hget(name, "data")
    const redis = RedisClient.getInstance();
    const sessionDataRaw = await redis.hget(sessionKey, 'data');
    
    if (!sessionDataRaw) {
      logger.warn(`Session not found for key: ${sessionKey}`);
      c.set('session', null);
      await next();
      return;
    }

    // Parse and validate session data
    let sessionData: SessionData;
    try {
      sessionData = SessionDataSchema.parse(JSON.parse(sessionDataRaw));
    } catch (parseError: any) {
      // Handle Zod validation errors gracefully
      if (parseError.name === 'ZodError') {
        logger.warn('Invalid session schema - corrupted session data', {
          sessionKey,
          errors: parseError.errors,
        });
        return c.json({ error: 'Invalid session' }, 401);
      }
      
      // Handle JSON parse errors
      logger.warn('Failed to parse session JSON', {
        sessionKey,
        error: parseError.message,
      });
      return c.json({ error: 'Invalid session' }, 401);
    }
    
    // Extend session TTL (Python does this on every access)
    const sessionTTL = parseInt(process.env.SESSION_LENGTH || '86400', 10);
    await redis.expire(sessionKey, sessionTTL);
    await redis.expire(`${sessionKey}.files`, sessionTTL);
    await redis.expire(`${sessionKey}.problems`, sessionTTL);
    
    // Attach session to context
    c.set('session', sessionData);
    
    logger.debug(`Session authenticated: ${sessionData.session_id}`);
  } catch (error) {
    logger.error('Error validating session', { error });
    c.set('session', null);
  }
  
  await next();
}

/**
 * Helper to extract org_id from session context
 * Used for multi-tenant filtering in template queries
 */
export function getOrgIdFromContext(c: Context): string | null {
  const session = c.get('session') as SessionData | null;
  return session?.org_id || null;
}

/**
 * Helper to extract project_id from session context
 * Used for project-scoped template filtering
 */
export function getProjectIdFromContext(c: Context): string | null {
  const session = c.get('session') as SessionData | null;
  return session?.project_id || null;
}

/**
 * Helper to get full session data from context
 */
export function getSessionFromContext(c: Context): SessionData | null {
  return c.get('session') as SessionData | null;
}
