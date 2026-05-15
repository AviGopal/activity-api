-- =============================================================================
-- Migration 129: Fix variant_performance_metrics PERMISSIONS — $auth → $token
-- =============================================================================
-- Created: 2026-05-15
-- Root cause: Migration 030 defined the CREATE permission as
--   FOR create WHERE $auth != NONE
-- but apikey_token ACCESS is TYPE JWT, so $auth is always NONE for API-key
-- requests ($token gets the JWT claims). Migration 080 fixed this pattern for
-- many tables but missed variant_performance_metrics; migration 099 re-applied
-- the same broken $auth guard in the OVERWRITE definition.
--
-- Effect: every INSERT into variant_performance_metrics via queryWithAuth was
-- silently denied — PERMISSIONS evaluate false, no error, empty RETURN AFTER.
-- Thompson posteriors for NEW templates never got their first row created via
-- the API-key path (18K+ existing rows were inserted before the guard was
-- broken, or via the root path in earlier code).
--
-- Fix: replace $auth with $token in CREATE + SELECT/UPDATE/DELETE, following
-- the exact pattern migration 080 applied to the other tables. The 4-cast
-- org_id variants from migration 074 / 099 are preserved.
--
-- Code fix (belt-and-suspenders): execution-traces.ts also switched the
-- variant_performance_metrics SELECT+INSERT/UPDATE to surrealDB.query() (root
-- path), matching the AET INSERT root-path fix from migration 121 comments.
-- =============================================================================

DEFINE TABLE variant_performance_metrics OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id IS NONE
      OR ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND (org_id = $token.org_id OR org_id = <string>$token.org_id
        OR <string>org_id = $token.org_id OR <string>org_id = <string>$token.org_id))
    FOR create WHERE $token.org_id IS NOT NONE
    FOR update WHERE org_id IS NONE
      OR ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND (org_id = $token.org_id OR org_id = <string>$token.org_id
        OR <string>org_id = $token.org_id OR <string>org_id = <string>$token.org_id))
    FOR delete WHERE org_id IS NONE
      OR ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND (org_id = $token.org_id OR org_id = <string>$token.org_id
        OR <string>org_id = $token.org_id OR <string>org_id = <string>$token.org_id));
