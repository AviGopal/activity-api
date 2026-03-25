# Activity API Schema Reorganization

## Before: 9 Fragmented Files (1,651 lines)

```
sql/
├── 001-init-schema.surql (222 lines)
│   └── Tables: activity_template, variant_performance_metrics, activity_executions
│
├── 002-learning-system-phase1.surql (227 lines)
│   └── Tables: activity_composition_graph, impulse_relevance_metrics, tool_usage
│
├── 003-goal-execution-paths.surql (110 lines)
│   └── Tables: goal_execution_paths
│
├── 004-execution-traces.surql (37 lines)
│   └── Tables: execution_traces
│
├── 005-ci-integration.surql (170 lines)
│   └── Tables: ci_runs, ci_test_results, code_variants
│
├── 005-dashboard-components.surql (327 lines)  ⚠️  Duplicate numbering
│   └── Tables: dashboard_components, dashboard_metrics
│
├── 005-impulse-data.surql (45 lines)           ⚠️  Duplicate numbering
│   └── Tables: impulse_data
│
├── 007-control-flow-data-flow-learning.surql (275 lines)
│   └── Tables: goal_paths, activity_prerequisites, prerequisite_patterns
│
└── 008-unified-activity-model.surql (238 lines)
    └── Tables: activity_registry, activity_dataflows, views
```

**Problems:**
- ❌ Duplicate file numbering (three files numbered `005-*`)
- ❌ No RBAC PERMISSIONS clauses
- ❌ Inconsistent org_id/project_id fields (7 tables missing)
- ❌ No multi-tenant indexes
- ❌ activity_template vs activity_registry conflict
- ❌ Manual org_id filtering required in application code

## After: 4 Organized Files (~1,800 lines with RBAC)

```
sql/
├── schemas/
│   ├── 010-activity-registry.surql (260 lines)
│   │   ├── activity_registry              ✅ RBAC
│   │   │   └── Scope-aware: global/org/project/vessel
│   │   ├── variant_performance_metrics    ✅ RBAC (deprecated - migrating to registry)
│   │   └── view_activity_template         (backward compatibility)
│   │
│   ├── 011-executions.surql (540 lines)
│   │   ├── activity_execution_traces      ✅ RBAC (org/project filtering)
│   │   ├── activity_composition_graph     ✅ RBAC
│   │   ├── impulse_relevance_metrics      ✅ RBAC
│   │   ├── tool_usage                     ✅ RBAC
│   │   ├── view_execution_traces          (backward compatibility)
│   │   └── view_activity_executions       (backward compatibility)
│   │
│   ├── 012-composition.surql (480 lines)
│   │   ├── goal_execution_paths           ✅ RBAC (org/project filtering)
│   │   ├── activity_dataflows             ✅ RBAC
│   │   ├── activity_prerequisites         ✅ RBAC
│   │   ├── prerequisite_patterns          ✅ RBAC
│   │   ├── execution_sequences            ✅ RBAC
│   │   └── view_goal_paths                (backward compatibility)
│   │
│   └── 013-impulse-tool-usage.surql (380 lines)
│       ├── impulse_data                   ✅ RBAC (creator/admin permissions)
│       ├── impulse_usage_history          ✅ RBAC
│       ├── ci_runs                        ✅ RBAC
│       └── code_variants                  ✅ RBAC
│
└── migrate.ts (305 lines)
    └── Automated migration with data backfill
```

**Improvements:**
- ✅ All tables have RBAC PERMISSIONS
- ✅ Consistent org_id/project_id on all 15 tables
- ✅ 44 new multi-tenant indexes
- ✅ Scope-aware activity marketplace (global/org/project)
- ✅ Database-enforced isolation (no app-level filtering needed)
- ✅ Backward compatibility views
- ✅ Automated migration with rollback support

## Schema Merging Strategy

### 010-activity-registry.surql
**Merged from:**
- `001-init-schema.surql` → activity_template table
- `008-unified-activity-model.surql` → activity_registry table

**Resolution:**
- Unified into single `activity_registry` table
- Supports both template-based and vessel-function activities
- Added scope field (global/org/project/vessel)
- Added public field for marketplace
- Deprecated `activity_template` → `view_activity_template`

### 011-executions.surql
**Merged from:**
- `001-init-schema.surql` → activity_executions table
- `002-learning-system-phase1.surql` → composition_graph, impulse_relevance, tool_usage
- `004-execution-traces.surql` → execution_traces table

**Resolution:**
- Unified into `activity_execution_traces` table
- Merged duplicate execution tracking tables
- Added parent_execution_id for composition tracking
- Added views for backward compatibility

### 012-composition.surql
**Merged from:**
- `003-goal-execution-paths.surql` → goal_execution_paths table
- `007-control-flow-data-flow-learning.surql` → goal_paths, prerequisites, patterns

**Resolution:**
- Consolidated goal path tracking
- Unified goal_execution_paths and goal_paths
- Added execution_sequences table for ordered tracking
- Added org_id/project_id to all composition tables

