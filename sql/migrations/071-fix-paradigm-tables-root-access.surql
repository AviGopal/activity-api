-- ============================================================================
-- Migration 071: Fix Paradigm Tables to Allow Root Access
-- ============================================================================
-- Purpose: Update PERMISSIONS on paradigm core tables to allow root access
-- Problem: Root credentials have no org_id, failing "$auth.org_id != NONE" check
-- Solution: Allow any authenticated user to CREATE (org_id still enforced by ASSERT)
-- ============================================================================

-- ============================================================================
-- Table: impulse
-- ============================================================================

DEFINE TABLE impulse OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE
      $auth != NONE  -- Allow any authenticated user (including root)
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id);

-- ============================================================================
-- Table: activity
-- ============================================================================

DEFINE TABLE activity OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      (scope = 'global' AND public = true)
      OR (org_id = $auth.org_id)
      OR (scope = 'project' AND project_id IN $auth.project_ids)
    FOR create WHERE
      $auth != NONE  -- Allow any authenticated user (including root)
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      org_id = $auth.org_id
      AND $auth.role = 'admin';

-- ============================================================================
-- Table: execution
-- ============================================================================

DEFINE TABLE execution OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE
      $auth != NONE  -- Allow any authenticated user (including root)
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      org_id = $auth.org_id
      AND $auth.role = 'admin';

-- ============================================================================
-- Notes:
-- ============================================================================
-- - Changed create PERMISSIONS from "$auth.org_id != NONE" to "$auth != NONE"
-- - This allows root users (who have no org_id) to create records
-- - Multi-tenant isolation still enforced by:
--   1. ASSERT on org_id field (must be provided)
--   2. SELECT/UPDATE/DELETE PERMISSIONS still check org_id
-- - Root users can create records for any org by providing org_id explicitly
--   This is acceptable since root has full database access anyway
-- ============================================================================

-- ============================================================================
-- Verification
-- ============================================================================
-- Run after applying:
-- INFO FOR TABLE impulse;
-- INFO FOR TABLE activity;
-- INFO FOR TABLE execution;
--
-- Test impulse creation with root credentials:
-- UPDATE impulse:test-root-create CONTENT {
--   id: "test-root-create",
--   pointer: { type: "memo", content: "test" },
--   shape: "test",
--   org_id: "metabob"
-- };
-- ============================================================================
