-- =============================================================================
-- Migration 069: Fix hardcoded JWT_SECRET in apikey_token ACCESS method
-- =============================================================================
-- Purpose: Replace hardcoded 'dev-secret-change-in-production' with a placeholder
--          that deployment scripts MUST replace with the actual JWT_SECRET.
--
-- SECURITY FIX: Migration 064 contained a hardcoded secret which is a security
--               risk if deployed to production without modification.
--
-- IMPORTANT: This migration file contains a placeholder that WILL NOT WORK
--            as-is. Deployment scripts MUST replace the placeholder before
--            applying this migration.
--
-- Deployment Process:
-- 1. Export JWT_SECRET environment variable (from SOPS secrets)
-- 2. Run sed replacement: sed "s/__JWT_SECRET_PLACEHOLDER__/$JWT_SECRET/g"
-- 3. Apply the modified migration to SurrealDB
-- 4. Verify the ACCESS method is correctly configured
--
-- See: repos/deployment/JWT_SECRET_CONFIGURATION.md for full documentation
-- =============================================================================

-- =============================================================================
-- DEPLOYMENT REQUIREMENT
-- =============================================================================
-- Before applying this migration, you MUST replace __JWT_SECRET_PLACEHOLDER__
-- with your actual JWT_SECRET value.
--
-- Example deployment script snippet:
--
--   export JWT_SECRET=$(sops -d secrets/production.secrets.yaml | yq '.activityApi.jwtSecret')
--   sed "s/__JWT_SECRET_PLACEHOLDER__/$JWT_SECRET/g" 069-fix-apikey-token-jwt-secret.surql | \
--     surreal sql --endpoint "$SURREALDB_URL" --namespace "$SURREALDB_NAMESPACE" --database "$SURREALDB_DATABASE"
--
-- Alternatively, use the deployment script:
--   ./scripts/apply-migration-with-secrets.sh 069-fix-apikey-token-jwt-secret.surql
-- =============================================================================

-- Redefine the apikey_token ACCESS method with placeholder
-- This OVERWRITES the previous definition from migration 064
DEFINE ACCESS OVERWRITE apikey_token ON DATABASE TYPE JWT
  -- Algorithm must match what jose library uses in generateJwtToken (HS512)
  ALGORITHM HS512
  -- KEY is replaced at deployment time by scripts/init-database.ts using the
  -- JWT_SECRET environment variable. The same env var is consumed by
  -- src/config.ts so signing and verification share one source. The unified
  -- placeholder is `__JWT_SECRET__` (matches sql/000-auth-schema.surql and
  -- sql/migrations/064-add-apikey-token-access.surql).
  --
  -- DO NOT deploy with the placeholder value - authentication will fail.
  KEY '__JWT_SECRET__'
  -- Duration settings for token and session
  -- Token: 15 minutes (controlled by generateJwtToken)
  -- Session: 1 hour (allows token refresh without re-auth)
  DURATION FOR TOKEN 15m, FOR SESSION 1h;

-- =============================================================================
-- VERIFICATION
-- =============================================================================
-- After applying this migration, verify the ACCESS method is correctly set:
--
--   INFO FOR DB;
--
-- You should see apikey_token in the accesses list with the correct configuration.
-- The KEY value should NOT be '__JWT_SECRET_PLACEHOLDER__'.
--
-- Test authentication by generating a JWT token with the Activity-API and
-- using it to authenticate with SurrealDB.
-- =============================================================================
