# Fix: Templates API 500 Error - "The access method cannot be used in the requested operation"

**Date**: 2026-04-22
**Status**: IDENTIFIED - Migration Already Applied
**Severity**: Critical - Blocks API access

## Executive Summary

The Templates API endpoint (`GET /v2/activities/templates`) returns HTTP 500 with error message "The access method cannot be used in the requested operation" when using API key authentication. This is a **SurrealDB ACCESS method / PERMISSIONS issue** that was previously fixed in Migration 074, but may not have been applied to all environments.

## Root Cause Analysis

### The Problem

When a client authenticates using `Authorization: ApiKey <key>`, the following flow occurs:

1. **API Key Validation** (`src/middleware/jwtAuth.ts:142-156`)
   - Client sends: `Authorization: ApiKey <key>`
   - Activity-API validates via identity-vessel
   - If valid, generates JWT token using `generateJwtToken()`

2. **JWT Token Generation** (`src/services/auth.ts:122-169`)
   - Creates JWT with claims:
     ```json
     {
       "NS": "activity-system",
       "DB": "learning_loop",
       "AC": "apikey_token",
       "id": "api_key:<keyId>",
       "org_id": "organizations:<orgId>",
       "user_id": "users:<userId>",
       "scopes": ["read", "write"]
     }
     ```
   - Signs with `JWT_SECRET` (default: `dev-secret-change-in-production`)
   - Uses HS512 algorithm

3. **SurrealDB Authentication** (`src/db/surreal.ts:168-181`)
   - Calls `db.authenticate(jwtToken)`
   - SurrealDB validates JWT against ACCESS method `apikey_token`
   - Populates `$auth` variable for PERMISSIONS enforcement

4. **Query Execution** (`src/routes/activities.ts:544`)
   - Queries: `SELECT * FROM activity WHERE ...`
   - SurrealDB applies PERMISSIONS clause
   - **FAILURE POINT**: PERMISSIONS clause tries to compare `org_id = $auth.org_id`

### Why It Fails

**Type Mismatch in PERMISSIONS Clause:**

- **JWT Claim Format**: `org_id = "organizations:<orgId>"` (string in record format)
- **Database Field**: `org_id` stored as either:
  - String: `"metabob_internal"`
  - Record: `organizations:metabob_internal`
- **SurrealDB 3.x Behavior**: Strict type checking fails when comparing different types

**Error Message Decoded:**
"The access method cannot be used in the requested operation" means:
- The ACCESS method `apikey_token` is defined correctly
- The JWT token is valid and signed correctly
- BUT the PERMISSIONS clause on the `activity` table fails during evaluation
- This causes SurrealDB to reject the query as an authentication/authorization error

### Previous Fix (Migration 074)

Migration `074-fix-org-id-type-mismatch-comprehensive.surql` was created on 2026-04-21 to fix this exact issue:

**What it does:**
- Updates PERMISSIONS clauses on 12 critical tables
- Adds explicit type casting to handle all type combinations:

```surql
FOR select WHERE
  (scope = 'global' AND public = true)
  OR (
    -- Handle multiple type combinations for org_id matching
    org_id = $auth.org_id
    OR org_id = <string>$auth.org_id
    OR <string>org_id = $auth.org_id
    OR <string>org_id = <string>$auth.org_id
  )
  OR (scope = 'project' AND project_id IN $auth.project_ids)
```

**Tables Fixed:**
1. `activity` (Paradigm schema - primary template table)
2. `activity_template` (Legacy schema)
3. `variant_performance_metrics`
4. `activity_execution_traces`
5. `execution`
6. `activity_composition_graph`
7. `composition_edge`
8. `dataflow_connection`
9. `prerequisite`
10. `composition_instance`
11. `goal_execution_paths`
12. `impulse`

## Current State Investigation

### Files Analyzed

