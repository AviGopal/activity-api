-- Migration: Register context acquisition templates for Thompson Sampling
-- Created: 2026-04-12
-- Purpose: Enable Thompson Sampling for primordial context acquisition activities

-- Template 1: acquire-error-log-context
INSERT INTO activity_template {
  variant_id: "acquire-error-log-context",
  activity_id: "acquire-error-log-context",
  variant_name: "Acquire Error Log Context",
  description: "Extract error messages and stack traces from execution traces or log files",
  category: "context-acquisition",
  tags: ["context.error-log", "bootstrap.primordial"],
  task_steps: [
    {
      id: "validate-inputs",
      description: "Validate that either executionTraceId or logFilePath is provided"
    },
    {
      id: "extract-errors-from-trace",
      description: "Extract errors from execution trace if trace ID provided"
    },
    {
      id: "extract-errors-from-file",
      description: "Extract errors from log file if file path provided"
    },
    {
      id: "create-error-impulse",
      description: "Create error_log impulse with structured error data"
    }
  ],
  scope: "global",
  org_id: "00000000-0000-0000-0000-000000000000",
  project_id: NONE,
  genealogy: {
    primordial: true,
    bootstrap: true,
    level: 0,
    extracted: false,
    author: "system"
  },
  created_at: time::now(),
  updated_at: time::now()
};

-- Template 2: acquire-requirements-context
INSERT INTO activity_template {
  variant_id: "acquire-requirements-context",
  activity_id: "acquire-requirements-context",
  variant_name: "Acquire Requirements Context",
  description: "Extract requirements from specification files or directories",
  category: "context-acquisition",
  tags: ["context.requirements", "bootstrap.primordial"],
  task_steps: [
    {
      id: "validate-inputs",
      description: "Validate that either filePath or directoryPath is provided"
    },
    {
      id: "extract-from-file",
      description: "Extract requirements from single file if file path provided"
    },
    {
      id: "extract-from-directory",
      description: "Extract requirements from all spec files if directory provided"
    },
    {
      id: "create-requirement-impulses",
      description: "Create requirement impulses with priority and scenarios"
    }
  ],
  scope: "global",
  org_id: "00000000-0000-0000-0000-000000000000",
  project_id: NONE,
  genealogy: {
    primordial: true,
    bootstrap: true,
    level: 0,
    extracted: false,
    author: "system"
  },
  created_at: time::now(),
  updated_at: time::now()
};

-- Template 3: acquire-codebase-context
INSERT INTO activity_template {
  variant_id: "acquire-codebase-context",
  activity_id: "acquire-codebase-context",
  variant_name: "Acquire Codebase Context",
  description: "Map repository structure and analyze module dependencies",
  category: "context-acquisition",
  tags: ["context.codebase-structure", "bootstrap.primordial"],
  task_steps: [
    {
      id: "map-file-tree",
      description: "Map directory structure and identify file types"
    },
    {
      id: "identify-entry-points",
      description: "Find main entry points (index, main, app files)"
    },
    {
      id: "analyze-dependencies",
      description: "Parse package.json and import statements for dependency graph"
    },
    {
      id: "collect-git-context",
      description: "Get git history for most-changed files"
    },
    {
      id: "create-codebase-impulse",
      description: "Create codebase_structure impulse with analysis results"
    }
  ],
  scope: "global",
  org_id: "00000000-0000-0000-0000-000000000000",
  project_id: NONE,
  genealogy: {
    primordial: true,
    bootstrap: true,
    level: 0,
    extracted: false,
    author: "system"
  },
  created_at: time::now(),
  updated_at: time::now()
};

-- Initialize Thompson Sampling metrics (thompson_alpha=1, thompson_beta=1 for neutral prior)
INSERT INTO variant_performance_metrics {
  variant_id: "acquire-error-log-context",
  activity_id: "acquire-error-log-context",
  org_id: "00000000-0000-0000-0000-000000000000",
  total_executions: 0,
  successful_executions: 0,
  failed_executions: 0,
  success_rate: 0.0,
  thompson_alpha: 1.0,
  thompson_beta: 1.0,
  total_selections: 0,
  avg_duration_ms: 0.0,
  avg_cost_usd: 0.0,
  created_at: time::now(),
  updated_at: time::now()
};

INSERT INTO variant_performance_metrics {
  variant_id: "acquire-requirements-context",
  activity_id: "acquire-requirements-context",
  org_id: "00000000-0000-0000-0000-000000000000",
  total_executions: 0,
  successful_executions: 0,
  failed_executions: 0,
  success_rate: 0.0,
  thompson_alpha: 1.0,
  thompson_beta: 1.0,
  total_selections: 0,
  avg_duration_ms: 0.0,
  avg_cost_usd: 0.0,
  created_at: time::now(),
  updated_at: time::now()
};

INSERT INTO variant_performance_metrics {
  variant_id: "acquire-codebase-context",
  activity_id: "acquire-codebase-context",
  org_id: "00000000-0000-0000-0000-000000000000",
  total_executions: 0,
  successful_executions: 0,
  failed_executions: 0,
  success_rate: 0.0,
  thompson_alpha: 1.0,
  thompson_beta: 1.0,
  total_selections: 0,
  avg_duration_ms: 0.0,
  avg_cost_usd: 0.0,
  created_at: time::now(),
  updated_at: time::now()
};
