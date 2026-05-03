-- =============================================================================
-- Migration 121: Fix trace table PERMISSIONS to accept $token.org_id
-- =============================================================================
-- Date: 2026-05-03
--
-- Problem: activity_execution_traces, trace_digest, execution_trace_content,
-- and execution_system_traces all have:
--   FOR create WHERE $auth.org_id != NONE
--
-- API-key auth (JWT via DEFINE ACCESS apikey_token TYPE JWT) only populates
-- $token, not $auth. $auth is only set for record users (dashboard JWT).
-- As a result, all INSERT attempts via queryWithAuth (the auth session pool)
-- silently produced empty results — PERMISSIONS blocked the create, no error
-- was thrown, and the calling code incorrectly treated empty = PERMISSIONS-
-- filtered RETURN AFTER (F-121 root cause).
--
-- Fix: Change FOR create guards to accept EITHER $auth OR $token org_id.
-- SELECT/UPDATE/DELETE guards are also updated to use the $token path so
-- future reads via queryWithAuth work correctly (currently reads bypass this
-- via root connection in GET handlers).
-- =============================================================================

USE NS `activity-system` DB `learning_loop`;

-- SurrealDB 3.0.0 uses ALTER TABLE to update PERMISSIONS on existing tables.
-- DEFINE TABLE OVERWRITE and plain DEFINE TABLE both fail on existing tables
-- in this version. ALTER TABLE modifies only the specified attributes,
-- leaving existing rows, field definitions, and indexes untouched.

-- activity_execution_traces ---------------------------------------------------
ALTER TABLE activity_execution_traces
  PERMISSIONS
    FOR select WHERE
      (
        ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR ($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND (
          org_id = $auth.org_id
          OR org_id = $token.org_id
          OR org_id = <string>$auth.org_id
          OR org_id = <string>$token.org_id
        ))
      )
      AND (project_id IS NONE OR project_id IN $auth.project_ids
        OR $auth.project_ids IS NONE OR array::len($auth.project_ids) = 0
        OR project_id IN $token.project_ids
        OR $token.project_ids IS NONE OR array::len($token.project_ids) = 0)
    FOR create WHERE $auth.org_id != NONE OR $token.org_id != NONE
    FOR update WHERE
      (
        ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR ($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND (org_id = $auth.org_id OR org_id = $token.org_id))
      )
      AND ($auth.role = 'admin' OR $token.role = 'admin' OR created_by = $auth.id OR created_by = $token.id)
    FOR delete WHERE
      (
        ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR ($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND (org_id = $auth.org_id OR org_id = $token.org_id))
      )
      AND ($auth.role = 'admin' OR $token.role = 'admin');

-- trace_digest ----------------------------------------------------------------
ALTER TABLE trace_digest
  PERMISSIONS
    FOR select WHERE
      (org_id = $auth.org_id OR org_id = $token.org_id)
      AND (project_id IS NONE OR project_id IN $auth.project_ids OR project_id IN $token.project_ids)
    FOR create WHERE $auth.org_id != NONE OR $token.org_id != NONE
    FOR update WHERE (org_id = $auth.org_id OR org_id = $token.org_id)
      AND ($auth.role = 'admin' OR $token.role = 'admin')
    FOR delete WHERE (org_id = $auth.org_id OR org_id = $token.org_id)
      AND ($auth.role = 'admin' OR $token.role = 'admin');

-- execution_trace_content -----------------------------------------------------
ALTER TABLE execution_trace_content
  PERMISSIONS
    FOR select WHERE
      (org_id = $auth.org_id OR org_id = $token.org_id)
      AND (project_id IS NONE OR project_id IN $auth.project_ids OR project_id IN $token.project_ids)
    FOR create WHERE $auth.org_id != NONE OR $token.org_id != NONE
    FOR update WHERE (org_id = $auth.org_id OR org_id = $token.org_id)
      AND ($auth.role = 'admin' OR $token.role = 'admin')
    FOR delete WHERE (org_id = $auth.org_id OR org_id = $token.org_id)
      AND ($auth.role = 'admin' OR $token.role = 'admin');

-- execution_system_traces -----------------------------------------------------
ALTER TABLE execution_system_traces
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id OR org_id = $token.org_id
    FOR create WHERE $auth.org_id != NONE OR $token.org_id != NONE
    FOR update WHERE (org_id = $auth.org_id OR org_id = $token.org_id)
      AND ($auth.role = 'admin' OR $token.role = 'admin')
    FOR delete WHERE (org_id = $auth.org_id OR org_id = $token.org_id)
      AND ($auth.role = 'admin' OR $token.role = 'admin');
