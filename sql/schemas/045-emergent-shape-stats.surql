-- ============================================================================
-- Emergent Shape Statistics
-- ============================================================================
-- Shapes are free-form strings that emerge from usage. This schema tracks
-- shape statistics to understand the network topology, NOT to constrain
-- what shapes are valid.
--
-- Philosophy:
-- - Shapes are discovered, not prescribed
-- - Shapes without resolvers are fine (system learns what works)
-- - Inference heuristics provide starting points, refined by execution data
-- - These views reveal the network; they don't define it
-- ============================================================================

-- ============================================================================
-- View: v_shape_usage
-- ============================================================================
-- Purpose: Aggregate shape usage across activities
-- Shows which shapes exist in the network and how frequently they're used
-- ============================================================================

-- =============================================================================
-- 2026-08-03 REWRITE — why these are flat projections, not aggregates
-- =============================================================================
-- The original definitions used `DEFINE TABLE ... AS SELECT ... FROM (subquery)`
-- with UNION ALL + SPLIT. SurrealDB 2.3.3 rejects ALL THREE of those inside a
-- DEFINE TABLE ... AS, so this file failed to PARSE on every boot since it was
-- written — and because a .surql file applies as one unit, NONE of the four
-- shape views has ever existed. The endpoint returned {"usage":[],"total":0},
-- which is indistinguishable from "no data yet".
--
-- Verified against the live 2.3.3 engine (throwaway namespace), not from docs:
--   DEFINE TABLE z AS SELECT .. FROM (SELECT ..)      -> Parse error `(`
--   DEFINE TABLE z AS SELECT a AS s FROM t SPLIT s    -> Parse error
--   DEFINE TABLE z AS SELECT a FROM t1 UNION ALL ..   -> Parse error
--   DEFINE TABLE z AS SELECT a, b FROM t WHERE ..     -> OK
--   SELECT a FROM t SPLIT a                           -> OK  (query time)
--
-- So the per-shape fan-out moves to READ time. These views now expose the raw
-- rows a caller SPLITs/GROUPs itself. That keeps the same source of truth with
-- no subquery, and it is honest about the cost: aggregation is per-query.
--
-- SCOPE, stated plainly: these aggregate DECLARED input_shapes/output_shapes on
-- `activity` (and declared input_impulse_shapes on `execution`). That is shape
-- USAGE. Learning a shape's observed FORMAT — field names and types of real
-- payloads — has no machinery anywhere in the substrate and is NOT added here.
-- =============================================================================

-- v_shape_usage_src — one row per activity with its declared shapes.
-- Callers SPLIT input_shapes / output_shapes at query time.
DEFINE TABLE IF NOT EXISTS v_shape_usage_src AS
  SELECT
    id AS activity_id,
    org_id,
    input_shapes,
    output_shapes
  FROM activity
  WHERE (array::len(input_shapes) > 0 OR array::len(output_shapes) > 0)
    AND (retired = false OR retired IS NONE)
PERMISSIONS FOR select FULL;

-- v_shape_execution_src — per-execution declared input shapes plus the outcome,
-- so a caller can compute per-shape success rates by SPLITting input_impulse_shapes.
DEFINE TABLE IF NOT EXISTS v_shape_execution_src AS
  SELECT
    activity_id,
    org_id,
    input_impulse_shapes,
    success,
    duration_ms,
    executed_at
  FROM execution
  WHERE array::len(input_impulse_shapes) > 0
PERMISSIONS FOR select FULL;

DEFINE INDEX IF NOT EXISTS idx_v_shape_usage_src_activity ON v_shape_usage_src FIELDS activity_id;
DEFINE INDEX IF NOT EXISTS idx_v_shape_exec_src_activity ON v_shape_execution_src FIELDS activity_id;
