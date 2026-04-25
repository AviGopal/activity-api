-- Migration 087: Fix Global Template Write Access Bypass
--
-- Problem: activityTemplate_update and activityTemplate_deprecate had WHERE clauses
-- matching `(org_id = $orgId OR scope = 'global')`, which allowed any authenticated
-- tenant to mutate system-owned global templates.
--
-- Fix: Restrict UPDATE and DELETE on `scope = 'global'` rows to callers whose
-- JWT claims carry `$auth.role = 'admin'`. This matches the application-level
-- check added to src/routes/impulses.ts (Spec 6).
--
-- Safe to re-run: DEFINE TABLE … OVERWRITE is idempotent in SurrealDB.
-- Affects: activity table UPDATE and DELETE PERMISSIONS.

-- Redefine PERMISSIONS for the `activity` table so that:
--   SELECT: unchanged — all authenticated callers see global + their org's templates
--   CREATE: unchanged — callers can create their own templates
--   UPDATE: own templates OR (global template AND caller is admin)
--   DELETE: own templates OR (global template AND caller is admin)
--
-- NOTE: $token is used instead of $auth because API-key auth populates $token
-- but not $auth (see docs/RBAC_GUIDE.md §$auth vs $token).

DEFINE TABLE activity OVERWRITE
  PERMISSIONS
    FOR select WHERE
      scope = 'global'
      OR org_id IS NONE
      OR org_id = $token.org_id
      OR org_id = <string>$token.org_id
    FOR create WHERE
      $token.org_id != NONE
    FOR update WHERE
      (org_id = $token.org_id OR org_id = <string>$token.org_id)
      OR (scope = 'global' AND $auth.role = 'admin')
    FOR delete WHERE
      (org_id = $token.org_id OR org_id = <string>$token.org_id)
      OR (scope = 'global' AND $auth.role = 'admin');
