-- 148-composition-edge-shape-flow.surql
-- Shape-flow fields on activity_composition_graph so genuine-edge classification
-- is backed by REAL producer→consumer shape overlap, not node-name substrings.
-- SCHEMAFULL table drops undeclared fields, so define before any writer persists.
-- input/output_impulse_shapes = the consumer-in / producer-out shape sets;
-- shape_flow = their intersection (the shapes that actually flow across the edge);
-- edge_kind_source = provenance of the edge_kind verdict ('shape-flow-reconcile'
-- vs the legacy node-name heuristic). (2026-06-26)
DEFINE FIELD OVERWRITE input_impulse_shapes ON activity_composition_graph TYPE option<array<string>>;
DEFINE FIELD OVERWRITE output_impulse_shapes ON activity_composition_graph TYPE option<array<string>>;
DEFINE FIELD OVERWRITE shape_flow ON activity_composition_graph TYPE option<array<string>>;
DEFINE FIELD OVERWRITE edge_kind_source ON activity_composition_graph TYPE option<string>;
RETURN "Migration 148-composition-edge-shape-flow completed";
