-- Phase 10 P4.5 of 2026-04-26-impulse-activity-loop: shape gap resolution index.
--
-- When MiniBob's slot-binding meta-activity escalates a missing shape via
-- `create-shape-provider-goal`, the resulting recursive sub-goal can be
-- expensive (one full goal-processing cycle, potentially with its own
-- escalations). Most of the gaps we hit aren't novel — the same shape
-- has already been resolved by some other path before. This table caches
-- the resolution so escalation can short-circuit when the gap is one we've
-- previously bridged.
--
-- Records:
--   shape            — the missing impulse shape
--   account_id       — owning account (option<string>; NONE means cross-
--                       account / system-wide resolution available)
--   resolved_by      — activity_id or vessel_id that produced the shape
--   required_scope   — caller-scope string the resolver needed (e.g.
--                       account_<id>:<resource>:<role>); NONE if the
--                       resolution is scope-free
--   resolution_type  — how the gap was bridged:
--                       "activity"        — dispatched a known activity
--                       "vessel"          — discovery-vessel routed to a
--                                           specific vessel
--                       "subgoal"         — recursive create-shape-provider-goal
--                       "manual_seed"     — operator-seeded into the pool
--   escalation_depth — composition_chain length at the resolution point;
--                       lets us cap re-escalation when nesting gets deep
--   cost_usd         — observed resolution cost (sum of dispatched activity
--                       cost_usd values in the resolving sub-tree)
--   times_used       — incremented every time slot-binding consults this
--                       row to satisfy a gap; used to age out stale entries
--   first_seen_at    — created_at; useful for time-window quality checks
--   last_used_at     — updated each time slot-binding hits the row
--
-- Phase B-followup: dual-tenant scoped via SurrealDB PERMISSIONS so a
-- caller can only see rows for their org / account chain. Until row-level
-- permissions ship across the rest of the schema, we reuse the
-- `account_id IS NONE` (cross-account) + `account_id = $token.account_id`
-- pattern other tables in this migration set use.
--
-- Idempotent via DEFINE TABLE / FIELD / INDEX with IF NOT EXISTS.

DEFINE TABLE IF NOT EXISTS shape_gap_resolution SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete
      WHERE org_id = $token.org_id
        AND (account_id IS NONE
             OR account_id = $token.account_id
             OR $token.account_id IS NONE)
    FOR create
      WHERE org_id = $token.org_id;

-- Required identity / shape fields.
DEFINE FIELD IF NOT EXISTS shape           ON shape_gap_resolution TYPE string
  ASSERT $value != NONE AND string::len($value) > 0
  COMMENT "Missing impulse shape that this row records a resolution for.";
DEFINE FIELD IF NOT EXISTS account_id      ON shape_gap_resolution TYPE option<string>
  COMMENT "Owning account; NONE = cross-account / system-wide resolution.";
DEFINE FIELD IF NOT EXISTS account_id_version ON shape_gap_resolution TYPE option<int>
  COMMENT "Phase B account_id schema version; default 1.";
DEFINE FIELD IF NOT EXISTS org_id          ON shape_gap_resolution TYPE string
  COMMENT "Organization slug. Required for tenant scoping.";

-- Resolution metadata.
DEFINE FIELD IF NOT EXISTS resolved_by     ON shape_gap_resolution TYPE string
  ASSERT $value != NONE AND string::len($value) > 0
  COMMENT "Activity id or vessel id that produced the shape.";
DEFINE FIELD IF NOT EXISTS required_scope  ON shape_gap_resolution TYPE option<string>
  COMMENT "Caller scope string needed by the resolver; NONE if scope-free.";
DEFINE FIELD IF NOT EXISTS resolution_type ON shape_gap_resolution TYPE string
  ASSERT $value INSIDE ['activity', 'vessel', 'subgoal', 'manual_seed']
  COMMENT "How the gap was bridged. See migration 105 header for legend.";
DEFINE FIELD IF NOT EXISTS escalation_depth ON shape_gap_resolution TYPE int
  ASSERT $value >= 0
  COMMENT "composition_chain length at the resolution point; caps re-escalation.";

-- Cost / usage tracking.
DEFINE FIELD IF NOT EXISTS cost_usd        ON shape_gap_resolution TYPE float DEFAULT 0
  COMMENT "Observed resolution cost (sum of resolving sub-tree's cost_usd).";
DEFINE FIELD IF NOT EXISTS times_used      ON shape_gap_resolution TYPE int DEFAULT 0
  COMMENT "Increments each time slot-binding hits the row.";

-- Timestamps.
DEFINE FIELD IF NOT EXISTS first_seen_at   ON shape_gap_resolution TYPE datetime DEFAULT time::now()
  COMMENT "When this gap-resolution was first recorded.";
DEFINE FIELD IF NOT EXISTS last_used_at    ON shape_gap_resolution TYPE datetime DEFAULT time::now()
  COMMENT "When slot-binding most recently hit this row.";

-- Lookup index: slot-binding consults by (shape, account_id) for hot-path
-- match. account_id NONE rows match every account.
DEFINE INDEX IF NOT EXISTS idx_shape_gap_lookup
  ON shape_gap_resolution FIELDS shape, account_id;

-- Hygiene index: time-window scans for staleness eviction.
DEFINE INDEX IF NOT EXISTS idx_shape_gap_last_used
  ON shape_gap_resolution FIELDS last_used_at;
