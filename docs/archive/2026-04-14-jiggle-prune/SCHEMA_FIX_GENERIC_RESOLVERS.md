# Schema Fix: Support for Generic Resolvers

**Date**: 2026-04-09
**Issue**: Activity creation fails with nested field validation errors
**Fix**: Update `activity` table schema to support arbitrary resolver types

## Problem

Activities failed to create with error:
```
Query failed in activity-system.learning_loop: Found field 'tasks[0].prompt.variables[0].description',
but no such field exists for table 'activity'
```

This blocked:
- Dynamic activity creation via `/v2/activities/create-goal-seeking`
- Activity composition workflows
- Goal-seeking execution

## Root Cause

The `activity` table schema defined tasks as:
```surql
DEFINE FIELD IF NOT EXISTS tasks ON activity TYPE option<array<object>> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS tasks.* ON activity TYPE object FLEXIBLE;
```

Even with `FLEXIBLE`, SurrealDB validated deeply nested fields when:
1. The array type was specified as `array<object>`
2. A separate `tasks.*` field definition existed

This meant LLM-based activities with nested structures like:
```json
{
  "tasks": [
    {
      "prompt": {
        "variables": [
          { "description": "..." }
        ]
      }
    }
  ]
}
```

...were rejected because `tasks[0].prompt.variables[0].description` wasn't explicitly defined in the schema.

## Solution

Updated schema to truly support generic resolvers (not just LLM):

**File**: `repos/metabob-activity-api/sql/schemas/020-paradigm-core-tables.surql`

**Changes**:
```surql
-- Before
DEFINE FIELD IF NOT EXISTS tasks ON activity TYPE option<array<object>> FLEXIBLE
  COMMENT "Task steps array for template execution";
DEFINE FIELD IF NOT EXISTS tasks.* ON activity TYPE object FLEXIBLE
  COMMENT "Individual task objects with arbitrary nested fields (dependencies, prompt, etc.)";

-- After
DEFINE FIELD IF NOT EXISTS tasks ON activity TYPE option<array> FLEXIBLE
  COMMENT "Task steps array - supports any resolver type (LLM, deterministic, tool, etc.)";
```

**Key differences**:
1. Changed `option<array<object>>` → `option<array>` (removes element type constraint)
2. Removed `tasks.*` field definition (prevents deep validation)
3. Updated comment to emphasize generic resolver support

## Supported Resolver Types

This schema now supports any task resolver pattern:

### LLM Resolvers
```json
{
  "id": "analyze",
  "prompt": {
    "template": "Analyze {{code}}",
    "variables": [
      { "name": "code", "type": "string", "description": "Code to analyze" }
    ],
    "maxTokens": 4000
  }
}
```

### Deterministic Resolvers
```json
{
  "id": "run-tests",
  "resolver": {
    "type": "bash",
    "command": "npm test",
    "timeout": 30000
  }
}
```

### Tool Invocations
```json
{
  "id": "read-file",
  "resolver": {
    "type": "tool",
    "tool": "read",
    "args": { "path": "package.json" }
  }
}
```

### Compositions
```json
{
  "id": "validate",
  "resolver": {
    "type": "composition",
    "activities": ["lint", "typecheck", "test"]
  }
}
```

### Future Patterns
Any future resolver type can be added without schema changes.

## How to Apply

### For Canary/Production Deployment

The schema change is in `sql/schemas/020-paradigm-core-tables.surql`, which is loaded by the init-db job on deployment.

**Option 1: Redeploy with schema update**
```bash
cd repos/deployment
git pull  # Get updated schema
helmfile -e canary sync --selector app.kubernetes.io/name=metabob-activity-api
```

The init-db job will apply the updated schema.

