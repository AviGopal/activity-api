-- Migration 076: Register Resolver Shapes in shape_definition
-- Date: 2026-04-22
-- Purpose: Register 10 shapes that have resolver case statements in
--          src/routes/impulses.ts but were missing from the shape registry,
--          so clients had no way to validate pointers or understand expected
--          inputs. Each schema is derived directly from the resolver code.
--
-- Schemas describe the POINTER accepted by the resolver, not the content
-- returned. Follow the same style as migration 057.

-- ============================================================================
-- Read-only resolver shapes (live at metabob-activity-api)
-- ============================================================================

-- executionTraceList shape: Metadata-first list of execution trace pointers
INSERT INTO shape_definition {
  name: "executionTraceList",
  version: "1.0.0",
  description: "Metadata-first impulse returning execution trace pointers. Resolver returns loaded:false with aggregated summary and per-trace pointers rather than expanding content.",
  schema: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        enum: ["all", "successful", "failed"],
        description: "Filter by execution outcome (default: all)"
      },
      activityId: { type: "string", description: "Filter by activity id" },
      templateId: { type: "string", description: "Filter by template id (alias of activity_id)" },
      since: { type: "string", format: "date-time", description: "ISO timestamp lower bound" },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Max traces (default 50)" }
    }
  },
  example: {
    filter: "failed",
    activityId: "acquire-codebase-context",
    since: "2026-04-01T00:00:00Z",
    limit: 50
  },
  tags: ["learning", "trace", "metadata-first"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- variantMetricsSummary shape: Aggregated metrics across variants of a base activity
INSERT INTO shape_definition {
  name: "variantMetricsSummary",
  version: "1.0.0",
  description: "Metadata-first summary of Thompson Sampling metrics across all variants of a base activity. Returns bestVariant, worstVariant, avgSuccessRate plus per-variant pointers.",
  schema: {
    type: "object",
    properties: {
      activityId: { type: "string", description: "Base activity id to summarize variants for" }
    },
    required: ["activityId"]
  },
  example: {
    activityId: "acquire-codebase-context"
  },
  tags: ["learning", "metrics", "metadata-first", "thompson-sampling"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- compositionSuccess shape: Parent->child activity composition success rates
INSERT INTO shape_definition {
  name: "compositionSuccess",
  version: "1.0.0",
  description: "Composition graph edges with success rates learned from execution sequences. Use to find proven activity chains (>=80% success) and risky compositions (<50% success).",
  schema: {
    type: "object",
    properties: {
      parentActivityId: { type: "string", description: "Filter by parent (source) activity id" },
      childActivityId: { type: "string", description: "Filter by child (destination) activity id" },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Max edges (default 50)" }
    }
  },
  example: {
    parentActivityId: "debug-feature",
    limit: 20
  },
  tags: ["learning", "composition", "pattern"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- goal shape: Goal-based activity recommendation via Thompson Sampling
INSERT INTO shape_definition {
  name: "goal",
  version: "1.0.0",
  description: "Goal-conditioned activity recommendation. Resolver delegates to /v2/activities/recommend with optional impulse context. Returns ranked activity_recommendations with selection metadata.",
  schema: {
    type: "object",
    properties: {
      content: { type: "string", description: "Natural-language goal description" },
      category: { type: "string", description: "Optional activity category hint" },
      impulseRefs: {
        type: "array",
        items: { type: "string" },
        description: "Impulse ids already loaded in context, used to enrich Thompson Sampling priors"
      },
      excludeActivities: {
        type: "array",
        items: { type: "string" },
        description: "Activity ids to exclude (e.g. already attempted within this goal)"
      },
      expectedOutputShapes: {
        type: "array",
        items: { type: "string" },
        description: "Shapes the caller expects the selected activity to produce"
      },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "Top-N recommendations (default 3)" }
    },
    required: ["content"]
  },
  example: {
    content: "debug the failing authentication test",
    impulseRefs: ["error-log-123", "auth-source-456"],
    expectedOutputShapes: ["fixed_code", "git_commit"],
    limit: 3
  },
  tags: ["goal", "recommendation", "thompson-sampling"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- activityTemplateRecommendation shape: Similar template search
INSERT INTO shape_definition {
  name: "activityTemplateRecommendation",
  version: "1.0.0",
  description: "Free-text search over activity templates for similarity-based recommendation. Used by genesis templates to learn from existing definitions.",
  schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text search query" },
      category: { type: "string", description: "Optional category filter" },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "Max templates (default 3)" }
    }
  },
  example: {
    query: "test-driven refactor of authentication module",
    limit: 3
  },
  tags: ["template", "recommendation", "search"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- activityTemplatesByMetrics shape: Top performing templates
INSERT INTO shape_definition {
  name: "activityTemplatesByMetrics",
  version: "1.0.0",
  description: "Activity templates ranked by learned performance metrics (success_rate or total_executions). Used by genesis templates to learn from proven patterns.",
  schema: {
    type: "object",
    properties: {
      sortBy: {
        type: "string",
        enum: ["success_rate", "total_executions"],
        description: "Ranking dimension (default: success_rate)"
      },
      minExecutions: { type: "integer", minimum: 1, description: "Minimum execution count threshold (default 5)" },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "Max templates (default 2)" }
    }
  },
  example: {
    sortBy: "success_rate",
    minExecutions: 10,
    limit: 5
  },
  tags: ["template", "metrics", "learning"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- executionTraces shape: Multiple execution traces for a specific template
INSERT INTO shape_definition {
  name: "executionTraces",
  version: "1.0.0",
  description: "Multiple execution traces filtered by template and optional success status. Used by trailblazer templates for failure pattern analysis.",
  schema: {
    type: "object",
    properties: {
      templateId: { type: "string", description: "Activity template id to pull traces for" },
      success: { type: "boolean", description: "If set, filter to successful or failed only" },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Max traces (default 5)" }
    },
    required: ["templateId"]
  },
  example: {
    templateId: "acquire-codebase-context",
    success: false,
    limit: 5
  },
  tags: ["trace", "learning", "debugging"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- impulseRelevance shape: Bayesian impulse relevance metrics
INSERT INTO shape_definition {
  name: "impulseRelevance",
  version: "1.0.0",
  description: "Per-impulse-per-activity relevance scores. relevance_score = P(success|loaded), irrelevance_score = P(success|not loaded). Used to learn which impulses actually help.",
  schema: {
    type: "object",
    properties: {
      activityId: { type: "string", description: "Filter by activity variant id" },
      impulseShape: { type: "string", description: "Filter by impulse shape (resolved via impulse table)" },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Max rows (default 50)" }
    }
  },
  example: {
    activityId: "acquire-codebase-context",
    impulseShape: "error_log",
    limit: 25
  },
  tags: ["learning", "relevance", "impulse", "bayesian"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- toolRiskProfile shape: Aggregated tool error rates
INSERT INTO shape_definition {
  name: "toolRiskProfile",
  version: "1.0.0",
  description: "Aggregated tool usage metrics grouped by tool and activity. Surfaces high-risk tools (high error rate) with recommendations.",
  schema: {
    type: "object",
    properties: {
      toolName: { type: "string", description: "Filter by tool name (e.g. bash, git, file)" },
      activityId: { type: "string", description: "Filter by activity id" },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Max rows (default 50)" }
    }
  },
  example: {
    toolName: "bash",
    limit: 50
  },
  tags: ["learning", "tool", "risk", "pattern"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- preValidationResult shape: Historical tool-call skip decision
INSERT INTO shape_definition {
  name: "preValidationResult",
  version: "1.0.0",
  description: "Decision whether a tool call can be skipped/memoized based on historical success of identical arguments. Returns canSkip boolean with confidence score.",
  schema: {
    type: "object",
    properties: {
      toolName: { type: "string", description: "Tool being considered for skip (e.g. bash)" },
      activityId: { type: "string", description: "Activity context for the tool call" },
      argumentHash: { type: "string", description: "Precomputed SHA hash of arguments (optional if arguments provided)" },
      arguments: { type: "object", description: "Raw tool arguments (will be hashed server-side)" },
      minSuccessRate: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Threshold below which skip is not recommended (default 0.9)"
      },
      skipThreshold: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Confidence threshold required to return canSkip=true (default 0.85)"
      }
    },
    required: ["toolName", "activityId"]
  },
  example: {
    toolName: "bash",
    activityId: "run-tests",
    arguments: { command: "bun test" },
    minSuccessRate: 0.9,
    skipThreshold: 0.85
  },
  tags: ["learning", "validation", "optimization", "pattern"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- ============================================================================
-- Verification
-- ============================================================================

-- Expected: these queries should succeed after migration
-- SELECT name, version FROM shape_definition WHERE name IN [
--   'executionTraceList', 'variantMetricsSummary', 'compositionSuccess',
--   'goal', 'activityTemplateRecommendation', 'activityTemplatesByMetrics',
--   'executionTraces', 'impulseRelevance', 'toolRiskProfile',
--   'preValidationResult'
-- ] ORDER BY name;
