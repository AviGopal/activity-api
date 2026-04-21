-- ============================================================================
-- Migration 070: Fix impulse_resolution_metrics org_id Type
-- ============================================================================
-- Purpose: Change org_id from record<organization> to string to match auth
-- Related: GitHub issue - impulse metrics returning 500 error
-- ============================================================================

-- Remove the old field definition
REMOVE FIELD org_id ON impulse_resolution_metrics;

-- Re-define with correct type (string instead of record<organization>)
DEFINE FIELD org_id ON impulse_resolution_metrics TYPE string;

-- Note: PERMISSIONS already use org_id = $auth.org_id (string comparison)
-- This fix aligns the field type with the PERMISSIONS clause
