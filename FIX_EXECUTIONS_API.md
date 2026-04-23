# Fix: Executions API 500 Error

**Date**: 2026-04-22
**Issue**: HTTP 500 from `/v2/activities/executions` endpoint
**Error Message**: "The access method cannot be used in the requested operation"

## Root Cause Analysis

### The Problem

The `activity_execution_traces` table has PERMISSIONS clauses that reference `$auth.org_id` and `$auth.project_ids`:

```sql
DEFINE TABLE IF NOT EXISTS activity_execution_traces SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
```

However, based on [SurrealDB 3.x documentation](https://surrealdb.com/docs/surrealql/statements/define/access/jwt):

1. **`$auth` variable**: Only populated when using TYPE RECORD access methods AND the JWT contains an `id` claim pointing to a SurrealDB record
2. **`$token` variable**: Contains custom JWT claims when using TYPE JWT access methods

### Current Authentication Flow

Our current setup uses `apikey_token` ACCESS method defined as TYPE JWT:

```sql
DEFINE ACCESS IF NOT EXISTS apikey_token ON DATABASE TYPE JWT
  ALGORITHM HS512
  KEY 'dev-secret-change-in-production'
  DURATION FOR TOKEN 15m, FOR SESSION 1h;
```

The JWT tokens are generated with these claims (from `src/services/auth.ts:144-151`):

```typescript
const token = await new jose.SignJWT({
  NS: config.surrealdb.namespace,
  DB: config.surrealdb.database,
  AC: 'apikey_token',
  id: `api_key:${context.keyId}`,         // This is NOT a record ID
  org_id: `organizations:${context.orgId}`, // Custom claim
  user_id: `users:${context.userId}`,       // Custom claim
  scopes: context.scopes,
})
```

### Why It Fails

The `id` claim is set to `api_key:${keyId}` which is **not** a valid record reference in SurrealDB (there's no `api_key` table with this ID). Therefore:

- `$auth` is **not populated** because the `id` claim doesn't point to a valid record
- `$auth.org_id` and `$auth.project_ids` are **undefined**
- PERMISSIONS clause `org_id = $auth.org_id` evaluates to `org_id = NONE`
- SurrealDB rejects the query with "The access method cannot be used in the requested operation"

### Evidence from Web Search

From [SurrealDB GitHub Issue #4229](https://github.com/surrealdb/surrealdb/issues/4229):
> "The $auth variable accessible from SurrealQL will not contain any values if the id claim is not added to the JWT, as it requires the id claim to identify a SurrealDB record."

From [SurrealDB Authentication Docs](https://surrealdb.com/docs/surrealdb/security/authentication):
> "When calling SurrealDB interfaces using a JWT, SurrealQL queries gain access to claims in the token through the $token variable, so custom claims like 'name' or 'email' are accessible through $token.name and $token.email."

## Solutions

### Solution 1: Use $token Instead of $auth (RECOMMENDED)

Update PERMISSIONS clauses to use `$token` for custom claims:

**File**: `sql/schemas/011-executions.surql`

```sql
DEFINE TABLE IF NOT EXISTS activity_execution_traces SCHEMAFULL
  PERMISSIONS
    -- SELECT: Users can see executions in their org and assigned projects
    FOR select WHERE
      org_id = $token.org_id
      AND (project_id IS NONE OR project_id IN $token.project_ids)

    -- CREATE: Any authenticated user can create execution traces
    FOR create WHERE $token.org_id != NONE

    -- UPDATE: Users can update executions they created or admins in their org
    FOR update WHERE
      org_id = $token.org_id
      AND ($token.role = 'admin' OR created_by = $token.id)

    -- DELETE: Only admins can delete execution traces
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';
```

**Migration**: Create `sql/migrations/079-fix-executions-permissions-use-token.surql`

```sql
-- =============================================================================
-- Migration 079: Fix activity_execution_traces PERMISSIONS to use $token
-- =============================================================================
-- Date: 2026-04-22
--
-- Problem: PERMISSIONS clauses use $auth.org_id which is not populated for
-- TYPE JWT access methods. The $auth variable requires an 'id' claim pointing
-- to a valid SurrealDB record.
--
-- Solution: Use $token.org_id instead, which accesses custom JWT claims directly.
--
-- References:
-- - https://surrealdb.com/docs/surrealql/statements/define/access/jwt
-- - https://github.com/surrealdb/surrealdb/issues/4229
-- =============================================================================

DEFINE TABLE activity_execution_traces OVERWRITE SCHEMAFULL
  PERMISSIONS
    -- SELECT: Users can see executions in their org and assigned projects
    FOR select WHERE
      org_id = $token.org_id
      AND (project_id IS NONE OR project_id IN $token.project_ids)

    -- CREATE: Any authenticated user can create execution traces
    --   org_id and project_id are auto-assigned from $token
    FOR create WHERE $token.org_id != NONE

    -- UPDATE: Users can update executions they created or admins in their org
    FOR update WHERE
      org_id = $token.org_id
      AND ($token.role = 'admin' OR created_by = $token.id)

    -- DELETE: Only admins can delete execution traces
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';
```

### Solution 2: Create Actual Record-Based Authentication (COMPLEX)

This would require:

1. Creating an `api_key` table in SurrealDB with record IDs
2. Using TYPE RECORD access method instead of TYPE JWT
3. Linking JWT `id` claim to actual records
4. Ensuring all authentication flows create/update these records

**This is complex and not recommended** because:
- Violates the vessel pattern (identity-vessel owns api_key table)
- Requires dual-write to both identity-vessel and activity-api databases
- Adds significant complexity for marginal benefit

## Implementation Steps

### Step 1: Create Migration File

```bash
cd /home/avi/documents/work/exp-repo/metabob-devbob/repos/metabob-activity-api
cat > sql/migrations/079-fix-executions-permissions-use-token.surql << 'EOF'
-- =============================================================================
-- Migration 079: Fix activity_execution_traces PERMISSIONS to use $token
-- =============================================================================
-- Date: 2026-04-22
--
-- Problem: PERMISSIONS clauses use $auth.org_id which is not populated for
-- TYPE JWT access methods. The $auth variable requires an 'id' claim pointing
-- to a valid SurrealDB record.
--
-- Solution: Use $token.org_id instead, which accesses custom JWT claims directly.
--
-- References:
-- - https://surrealdb.com/docs/surrealql/statements/define/access/jwt
-- - https://github.com/surrealdb/surrealdb/issues/4229
-- =============================================================================

DEFINE TABLE activity_execution_traces OVERWRITE SCHEMAFULL
  PERMISSIONS
    -- SELECT: Users can see executions in their org and assigned projects
    FOR select WHERE
      org_id = $token.org_id
      AND (project_id IS NONE OR project_id IN $token.project_ids)

    -- CREATE: Any authenticated user can create execution traces
    --   org_id and project_id are auto-assigned from $token
    FOR create WHERE $token.org_id != NONE

    -- UPDATE: Users can update executions they created or admins in their org
    FOR update WHERE
      org_id = $token.org_id
      AND ($token.role = 'admin' OR created_by = $token.id)

    -- DELETE: Only admins can delete execution traces
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';
EOF
```

### Step 2: Update Base Schema

Also update the base schema file to reflect the correct pattern:

**File**: `sql/schemas/011-executions.surql` (lines 59-76)

Replace `$auth` with `$token` in all PERMISSIONS clauses.

### Step 3: Apply Migration

**Local Testing**:
```bash
# Connect to local SurrealDB
surreal sql --endpoint http://localhost:8000 \
  --namespace activity-system \
  --database learning_loop \
  --username root \
  --password "surrealdb-local-dev-123"

# Import migration
IMPORT 'sql/migrations/079-fix-executions-permissions-use-token.surql';

# Verify
INFO FOR TABLE activity_execution_traces;
```

**Production Deployment**:
The migration will be applied automatically when the deployment pipeline runs.

### Step 4: Update Other Tables with Same Issue

After confirming the fix works, apply the same pattern to other tables:

1. **activity_template** - Uses `$auth.org_id`
2. **thompson_selection_log** - Uses `$auth.org_id`
3. **impulse_relevance_metrics** - Uses `$auth.org_id`
4. **tool_usage** - Uses `$auth.org_id`
5. **All tables in migration 068** - Need to use `$token` instead of `$auth`

### Step 5: Update Field VALUE Clauses

Also update auto-assignment VALUE clauses to use `$token`:

```sql
-- Before:
DEFINE FIELD IF NOT EXISTS org_id ON activity_execution_traces TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id

-- After:
DEFINE FIELD IF NOT EXISTS org_id ON activity_execution_traces TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$token.org_id
```

## Testing Plan

### Test 1: List Executions via Workbench

```bash
# Should return 200 with executions array
curl -X GET https://activity.metabob.com/v2/activities/executions \
  -H "Authorization: ApiKey <your-api-key>" \
  -H "Content-Type: application/json"
```

Expected result:
```json
{
  "executions": [...],
  "total": 5,
  "limit": 50,
  "offset": 0
}
```

### Test 2: Get Single Execution

```bash
curl -X GET https://activity.metabob.com/v2/activities/executions/<execution_id> \
  -H "Authorization: ApiKey <your-api-key>"
```

Expected: 200 OK with execution details

### Test 3: Create Execution (POST)

```bash
curl -X POST https://activity.metabob.com/v2/activities/execution-traces \
  -H "Authorization: ApiKey <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "execution_id": "test-exec-123",
    "template_id": "test-template",
    "status": "completed",
    "success": true,
    "duration_ms": 1000,
    "cost_usd": 0.01,
    "org_id": "test-org"
  }'
```

Expected: 200 OK with stored trace

### Test 4: Multi-Tenant Isolation

Use two different API keys from different orgs:

```bash
# Org A - should only see Org A's executions
curl -X GET https://activity.metabob.com/v2/activities/executions \
  -H "Authorization: ApiKey <org-a-key>"

# Org B - should only see Org B's executions
curl -X GET https://activity.metabob.com/v2/activities/executions \
  -H "Authorization: ApiKey <org-b-key>"
```

Expected: Each org sees only their own data

## Impact Analysis

### Breaking Changes

**None**. This is a bug fix that restores intended functionality.

### Affected Components

1. **Workbench** - Will now be able to fetch execution traces
2. **Activity Dashboard** - Execution timeline will work correctly
3. **MiniBob instances** - Can now store and retrieve execution traces with proper RBAC

### Rollback Plan

If the fix causes issues, revert by:

1. Rolling back migration 079
2. Restoring original PERMISSIONS with `$auth` (even though they don't work)
3. Investigating alternative authentication approach

## Related Issues

### Templates API Similar Issue

The Templates API had a similar 500 error which was likely also caused by `$auth.org_id` being undefined. The same fix (using `$token` instead) should be applied there.

Check: `sql/schemas/001-init-schema.surql` for `activity_template` table.

### Migration 068 Comprehensive Fix Needed

Migration 068 added PERMISSIONS to 14 tables, all using `$auth.org_id`. All of these need to be updated to use `$token.org_id`:

1. impulse_relevance_metrics
2. activity_execution_traces ✅ (this fix)
3. execution_traces
4. goal_execution_paths
5. composition_node
6. composition_chain
7. composition_impulse_flow
8. resolver
9. impulse_state_pattern
10. state_transition
11. tool_argument_pattern
12. llm_resolution_log
13. pattern
14. composite_sequence_patterns

**Recommendation**: Create migration 080 to fix all remaining tables.

## Key Learnings

1. **SurrealDB TYPE JWT vs TYPE RECORD**:
   - TYPE JWT: Custom claims in `$token`, `$auth` is undefined unless `id` points to valid record
   - TYPE RECORD: Authenticates against a table, `$auth` points to the record

2. **PERMISSIONS Debugging**:
   - Test PERMISSIONS by querying with actual JWT tokens
   - Use `INFO FOR TABLE <name>` to see PERMISSIONS clauses
   - Check SurrealDB logs for permission-related errors

3. **Multi-Tenant RBAC**:
   - Always verify org isolation in PERMISSIONS
   - Test with multiple org API keys
   - Use `$token.org_id` for JWT-based auth, not `$auth.org_id`

## References

- [SurrealDB JWT Access Documentation](https://surrealdb.com/docs/surrealql/statements/define/access/jwt)
- [SurrealDB Record Access Documentation](https://surrealdb.com/docs/surrealql/statements/define/access/record)
- [SurrealDB Authentication Troubleshooting](https://surrealdb.com/docs/surrealdb/security/troubleshooting)
- [GitHub Issue #4229: ACCESS TYPE RECORD WITH JWT needs field id](https://github.com/surrealdb/surrealdb/issues/4229)
- [SurrealDB Parameters Documentation](https://surrealdb.com/docs/surrealql/parameters)

## Next Steps

1. ✅ Create migration 079 for activity_execution_traces
2. ⬜ Test locally with curl
3. ⬜ Test via Workbench UI
4. ⬜ Create migration 080 for remaining 13 tables
5. ⬜ Update base schema files in sql/schemas/
6. ⬜ Document the $token vs $auth pattern in CLAUDE.md
7. ⬜ Deploy to canary and validate
8. ⬜ Promote to production
