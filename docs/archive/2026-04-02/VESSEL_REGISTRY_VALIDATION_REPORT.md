# Vessel Registry Protocol Validation Report

**Date:** 2026-03-31
**Spec:** SPEC-004 Vessel Registry Protocol
**Implementation:** repos/metabob-activity-api/src/routes/vessels.ts

## Executive Summary

The vessel registry protocol implementation is **INCOMPLETE and NON-FUNCTIONAL**. While the route handlers exist, critical issues prevent the system from working according to SPEC-004.

### Critical Issues

1. **Database writes fail** - UPSERT syntax is incorrect for SurrealDB
2. **Missing schema fields** - TTL, expiry, org_id not in `vessel_capabilities` table
3. **Wrong table** - Implementation uses `vessel_capabilities` instead of `vessel` as specified
4. **Missing endpoints** - Several required endpoints not implemented
5. **No TTL/expiry mechanism** - No cleanup job, no expiry tracking
6. **No org isolation** - Missing org_id field and RBAC permissions

## Detailed Validation Results

### 1. Endpoint Availability

| Endpoint | Status | Notes |
|----------|--------|-------|
| POST /v2/vessels/register | ⚠️ EXISTS BUT BROKEN | Returns 200 but doesn't write to DB |
| GET /v2/vessels/discover | ⚠️ PARTIAL | Exists but returns empty (nothing in DB) |
| GET /v2/vessels | ❌ NOT FOUND | Returns 404 |
| GET /v2/vessels/:id | ❌ NOT FOUND | Returns 404 |
| DELETE /v2/vessels/:id | ❌ NOT FOUND | Returns 404 |
| GET /v2/vessels/:id/health | ❌ NOT FOUND | Returns 404 |

### 2. Database Schema Compliance

**Current State (vessel_capabilities table):**

```sql
DEFINE TABLE vessel_capabilities SCHEMALESS;
DEFINE FIELD vessel_id ON vessel_capabilities TYPE string;
DEFINE FIELD vessel_name ON vessel_capabilities TYPE string;
DEFINE FIELD endpoint ON vessel_capabilities TYPE string;
DEFINE FIELD shapes ON vessel_capabilities TYPE array;
DEFINE FIELD metadata ON vessel_capabilities TYPE object DEFAULT {};
DEFINE FIELD registered_at ON vessel_capabilities TYPE datetime;
DEFINE FIELD last_seen ON vessel_capabilities TYPE datetime;
```

**Missing Fields (per SPEC-004):**
- ❌ `id` (record ID)
- ❌ `capabilities` (array<object>)
- ❌ `version` (string)
- ❌ `environment` (string)
- ❌ `ttl` (int, default 300)
- ❌ `last_heartbeat` (datetime)
- ❌ `expires_at` (datetime) - **CRITICAL**
- ❌ `org_id` (string) - **CRITICAL for multi-tenancy**

**Table Name:**
- Spec requires: `vessel`
- Implementation has: `vessel_capabilities`

**Permissions:**
- Current: `PERMISSIONS NONE` (open access)
- Required: Org-scoped with JWT auth

### 3. Registration Endpoint Issues

**Current Behavior:**
```bash
POST /v2/vessels/register
{
  "vesselId": "test",
  "vesselName": "Test",
  "endpoint": "http://test:8081",
  "shapes": ["test"],
  "ttl": 300
}

Response: 200 OK
{
  "success": true,
  "vesselId": "test",
  "timestamp": "2026-03-31T21:46:52.582Z",
  "message": "Vessel registered successfully"
}
```

**Database State After Registration:**
```sql
SELECT * FROM vessel_capabilities WHERE vessel_id = "test"
-- Returns: [] (empty)
```

**Root Cause:**

The UPSERT syntax in vessels.ts line 330-340 is incorrect:

```typescript
// BROKEN CODE
const query = `
  UPSERT vessel_capabilities SET
    vessel_id = $vessel_id,
    vessel_name = $vessel_name,
    endpoint = $endpoint,
    shapes = $shapes,
    metadata = $metadata,
    registered_at = $registered_at,
    last_seen = $last_seen
  WHERE vessel_id = $vessel_id
`;
```

This is **NOT valid SurrealDB syntax**. SurrealDB doesn't support `UPSERT...WHERE`.

**Correct Patterns:**

