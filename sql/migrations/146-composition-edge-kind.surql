-- =============================================================================
-- Migration: 146-composition-edge-kind
-- Description: Durably distinguish GENUINE producer→consumer shape-flow edges
--              from wrapper/dispatch SCAFFOLD edges and lifecycle HUB spokes on
--              activity_composition_graph rows (C7 / SUBSTRATE_AS_DYNAMICS §3-4).
--
--   Before this migration, "genuine vs scaffold" was decided only at READ time by
--   heuristic node-name filtering (touchesHook / compose-* / genuine-edge-probe).
--   The selection scaffold-exclusion gate and the spectral-gap reader both had to
--   re-derive it on every read, and could not trust a persisted signal. This adds
--   a durable `edge_kind` discriminator (and a convenience `genuine` boolean) that
--   each writer sets at WRITE time, so readers can PREFER the persisted column and
--   fall back to the heuristic only for legacy untagged rows.
--
--   activity_composition_graph is SCHEMAFULL (sql/schemas/011-executions.surql),
--   so undeclared CONTENT fields are silently DROPPED — the column must be DEFINEd
--   before any writer can persist it. Both fields are `option<>` so legacy rows
--   (and any writer that omits them) remain valid with the field absent → NONE,
--   which read-time consumers treat as "untagged, apply the heuristic".
-- Date: 2026-06-26
-- =============================================================================

-- edge_kind: 'genuine' | 'scaffold' | 'hub' (free-form string, option so legacy
-- rows stay valid with NONE). 'genuine' = a real producer-shape → consumer-shape
-- capability edge; 'scaffold' = a wrapper/dispatch-nesting spoke (compose-* /
-- genuine-edge-probe orchestration that records wrapper→child, not A→B);
-- 'hub' = a lifecycle-hub spoke (validator-dispatch / slot-binding nests under
-- every execution and carries no capability-to-capability credit).
DEFINE FIELD IF NOT EXISTS edge_kind ON activity_composition_graph TYPE option<string>
  COMMENT "Edge classification: 'genuine' (producer→consumer shape-flow), 'scaffold' (wrapper/dispatch-nesting), or 'hub' (lifecycle hub spoke). NONE on legacy rows → read-time heuristic applies.";

-- genuine: convenience boolean mirroring (edge_kind == 'genuine'). Lets readers and
-- SQL filters test a single boolean without string compares. option so legacy rows
-- stay valid with NONE.
DEFINE FIELD IF NOT EXISTS genuine ON activity_composition_graph TYPE option<bool>
  COMMENT "True iff edge_kind = 'genuine' (a producer→consumer capability edge). NONE on legacy/untagged rows.";

-- Verify migration
RETURN "Migration 146-composition-edge-kind completed";
