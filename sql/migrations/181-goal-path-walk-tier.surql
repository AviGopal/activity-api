-- Migration 181: walk_tier field on goal_execution_paths (ratchet legibility).
-- goal_execution_paths is SCHEMAFULL, so recordGoalPath's walk_tier was silently
-- dropped (null for all rows). Define the field so the tier (learned_pathway /
-- satisfier / universal_tool_fallback / feature_compose / fresh_derivation) persists,
-- making a goal's fresh-derivation -> learned-reuse transition legible.
DEFINE FIELD IF NOT EXISTS walk_tier ON goal_execution_paths TYPE option<string>;