Option 1 - CREATE with specific ID:
```sql
CREATE vessel_capabilities:`concept-db` SET
  vessel_id = "concept-db",
  vessel_name = "Concept Database",
  ...
```

Option 2 - UPDATE with specific ID:
```sql
UPDATE vessel_capabilities:`concept-db` SET
  last_seen = time::now()
  -- No WHERE clause needed
```

Option 3 - Conditional logic:
```typescript
// First try CREATE, if fails (409), then UPDATE
try {
  await db.query(`CREATE vessel_capabilities:$id SET ...`);
} catch (e) {
  if (e.code === 409) { // Already exists
    await db.query(`UPDATE vessel_capabilities:$id SET ...`);
  }
}
```

### 4. Discovery Endpoint Issues

**Current Behavior:**
```bash
GET /v2/vessels/discover?shape=concept

Response: 200 OK (WRONG - should be 404)
{
  "vessels": [],
  "shape": "concept",
  "found": false,
  "message": "No vessels found that can resolve shape: concept"
}
```

**Issues:**
1. Returns 200 instead of 404 for not found (violates spec)
2. Cannot find vessels because registration doesn't work
3. Missing TTL filter (`expires_at > time::now()`)

**Correct Behavior (per spec):**
- Returns 404 with error object when no vessels found
- Filters by `expires_at > time::now()`
- Scopes to `org_id = $auth.org_id`

### 5. Test Results Summary

**From test/vessels.test.ts:**

```
 7 pass
 7 fail
```

**Passing Tests:**
✅ Validation errors (missing fields, empty shapes)
✅ Missing query parameters
✅ Auth requirements (skipped - JWT not configured)

