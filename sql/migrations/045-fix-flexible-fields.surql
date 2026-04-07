-- =============================================================================
-- Migration 045: Fix FLEXIBLE field definitions
-- =============================================================================
-- Problem: The `tasks.*` and `output_impulses.*` sub-field definitions
-- override the FLEXIBLE behavior on the parent arrays, causing SurrealDB
-- to reject documents with nested fields like `tasks[0].description`.
--
-- Solution: Remove the sub-field definitions so the parent FLEXIBLE works.
--
-- Also fixes the `created_by` field on `impulse` table to accept string values
-- (for backward compatibility with MiniBob sending instance ID as string).
-- =============================================================================

-- Remove sub-field definitions that override FLEXIBLE behavior
REMOVE FIELD IF EXISTS tasks.* ON activity_execution_traces;
REMOVE FIELD IF EXISTS output_impulses.* ON activity_execution_traces;

-- Ensure impulse.created_by accepts string values for backward compatibility
-- (MiniBob may send instance_id as string instead of record reference)
REMOVE FIELD IF EXISTS created_by ON impulse;
DEFINE FIELD created_by ON impulse TYPE option<string | record<users> | record<minibob_instance>>
  VALUE $value OR $auth.id
  COMMENT "User, MiniBob instance, or instance ID string who created this impulse";

-- Ensure execution trace created_by also accepts string values
REMOVE FIELD IF EXISTS created_by ON activity_execution_traces;
DEFINE FIELD created_by ON activity_execution_traces TYPE option<string | record<users> | record<minibob_instance>>
  VALUE $value OR $auth.id
  COMMENT "User, MiniBob instance, or instance ID string who created this execution";
