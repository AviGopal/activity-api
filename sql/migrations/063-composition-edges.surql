-- ============================================================================
-- Migration 063: Composition Edge Learning (Phase 3)
-- ============================================================================
-- Purpose: Enable composition learning by tracking activity transitions
-- Related: IMPULSE_DRIVEN_COMPOSITION.md - Section 4 (Composition Learning)
-- ============================================================================

-- Composition Edge Table
-- Records parent → child activity transitions with state signatures
DEFINE TABLE IF NOT EXISTS composition_edge SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Parent activity (what ran first)
DEFINE FIELD IF NOT EXISTS parent_activity_id ON composition_edge TYPE string
  ASSERT $value != NONE
  COMMENT "Activity ID that completed before the child activity";

-- Child activity (what ran after)
DEFINE FIELD IF NOT EXISTS child_activity_id ON composition_edge TYPE string
  ASSERT $value != NONE
  COMMENT "Activity ID that started after the parent activity";

-- State signature before child execution
DEFINE FIELD IF NOT EXISTS state_signature_before ON composition_edge TYPE string
  ASSERT $value != NONE
  COMMENT "SHA-256 hash of state (shapes + git + env) before child execution";

-- State signature after child execution
DEFINE FIELD IF NOT EXISTS state_signature_after ON composition_edge TYPE string
  ASSERT $value != NONE
  COMMENT "SHA-256 hash of state (shapes + git + env) after child execution";

-- Execution outcome
DEFINE FIELD IF NOT EXISTS success ON composition_edge TYPE bool
  ASSERT $value != NONE
  COMMENT "Whether the child activity succeeded";

-- Execution duration
DEFINE FIELD IF NOT EXISTS duration_ms ON composition_edge TYPE int
  ASSERT $value >= 0
  VALUE $value OR 0
  COMMENT "Duration of child activity execution in milliseconds";

-- Multi-tenancy
DEFINE FIELD IF NOT EXISTS org_id ON composition_edge TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON composition_edge TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

-- Metadata
DEFINE FIELD IF NOT EXISTS created_at ON composition_edge TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Edge creation timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_composition_edge_org
  ON composition_edge FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_composition_edge_parent
  ON composition_edge FIELDS parent_activity_id;

DEFINE INDEX IF NOT EXISTS idx_composition_edge_child
  ON composition_edge FIELDS child_activity_id;

DEFINE INDEX IF NOT EXISTS idx_composition_edge_state_before
  ON composition_edge FIELDS state_signature_before;

-- Composite index for successor queries (parent + state → children)
DEFINE INDEX IF NOT EXISTS idx_composition_edge_parent_state
  ON composition_edge FIELDS parent_activity_id, state_signature_before;

-- Composite index for multi-tenant queries
DEFINE INDEX IF NOT EXISTS idx_composition_edge_org_parent
  ON composition_edge FIELDS org_id, parent_activity_id;

-- ============================================================================
-- Usage Notes:
--
-- 1. Recording an edge (after child activity completes):
--    INSERT INTO composition_edge {
--      parent_activity_id: "fix-bug",
--      child_activity_id: "run-tests",
--      state_signature_before: "abc123...",
--      state_signature_after: "def456...",
--      success: true,
--      duration_ms: 5000,
--      org_id: $auth.org_id
--    };
--
-- 2. Query successors (what should run after parent in similar state):
--    SELECT child_activity_id,
--           COUNT() as total_occurrences,
--           math::sum(success::int) as successful_occurrences,
--           math::sum(success::int) / COUNT() as success_rate
--    FROM composition_edge
--    WHERE parent_activity_id = "fix-bug"
--      AND state_signature_before = "abc123..."
--      AND org_id = $auth.org_id
--    GROUP BY child_activity_id
--    ORDER BY success_rate DESC, total_occurrences DESC;
--
-- 3. State signature calculation (in application code):
--    import { generateStateSignature } from './state-space-manager';
--    const signature = generateStateSignature(shapes, gitState, environment);
--
-- ============================================================================
-- Verification query (run after migration):
-- INFO FOR TABLE composition_edge;
-- ============================================================================
