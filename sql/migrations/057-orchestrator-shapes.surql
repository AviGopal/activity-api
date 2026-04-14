-- Migration 057: Orchestrator Shape Definitions
-- Date: 2026-04-12
-- Purpose: Add shape definitions for goal orchestrators (goal:test, goal:refactor)
--
-- SPEC: openspec/changes/vessel-integration-standardization/specs/minibob-goal-orchestrators/spec.md

-- ============================================================================
-- Orchestrator Input Shapes
-- ============================================================================

-- requirement shape: Natural language or structured requirement specification
INSERT INTO shape_definition {
  name: "requirement",
  version: "1.0.0",
  description: "Requirement specification for goal-driven activities. Can be natural language description or structured acceptance criteria.",
  schema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Natural language requirement" },
      acceptance_criteria: {
        type: "array",
        items: { type: "string" },
        description: "List of testable acceptance criteria"
      },
      priority: {
        type: "string",
        enum: ["critical", "high", "medium", "low"],
        description: "Requirement priority"
      },
      component: { type: "string", description: "Component or module targeted" }
    },
    required: ["description"]
  },
  example: {
    description: "Write tests for the authentication module",
    acceptance_criteria: [
      "Tests cover login, logout, and session management",
      "Tests validate error handling for invalid credentials",
      "Tests verify JWT token generation and validation"
    ],
    priority: "high",
    component: "authentication"
  },
  tags: ["goal", "orchestration", "requirement"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- source_code shape: Reference to source code files or modules
INSERT INTO shape_definition {
  name: "source_code",
  version: "1.0.0",
  description: "Reference to source code file(s) or module(s) for analysis or testing.",
  schema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: { type: "string" },
        description: "List of file paths"
      },
      module: { type: "string", description: "Module or package name" },
      language: { type: "string", description: "Programming language" },
      entry_point: { type: "string", description: "Main entry point file" }
    },
    required: ["files"]
  },
  example: {
    files: ["src/lib/auth.ts", "src/middleware/auth-middleware.ts"],
    module: "authentication",
    language: "typescript",
    entry_point: "src/lib/auth.ts"
  },
  tags: ["code", "orchestration", "context"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- error_log shape: Structured error information from execution traces
INSERT INTO shape_definition {
  name: "error_log",
  version: "1.0.0",
  description: "Structured error information extracted from execution traces or log files.",
  schema: {
    type: "object",
    properties: {
      error_type: { type: "string", description: "Classification of error" },
      message: { type: "string", description: "Error message" },
      stack_trace: { type: "string", description: "Full stack trace if available" },
      context_files: {
        type: "array",
        items: { type: "string" },
        description: "Files involved in the error"
      },
      task_id: { type: "string", description: "Task ID where error occurred" },
      execution_id: { type: "string", description: "Execution trace ID" },
      timestamp: { type: "string", format: "date-time", description: "When error occurred" }
    },
    required: ["error_type", "message"]
  },
  example: {
    error_type: "validation_failure",
    message: "Required pattern 'export function authenticate' not found in src/lib/auth.ts",
    context_files: ["src/lib/auth.ts"],
    task_id: "task-2",
    execution_id: "exec_abc123",
    timestamp: "2026-04-12T10:30:00Z"
  },
  tags: ["error", "orchestration", "context"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- codebase_structure shape: High-level codebase organization and metadata
INSERT INTO shape_definition {
  name: "codebase_structure",
  version: "1.0.0",
  description: "High-level codebase structure including directory layout, module dependencies, and architectural patterns.",
  schema: {
    type: "object",
    properties: {
      root_path: { type: "string", description: "Root directory of codebase" },
      directories: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            type: { type: "string", enum: ["src", "test", "docs", "config", "build"] },
            file_count: { type: "number" }
          }
        }
      },
      languages: {
        type: "array",
        items: { type: "string" },
        description: "Programming languages detected"
      },
      frameworks: {
        type: "array",
        items: { type: "string" },
        description: "Frameworks and libraries detected"
      },
      entry_points: {
        type: "array",
        items: { type: "string" },
        description: "Main entry point files"
      }
    },
    required: ["root_path", "directories"]
  },
  example: {
    root_path: "/home/user/project",
    directories: [
      { path: "src", type: "src", file_count: 45 },
      { path: "test", type: "test", file_count: 23 },
      { path: "docs", type: "docs", file_count: 5 }
    ],
    languages: ["typescript", "javascript"],
    frameworks: ["react", "express", "bun"],
    entry_points: ["src/index.ts", "src/server.ts"]
  },
  tags: ["codebase", "orchestration", "context"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- design_pattern shape: Design pattern specification for refactoring
INSERT INTO shape_definition {
  name: "design_pattern",
  version: "1.0.0",
  description: "Design pattern specification for code refactoring activities.",
  schema: {
    type: "object",
    properties: {
      pattern_name: { type: "string", description: "Name of design pattern" },
      pattern_type: {
        type: "string",
        enum: ["creational", "structural", "behavioral"],
        description: "Category of design pattern"
      },
      description: { type: "string", description: "What the pattern achieves" },
      target_modules: {
        type: "array",
        items: { type: "string" },
        description: "Modules to apply pattern to"
      },
      constraints: {
        type: "array",
        items: { type: "string" },
        description: "Constraints or requirements for application"
      }
    },
    required: ["pattern_name", "description"]
  },
  example: {
    pattern_name: "Dependency Injection",
    pattern_type: "structural",
    description: "Refactor user service to use dependency injection for better testability",
    target_modules: ["src/services/user-service.ts"],
    constraints: ["Maintain backward compatibility with existing API", "Use constructor injection"]
  },
  tags: ["refactoring", "orchestration", "design"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- ============================================================================
-- Orchestrator Output Shapes
-- ============================================================================

-- test_suite shape: Collection of test files and test cases
INSERT INTO shape_definition {
  name: "test_suite",
  version: "1.0.0",
  description: "Test suite containing test files, test cases, and test configuration.",
  schema: {
    type: "object",
    properties: {
      test_files: {
        type: "array",
        items: { type: "string" },
        description: "List of test file paths"
      },
      test_framework: { type: "string", description: "Testing framework used" },
      test_count: { type: "number", description: "Total number of tests" },
      coverage_target: { type: "number", description: "Target code coverage percentage" },
      test_types: {
        type: "array",
        items: { type: "string", enum: ["unit", "integration", "e2e"] },
        description: "Types of tests included"
      }
    },
    required: ["test_files", "test_framework"]
  },
  example: {
    test_files: ["test/auth.test.ts", "test/middleware.test.ts"],
    test_framework: "bun:test",
    test_count: 15,
    coverage_target: 80,
    test_types: ["unit", "integration"]
  },
  tags: ["test", "orchestration", "output"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- test_result shape: Test execution results
INSERT INTO shape_definition {
  name: "test_result",
  version: "1.0.0",
  description: "Results from test execution including pass/fail status and coverage.",
  schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["passing", "failing", "skipped", "error"],
        description: "Overall test status"
      },
      total_tests: { type: "number", description: "Total tests run" },
      passed: { type: "number", description: "Number of tests passed" },
      failed: { type: "number", description: "Number of tests failed" },
      skipped: { type: "number", description: "Number of tests skipped" },
      duration_ms: { type: "number", description: "Test execution duration" },
      coverage: {
        type: "object",
        properties: {
          lines: { type: "number" },
          branches: { type: "number" },
          functions: { type: "number" },
          statements: { type: "number" }
        },
        description: "Code coverage percentages"
      },
      failures: {
        type: "array",
        items: {
          type: "object",
          properties: {
            test_name: { type: "string" },
            error: { type: "string" },
            file: { type: "string" }
          }
        },
        description: "Details of failed tests"
      }
    },
    required: ["status", "total_tests", "passed", "failed"]
  },
  example: {
    status: "passing",
    total_tests: 15,
    passed: 15,
    failed: 0,
    skipped: 0,
    duration_ms: 1234,
    coverage: {
      lines: 85.5,
      branches: 78.3,
      functions: 90.0,
      statements: 84.2
    },
    failures: []
  },
  tags: ["test", "orchestration", "output"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- execution_trace shape: Reference to full execution trace
INSERT INTO shape_definition {
  name: "execution_trace",
  version: "1.0.0",
  description: "Reference to stored execution trace with state transitions and outcomes.",
  schema: {
    type: "object",
    properties: {
      execution_id: { type: "string", description: "Execution trace ID" },
      activity_id: { type: "string", description: "Activity template ID" },
      success: { type: "boolean", description: "Whether execution succeeded" },
      duration_ms: { type: "number", description: "Total execution duration" },
      cost_usd: { type: "number", description: "Total execution cost" },
      task_count: { type: "number", description: "Number of tasks executed" },
      composition_metadata: {
        type: "object",
        properties: {
          parent_execution_id: { type: "string" },
          child_executions: { type: "array", items: { type: "string" } },
          composition_chain: { type: "array", items: { type: "string" } }
        },
        description: "Composition graph metadata if part of orchestration"
      }
    },
    required: ["execution_id", "activity_id", "success"]
  },
  example: {
    execution_id: "exec_abc123",
    activity_id: "orchestrate-test-goal",
    success: true,
    duration_ms: 45000,
    cost_usd: 0.0123,
    task_count: 5,
    composition_metadata: {
      parent_execution_id: null,
      child_executions: ["exec_def456", "exec_ghi789"],
      composition_chain: ["context:codebase", "generate-tests", "run-tests"]
    }
  },
  tags: ["trace", "orchestration", "output"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- refactored_code shape: Refactored code with validation status
INSERT INTO shape_definition {
  name: "refactored_code",
  version: "1.0.0",
  description: "Refactored code files with validation status and applied patterns.",
  schema: {
    type: "object",
    properties: {
      files_modified: {
        type: "array",
        items: { type: "string" },
        description: "List of files modified during refactoring"
      },
      pattern_applied: { type: "string", description: "Design pattern applied" },
      validated: { type: "boolean", description: "Whether refactoring passed validation" },
      tests_passing: { type: "boolean", description: "Whether tests still pass" },
      compilation_status: {
        type: "string",
        enum: ["success", "warning", "error"],
        description: "Compilation/type-checking status"
      },
      metrics: {
        type: "object",
        properties: {
          lines_changed: { type: "number" },
          files_touched: { type: "number" },
          breaking_changes: { type: "boolean" }
        },
        description: "Refactoring metrics"
      }
    },
    required: ["files_modified", "validated"]
  },
  example: {
    files_modified: ["src/services/user-service.ts", "src/index.ts"],
    pattern_applied: "Dependency Injection",
    validated: true,
    tests_passing: true,
    compilation_status: "success",
    metrics: {
      lines_changed: 45,
      files_touched: 2,
      breaking_changes: false
    }
  },
  tags: ["refactoring", "orchestration", "output"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- ============================================================================
-- Verification
-- ============================================================================

-- Expected: These queries should work after migration
-- SELECT * FROM shape_definition WHERE name IN ['requirement', 'test_suite', 'test_result', 'refactored_code'] ORDER BY name;
-- SELECT * FROM shape_definition WHERE 'orchestration' IN tags;