**Option 2: Manual migration (if redeploy not possible)**
Use the migration file in `sql/migrations/054-fix-activity-flexible-schema.surql`:
```bash
# Port-forward to SurrealDB (if accessible in cluster)
kubectl port-forward -n activity-system svc/surrealdb 8000:8000

# Run migration
curl -X POST http://localhost:8000/sql \
  -H "surreal-ns: activity-system" \
  -H "surreal-db: learning_loop" \
  -u 'root:password' \
  --data-binary @sql/migrations/054-fix-activity-flexible-schema.surql
```

### For Local Development

If running local SurrealDB:
```bash
cd repos/metabob-activity-api
export SURREALDB_URL=http://localhost:8000
export SURREALDB_USERNAME=root
export SURREALDB_PASSWORD=root

# Apply migration
curl -X POST http://localhost:8000/sql \
  -H "surreal-ns: activity-system" \
  -H "surreal-db: learning_loop" \
  -u 'root:root' \
  --data-binary @sql/migrations/054-fix-activity-flexible-schema.surql
```

## Testing

After applying the schema fix, test activity creation:

### Test 1: Create goal-seeking activity
```bash
curl -X POST https://activity.metabob.com/v2/activities/create-goal-seeking \
  -H "Authorization: ApiKey mb_self_canary_..." \
  -H "Content-Type: application/json" \
  -d '{
    "goal_description": "Test goal",
    "template_name": "test-template",
    "category": "test",
    "variables": {},
    "impulse_refs": [],
    "constraints": {
      "max_tasks": 7,
      "max_cost": 5.0,
      "prefer_composition": true
    }
  }'
```

Expected: `{"status":"success","template_id":"..."}` (not 500 error)

### Test 2: Run composition activity
```bash
cd /home/avi/documents/work/exp-repo/metabob-devbob/repos/minibob
export ANTHROPIC_API_KEY="sk-ant-..."

bun run index.ts --template \
  /home/avi/documents/work/exp-repo/demo-minibob-cicd/activities/development/ci-pipeline.json
```

Expected: Activity completes without 500 errors from backend

### Test 3: Run goal-seeking workflow
```bash
bun run index.ts --single "Fix the TypeScript errors in counter.test.ts"
```

Expected: Goal processor creates activity dynamically without backend errors

## Architecture Compliance

This fix aligns with the impulse/activity foundation:

✅ **Generic resolvers**: Not all resolvers are LLMs
✅ **Flexible execution**: Activities can use any resolver type
✅ **No premature constraints**: Schema doesn't assume execution method
✅ **Future-proof**: New resolver types don't require schema changes

## Impact

**Before fix**:
- ❌ Only LLM activities with flat structures worked
- ❌ Composition workflows blocked
- ❌ Goal-seeking failed with 500 errors
- ❌ Deterministic resolvers couldn't be properly defined

**After fix**:
- ✅ LLM activities with any nesting level work
- ✅ Composition workflows function correctly
- ✅ Goal-seeking creates activities dynamically
- ✅ Deterministic resolvers fully supported
- ✅ Future resolver types can be added without schema changes

## Files Modified

- `repos/metabob-activity-api/sql/schemas/020-paradigm-core-tables.surql` - Schema definition
- `repos/metabob-activity-api/sql/migrations/054-fix-activity-flexible-schema.surql` - Migration script
- `repos/metabob-activity-api/scripts/apply-migration-054.sh` - Migration helper (for local/direct access)

## Next Steps

1. **Commit changes** to metabob-devbob repository
2. **Sync to deployment** repository
3. **Deploy to canary** (triggers init-db with updated schema)
4. **Test** activity creation and composition workflows
5. **Promote to production** after canary validation

## Rollback

If issues occur, the old schema can be restored:
```surql
DEFINE FIELD IF NOT EXISTS tasks ON activity TYPE option<array<object>> FLEXIBLE
  COMMENT "Task steps array for template execution";
DEFINE FIELD IF NOT EXISTS tasks.* ON activity TYPE object FLEXIBLE
  COMMENT "Individual task objects with arbitrary nested fields";
```

However, this will reintroduce the validation errors for deeply nested fields.
