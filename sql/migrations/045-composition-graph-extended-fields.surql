-- =============================================================================
-- Migration: 045-composition-graph-extended-fields
-- Description: Add extended fields to activity_composition_graph for impulse
--              flow tracking and performance metrics.
-- Date: 2026-04-07
-- =============================================================================

-- Add duration_ms for performance tracking
DEFINE FIELD duration_ms ON activity_composition_graph TYPE option<float>
  COMMENT "Duration of composition execution in milliseconds";

-- Add cost_usd for cost tracking
DEFINE FIELD cost_usd ON activity_composition_graph TYPE option<float>
  COMMENT "Cost of composition execution in USD";

-- Add tokens_input for token tracking
DEFINE FIELD tokens_input ON activity_composition_graph TYPE option<int>
  COMMENT "Input tokens used in composition";

-- Add tokens_output for token tracking
DEFINE FIELD tokens_output ON activity_composition_graph TYPE option<int>
  COMMENT "Output tokens generated in composition";

-- Add depth for composition nesting tracking
DEFINE FIELD depth ON activity_composition_graph TYPE option<int>
  COMMENT "Nesting depth of composition (0 = root)";

-- Add composition_chain for ancestry tracking
DEFINE FIELD composition_chain ON activity_composition_graph TYPE option<array<string>>
  COMMENT "Full ancestry path from root activity";

-- Add input_impulse_shapes for shape-based routing
DEFINE FIELD input_impulse_shapes ON activity_composition_graph TYPE option<array<string>>
  COMMENT "Shapes of input impulses that flow into child activity";

-- Add output_impulse_shapes for shape-based routing
DEFINE FIELD output_impulse_shapes ON activity_composition_graph TYPE option<array<string>>
  COMMENT "Shapes of output impulses produced by child activity";

-- Verify migration
RETURN "Migration 045-composition-graph-extended-fields completed";
