# Phase 2: Activity API RBAC Migration

## Overview

This migration refactors the existing activity-api schema to use SurrealDB 3.0 RBAC with multi-tenant isolation. The key changes are:

1. **Schema reorganization**: Consolidates 9 separate .surql files into 4 organized schema files
2. **RBAC PERMISSIONS**: Adds database-enforced permissions to all tables
3. **Multi-tenancy fields**: Adds `org_id` and `project_id` to all tables
4. **Core schema integration**: Imports organizations, users, projects from `@metabob/proto`
5. **Data migration**: Backfills `org_id = organization:metabob_internal` on existing records

## New Schema Structure

### Before (9 files, 1,651 lines)
```
sql/
├── 001-init-schema.surql (222 lines)
├── 002-learning-system-phase1.surql (227 lines)
├── 003-goal-execution-paths.surql (110 lines)
├── 004-execution-traces.surql (37 lines)
├── 005-ci-integration.surql (170 lines)
├── 005-dashboard-components.surql (327 lines)
├── 005-impulse-data.surql (45 lines)
├── 007-control-flow-data-flow-learning.surql (275 lines)
└── 008-unified-activity-model.surql (238 lines)
```

### After (4 files + migrate.ts)
```
sql/
├── schemas/
│   ├── 010-activity-registry.surql     # Activity templates + unified model
│   ├── 011-executions.surql            # Execution traces + composition + metrics
│   ├── 012-composition.surql           # Goal paths + dataflows + prerequisites
│   └── 013-impulse-tool-usage.surql    # Impulses + tool usage + CI integration
└── migrate.ts                          # Migration runner
```

## RBAC Permissions Pattern

All tables follow this permission pattern:

```sql
DEFINE TABLE activity_registry SCHEMAFULL
  PERMISSIONS
    -- SELECT: Users can see:
    --   1. Global public activities (marketplace)
    --   2. Activities in their organization
    --   3. Activities in their projects
    FOR select WHERE
      (scope = 'global' AND public = true)
      OR (org_id = $auth.org_id)
      OR (scope = 'project' AND project_id IN $auth.project_ids)

    -- CREATE: Any authenticated user
    FOR create WHERE $auth.org_id != NONE

    -- UPDATE: Admins or record creator
    FOR update WHERE
      (org_id = $auth.org_id AND $auth.role = 'admin')
      OR (org_id = $auth.org_id AND created_by = $auth.id)

    -- DELETE: Admins only
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';
```

## Multi-Tenancy Fields

Every table now has:

```sql
-- Required for RBAC isolation
DEFINE FIELD org_id ON table_name TYPE record<organizations>
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (required)";

-- Optional project scoping
DEFINE FIELD project_id ON table_name TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

-- Audit trail
DEFINE FIELD created_by ON table_name TYPE option<record<users>>
  VALUE $value OR $auth.id
  COMMENT "User or instance who created this record";
```

## Indexes for Performance

Critical indexes for RBAC query performance:

```sql
-- Single-field indexes
DEFINE INDEX idx_table_org ON table_name FIELDS org_id;
DEFINE INDEX idx_table_project ON table_name FIELDS project_id;

-- Composite indexes for common query patterns
DEFINE INDEX idx_table_org_project
  ON table_name FIELDS org_id, project_id;

DEFINE INDEX idx_table_org_project_activity
  ON table_name FIELDS org_id, project_id, activity_id;
```

## Migration Process

### Step 1: Dry-Run Preview

```bash
cd repos/metabob-activity-api
bun run migrate:dry-run
```

This shows what would be applied without making changes.

### Step 2: Apply Schemas

```bash
bun run migrate
```

This:
1. Applies core schemas from @metabob/proto (organizations, users, projects)
2. Applies activity-specific schemas (registry, executions, composition, impulses)
3. Creates default organization: `organization:metabob_internal`
4. Backfills `org_id` on all existing records in batches of 10,000
5. Records migration in `schema_version` table

### Step 3: Data-Only Migration

If schemas are already applied and you only need to run data migrations:

```bash
bun run migrate:data-only
```

### Step 4: Verify Migration

Query the schema version:

```bash
surreal sql --endpoint http://localhost:8000 \
  --namespace activity-system \
  --database learning_loop \
  --username root \
  --password root \
  "SELECT * FROM schema_version ORDER BY applied_at DESC LIMIT 1;"
```

Verify default organization exists:

```bash
surreal sql --endpoint http://localhost:8000 \
  --namespace activity-system \
  --database learning_loop \
  --username root \
  --password root \
  "SELECT * FROM organizations WHERE id = organization:metabob_internal;"
```

Check that existing records have org_id:

```bash
surreal sql --endpoint http://localhost:8000 \
  --namespace activity-system \
  --database learning_loop \
  --username root \
  --password root \
  "SELECT id, org_id FROM activity_registry LIMIT 10;"
```

