-- ============================================================================
-- Migration 081: Persist composition_chain on execution trace tables
-- ============================================================================
-- Purpose: Store the denormalized ancestor chain (root -> ... -> current) for
--          each execution trace, so dashboards / learning consumers can
--          reconstruct composition trees in a single read instead of walking
--          `parent_execution_id` pointers hop-by-hop.
--
-- Background: MiniBob's three-level activity tracing (L1 goal_resolve,
--             L2 activity_execute, L3 template_run) sends both
--             `parent_execution_id` and `composition_chain` on every trace.
--             `parent_execution_id` is already persisted on both trace tables;
--             `composition_chain` was being silently dropped because neither
--             table had a field for it.
--
-- Data model: `composition_chain` is an ordered array of execution_id strings
--             where index 0 is the root ancestor (typically an L1
--             goal_resolve) and the last element is the parent of the
--             current trace. The current trace's own execution_id is NOT
--             included in the chain (it's the node, not part of its ancestry).
--
-- Date: 2026-04-21
-- Related: minibob trace-unification phase 2 (three-level tracing)
-- ============================================================================

-- 1. Legacy trace table (still the primary write path in execution-traces.ts)
DEFINE FIELD IF NOT EXISTS composition_chain ON activity_execution_traces
  TYPE option<array<string>>
  COMMENT "Denormalized ancestor chain: [root_execution_id, ..., parent_execution_id]. Ordered root-first.";

-- 2. Paradigm-aligned execution table (dual-write target)
DEFINE FIELD IF NOT EXISTS composition_chain ON execution
  TYPE option<array<string>>
  COMMENT "Denormalized ancestor chain: [root_execution_id, ..., parent_execution_id]. Ordered root-first.";

-- 3. Indexes for root-ancestor / membership lookups
--    (SurrealDB indexes arrays element-wise, so this enables queries like
--    `WHERE 'root-exec-id' IN composition_chain` efficiently.)
DEFINE INDEX IF NOT EXISTS idx_activity_execution_traces_composition_chain
  ON activity_execution_traces FIELDS composition_chain;

DEFINE INDEX IF NOT EXISTS idx_execution_composition_chain
  ON execution FIELDS composition_chain;