1. **Schema Files:**
   - `/repos/metabob-activity-api/sql/000-auth-schema.surql` - Defines `apikey_token` ACCESS method (Migration 064)
   - `/repos/metabob-activity-api/sql/migrations/064-add-apikey-token-access.surql` - ACCESS method creation
   - `/repos/metabob-activity-api/sql/migrations/074-fix-org-id-type-mismatch-comprehensive.surql` - PERMISSIONS fix

2. **Application Code:**
   - `/repos/metabob-activity-api/src/middleware/jwtAuth.ts` - JWT middleware
   - `/repos/metabob-activity-api/src/services/auth.ts` - JWT generation
   - `/repos/metabob-activity-api/src/routes/activities.ts` - Templates endpoint
   - `/repos/metabob-activity-api/src/db/surreal.ts` - Database client
   - `/repos/metabob-activity-api/src/config.ts` - Configuration

3. **Documentation:**
   - `/repos/metabob-activity-api/sql/migrations/MIGRATION-074-SUMMARY.md` - Fix summary
   - `/repos/metabob-activity-api/sql/migrations/074-TESTING-PLAN.md` - Testing procedures

### ACCESS Method Configuration

**Migration 064 (Applied):**
```surql
DEFINE ACCESS OVERWRITE apikey_token ON DATABASE TYPE JWT
  ALGORITHM HS512
  KEY 'dev-secret-change-in-production'
  DURATION FOR TOKEN 15m, FOR SESSION 1h;
```

**Current Config (`src/config.ts:139`):**
```typescript
jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production'
```

**CRITICAL**: The JWT_SECRET environment variable MUST match the KEY in the ACCESS definition.

## Possible Causes

Given that Migration 074 exists and was committed on 2026-04-21, there are several possibilities:

### 1. Migration Not Applied to Canary/Production
**Likelihood**: High
**Symptoms**: Templates endpoint returns 500 error
**Verification**: Query SurrealDB to check PERMISSIONS clause on `activity` table
**Fix**: Apply migration 074

### 2. JWT_SECRET Mismatch
**Likelihood**: Medium
**Symptoms**: "The access method cannot be used in the requested operation"
**Verification**: Check if `JWT_SECRET` env var matches SurrealDB ACCESS KEY
**Fix**: Update environment variable or re-run migration with correct KEY

### 3. ACCESS Method Not Defined
**Likelihood**: Low (Migration 064 is older)
**Symptoms**: "Access method not found" error
**Verification**: Query SurrealDB: `INFO FOR DB` and check ACCESS methods
**Fix**: Apply migration 064

### 4. Incorrect AC Claim in JWT
**Likelihood**: Low (code is correct)
**Symptoms**: JWT authentication fails
**Verification**: Decode JWT token and check `AC` field
**Fix**: Update `generateJwtToken()` to use correct AC name

## Verification Steps

### Step 1: Check if Migration 074 has been applied

```bash
# Connect to SurrealDB (adjust credentials)
surreal sql --endpoint http://localhost:8000 \
  --namespace activity-system \
  --database learning_loop \
  --username root \
  --password <password>

# Check PERMISSIONS on activity table
INFO FOR TABLE activity;

# Expected output should show PERMISSIONS clause with type casting
```

**What to look for:**
- PERMISSIONS clause should have 4 OR conditions for org_id matching
- Should see `<string>org_id` and `<string>$auth.org_id` casts

### Step 2: Check ACCESS method

```bash
# Check ACCESS methods defined
INFO FOR DB;

# Expected output should include:
# - apikey_token (TYPE JWT, ALGORITHM HS512)
```

### Step 3: Verify JWT_SECRET matches

```bash
# Check environment variable
echo $JWT_SECRET

# Should match the KEY in ACCESS definition:
# - Development: 'dev-secret-change-in-production'
# - Production: <production-secret>
```

### Step 4: Test JWT token generation and validation

