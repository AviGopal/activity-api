-- =============================================================================
-- Migration 064: Add apikey_token ACCESS method for API Key JWT Authentication
-- =============================================================================
-- Purpose: Enable JWT authentication for API key-derived tokens
--
-- When a client authenticates via "Authorization: ApiKey <key>":
-- 1. Activity-API validates the key via identity-vessel
-- 2. Activity-API generates a short-lived JWT with AC: 'apikey_token'
-- 3. This JWT is used with createAuthenticatedClient() for SurrealDB queries
-- 4. SurrealDB validates the JWT against this ACCESS method
-- 5. $auth is populated from JWT claims for PERMISSIONS enforcement
--
-- JWT Claims Structure (set by generateJwtToken in auth.ts):
-- {
--   "NS": "activity-system",
--   "DB": "learning_loop",
--   "AC": "apikey_token",
--   "id": "api_key:<keyId>",
--   "org_id": "organizations:<orgId>",
--   "user_id": "users:<userId>",
--   "scopes": ["read", "write"],
--   "iat": <timestamp>,
--   "nbf": <timestamp>,
--   "exp": <timestamp>
-- }
--
-- The JWT secret MUST match the JWT_SECRET environment variable in Activity-API.
-- Default: 'dev-secret-change-in-production' (see config.ts)
-- =============================================================================

-- Define JWT ACCESS method for API key-generated tokens
-- This allows programmatically generated JWTs to authenticate with SurrealDB
DEFINE ACCESS OVERWRITE apikey_token ON DATABASE TYPE JWT
  -- Algorithm must match what jose library uses in generateJwtToken (HS512)
  ALGORITHM HS512
  -- Key must match JWT_SECRET environment variable
  -- In production, set this via SOPS secrets management
  KEY 'dev-secret-change-in-production'
  -- Duration settings for token and session
  -- Note: Token duration is controlled by generateJwtToken (15 min default)
  -- Session duration allows token refresh without re-auth
  DURATION FOR TOKEN 15m, FOR SESSION 1h;

-- =============================================================================
-- IMPORTANT: In production, update the KEY to match your JWT_SECRET
-- =============================================================================
-- Option 1: Update via SurrealQL after deployment:
--   DEFINE ACCESS OVERWRITE apikey_token ON DATABASE TYPE JWT
--     ALGORITHM HS512
--     KEY $your_production_secret
--     DURATION FOR TOKEN 15m, FOR SESSION 1h;
--
-- Option 2: Use environment variable interpolation in deployment scripts
-- =============================================================================