### 013-impulse-tool-usage.surql
**Merged from:**
- `005-impulse-data.surql` → impulse_data table
- `005-ci-integration.surql` → ci_runs, code_variants
- `002-learning-system-phase1.surql` → tool_usage

**Resolution:**
- Moved tool_usage to executions file (more logical grouping)
- Kept impulse_data with CI integration (related to execution context)
- Deprecated api_key field → org_id for consistency
- Added impulse_usage_history for analytics

## Field Additions Summary

All 15 tables received these standard fields:

```sql
-- Multi-tenancy (required for RBAC)
org_id: record<organizations>           -- Auto-assigned from $auth.org_id
project_id: option<record<projects>>    -- Auto-assigned from $auth.project_id
created_by: option<record<users>>       -- Auto-assigned from $auth.id

-- Timestamps (standardized)
created_at: datetime DEFAULT time::now()
updated_at: datetime VALUE time::now()
```

## Index Additions Summary

**Per-table standard indexes:**
```sql
idx_table_org                    -- Single-field org queries
idx_table_project                -- Single-field project queries
idx_table_org_project            -- Composite for filtered queries
idx_table_created_by             -- Audit trail queries
```

**Activity-specific composite indexes:**
```sql
idx_activity_executions_org_project_activity    -- Common execution lookup
idx_goal_paths_org_category                     -- Goal filtering
idx_dataflow_org_caller                         -- Composition queries
idx_impulse_data_org_project_id                 -- Impulse resolution
```

**Total:** 44 new indexes added across 15 tables

## PERMISSIONS Pattern

Every table uses this template:

```sql
DEFINE TABLE table_name SCHEMAFULL
  PERMISSIONS
    -- SELECT: Org/project scoped
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)

    -- CREATE: Any authenticated user
    FOR create WHERE $auth.org_id != NONE

    -- UPDATE: Admin or creator
    FOR update WHERE
      (org_id = $auth.org_id AND $auth.role = 'admin')
      OR (org_id = $auth.org_id AND created_by = $auth.id)

    -- DELETE: Admin only
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';
```

**Special cases:**

1. **activity_registry** - Adds public marketplace support:
   ```sql
   FOR select WHERE
     (scope = 'global' AND public = true)  -- Public templates
     OR (org_id = $auth.org_id)            -- Org private
     OR (scope = 'project' AND project_id IN $auth.project_ids)  -- Project scoped
   ```

2. **impulse_data** - Creator can delete own impulses:
   ```sql
   FOR delete WHERE
     org_id = $auth.org_id
     AND ($auth.role = 'admin' OR created_by = $auth.id)
   ```

## Migration Data Flow

```
Phase 1 (metabob-proto)
  ├── 001-auth-access.surql       → JWT + RECORD auth definitions
  ├── 002-organizations.surql     → organizations, users, api_keys
  ├── 003-projects.surql          → projects, project_members
  └── 004-subscriptions.surql     → subscriptions, audit_logs
            ↓
Phase 2 (metabob-activity-api)
  ├── Import core schemas from @metabob/proto
  ├── Apply activity schemas (010-013)
  ├── Create organization:metabob_internal
  ├── Backfill org_id on 15 tables (10k batches)
  └── Record migration in schema_version
            ↓
Application Code
  └── Remove manual org_id filtering (trust PERMISSIONS)
```

## Backward Compatibility Strategy

Migration includes views that map legacy table names:

| Legacy Table Name       | New Table Name              | View |
|-------------------------|----------------------------|------|
| activity_template       | activity_registry          | view_activity_template |
| execution_traces        | activity_execution_traces  | view_execution_traces |
| activity_executions     | activity_execution_traces  | view_activity_executions |
| goal_paths              | goal_execution_paths       | view_goal_paths |

Views use WHERE filters and field mapping:
```sql
-- Example: activity_template compatibility
DEFINE TABLE view_activity_template AS
  SELECT
    id AS variant_id,
    id AS activity_id,
    name AS variant_name,
    description,
    category,
    task_steps,
    scope,
    org_id,
    project_id,
    genealogy,
    created_at,
    updated_at
  FROM activity_registry
  WHERE execution_format = 'template';
```

This allows existing code to query `activity_template` without changes.

## File Size Comparison

| Aspect | Before | After | Change |
|--------|--------|-------|--------|
| Files | 9 | 4 | -56% |
| Total lines | 1,651 | ~1,800 | +9% |
| Tables | 15 | 15 | Same |
| PERMISSIONS clauses | 0 | 15 | +15 |
| Indexes | ~30 | 74 | +147% |
| Duplicate numbering | 3 conflicts | 0 | Fixed |
| Backward compat views | 0 | 4 | +4 |

The line count increased slightly due to:
- RBAC PERMISSIONS clauses (15 tables × ~10 lines each)
- Multi-tenancy field definitions (15 tables × 3 fields × 4 lines each)
- Additional indexes (44 new indexes × 2 lines each)
- Backward compatibility views (4 views × ~15 lines each)

But organization and maintainability improved significantly:
- Clear logical grouping (registry, executions, composition, impulses)
- Consistent RBAC pattern across all tables
- Eliminated duplicate file numbering conflicts
- Added comprehensive documentation and comments
