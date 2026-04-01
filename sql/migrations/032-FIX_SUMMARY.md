# Migration 032: Fix org_id Type Coercion in VALUE Clauses

## Problem

When using SurrealDB RECORD authentication, the `$auth` variable contains the entire authenticated record. When accessing `$auth.org_id` in VALUE clauses, SurrealDB was coercing the string value to a record ID format in some cases, causing type assertion failures.

### Error Observed

```
Expected `string` but found `organizations:metabob_internal`
```

Even though MiniBob was sending:
```json
{
  "org_id": "metabob_internal"
}
```

And the `minibob_instance.org_id` field is defined as `TYPE string`, the VALUE clause `VALUE $value OR $auth.org_id` was causing the org_id to be interpreted as a record ID.

## Root Cause

The issue occurs in this pattern across multiple tables:

```surql
DEFINE FIELD IF NOT EXISTS org_id ON impulse_data TYPE string
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id  -- ❌ Problem: No explicit type cast
  COMMENT "Organization ID (string reference to identity-vessel)";
```

When `$auth.org_id` is accessed during RECORD authentication, SurrealDB may return the value in a format that gets coerced to `record<organizations>` instead of staying as a plain string.

## Solution

Explicitly cast `$auth.org_id` to string in all VALUE clauses:

```surql
DEFINE FIELD IF NOT EXISTS org_id ON impulse_data TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id  -- ✅ Fixed: Explicit string cast
  COMMENT "Organization ID (string reference to identity-vessel)";
```

The `<string>` cast ensures that regardless of how SurrealDB represents the value internally, it is always converted to a plain string before being assigned to the field.

## Tables Updated

### Phase 1: Core Paradigm Tables (020-paradigm-core-tables.surql)
- `impulse.org_id`
- `activity.org_id`
- `execution.org_id`
- Note: `vessel.org_id` does NOT have VALUE clause, requires explicit value

### Phase 2: Activity Registry Tables (010-activity-registry.surql)
- `activity_registry.org_id`
- `variant_performance_metrics.org_id`

### Phase 3: Execution Tables (011-executions.surql)
- `activity_execution_traces.org_id`
- `activity_composition_graph.org_id`
- `impulse_relevance_metrics.org_id`
- `tool_usage.org_id`
- `thompson_selection_log.org_id`

### Phase 4: Composition Tables (012-composition.surql)
- `goal_execution_paths.org_id`
- `activity_dataflows.org_id`
- `activity_prerequisites.org_id`
- `prerequisite_patterns.org_id`
- `execution_sequences.org_id`

### Phase 5: Impulse Tables (013-impulse-tool-usage.surql)
- `impulse_data.org_id`
- `impulse_usage_history.org_id`
- `ci_runs.org_id`
- `code_variants.org_id`

### Phase 6: Ribosome Sequences (014-ribosome-sequences.surql)
- `composite_sequence_patterns.org_id`

### Phase 7: LLM Resolution (017-llm-resolution.surql)
- `llm_resolution_log.org_id`

### Phase 8: Patterns (018-patterns.surql)
- `pattern.org_id`

### Phase 9: Resolver Architecture (028-resolver-architecture.surql)
- `state_transition.org_id`
- `impulse_state_pattern.org_id`

## Migration Files

1. **Migration script**: `sql/migrations/032-fix-org-id-value-clause.surql`
   - Contains DEFINE FIELD statements for all affected tables
   - Safe to apply multiple times (IF NOT EXISTS)

2. **Schema files updated**:
   - All schema files in `sql/schemas/` with org_id VALUE clauses

3. **Verification script**: `sql/migrations/verify-032-org-id-value-clause.sh`
   - Checks that all org_id VALUE clauses use `<string>` cast
   - Run after applying migration to verify correctness

## Testing

### Before Fix

MiniBob would fail when creating impulses:
```
Error creating impulse: Expected `string` but found `organizations:metabob_internal`
```

### After Fix

MiniBob successfully creates impulses with org_id set to plain string:
```json
{
  "id": "impulse:xyz",
  "org_id": "metabob_internal",
  ...
}
```

### Verification

Run the verification script:
```bash
./sql/migrations/verify-032-org-id-value-clause.sh
```

Expected output:
```
✅ PASSED: All org_id VALUE clauses use <string> cast
```

## Deployment

1. Apply migration via migrate.ts:
   ```bash
   bun sql/migrate.ts
   ```

2. Verify with verification script:
   ```bash
   ./sql/migrations/verify-032-org-id-value-clause.sh
   ```

3. Test MiniBob authentication and impulse creation:
   ```bash
   # Authenticate
   curl -X POST http://api.minibob.local/v2/auth/minibob/signin \
     -H "Content-Type: application/json" \
     -d '{"instance_id":"minibob-local-001","api_key":"test-api-key-123"}'

   # Create impulse (should succeed now)
   curl -X POST http://api.minibob.local/v2/impulses \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{
       "impulse_id": "test",
       "pointer": {"type": "memo", "content": "test"},
       "shape": {"type": "text"}
     }'
   ```

## Related Issues

This fix is related to the org_id standardization effort:
- Migration 031: Standardized org_id to TYPE string across all tables
- Migration 032: Fixed VALUE clauses to prevent type coercion

## Notes

- The `<string>` cast is a SurrealDB type coercion operator
- This is different from the `string()` function
- The cast is applied before the ASSERT check, so type validation still works
- This pattern should be used for all fields that reference external records but are stored as strings
