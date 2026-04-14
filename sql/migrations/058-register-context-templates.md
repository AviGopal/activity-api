# Migration 058: Register Context Acquisition Templates

**Created**: 2026-04-12
**Purpose**: Register primordial context acquisition templates in Activity-API backend to enable Thompson Sampling for bootstrap activities.

## Templates Registered

This migration registers three context acquisition templates:

1. **acquire-error-log-context** - Extract error messages and stack traces from execution traces or log files
2. **acquire-requirements-context** - Extract requirements from specification files or directories
3. **acquire-codebase-context** - Map repository structure and analyze module dependencies

## Implementation Details

### Template Structure

Each template includes:
- **category**: `context-acquisition`
- **tags**: `["context.<type>", "bootstrap.primordial"]`
- **metadata**: `primordial: true, bootstrap: true, level: 0`
- **public**: `true` (global templates)
- **org_id**: `00000000-0000-0000-0000-000000000000` (global scope)

### Thompson Sampling Initialization

Each template gets initialized metrics with:
- **alpha**: 1 (neutral prior)
- **beta**: 1 (neutral prior)
- **total_executions**: 0
- **successful_executions**: 0
- **failed_executions**: 0

## Validation

After running this migration, verify:

### 1. Templates Exist

```bash
curl -X POST http://activity.metabob.local/sql \
  -u 'root:surrealdb-local-dev-123' \
  -H 'surreal-ns: activity-system' \
  -H 'surreal-db: learning_loop' \
  -d "SELECT * FROM activity_template WHERE id IN ['acquire-error-log-context', 'acquire-requirements-context', 'acquire-codebase-context']"
```

**Expected**: 3 templates returned

### 2. Metrics Initialized

```bash
curl -X POST http://activity.metabob.local/sql \
  -u 'root:surrealdb-local-dev-123' \
  -H 'surreal-ns: activity-system' \
  -H 'surreal-db: learning_loop' \
  -d "SELECT * FROM activity_metrics WHERE activity_id IN ['acquire-error-log-context', 'acquire-requirements-context', 'acquire-codebase-context']"
```

**Expected**: 3 metrics records with alpha=1, beta=1

### 3. API Endpoints Work

```bash
# List templates (should include context templates)
curl -X GET http://activity.metabob.local/v2/activities/templates

# Thompson Sampling recommendation with context requirements
curl -X POST http://activity.metabob.local/v2/activities/recommend \
  -H "Content-Type: application/json" \
  -d '{
    "goalDescription": "Debug a failed test",
    "contextRequirements": ["error_log"]
  }'
```

**Expected**: `acquire-error-log-context` appears in recommendations

### 4. Tag Filtering

```bash
# Query templates by tag
curl -X POST http://activity.metabob.local/sql \
  -u 'root:surrealdb-local-dev-123' \
  -H 'surreal-ns: activity-system' \
  -H 'surreal-db: learning_loop' \
  -d "SELECT * FROM activity_template WHERE 'bootstrap.primordial' IN tags"
```

**Expected**: At least 3 templates (the context acquisition templates)

## Rollback

If needed, remove the templates and metrics:

```sql
DELETE FROM activity_template WHERE id IN [
  'acquire-error-log-context',
  'acquire-requirements-context',
  'acquire-codebase-context'
];

DELETE FROM activity_metrics WHERE activity_id IN [
  'acquire-error-log-context',
  'acquire-requirements-context',
  'acquire-codebase-context'
];
```

## Related Files

- **Migration**: `sql/migrations/058-register-context-templates.surql`
- **Shape definitions**: `sql/migrations/057-orchestrator-shapes.surql`
- **Templates**: Will be registered via bootstrap seed in future

## Dependencies

- Migration 056: Shape registry (defines shape_definition table)
- Migration 057: Orchestrator shapes (defines error_log, requirement, codebase_structure shapes)

## Next Steps

After this migration:
1. Deploy to canary environment
2. Verify templates appear in Activity Dashboard
3. Test Thompson Sampling recommendations include context templates
4. Implement MiniBob executor for these templates (if not already done)