## Testing Locally

Use the test migration script to test in an isolated namespace:

```bash
# Start SurrealDB
surreal start --bind 0.0.0.0:8000 --user root --pass root memory

# Run test migration
cd repos/metabob-activity-api
./sql/test-migration.sh
```

This creates a test namespace `activity-system-test` and database `learning_loop_test`.

## Backward Compatibility

The migration includes views for backward compatibility:

- `view_activity_template` → `activity_registry WHERE execution_format = 'template'`
- `view_execution_traces` → `activity_execution_traces`
- `view_activity_executions` → `activity_execution_traces`
- `view_goal_paths` → `goal_execution_paths`

Existing code querying old table names will continue to work via these views.

## Rollback Procedure

If migration fails or causes issues:

### Option 1: Revert to Backup

```bash
# Restore from pre-migration backup
surreal import --endpoint http://localhost:8000 \
  --namespace activity-system \
  --database learning_loop \
  --username root \
  --password root \
  backup-pre-migration.surql
```

### Option 2: Drop Added Fields

```bash
# Remove org_id and project_id from tables
surreal sql --endpoint http://localhost:8000 \
  --namespace activity-system \
  --database learning_loop \
  --username root \
  --password root \
  "ALTER TABLE activity_registry DROP org_id;
   ALTER TABLE activity_registry DROP project_id;
   ALTER TABLE activity_registry DROP created_by;"
```

### Option 3: Full Database Reset

```bash
# Drop database and recreate from backup
surreal sql --endpoint http://localhost:8000 \
  --namespace activity-system \
  --username root \
  --password root \
  "REMOVE DATABASE learning_loop;"

# Restore from backup
surreal import ...
```

## Production Deployment Checklist

Before deploying to production:

- [ ] Create full database backup
- [ ] Test migration on staging with production data snapshot
- [ ] Verify query performance with RBAC (< 100ms for indexed queries)
- [ ] Confirm no application errors in logs
- [ ] Test health endpoints for all services
- [ ] Schedule maintenance window (estimated: 30 minutes for 1M records)
- [ ] Prepare rollback scripts and runbook
- [ ] Monitor query performance after deployment
- [ ] Verify WebSocket authentication works with new RBAC

## Table Migration Summary

| Table                       | org_id | project_id | created_by | Indexes Added |
|-----------------------------|--------|------------|------------|---------------|
| activity_registry           | ✓      | ✓          | ✓          | 4 new         |
| activity_execution_traces   | ✓      | ✓          | ✓          | 6 new         |
| variant_performance_metrics | ✓      | ✓          | -          | 2 new         |
| activity_composition_graph  | ✓      | ✓          | -          | 2 new         |
| impulse_relevance_metrics   | ✓      | ✓          | -          | 1 new         |
| tool_usage                  | ✓      | ✓          | -          | 2 new         |
| goal_execution_paths        | ✓      | ✓          | -          | 4 new         |
| activity_dataflows          | ✓      | ✓          | -          | 3 new         |
| activity_prerequisites      | ✓      | ✓          | -          | 1 new         |
| prerequisite_patterns       | ✓      | ✓          | -          | 1 new         |
| execution_sequences         | ✓      | ✓          | -          | 3 new         |
| impulse_data                | ✓      | ✓          | ✓          | 5 new         |
| impulse_usage_history       | ✓      | ✓          | -          | 4 new         |
| ci_runs                     | ✓      | ✓          | -          | 3 new         |
| code_variants               | ✓      | ✓          | -          | 3 new         |

**Total:** 15 tables migrated, 44 new indexes added

## Environment Variables

Required for migration:

```bash
# SurrealDB connection
export SURREALDB_URL="http://localhost:8000"
export SURREALDB_NAMESPACE="activity-system"
export SURREALDB_DATABASE="learning_loop"
export SURREALDB_USERNAME="root"
export SURREALDB_PASSWORD="your-password"

# Optional: Custom metabob-proto path
export METABOB_PROTO_PATH="/path/to/metabob-proto/surrealdb/core"
```

## Next Steps

After Phase 2 migration is complete:

1. **Phase 3**: Create Analysis API schemas with same RBAC pattern
2. **Phase 4**: Add MiniBob RECORD authentication
3. **Update application code**: Remove manual org_id filtering (rely on PERMISSIONS)
4. **Update routes**: Trust $auth.org_id from SurrealDB
5. **Add JWT validation middleware**: Enforce authentication
6. **Deploy to staging**: Test with production data snapshot
7. **Deploy to production**: Blue-green deployment with rollback ready

## Support

For issues or questions:

- Review `RBAC_TROUBLESHOOTING.md` for common issues
- Check SurrealDB logs for permission errors
- Use `surreal sql` to test queries manually
- Contact team if migration fails in production
