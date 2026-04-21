-- Migration 072: Add resolver tier tracking to impulse_relevance_metrics
--
-- Purpose: Enable learning which resolvers work best for which impulse shapes
--
-- Context:
-- Impulse resolution uses different tiers (deterministic/pattern/llm) but this
-- information wasn't tracked. Backend can't learn "use file resolver for
-- source_code shapes" without knowing which resolver succeeded.
--
-- Changes:
-- - Add resolver_tier field (LOCAL, CUSTOM, DISCOVERY, MCP, FALLBACK, ERROR)
-- - Add resolver_name field (memo, file, directoryTree, gitDiff, VesselClient, etc.)
-- - Add avg_resolution_latency_ms field (average resolution time)
-- - Add resolver_success_count field (number of successful resolutions)
-- - Add resolver_failure_count field (number of failed resolutions)
--
-- Learning Applications:
-- 1. Resolver Selection: Track success rate per resolver per shape
-- 2. Vessel Performance: Measure latency per vessel, detect degradation
-- 3. Cost Optimization: Identify expensive patterns, prefer deterministic resolvers
-- 4. Pattern Recognition: Learn which resolvers work together
--
-- References:
-- - CLAUDE.md: "Resolver tier tracking to impulse relevance metrics"
-- - docs/architecture/RESOLVER_TRACKING.md
-- - repos/minibob/src/resolution-tracker.ts

-- Add resolver tier field (what tier was used to resolve this impulse)
DEFINE FIELD resolver_tier ON impulse_relevance_metrics TYPE option<string>
  COMMENT "Resolution tier used: LOCAL, CUSTOM, DISCOVERY, MCP, FALLBACK, ERROR";

-- Add resolver name field (which specific resolver was used)
DEFINE FIELD resolver_name ON impulse_relevance_metrics TYPE option<string>
  COMMENT "Resolver name: memo, file, directoryTree, gitDiff, VesselClient, mcp, etc.";

-- Add average resolution latency tracking
DEFINE FIELD avg_resolution_latency_ms ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Average resolution time in milliseconds";

-- Add resolver success/failure counters for learning
DEFINE FIELD resolver_success_count ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful resolutions";

DEFINE FIELD resolver_failure_count ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of failed resolutions";

-- Create index for resolver-based queries
DEFINE INDEX idx_impulse_relevance_resolver ON impulse_relevance_metrics FIELDS resolver_tier, resolver_name;

-- Create index for shape-based resolver queries (requires pointer_type field from earlier migration)
-- This enables queries like "which resolver works best for file pointers?"
DEFINE INDEX idx_impulse_relevance_shape_resolver ON impulse_relevance_metrics FIELDS pointer_type, resolver_tier, resolver_name;
