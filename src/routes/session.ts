import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { RedisClient } from '../db/redis';
import {
  SessionPostRequestSchema,
  SessionDataSchema,
  type SessionPostRequest,
  type SessionData
} from '../models/schemas';
import { logger } from '../utils/logger';

// Define app environment type with session context variable
type SessionEnv = {
  Variables: {
    session: SessionData | null;
  };
};

const router = new Hono<SessionEnv>();

/**
 * POST /v2/session
 * Create a new session with optional org_id/project_id
 * 
 * Matches Python implementation:
 * repos/metabob-rpc-api/server/routes/session.py:41-69
 * repos/metabob-rpc-api/server/actions/auth.py:18-47
 * 
 * Flow:
 * 1. Extract org_id/project_id from request body
 * 2. Generate session_id = uuid()
 * 3. Create session data object
 * 4. Store in Redis as sessions.{session_id} with TTL
 * 5. Encode token = Base64(sessions.{session_id})
 * 6. Return { session: token }
 */
router.post('/', async (c) => {
  try {
    // Parse request body (optional)
    const body = await c.req.json().catch(() => ({}));
    const options = SessionPostRequestSchema.parse(body);
    
    // Extract multi-tenant parameters
    const org_id = options.org_id || null;
    const project_id = options.project_id || null;
    
    // Generate session ID
    const session_id = uuidv4();
    
    // Create session data model (matches Python SessionData)
    const sessionData: SessionData = {
      session_id,
      org_id,
      project_id,
      api_key: options.api_key || null,
      latest_job_id: null,
    };
    
    // Determine session key (Python: session_info_location(session_id))
    const sessionKey = `sessions.${session_id}`;
    const filesKey = `${sessionKey}.files`;
    const problemsKey = `${sessionKey}.problems`;
    
    // Store in Redis with TTL (Python uses pipeline with transaction)
    const redis = RedisClient.getInstance();
    const sessionTTL = parseInt(process.env.SESSION_LENGTH || '86400', 10);
    
    // Store session data as hash with 'data' field (matches Python)
    await redis.hset(sessionKey, 'data', JSON.stringify(sessionData));
    await redis.hset(filesKey, '$latest', '');
    await redis.hset(problemsKey, '$latest', '');
    
    // Set TTLs
    await redis.expire(sessionKey, sessionTTL);
    await redis.expire(filesKey, sessionTTL);
    await redis.expire(problemsKey, sessionTTL);
    
    // Encode token as Base64(sessionKey) - matches Python standard_b64encode(name)
    const token = Buffer.from(sessionKey).toString('base64');
    
    logger.info('Session created', { 
      session_id, 
      org_id, 
      project_id,
      ttl: sessionTTL 
    });
    
    return c.json({ session: token }, 201);
    
  } catch (error) {
    logger.error('Error creating session', { error });
    return c.json({ 
      error: 'Failed to create session',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

/**
 * GET /v2/session
 * Retrieve current session information (requires Bearer token)
 * 
 * This endpoint validates the Bearer token and returns session metadata
 */
router.get('/', async (c) => {
  try {
    const session = c.get('session') as SessionData | null;
    
    if (!session) {
      return c.json({ error: 'Session not found or invalid token' }, 404);
    }
    
    return c.json(session, 200);
    
  } catch (error) {
    logger.error('Error fetching session', { error });
    return c.json({ 
      error: 'Failed to fetch session',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

export default router;
