# metabob-activity-api API Reference

**Version:** 1.4.5
**Base URL:** `https://activity.metabob.com` (production) | `http://localhost:8080` (development)

This document provides a complete reference for all HTTP endpoints exposed by the metabob-activity-api service.

## Table of Contents

1. [Authentication](#authentication)
2. [Core Endpoints](#core-endpoints)
   - [Health & Status](#health--status)
   - [Authentication & Authorization](#authentication--authorization)
   - [Activity Templates](#activity-templates)
   - [Activity Executions](#activity-executions)
   - [Thompson Sampling & Recommendations](#thompson-sampling--recommendations)
   - [Impulses](#impulses)
   - [Execution Traces](#execution-traces)
   - [Metrics & Analytics](#metrics--analytics)
3. [Learning System Endpoints](#learning-system-endpoints)
   - [Composition Graph](#composition-graph)
   - [Impulse Relevance](#impulse-relevance)
   - [Tool Usage Patterns](#tool-usage-patterns)
   - [Shape Management](#shape-management)
4. [Advanced Features](#advanced-features)
   - [Ribosome (Template Extraction)](#ribosome-template-extraction)
   - [Goal Paths](#goal-paths)
   - [Boredom Queue](#boredom-queue)
   - [CI/CD Integration](#cicd-integration)
5. [Deprecated Endpoints](#deprecated-endpoints)
6. [WebSocket API](#websocket-api)

---

## Authentication

All endpoints (except `/health` and `/v2/auth/login`) require authentication.

### Authentication Methods

1. **JWT Token** (Dashboard users, 15-minute expiry)
   ```
   Authorization: Bearer <jwt-token>
   ```

2. **API Key** (MiniBob instances, IDE integrations)
   ```
   Authorization: ApiKey <api-key>
   ```

### Multi-Tenant Isolation

- All endpoints enforce org-level isolation via `org_id` from JWT claims
- SurrealDB PERMISSIONS automatically filter results by `$auth.org_id`
- No application-level filtering needed - database handles isolation

---

## Core Endpoints

### Health & Status

#### `GET /health`

Health check with dependency status.

**Authentication:** None required

**Response:**
```json
{
  "service": "metabob-activity-api",
  "version": "1.4.5",
  "status": "healthy",
  "timestamp": "2026-04-23T12:00:00.000Z",
  "checks": {
    "redis": {
      "status": "healthy",
      "latency_ms": 5
    },
    "surrealdb": {
      "status": "healthy",
      "latency_ms": 10
    },
    "discovery": {
      "status": "healthy",
      "registered": true
    }
  }
}
```

**Status Codes:**
- `200 OK` - All dependencies healthy
- `503 Service Unavailable` - One or more critical dependencies unhealthy

---

### Authentication & Authorization

#### `POST /v2/auth/login`

Login for dashboard users with email/password.

**Authentication:** None required

**Request:**
```json
{
  "email": "user@example.com",
  "password": "secure-password"
}
```

**Response:**
```json
{
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "users:123",
      "email": "user@example.com",
      "name": "John Doe",
      "org_id": "organizations:456",
      "role": "admin"
    }
  }
}
```

**Status Codes:**
- `200 OK` - Login successful
- `401 Unauthorized` - Invalid credentials or inactive account

---

#### `GET /v2/auth/me`

Get current authenticated user information.

**Authentication:** Required (JWT)

**Response:**
```json
{
  "data": {
    "id": "users:123",
    "email": "user@example.com",
    "name": "John Doe",
    "is_active": true
  }
}
```

**Status Codes:**
- `200 OK` - User found
- `401 Unauthorized` - Not authenticated
- `404 Not Found` - User not found

---

#### `POST /v2/auth/minibob/signin`

**DEPRECATED** - Returns 410 Gone.

MiniBob instances now use API key authentication directly. No signin required.

**Migration:** Use `Authorization: ApiKey <key>` header on all requests.

---

### Activity Templates

#### `GET /v2/activities/templates`

List activity templates with pagination and filtering.

**Authentication:** Required

**Query Parameters:**
- `limit` (number, default: 50) - Results per page
- `offset` (number, default: 0) - Pagination offset
- `category` (string) - Filter by legacy category
- `tags` (string) - Comma-separated tags to filter by
- `scope` (string: global | org | project) - Filter by scope
- `public` (boolean) - Include public templates

**Response:**
```json
{
  "templates": [
    {
      "id": "fix-typescript-errors",
      "name": "Fix TypeScript Errors",
      "description": "Resolve TypeScript compilation errors in a codebase",
      "tags": ["feature.bugfix", "language.typescript"],
      "category": "bugfix",
      "tasks": [
        {
          "id": "analyze-errors",
          "description": "Identify TypeScript errors",
          "prompt": {
            "template": "Analyze TypeScript errors in {{file}}",
            "variables": ["file"]
          },
          "validation": {
            "requiredPatterns": ["error TS[0-9]+"]
          }
        }
      ],
      "scope": "global",
      "public": true,
      "input_shapes": ["error_log", "source_code"],
      "output_shapes": ["source_code", "fix_summary"],
      "metrics": {
        "id": "fix-typescript-errors",
        "total_executions": 42,
        "successful_executions": 38,
        "success_rate": 0.905,
        "avg_duration_ms": 12500,
        "avg_cost_usd": 0.08,
        "thompson_alpha": 39,
        "thompson_beta": 5
      },
      "created_at": "2026-01-15T10:30:00.000Z",
      "updated_at": "2026-04-20T14:22:00.000Z"
    }
  ],
  "total": 156
}
```

**Status Codes:**
- `200 OK` - Templates retrieved
- `401 Unauthorized` - Authentication required

---

#### `GET /v2/activities/templates/:variantId`

Get a single activity template by ID.

**Authentication:** Required

**Response:**
```json
{
  "id": "fix-typescript-errors",
  "name": "Fix TypeScript Errors",
  "description": "...",
  "tasks": [...],
  "metrics": {...}
}
```

**Status Codes:**
- `200 OK` - Template found
- `404 Not Found` - Template not found

---

#### `POST /v2/activities/templates`

Create a new activity template.

**Authentication:** Required

**Request:**
```json
{
  "id": "custom-refactor-task",
  "name": "Custom Refactoring Task",
  "description": "Extract common patterns into utilities",
  "tags": ["feature.refactor", "pattern.extract"],
  "tasks": [
    {
      "id": "identify-patterns",
      "description": "Find duplicated code patterns",
      "prompt": {
        "template": "Analyze {{directory}} for duplicate patterns",
        "variables": ["directory"]
      }
    }
  ],
  "scope": "org",
  "input_shapes": ["source_code", "directory_tree"],
  "output_shapes": ["refactor_plan", "source_code"]
}
```

**Response:**
```json
{
  "success": true,
  "id": "custom-refactor-task",
  "message": "Template created successfully"
}
```

**Status Codes:**
- `201 Created` - Template created
- `400 Bad Request` - Invalid schema
- `409 Conflict` - Template ID already exists

---

#### `GET /v2/activities/public`

Get public activity templates (accessible to all orgs).

**Authentication:** Required

**Response:**
```json
{
  "templates": [
    {
      "id": "ribosome-extracted-template-001",
      "name": "Git Commit with Message",
      "public": true,
      "tags": ["tool.git", "action.commit"],
      "output_shapes": ["git_commit"]
    }
  ],
  "total": 23
}
```

---

#### `GET /v2/activities/:id/variants`

Get all variants of a base activity template.

**Authentication:** Required

**Response:**
```json
{
  "variants": [
    {
      "id": "fix-typescript-errors-v2",
      "name": "Fix TypeScript Errors (Conservative)",
      "variant_of": {
        "base_id": "fix-typescript-errors",
        "reason": "trailblazing",
        "created_from_execution": "exec-123"
      },
      "metrics": {
        "success_rate": 0.95
      }
    }
  ],
  "total": 3
}
```

---

#### `POST /v2/activities/:id/variants`

Create a variant of an existing template.

**Authentication:** Required

**Request:**
```json
{
  "name": "Fix TypeScript Errors (Aggressive)",
  "description": "More aggressive error fixing approach",
  "tasks": [...],
  "variant_of": {
    "base_id": "fix-typescript-errors",
    "reason": "manual_optimization"
  }
}
```

**Response:**
```json
{
  "success": true,
  "variant_id": "fix-typescript-errors-aggressive",
  "message": "Variant created"
}
```

---

#### `GET /v2/activities/family/:baseId`

Get all templates in a variant family tree.

**Authentication:** Required

**Response:**
```json
{
  "family": {
    "base": {
      "id": "fix-typescript-errors",
      "name": "Fix TypeScript Errors"
    },
    "variants": [
      {
        "id": "fix-typescript-errors-v2",
        "generation": 1,
        "parent_id": "fix-typescript-errors"
      },
      {
        "id": "fix-typescript-errors-v3",
        "generation": 2,
        "parent_id": "fix-typescript-errors-v2"
      }
    ]
  }
}
```

---

### Activity Executions

#### `POST /v2/activities/executions`

Record an activity execution.

**Authentication:** Required

**Request:**
```json
{
  "activity_id": "fix-typescript-errors",
  "success": true,
  "duration_ms": 12500,
  "cost": 0.08,
  "tokens": {
    "input": 5000,
    "output": 2000,
    "cache": 1000
  },
  "impulses_used": ["error-log-1", "source-file-2"],
  "component_changes": ["src/utils.ts", "src/types.ts"]
}
```

**Response:**
```json
{
  "success": true,
  "execution_id": "exec-789",
  "metrics": {
    "total_executions": 43,
    "success_rate": 0.907,
    "thompson_alpha": 40,
    "thompson_beta": 5
  }
}
```

**Status Codes:**
- `200 OK` - Execution recorded
- `400 Bad Request` - Invalid schema

---

#### `GET /v2/activities/executions`

List recent activity executions.

**Authentication:** Required

**Query Parameters:**
- `limit` (number) - Results per page
- `offset` (number) - Pagination offset
- `activity_id` (string) - Filter by activity
- `success` (boolean) - Filter by success/failure
- `since` (ISO date) - Filter by timestamp

**Response:**
```json
{
  "executions": [
    {
      "id": "exec-789",
      "activity_id": "fix-typescript-errors",
      "success": true,
      "duration_ms": 12500,
      "cost": 0.08,
      "created_at": "2026-04-23T12:00:00.000Z"
    }
  ],
  "total": 1250
}
```

---

### Thompson Sampling & Recommendations

#### `POST /v2/activities/recommend`

Get activity recommendations using Thompson Sampling.

**Authentication:** Required

**Request:**
```json
{
  "goal_description": "Fix failing tests in the authentication module",
  "available_impulses": [
    {
      "id": "test-output",
      "shape": "error_log",
      "summary": "Test failures from jest"
    },
    {
      "id": "auth-module",
      "shape": "source_code",
      "summary": "Authentication module code"
    }
  ],
  "context": {
    "current_state": "Tests failing",
    "constraints": ["No breaking changes"]
  },
  "limit": 5
}
```

**Response:**
```json
{
  "recommendations": [
    {
      "activity_id": "fix-test-failures",
      "name": "Fix Test Failures",
      "score": 0.89,
      "reasoning": {
        "thompson_score": 0.85,
        "shape_match_score": 0.95,
        "impulse_boost": 0.12,
        "novelty_penalty": 0.02
      },
      "expected_success_rate": 0.92,
      "avg_duration_ms": 15000,
      "avg_cost_usd": 0.12,
      "compatible_impulses": ["test-output", "auth-module"]
    },
    {
      "activity_id": "debug-authentication",
      "name": "Debug Authentication Issues",
      "score": 0.76,
      "reasoning": {
        "thompson_score": 0.72,
        "shape_match_score": 0.88,
        "impulse_boost": 0.08
      }
    }
  ],
  "selection_event_id": "selection-456",
  "total_candidates": 15
}
```

**Key Features:**
- Thompson Sampling for exploration/exploitation balance
- Shape-based matching between goal and activity I/O
- Impulse relevance boosting
- Semantic tag matching
- Novelty penalty for untested activities

**Status Codes:**
- `200 OK` - Recommendations generated
- `400 Bad Request` - Invalid request

---

#### `POST /v2/activities/create-goal-seeking`

Create a new activity template from a goal description and impulses.

**Authentication:** Required

**Request:**
```json
{
  "goal_description": "Optimize database queries in the user service",
  "impulse_refs": [
    "slow-query-log",
    "user-service-code",
    "database-schema"
  ],
  "context": {
    "performance_target": "< 100ms p95 latency"
  }
}
```

**Response:**
```json
{
  "success": true,
  "activity_id": "optimize-user-queries-001",
  "template": {
    "id": "optimize-user-queries-001",
    "name": "Optimize User Service Queries",
    "tasks": [
      {
        "id": "analyze-queries",
        "description": "Identify slow queries",
        "prompt": {...}
      }
    ]
  }
}
```

---

#### `POST /v2/activities/feedback`

Provide feedback on activity execution quality.

**Authentication:** Required

**Request:**
```json
{
  "execution_id": "exec-789",
  "activity_id": "fix-typescript-errors",
  "feedback_type": "quality",
  "score": 0.9,
  "comments": "Fixed all errors efficiently",
  "issues": []
}
```

**Response:**
```json
{
  "success": true,
  "message": "Feedback recorded"
}
```

---

### Impulses

#### `POST /v2/impulses`

Create a new impulse (data pointer with metadata).

**Authentication:** Required

**Request:**
```json
{
  "impulse_id": "error-log-main-001",
  "project_id": "project-123",
  "impulse_data": {
    "type": "error_log",
    "pointer": {
      "type": "file",
      "path": "/var/log/app.log",
      "offset": 0,
      "limit": 1000
    },
    "budget": 2000,
    "priority": "high",
    "metadata": {
      "shape": "error_log",
      "summary": "Application error log from production",
      "rowCount": 450
    }
  }
}
```

**Response:**
```json
{
  "impulse_id": "error-log-main-001",
  "api_key": "api_key:xyz",
  "project_id": "projects:123",
  "impulse_data": {
    "type": "error_log",
    "pointer": {...}
  },
  "created_at": "2026-04-23T12:00:00.000Z",
  "updated_at": "2026-04-23T12:00:00.000Z"
}
```

**Status Codes:**
- `201 Created` - Impulse created
- `400 Bad Request` - Invalid schema

---

#### `GET /v2/impulses/:impulseId`

Get impulse by ID.

**Authentication:** Required

**Response:**
```json
{
  "impulse_id": "error-log-main-001",
  "impulse_data": {
    "type": "error_log",
    "pointer": {...},
    "metadata": {...}
  }
}
```

---

#### `GET /v2/impulses`

List impulses with pagination.

**Authentication:** Required

**Query Parameters:**
- `limit` (number) - Results per page
- `offset` (number) - Pagination offset
- `shape` (string) - Filter by shape
- `project_id` (string) - Filter by project

**Response:**
```json
{
  "impulses": [...],
  "total": 120,
  "limit": 50,
  "offset": 0
}
```

---

#### `POST /v2/impulses/resolve`

Resolve impulse pointers to actual content.

**Authentication:** Required

**Request:**
```json
{
  "impulses": [
    {
      "id": "error-log-main-001",
      "pointer": {
        "type": "activityExecutionTrace",
        "execution_id": "exec-789"
      }
    }
  ]
}
```

**Response:**
```json
{
  "resolved": [
    {
      "impulse_id": "error-log-main-001",
      "success": true,
      "content": "... execution trace markdown ...",
      "metadata": {
        "shape": "activityExecutionTrace",
        "resolver": "activity-api"
      }
    }
  ]
}
```

**Supported Impulse Types:**
- `activityExecutionTrace` - Full execution trace
- `activityTemplate` - Template definition
- `activityMetrics` - Performance metrics
- `activityCompositionGraph` - Composition relationships
- `impulseRelevanceMetrics` - Relevance scores
- `toolUsagePatterns` - Tool usage patterns
- `executionCostSummary` - Cost analytics
- `resolverCostAnalysis` - Resolver performance
- `vesselPerformanceMetrics` - Vessel metrics

---

#### `POST /v2/impulses/:impulseId/usage`

Track impulse usage for analytics.

**Authentication:** Required

**Request:**
```json
{
  "execution_id": "exec-789",
  "activity_id": "fix-typescript-errors",
  "loaded": true,
  "resolution_latency_ms": 45
}
```

**Response:**
```json
{
  "success": true
}
```

---

### Execution Traces

#### `GET /v2/activities/execution-traces`

List execution traces with full state information.

**Authentication:** Required

**Query Parameters:**
- `limit` (number) - Results per page
- `offset` (number) - Pagination offset
- `activity_id` (string) - Filter by activity
- `success` (boolean) - Filter by outcome
- `vessel_id` (string) - Filter by vessel

**Response:**
```json
{
  "traces": [
    {
      "id": "exec-789",
      "activity_id": "fix-typescript-errors",
      "success": true,
      "duration_ms": 12500,
      "cost_usd": 0.08,
      "tasks": [
        {
          "id": "analyze-errors",
          "description": "Identify TypeScript errors",
          "success": true,
          "duration_ms": 5000,
          "tool_calls": [
            {
              "tool": "bash",
              "args": ["tsc", "--noEmit"],
              "result": "..."
            }
          ]
        }
      ],
      "input_state": {
        "filesAvailable": ["src/utils.ts"],
        "environment": {"NODE_ENV": "development"}
      },
      "output_state": {
        "filesModified": ["src/utils.ts"],
        "filesCreated": []
      },
      "resolved_by_vessel_id": "minibob-001",
      "impulse_resolutions": [
        {
          "impulse_id": "error-log-1",
          "resolver_id": "file",
          "resolver_tier": "deterministic",
          "vessel_id": "minibob-001",
          "latency_ms": 15,
          "cost_usd": 0
        }
      ],
      "created_at": "2026-04-23T12:00:00.000Z"
    }
  ],
  "total": 450
}
```

---

#### `GET /v2/activities/execution-traces/:executionId`

Get a single execution trace by ID.

**Authentication:** Required

**Response:**
```json
{
  "id": "exec-789",
  "activity_id": "fix-typescript-errors",
  "tasks": [...],
  "input_state": {...},
  "output_state": {...}
}
```

---

#### `POST /v2/activities/execution-traces`

Store a new execution trace.

**Authentication:** Required

**Request:**
```json
{
  "execution_id": "exec-789",
  "activity_id": "fix-typescript-errors",
  "success": true,
  "duration_ms": 12500,
  "cost_usd": 0.08,
  "tasks": [...],
  "input_state": {...},
  "output_state": {...},
  "resolved_by_vessel_id": "minibob-001",
  "impulse_resolutions": [...]
}
```

**Response:**
```json
{
  "success": true,
  "execution_id": "exec-789"
}
```

---

### Metrics & Analytics

#### `GET /v2/activities/metrics`

Get aggregated metrics across all activities.

**Authentication:** Required

**Query Parameters:**
- `category` (string) - Filter by category
- `tags` (string) - Filter by tags
- `min_executions` (number) - Minimum execution count

**Response:**
```json
{
  "metrics": [
    {
      "id": "fix-typescript-errors",
      "name": "Fix TypeScript Errors",
      "total_executions": 43,
      "success_rate": 0.907,
      "avg_duration_ms": 12500,
      "avg_cost_usd": 0.08,
      "thompson_alpha": 40,
      "thompson_beta": 5
    }
  ],
  "total": 156
}
```

---

#### `GET /v2/activities/templates/:templateId/metrics`

Get metrics for a specific template.

**Authentication:** Required

**Response:**
```json
{
  "id": "fix-typescript-errors",
  "total_executions": 43,
  "successful_executions": 39,
  "failed_executions": 4,
  "success_rate": 0.907,
  "avg_duration_ms": 12500,
  "avg_cost_usd": 0.08,
  "avg_tokens_input": 5000,
  "avg_tokens_output": 2000,
  "thompson_alpha": 40,
  "thompson_beta": 5,
  "last_executed_at": "2026-04-23T11:45:00.000Z"
}
```

---

#### `GET /v2/activities/metrics/trend`

Get time-series metrics for trend analysis.

**Authentication:** Required

**Query Parameters:**
- `activity_id` (string) - Filter by activity
- `interval` (string: hour | day | week) - Time bucket
- `since` (ISO date) - Start date

**Response:**
```json
{
  "trend": [
    {
      "timestamp": "2026-04-23T00:00:00.000Z",
      "executions": 15,
      "success_rate": 0.93,
      "avg_cost_usd": 0.075
    }
  ]
}
```

---

#### `GET /v2/activities/metrics/summary`

Get high-level summary metrics.

**Authentication:** Required

**Response:**
```json
{
  "total_activities": 156,
  "total_executions": 12450,
  "overall_success_rate": 0.87,
  "total_cost_usd": 1245.67,
  "avg_execution_time_ms": 14200,
  "top_activities": [
    {
      "id": "fix-typescript-errors",
      "executions": 450,
      "success_rate": 0.91
    }
  ]
}
```

---

#### `GET /v2/activities/metrics/aggregate`

Get aggregated metrics with grouping.

**Authentication:** Required

**Query Parameters:**
- `group_by` (string: category | tag | vessel) - Grouping dimension
- `metric` (string: count | success_rate | cost) - Metric to aggregate

**Response:**
```json
{
  "aggregates": [
    {
      "group": "bugfix",
      "total_executions": 3450,
      "success_rate": 0.89,
      "total_cost_usd": 456.78
    }
  ]
}
```

---

#### `GET /v2/activities/scores`

Get Thompson Sampling scores for all activities.

**Authentication:** Required

**Response:**
```json
{
  "scores": [
    {
      "activity_id": "fix-typescript-errors",
      "thompson_alpha": 40,
      "thompson_beta": 5,
      "expected_success_rate": 0.89,
      "confidence_interval": [0.82, 0.94]
    }
  ]
}
```

---

#### `GET /v2/activities/failure-patterns`

Get common failure patterns across activities.

**Authentication:** Required

**Response:**
```json
{
  "patterns": [
    {
      "error_type": "timeout",
      "count": 45,
      "affected_activities": ["fix-typescript-errors", "run-tests"],
      "avg_duration_before_failure_ms": 25000
    }
  ]
}
```

---

## Learning System Endpoints

### Composition Graph

#### `POST /v2/activities/composition`

Record an activity composition (parent calls child).

**Authentication:** Required

**Request:**
```json
{
  "parent_activity_id": "fix-all-errors",
  "child_activity_id": "fix-typescript-errors",
  "execution_id": "exec-789",
  "goal_context": "Fix compilation errors",
  "success": true,
  "input_impulse_shapes": ["error_log", "source_code"],
  "output_impulse_shapes": ["source_code", "fix_summary"],
  "duration_ms": 12500,
  "cost_usd": 0.08
}
```

**Response:**
```json
{
  "success": true,
  "edge_id": "edge-456"
}
```

---

#### `GET /v2/activities/composition/graph`

Get composition graph edges.

**Authentication:** Required

**Query Parameters:**
- `activity_id` (string) - Filter by parent or child
- `min_weight` (number) - Minimum success rate
- `limit` (number) - Results per page

**Response:**
```json
{
  "edges": [
    {
      "parent_activity_id": "fix-all-errors",
      "child_activity_id": "fix-typescript-errors",
      "execution_count": 25,
      "success_count": 23,
      "weight": 0.92,
      "input_impulse_shapes": ["error_log"],
      "output_impulse_shapes": ["source_code"]
    }
  ],
  "total": 145
}
```

---

#### `GET /v2/activities/composition/successors`

Get successful successor activities for a given activity.

**Authentication:** Required

**Query Parameters:**
- `activity_id` (string, required) - Parent activity ID
- `min_weight` (number) - Minimum success rate
- `limit` (number) - Results per page

**Response:**
```json
{
  "successors": [
    {
      "activity_id": "run-tests",
      "success_rate": 0.95,
      "avg_duration_ms": 8000,
      "typical_context": "Verify fixes"
    }
  ]
}
```

---

#### `GET /v2/activities/composition/impulse-success`

Get success rates by impulse shape combinations.

**Authentication:** Required

**Response:**
```json
{
  "combinations": [
    {
      "input_shapes": ["error_log", "source_code"],
      "output_shapes": ["source_code"],
      "success_rate": 0.91,
      "sample_count": 120
    }
  ]
}
```

---

### Impulse Relevance

#### `POST /v2/activities/impulse-relevance`

Record impulse relevance for an execution.

**Authentication:** Required

**Request:**
```json
{
  "impulse_id": "error-log-1",
  "activity_variant_id": "fix-typescript-errors",
  "task_id": "analyze-errors",
  "execution_id": "exec-789",
  "was_loaded": true,
  "execution_succeeded": true,
  "content_size_tokens": 1500,
  "pointer_type": "file",
  "resolver_tier": "deterministic",
  "resolver_name": "file",
  "resolution_latency_ms": 15
}
```

**Response:**
```json
{
  "success": true,
  "metrics": {
    "relevance_score": 0.89,
    "irrelevance_score": 0.45
  }
}
```

---

#### `GET /v2/activities/impulse-relevance`

Get impulse relevance metrics.

**Authentication:** Required

**Query Parameters:**
- `impulse_id` (string) - Filter by impulse
- `activity_variant_id` (string) - Filter by activity
- `min_relevance_score` (number) - Minimum relevance

**Response:**
```json
{
  "metrics": [
    {
      "impulse_id": "error-log-1",
      "activity_variant_id": "fix-typescript-errors",
      "times_loaded": 35,
      "times_execution_succeeded": 32,
      "times_execution_failed": 3,
      "relevance_score": 0.89,
      "irrelevance_score": 0.45,
      "resolver_tier": "deterministic",
      "avg_resolution_latency_ms": 18
    }
  ],
  "total": 250
}
```

---

### Tool Usage Patterns

#### `POST /v2/activities/tool-usage`

Record tool usage during execution.

**Authentication:** Required

**Request:**
```json
{
  "execution_id": "exec-789",
  "activity_id": "fix-typescript-errors",
  "task_id": "analyze-errors",
  "tool_name": "bash",
  "args": ["tsc", "--noEmit"],
  "success": true,
  "duration_ms": 5000,
  "error_type": null
}
```

**Response:**
```json
{
  "success": true
}
```

---

#### `GET /v2/activities/tool-usage`

Get tool usage patterns.

**Authentication:** Required

**Query Parameters:**
- `activity_id` (string) - Filter by activity
- `tool_name` (string) - Filter by tool
- `limit` (number) - Results per page

**Response:**
```json
{
  "patterns": [
    {
      "activity_id": "fix-typescript-errors",
      "tool_name": "bash",
      "usage_count": 45,
      "success_count": 42,
      "success_rate": 0.93,
      "avg_duration_ms": 5200,
      "common_args": [
        ["tsc", "--noEmit"],
        ["npm", "run", "typecheck"]
      ]
    }
  ],
  "total": 78
}
```

---

#### `POST /v2/activities/tool-argument-patterns`

Record tool argument patterns for learning.

**Authentication:** Required

**Request:**
```json
{
  "tool_name": "bash",
  "args": ["tsc", "--noEmit"],
  "context": {
    "activity_id": "fix-typescript-errors",
    "task_id": "analyze-errors"
  },
  "success": true
}
```

---

#### `GET /v2/activities/tool-argument-recommendations`

Get recommended tool arguments based on patterns.

**Authentication:** Required

**Query Parameters:**
- `tool_name` (string, required) - Tool to get recommendations for
- `context` (JSON) - Context for recommendations

**Response:**
```json
{
  "recommendations": [
    {
      "args": ["tsc", "--noEmit"],
      "confidence": 0.92,
      "usage_count": 45,
      "success_rate": 0.95
    }
  ]
}
```

---

### Shape Management

#### `POST /v2/shapes`

Register a new impulse shape definition.

**Authentication:** Required

**Request:**
```json
{
  "name": "custom_error_log",
  "version": "1.0.0",
  "schema": {
    "type": "object",
    "properties": {
      "timestamp": {"type": "string"},
      "level": {"type": "string"},
      "message": {"type": "string"}
    }
  },
  "description": "Custom error log format"
}
```

**Response:**
```json
{
  "success": true,
  "shape_id": "custom_error_log"
}
```

---

#### `GET /v2/shapes`

List all registered shapes.

**Authentication:** Required

**Response:**
```json
{
  "shapes": [
    {
      "name": "error_log",
      "version": "1.0.0",
      "description": "Error log entries",
      "usage_count": 450
    }
  ],
  "total": 45
}
```

---

#### `GET /v2/shapes/:name`

Get shape definition by name.

**Authentication:** Required

**Response:**
```json
{
  "name": "error_log",
  "version": "1.0.0",
  "schema": {...},
  "description": "Error log entries"
}
```

---

#### `GET /v2/shapes/:name/versions`

Get all versions of a shape.

**Authentication:** Required

**Response:**
```json
{
  "versions": [
    {
      "version": "1.0.0",
      "created_at": "2026-01-15T10:00:00.000Z"
    },
    {
      "version": "1.1.0",
      "created_at": "2026-03-20T14:30:00.000Z"
    }
  ]
}
```

---

#### `GET /v2/shapes/network`

Get shape relationship network (inputs/outputs).

**Authentication:** Required

**Response:**
```json
{
  "network": {
    "nodes": [
      {
        "shape": "error_log",
        "activities_producing": 5,
        "activities_consuming": 12
      }
    ],
    "edges": [
      {
        "from_shape": "error_log",
        "to_shape": "source_code",
        "via_activities": ["fix-typescript-errors"]
      }
    ]
  }
}
```

---

#### `GET /v2/shapes/usage`

Get shape usage statistics.

**Authentication:** Required

**Response:**
```json
{
  "usage": [
    {
      "shape": "error_log",
      "total_impulses": 450,
      "total_resolutions": 1250,
      "avg_resolution_latency_ms": 25,
      "primary_resolvers": ["file", "bash"]
    }
  ]
}
```

---

## Advanced Features

### Ribosome (Template Extraction)

The ribosome extracts successful execution patterns into reusable activity templates.

#### `POST /v2/ribosome/extract`

Extract template from execution trace.

**Authentication:** Required

**Request:**
```json
{
  "execution_id": "exec-789",
  "template_name": "Fix TypeScript Strict Mode Errors",
  "template_description": "Extracted from successful strict mode migration"
}
```

**Response:**
```json
{
  "success": true,
  "template_id": "fix-typescript-strict-001",
  "template": {
    "id": "fix-typescript-strict-001",
    "name": "Fix TypeScript Strict Mode Errors",
    "tasks": [
      {
        "id": "enable-strict",
        "description": "Enable strict mode in tsconfig",
        "prompt": {...}
      }
    ],
    "public": true
  }
}
```

---

#### `POST /v2/ribosome/extract-from-session`

Extract template from multiple executions in a session.

**Authentication:** Required

**Request:**
```json
{
  "session_id": "session-123",
  "template_name": "Multi-step Refactoring",
  "min_success_rate": 0.8
}
```

**Response:**
```json
{
  "success": true,
  "template_id": "refactor-pattern-001",
  "executions_analyzed": 5,
  "template": {...}
}
```

---

#### `GET /v2/ribosome/candidates`

Get execution traces that are good candidates for extraction.

**Authentication:** Required

**Query Parameters:**
- `min_duration_ms` (number) - Minimum complexity threshold
- `min_tasks` (number) - Minimum task count
- `success_only` (boolean) - Only successful executions

**Response:**
```json
{
  "candidates": [
    {
      "execution_id": "exec-789",
      "activity_id": "improvisation",
      "duration_ms": 45000,
      "task_count": 8,
      "success": true,
      "extraction_confidence": 0.85
    }
  ],
  "total": 12
}
```

---

### Goal Paths

Goal paths track sequences of activities that achieve specific goals.

#### `POST /v2/goal-paths`

Record a goal path (sequence of activities).

**Authentication:** Required

**Request:**
```json
{
  "goal_text": "Deploy new feature to production",
  "goal_category": "infrastructure",
  "path_activities": [
    "run-tests",
    "build-docker-image",
    "deploy-to-staging",
    "run-smoke-tests",
    "deploy-to-production"
  ],
  "success": true,
  "duration_ms": 120000,
  "cost_usd": 2.45,
  "token_usage": 5000,
  "files_modified": ["src/deploy.ts"],
  "tools_used": ["bash", "docker"]
}
```

**Response:**
```json
{
  "success": true,
  "path": {
    "goal_hash": "a1b2c3d4",
    "path_signature": "e5f6g7h8",
    "total_executions": 1,
    "success_rate": 1.0
  }
}
```

---

#### `GET /v2/goal-paths`

List recorded goal paths.

**Authentication:** Required

**Query Parameters:**
- `goal_text` (string) - Filter by goal text
- `goal_hash` (string) - Filter by goal hash
- `goal_category` (string) - Filter by category
- `min_executions` (number) - Minimum execution count
- `limit` (number) - Max results (default: 50)
- `offset` (number) - Pagination offset (default: 0)

**Response:**
```json
{
  "paths": [
    {
      "goal_hash": "a1b2c3d4",
      "goal_text": "Deploy new feature",
      "path_activities": ["run-tests", "build-docker-image"],
      "path_signature": "e5f6g7h8",
      "total_executions": 15,
      "successful_executions": 14,
      "failed_executions": 1,
      "success_rate": 0.93,
      "avg_duration_ms": 118000,
      "avg_cost_usd": 2.45,
      "thompson_alpha": 15.0,
      "thompson_beta": 2.0
    }
  ],
  "total": 45
}
```

---

#### `POST /v2/goal-paths/recommend`

Get recommended paths for a goal using Thompson Sampling.

**Authentication:** Required

**Request:**
```json
{
  "goal_text": "Deploy new feature to production",
  "goal_category": "infrastructure",
  "exploration_rate": 0.2,
  "top_k": 5
}
```

**Response:**
```json
{
  "goal_hash": "a1b2c3d4",
  "recommended_paths": [
    {
      "path_activities": [
        "run-tests",
        "build-docker-image",
        "deploy-to-production"
      ],
      "confidence": 0.87,
      "success_rate": 0.91,
      "avg_duration_ms": 95000,
      "avg_cost_usd": 2.45,
      "total_executions": 15
    },
    {
      "path_activities": [
        "run-tests",
        "deploy-to-staging",
        "deploy-to-production"
      ],
      "confidence": 0.5,
      "success_rate": 0.8,
      "avg_duration_ms": 120000,
      "avg_cost_usd": 3.10,
      "total_executions": 5,
      "exploration_bonus": 0.17
    }
  ]
}
```

---

### Boredom Queue

The boredom queue manages autonomous improvement tasks when vessels are idle.

#### `GET /boredom-tasks`

Get next boredom task from queue (for vessels to poll).

**Authentication:** Required

**Response:**
```json
{
  "task": {
    "id": "boredom-task-123",
    "type": "optimize_template",
    "priority": 8,
    "description": "Optimize fix-typescript-errors template",
    "context": {
      "template_id": "fix-typescript-errors",
      "current_success_rate": 0.85,
      "target_success_rate": 0.90
    }
  }
}
```

**Status Codes:**
- `200 OK` - Task available
- `204 No Content` - Queue empty

---

#### `POST /v2/activities/boredom/enqueue`

Add task to boredom queue.

**Authentication:** Required

**Request:**
```json
{
  "type": "create_variant",
  "priority": 7,
  "description": "Create variant for edge case handling",
  "context": {
    "base_template_id": "fix-typescript-errors",
    "failure_pattern": "timeout on large files"
  }
}
```

**Response:**
```json
{
  "success": true,
  "task_id": "boredom-task-456"
}
```

---

#### `POST /boredom-tasks/:taskId/result`

Submit boredom task completion result.

**Authentication:** Required

**Request:**
```json
{
  "success": true,
  "result": {
    "variant_id": "fix-typescript-errors-chunked",
    "improvement": "Handles large files via chunking"
  }
}
```

**Response:**
```json
{
  "success": true
}
```

---

#### `GET /v2/activities/boredom/stats`

Get boredom queue statistics.

**Authentication:** Required

**Response:**
```json
{
  "queue_size": 12,
  "tasks_completed_today": 45,
  "avg_task_duration_ms": 180000,
  "success_rate": 0.78
}
```

---

### CI/CD Integration

#### `POST /v2/activities/ci-result`

Record CI/CD pipeline result for a template.

**Authentication:** Required

**Request:**
```json
{
  "template_id": "fix-typescript-errors",
  "pipeline_id": "github-actions-123",
  "commit_sha": "abc123def456",
  "success": true,
  "test_results": {
    "total": 25,
    "passed": 24,
    "failed": 1
  },
  "duration_ms": 45000
}
```

**Response:**
```json
{
  "success": true,
  "result_id": "ci-result-789"
}
```

---

#### `GET /v2/activities/ci-results`

Get CI/CD results for templates.

**Authentication:** Required

**Query Parameters:**
- `template_id` (string) - Filter by template
- `since` (ISO date) - Filter by date

**Response:**
```json
{
  "results": [
    {
      "template_id": "fix-typescript-errors",
      "pipeline_id": "github-actions-123",
      "success": true,
      "created_at": "2026-04-23T10:30:00.000Z"
    }
  ],
  "total": 150
}
```

---

## Deprecated Endpoints

The following endpoints are deprecated and will be removed in future versions.

### Vessel Registry (Legacy)

**Deprecation:** All `/v2/vessels/*` endpoints are deprecated as of 2026-04-11.

**Replacement:** Use discovery-vessel directly at `https://discovery.metabob.com`.

**Migration Timeline:**
- **2026-05-01**: Deprecation notices added
- **2026-07-01**: Endpoints return 410 Gone

#### `POST /v2/vessels/register` (Deprecated)

**Status:** Returns deprecation warning, proxies to discovery-vessel

**Replacement:** Use discovery-vessel directly or VesselClient package

---

#### `POST /v2/vessels/heartbeat` (Deprecated)

**Status:** Returns deprecation warning, proxies to discovery-vessel

---

#### `GET /v2/vessels/discover` (Deprecated)

**Status:** Returns deprecation warning, proxies to discovery-vessel

**Replacement:** `POST https://discovery.metabob.com/resolve`

---

#### `GET /v2/vessels/status` (Deprecated)

**Status:** Returns deprecation warning

**Replacement:** Query discovery-vessel `/registry/stats`

---

## WebSocket API

### Connection

**Endpoint:** `wss://activity.metabob.com/ws`

**Authentication:** Send authentication message after connection

```javascript
// Connect
const ws = new WebSocket('wss://activity.metabob.com/ws');

// Authenticate (JWT or API key)
ws.send(JSON.stringify({
  type: 'authenticate',
  token: 'your-jwt-or-api-key',
  sessionId: 'optional-session-id'
}));
```

### Authentication Response

```json
{
  "type": "authenticated",
  "timestamp": "2026-04-23T12:00:00.000Z"
}
```

### Error Response

```json
{
  "type": "auth_error",
  "error": "Authentication failed",
  "message": "Invalid or expired token",
  "timestamp": "2026-04-23T12:00:00.000Z"
}
```

### Real-time Events

Once authenticated, the WebSocket receives real-time events:

#### Execution Started
```json
{
  "type": "execution_started",
  "execution_id": "exec-789",
  "activity_id": "fix-typescript-errors",
  "timestamp": "2026-04-23T12:00:00.000Z"
}
```

#### Execution Completed
```json
{
  "type": "execution_completed",
  "execution_id": "exec-789",
  "activity_id": "fix-typescript-errors",
  "success": true,
  "duration_ms": 12500,
  "timestamp": "2026-04-23T12:00:12.500Z"
}
```

#### Template Created
```json
{
  "type": "template_created",
  "template_id": "new-template-001",
  "name": "New Template",
  "timestamp": "2026-04-23T12:05:00.000Z"
}
```

#### Metrics Updated
```json
{
  "type": "metrics_updated",
  "activity_id": "fix-typescript-errors",
  "metrics": {
    "success_rate": 0.91,
    "total_executions": 46
  },
  "timestamp": "2026-04-23T12:10:00.000Z"
}
```

### Keepalive

Send ping to maintain connection:

```json
{
  "type": "ping"
}
```

Response:
```json
{
  "type": "pong",
  "timestamp": "2026-04-23T12:00:00.000Z"
}
```

---

## Error Handling

### Standard Error Response

All endpoints return errors in this format:

```json
{
  "error": "Error message",
  "details": {
    "field": "specific error details"
  },
  "timestamp": "2026-04-23T12:00:00.000Z"
}
```

### Common Status Codes

- `200 OK` - Request successful
- `201 Created` - Resource created
- `204 No Content` - Success, no data to return
- `400 Bad Request` - Invalid request schema
- `401 Unauthorized` - Authentication required or failed
- `403 Forbidden` - Insufficient permissions
- `404 Not Found` - Resource not found
- `409 Conflict` - Resource conflict (e.g., duplicate ID)
- `410 Gone` - Endpoint permanently removed
- `429 Too Many Requests` - Rate limit exceeded
- `500 Internal Server Error` - Server error
- `503 Service Unavailable` - Service temporarily unavailable

---

## Rate Limiting

Rate limits are enforced per API key:

- **Starter tier**: 100 requests/minute
- **Pro tier**: 1000 requests/minute
- **Enterprise tier**: Custom limits

Rate limit headers:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1714737600
```

---

## Versioning

**Current version:** v2

All endpoints are prefixed with `/v2/`. Future API versions will use `/v3/`, etc.

**Backward compatibility:** v2 endpoints will be maintained for at least 12 months after v3 release.

---

## Common Request/Response Patterns

### Pagination

Most list endpoints support pagination:

**Request:**
```
GET /v2/activities/templates?limit=50&offset=100
```

**Response:**
```json
{
  "templates": [...],
  "total": 450,
  "limit": 50,
  "offset": 100
}
```

### Filtering

Many endpoints support filtering via query parameters:

**Request:**
```
GET /v2/activities/templates?tags=feature.bugfix&scope=global
```

### Sorting

Use `sort` and `order` query parameters:

**Request:**
```
GET /v2/activities/executions?sort=created_at&order=desc
```

---

## Additional Resources

- **Main Documentation:** `/home/avi/documents/work/exp-repo/metabob-devbob/CLAUDE.md`
- **Foundation Document:** `/home/avi/documents/work/exp-repo/metabob-devbob/docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md`
- **Discovery Integration:** `/home/avi/documents/work/exp-repo/metabob-devbob/DISCOVERY_INTEGRATION.md`
- **Deployment Guide:** `/home/avi/documents/work/exp-repo/metabob-devbob/repos/deployment/DEPLOYMENT_WORKFLOW.md`

---

**Last Updated:** 2026-04-23
**API Version:** v2
**Service Version:** 1.4.5