**Failing Tests:**
❌ Registration success (returns wrong response format)
❌ Registration update (doesn't return `expires_at`)
❌ Discovery (empty results because DB writes fail)
❌ Expiry (can't test - registration broken)
❌ List vessels (endpoint not implemented)
❌ Heartbeat extension (can't test - no `expires_at`)

### 6. Missing Features

#### TTL and Expiry Mechanism

**Required:**
- `ttl` field in seconds (default 300)
- `expires_at` calculated as `registered_at + ttl`
- Discovery filters `WHERE expires_at > time::now()`
- Cleanup job runs periodically to DELETE expired vessels

**Current State:**
- ❌ No `ttl` field
- ❌ No `expires_at` field
- ❌ No cleanup job
- ❌ No expiry filtering

**Impact:**
Vessels accumulate forever. No automatic cleanup. Heartbeat mechanism cannot work.

#### Org Isolation

**Required:**
- `org_id` field populated from `$auth.org_id`
- Discovery scoped: `WHERE org_id = $auth.org_id`
- PERMISSIONS enforce isolation

**Current State:**
- ❌ No `org_id` field
- ❌ PERMISSIONS = NONE (no isolation)
- ❌ Discovery not scoped

**Impact:**
All vessels visible to all orgs. Security vulnerability.

#### Capabilities Structure

**Required (per spec):**
```typescript
interface VesselCapability {
  type: "impulse-resolver" | "tool" | "activity" | "mcp-server"
  shapes?: string[]        // For impulse-resolvers
  tools?: string[]         // For tool providers
  activities?: string[]    // For activity providers
  mcp?: {
    protocol: string
    tools: string[]
  }
}
```

**Current State:**
- ❌ Not implemented
- Only flat `shapes` array exists

#### Cleanup Job

**Required:**
```typescript
// Run every minute
async function cleanupExpiredVessels() {
  const deleted = await surrealDB.query(`
    DELETE FROM vessel
    WHERE expires_at < time::now()
    RETURN id
  `);
}
```

**Current State:**
- ❌ Not implemented
- No periodic cleanup
- No logging

### 7. Concept-DB Heartbeat Test

**Cannot test** because:
1. Registration endpoint doesn't write to database
2. No `expires_at` to track
3. No cleanup job to expire vessels

**Expected behavior (untestable):**
- concept-db registers on startup
- Re-registers every ~2.5 minutes (TTL/2)
- Never expires while running
- Expires after 5 minutes if stopped

## Response Format Violations

### Registration Response

**Spec requires:**
```json
{
  "id": "vessel_abc123",
  "expires_at": "2026-03-31T12:10:00Z"
}
```

**Implementation returns:**
```json
{
  "success": true,
  "vesselId": "test",
  "timestamp": "2026-03-31T21:46:52.582Z",
  "message": "Vessel registered successfully"
}
```

Missing: `id`, `expires_at`

### Discovery Response

**Spec for not found:**
```json
{
  "error": "No vessels found for shape: unknown_shape",
  "shape": "unknown_shape"
}
```

**Implementation returns:**
```json
{
  "vessels": [],
  "shape": "unknown_shape",
  "found": false,
  "message": "No vessels found that can resolve shape: unknown_shape"
}
```

Wrong: Returns 200 instead of 404, uses `message` instead of `error`

## Implementation Roadmap

### Phase 1: Fix Database Schema (CRITICAL)

1. Create new `vessel` table with all required fields
2. Add `org_id`, `ttl`, `expires_at`, `last_heartbeat`
3. Add proper RBAC permissions
4. Migrate existing `vessel_capabilities` data (if any)

### Phase 2: Fix Registration Endpoint

1. Fix UPSERT syntax to actually write to database
2. Calculate `expires_at = time::now() + ttl`
3. Return correct response format with `id` and `expires_at`
4. Extract `org_id` from JWT `$auth.org_id`

### Phase 3: Fix Discovery Endpoint

1. Add TTL filter: `WHERE expires_at > time::now()`
2. Add org filter: `WHERE org_id = $auth.org_id`
3. Return 404 for not found (not 200)
4. Return correct error format

### Phase 4: Implement Missing Endpoints

1. `GET /v2/vessels` - List all vessels
2. `GET /v2/vessels/:id` - Get vessel details
3. `DELETE /v2/vessels/:id` - Unregister vessel
4. `GET /v2/vessels/:id/health` - Health check

### Phase 5: Add TTL/Expiry Mechanism

1. Create cleanup job in `src/jobs/cleanup-vessels.ts`
2. Run every 60 seconds
3. DELETE expired vessels
4. Log cleanup activity

### Phase 6: Test with concept-db

1. Implement heartbeat in concept-db
2. Verify registration on startup
3. Verify re-registration every TTL/2
4. Verify no expiry while running
5. Verify expiry after stop

## Recommended Actions

### Immediate (P0)
1. **Fix UPSERT syntax** - Switch to CREATE + UPDATE pattern
2. **Add missing schema fields** - Especially `expires_at` and `org_id`
3. **Fix response formats** - Match SPEC-004 exactly

### Short-term (P1)
4. **Implement missing endpoints** - List, get, delete, health
5. **Add TTL filtering** - Discovery must filter expired vessels
6. **Add org isolation** - Enforce `org_id` in queries and permissions

### Medium-term (P2)
7. **Create cleanup job** - Remove expired vessels automatically
8. **Implement capabilities** - Support full capability structure
9. **Add integration tests** - Automated validation suite

### Long-term (P3)
10. **Add monitoring** - Track vessel count, expiry rate
11. **Add health checks** - Active pings to vessel endpoints
12. **Add public vessels** - Cross-org shared services

## Test Coverage Status

| Test Category | Status | Pass Rate |
|---------------|--------|-----------|
| Registration | ❌ FAIL | 1/4 (25%) |
| Discovery | ❌ FAIL | 1/3 (33%) |
| Expiry | ❌ FAIL | 0/1 (0%) |
| Org Isolation | ⚠️ SKIP | N/A (JWT not configured) |
| Additional Endpoints | ⚠️ SKIP | 0/4 (0%) |
| Heartbeat | ❌ FAIL | 0/1 (0%) |
| **TOTAL** | **❌ FAIL** | **7/14 (50%)** |

Note: 50% pass rate is misleading - most passes are validation errors, not actual functionality.

## Conclusion

The vessel registry protocol implementation is **non-functional** and requires significant work to meet SPEC-004 requirements. The core issue is the broken database write operation, which prevents any vessel from being registered. Additional issues include missing schema fields, missing endpoints, and no TTL/expiry mechanism.

**Estimated effort to fix:** 4-6 hours for full compliance

**Priority:** HIGH - This blocks vessel discovery and impulse resolution across the system

## References

- SPEC-004: `/home/avi/documents/work/exp-repo/metabob-devbob/openspec/vessel-specs/SPEC-004-vessel-registry-protocol.md`
- Implementation: `repos/metabob-activity-api/src/routes/vessels.ts`
- Schema: `repos/metabob-activity-api/sql/schemas/024-vessel-capabilities.surql`
- Tests: `repos/metabob-activity-api/test/vessels.test.ts`