```bash
# Generate test JWT (from Activity-API)
curl -X POST http://localhost:8080/v2/auth/test-jwt \
  -H "Content-Type: application/json" \
  -d '{"orgId": "metabob_internal", "userId": "test", "keyId": "test"}'

# Decode JWT to verify claims
# Use https://jwt.io or jwt-cli tool

# Expected claims:
# - AC: "apikey_token"
# - NS: "activity-system"
# - DB: "learning_loop"
# - org_id: "organizations:metabob_internal"
```

### Step 5: Test Templates endpoint

```bash
# Test with API key
curl -H "Authorization: ApiKey <your-api-key>" \
  https://activity.metabob.com/v2/activities/templates

# Expected: 200 OK with template data
# If 500: Check logs for specific error
```

## Solution

### Option A: Migration 074 Not Applied (Most Likely)

**Apply Migration 074:**

```bash
# Navigate to activity-api directory
cd repos/metabob-activity-api

# Apply migration (adjust endpoint/credentials)
surreal sql --endpoint http://localhost:8000 \
  --namespace activity-system \
  --database learning_loop \
  --username root \
  --password <password> \
  sql/migrations/074-fix-org-id-type-mismatch-comprehensive.surql

# Verify application
surreal sql --endpoint http://localhost:8000 \
  --namespace activity-system \
  --database learning_loop \
  --username root \
  --password <password> \
  -c "INFO FOR TABLE activity"
```

**Via Kubernetes (if deployed):**

```bash
# Find SurrealDB pod
kubectl get pods -n activity-system | grep surreal

# Port-forward to local
kubectl port-forward -n activity-system svc/surrealdb 8000:8000

# Apply migration (see above)
```

### Option B: JWT_SECRET Mismatch

**Update ACCESS Method:**

```bash
# Update ACCESS method with production secret
surreal sql --endpoint http://localhost:8000 \
  --namespace activity-system \
  --database learning_loop \
  --username root \
  --password <password> \
  -c "
  DEFINE ACCESS OVERWRITE apikey_token ON DATABASE TYPE JWT
    ALGORITHM HS512
    KEY '<your-jwt-secret>'
    DURATION FOR TOKEN 15m, FOR SESSION 1h;
  "
```

**OR Update Environment Variable:**

```bash
# Set JWT_SECRET to match ACCESS KEY
export JWT_SECRET='dev-secret-change-in-production'

# Restart Activity-API
kubectl rollout restart deployment -n activity-system metabob-activity-api
```

### Option C: Both Migrations Needed

Apply migrations in order:
1. Migration 064 (ACCESS method)
2. Migration 074 (PERMISSIONS fix)

## Testing After Fix

### 1. Smoke Tests

```bash
# Health check
curl https://activity.metabob.com/health

# Templates endpoint (unauthenticated - should fail with 401/403)
curl https://activity.metabob.com/v2/activities/templates

# Templates endpoint (with API key)
curl -H "Authorization: ApiKey <key>" \
  https://activity.metabob.com/v2/activities/templates
```

### 2. Full Test Suite

```bash
# Run Activity-API tests
cd repos/metabob-activity-api
bun test

# Specific endpoint tests
bun test src/routes/activities.test.ts
```

### 3. Integration Tests

```bash
# Test with MiniBob
minibob --single "list available activity templates"

# Test with Workbench
# Navigate to activity templates page
# Should see template list without errors
```

## Related Issues

- **Issue**: Composition graph returning NULL values
- **Fix**: Also fixed by Migration 074 (PERMISSIONS on composition tables)

- **Issue**: Thompson Sampling metrics not updating
- **Fix**: Also fixed by Migration 074 (PERMISSIONS on variant_performance_metrics)

## References

### Migrations
- `sql/migrations/064-add-apikey-token-access.surql` - ACCESS method definition
- `sql/migrations/074-fix-org-id-type-mismatch-comprehensive.surql` - PERMISSIONS fix
- `sql/migrations/MIGRATION-074-SUMMARY.md` - Fix documentation

