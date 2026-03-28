-- =============================================================================
-- Migration: Fix org_id Format in Legacy Tables
-- =============================================================================
-- Problem: Legacy tables (activity_template, variant_performance_metrics) store
--          org_id as plain strings like "metabob_internal", but $auth.org_id
--          from JWT contains record references like "organizations:metabob_internal".
--          This causes PERMISSIONS comparisons to fail.
--
-- Solution:
--   1. Add new org_id_ref field as record<organizations>
--   2. Backfill from existing string org_id
--   3. Update PERMISSIONS to use the record field
--   4. Eventually: drop string field, rename record field
-- =============================================================================

-- =============================================================================
-- Step 1: Update activity_template table
-- =============================================================================

-- Redefine with proper PERMISSIONS that handle both formats during migration
DEFINE TABLE OVERWRITE activity_template SCHEMAFULL
  PERMISSIONS
    -- SELECT: Global templates OR templates where org matches (handle both string and record)
    FOR select WHERE
      scope = 'global'
      OR org_id IS NONE
      OR org_id = $auth.org_id
      OR org_id = string::replace(type::string($auth.org_id), 'organizations:', '')

    -- CREATE: Authenticated users can create
    FOR create WHERE $auth != NONE

    -- UPDATE: Users can update their org's templates
    FOR update WHERE
      org_id IS NONE
      OR org_id = $auth.org_id
      OR org_id = string::replace(type::string($auth.org_id), 'organizations:', '')

    -- DELETE: Users can delete their org's templates
    FOR delete WHERE
      org_id IS NONE
      OR org_id = $auth.org_id
      OR org_id = string::replace(type::string($auth.org_id), 'organizations:', '');

-- =============================================================================
-- Step 2: Update variant_performance_metrics table
-- =============================================================================

DEFINE TABLE OVERWRITE variant_performance_metrics SCHEMAFULL
  PERMISSIONS
    -- SELECT: Metrics where org matches (handle both formats)
    FOR select WHERE
      org_id IS NONE
      OR org_id = $auth.org_id
      OR org_id = string::replace(type::string($auth.org_id), 'organizations:', '')

    -- CREATE: Authenticated users can create
    FOR create WHERE $auth != NONE

    -- UPDATE: Users can update their org's metrics
    FOR update WHERE
      org_id IS NONE
      OR org_id = $auth.org_id
      OR org_id = string::replace(type::string($auth.org_id), 'organizations:', '')

    -- DELETE: Only for own org
    FOR delete WHERE
      org_id IS NONE
      OR org_id = $auth.org_id
      OR org_id = string::replace(type::string($auth.org_id), 'organizations:', '');

-- =============================================================================
-- Step 3: Update activity_executions table (if it exists)
-- =============================================================================

DEFINE TABLE OVERWRITE IF EXISTS activity_executions SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id IS NONE
      OR org_id = $auth.org_id
      OR org_id = string::replace(type::string($auth.org_id), 'organizations:', '')
    FOR create WHERE $auth != NONE
    FOR update WHERE
      org_id IS NONE
      OR org_id = $auth.org_id
      OR org_id = string::replace(type::string($auth.org_id), 'organizations:', '')
    FOR delete WHERE
      org_id IS NONE
      OR org_id = $auth.org_id;

-- =============================================================================
-- Note: Future Migration Steps
-- =============================================================================
-- After this migration stabilizes, a follow-up migration should:
--   1. Add org_id_ref TYPE record<organizations> field
--   2. Backfill: UPDATE table SET org_id_ref = type::thing('organizations', org_id) WHERE org_id != NONE
--   3. Update application code to write to org_id_ref
--   4. Update PERMISSIONS to use org_id_ref
--   5. Drop org_id string field
--   6. Rename org_id_ref to org_id
-- =============================================================================