### SurrealDB Documentation
- [DEFINE ACCESS ... TYPE JWT](https://surrealdb.com/docs/surrealql/statements/define/access/jwt) - JWT access method definition
- [Authentication](https://surrealdb.com/docs/surrealdb/security/authentication) - SurrealDB authentication overview
- [PERMISSIONS](https://surrealdb.com/docs/surrealdb/security/authentication) - Table-level permissions

### Code References
- `src/middleware/jwtAuth.ts:126-285` - JWT authentication middleware
- `src/services/auth.ts:122-169` - JWT token generation
- `src/routes/activities.ts:1114-1306` - Templates endpoint
- `src/db/surreal.ts:168-221` - Authenticated client creation

## Commit History

- `daea780` (2026-04-21) - "fix(permissions): resolve API key authentication 500 error on templates endpoint"
- Migration 074 created and committed
- Previous commit addressed this exact issue

## How to Apply Migration 074

### For Kubernetes Environments

Use the provided migration script:

```bash
# Navigate to activity-api directory
cd repos/metabob-activity-api

# Apply to local environment
./scripts/apply-migration-074-k8s.sh local

# Apply to canary environment
./scripts/apply-migration-074-k8s.sh canary

# Apply to production environment
./scripts/apply-migration-074-k8s.sh production
```

The script will:
1. Retrieve SurrealDB credentials from Kubernetes secrets
2. Set up port-forward to SurrealDB
3. Apply migration 074
4. Verify PERMISSIONS clause contains type casting
5. Display next steps for testing

### For Direct SurrealDB Access

```bash
# Using surreal CLI
surreal sql --endpoint http://localhost:8000 \
  --namespace activity-system \
  --database learning_loop \
  --username root \
  --password <password> \
  sql/migrations/074-fix-org-id-type-mismatch-comprehensive.surql

# Using curl
curl -X POST "http://localhost:8000/sql" \
  -u "root:<password>" \
  -H "Accept: application/json" \
  -H "NS: activity-system" \
  -H "DB: learning_loop" \
  --data-binary "@sql/migrations/074-fix-org-id-type-mismatch-comprehensive.surql"
```

## Next Steps

1. ⬜ Verify migration 074 has been applied to canary environment
2. ⬜ Verify migration 074 has been applied to production environment
3. ⬜ If not applied, apply migration 074 using `./scripts/apply-migration-074-k8s.sh`
4. ⬜ Test templates endpoint with API key authentication
5. ⬜ Monitor logs for authentication errors
6. ⬜ Update deployment documentation with migration checklist

## Success Criteria

- ✅ Templates endpoint returns 200 OK with API key authentication
- ✅ No "The access method cannot be used in the requested operation" errors in logs
- ✅ Multi-tenant isolation maintained (users see only their org's templates)
- ✅ Thompson Sampling metrics update correctly
- ✅ Composition graph returns complete data (no NULL values)
- ✅ No performance degradation (< 5% increase in query time)

## Rollback Plan

If migration 074 causes issues:

```bash
# Revert PERMISSIONS to previous version
# WARNING: This will re-introduce the bug
git revert daea780

# Apply previous schema
surreal sql --endpoint http://localhost:8000 \
  --namespace activity-system \
  --database learning_loop \
  --username root \
  --password <password> \
  sql/migrations/073-add-times-failed-to-tool-argument-pattern.surql
```

## Conclusion

The Templates API 500 error is caused by a **type mismatch in PERMISSIONS clauses** when comparing `org_id` fields with `$auth.org_id` JWT claims. This issue was identified and fixed in Migration 074 (2026-04-21).

**Most likely cause**: Migration 074 has not been applied to the environment where the error is occurring.

**Recommended action**: Verify migration status and apply Migration 074 if needed.

**Confidence**: High - Migration 074 was specifically created to fix this exact error message and symptom.
