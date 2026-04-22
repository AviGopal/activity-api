# Cleanup Upkeep Runbook

End-to-end verification that activities can perform destructive upkeep
through the impulse surface. Exercises `cleanup-stale-traces-v1` (migration
078) which chains `executionTraceList` (read) →
`activityExecutionTrace_delete` (write) → `upkeepAuditLog` (audit impulse).

## Prerequisites

- Canary healthy: `curl https://activity.metabob.com/health | jq .status` → `"healthy"`
- Admin API key with the test org scope
- A non-admin API key in the same org (for the negative test)
- `jq` on your shell

```bash
export API=https://activity.metabob.com
export ADMIN_KEY=sk-admin-xxxxxxxxxxxx
export USER_KEY=sk-user-xxxxxxxxxxxxx
export TEST_ORG_ID=org_cleanup_$(date +%s)

# For seeding, we need direct SurrealDB access (admin creds)
export SURREALDB_URL=https://surql.metabob.com
export SURREALDB_PASSWORD=...  # from 1Password / secrets
```

All API calls authenticate with `Authorization: ApiKey <key>`.

---

## Step 1 — Seed fixtures

```bash
TEST_ORG_ID=$TEST_ORG_ID bun run seed:cleanup-test
```

**Expected**: `Created 50 execution-trace fixtures` and a bucket breakdown
(15×3d + 10×7d + 12×30d + 13×60d).

**Verify via the read resolver**:

```bash
curl -s -X POST "$API/v2/impulses/resolve" \
  -H "Authorization: ApiKey $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"pointer": {"type": "executionTraceList", "filter": "all", "limit": 100}}' \
  | jq '.metadata.rowCount'
```

**Expected**: `50` (or at least 50 — larger if other traces exist in the org).

---

## Step 2 — Dry run (must not mutate)

```bash
OLDER_THAN=$(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)

curl -s -X POST "$API/v2/impulses/resolve" \
  -H "Authorization: ApiKey $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"pointer\": {
    \"type\": \"activityExecutionTrace_delete\",
    \"olderThan\": \"$OLDER_THAN\",
    \"limit\": 100,
    \"dryRun\": true
  }}" | jq .
```

**Expected envelope** (`jq .metadata.shape`): `"activityExecutionTrace_delete_result"`.

**Expected content** (`jq -r .content | jq`):

```json
{
  "type": "activityExecutionTrace",
  "ids": ["...", "...", ...],
  "count": 25,
  "dryRun": true,
  "olderThan": "2026-03-23T..."
}
```

**Assertion**: `count == 25` (12×30d + 13×60d). No deletion side effect.

---

## Step 3 — Confirm nothing was deleted

Repeat the Step 1 verify query. **Expected**: rowCount still ≥ 50.

---

## Step 4 — Real delete

Same request as Step 2 but `dryRun: false`:

```bash
curl -s -X POST "$API/v2/impulses/resolve" \
  -H "Authorization: ApiKey $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"pointer\": {
    \"type\": \"activityExecutionTrace_delete\",
    \"olderThan\": \"$OLDER_THAN\",
    \"limit\": 100,
    \"dryRun\": false
  }}" | jq -r .content | jq .
```

**Expected content**:

```json
{
  "type": "activityExecutionTrace",
  "count": 25,
  "dryRun": false,
  "olderThan": "2026-03-23T...",
  "auditImpulseId": "upkeep-1714...-abcd12"
}
```

**Capture** the `auditImpulseId` for the next step:

```bash
AUDIT_ID=$(curl -s -X POST "$API/v2/impulses/resolve" \
  -H "Authorization: ApiKey $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"pointer\": {\"type\": \"activityExecutionTrace_delete\", \"olderThan\": \"$OLDER_THAN\", \"limit\": 100, \"dryRun\": false}}" \
  | jq -r '.content | fromjson | .auditImpulseId')
echo "Audit impulse: $AUDIT_ID"
```

---

## Step 5 — Audit impulse exists with correct payload

```bash
curl -s "$API/v2/impulses/$AUDIT_ID" \
  -H "Authorization: ApiKey $ADMIN_KEY" | jq .
```

**Expected** (fields from the `upkeepAuditLog` shape, migration 077):

```json
{
  "id": "upkeep-...",
  "shape": "upkeepAuditLog",
  "pointer": {
    "operation": "delete",
    "target_table": "activity_execution_traces",
    "target_ids": ["...", "...", ...],
    "filter_used": {"olderThan": "...", "success": null, "limit": 100},
    "dry_run": false,
    "count": 25,
    "performed_by": "<admin key id>",
    "org_id": "<your TEST_ORG_ID>",
    "performed_at": "..."
  }
}
```

**Assertion**: `pointer.target_ids | length == 25`.

---

## Step 6 — Row count dropped

```bash
curl -s -X POST "$API/v2/impulses/resolve" \
  -H "Authorization: ApiKey $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"pointer": {"type": "executionTraceList", "filter": "all", "limit": 100}}' \
  | jq '.metadata.rowCount'
```

**Expected**: `25` (15×3d + 10×7d remain).

---

## Step 7 — Idempotency

Re-run Step 4. **Expected**:

```json
{"type": "activityExecutionTrace", "count": 0, "dryRun": false, ...}
```

`summary` in the envelope: `"No matching traces to delete"`. No audit
impulse emitted when count is 0.

---

## Step 8 — RBAC negative test

Same call as Step 4 but with a non-admin key:

```bash
curl -s -X POST "$API/v2/impulses/resolve" \
  -H "Authorization: ApiKey $USER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"pointer\": {
    \"type\": \"activityExecutionTrace_delete\",
    \"olderThan\": \"$OLDER_THAN\",
    \"limit\": 100,
    \"dryRun\": false
  }}" | jq .
```

**Expected**: `success: false`. The SurrealDB PERMISSIONS layer rejects the
DELETE because `$auth.role != 'admin'`; the resolver surfaces the DB error
in `.error`. Exact message varies, but it should reference permission or
auth. Row count in Step 6 must not have changed further.

---

## Step 9 — Invoke via MiniBob (template round trip)

Proves the full activity path works, not just the resolver.

```bash
minibob --single "run upkeep activity cleanup-stale-traces-v1 with olderThanDays=30 dryRun=true"
```

**Expected**: MiniBob resolves the `cleanup-stale-traces-v1` template via
`activityTemplate`, executes its task sequence, and emits a `cleanup_report`
impulse describing candidate and deleted counts.

The specific MiniBob invocation path depends on how the template executor
interprets free-form goals vs. explicit template ids. If the free-form
phrasing doesn't route, fall back to an explicit invocation:

```bash
# direct template invocation via the goal resolver
curl -s -X POST "$API/v2/impulses/resolve" \
  -H "Authorization: ApiKey $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"pointer": {
    "type": "goal",
    "content": "prune traces older than 30 days (dry run)",
    "category": "upkeep"
  }}' | jq '.content | fromjson | .recommendations[0].template_id'
```

**Expected**: `"cleanup-stale-traces-v1"` should be the top recommendation
when the goal text matches upkeep semantics.

---

## Step 10 — Cleanup leftover fixtures

Any rows tagged `metadata.marker == 'fixture:cleanup-test'` younger than
30d didn't get deleted by Step 4. Drop them directly:

```bash
# via SurrealDB HTTP — requires admin creds
curl -s -X POST "$SURREALDB_URL/sql" \
  -H "Authorization: Basic $(echo -n "root:$SURREALDB_PASSWORD" | base64)" \
  -H "surreal-ns: activity-system" \
  -H "surreal-db: learning_loop" \
  -H "Content-Type: application/json" \
  -d "DELETE FROM activity_execution_traces WHERE org_id = '$TEST_ORG_ID' AND metadata.marker = 'fixture:cleanup-test';"
```

---

## Pass criteria

| Step | Pass condition |
| --- | --- |
| 1 | 50 fixtures created |
| 2 | dryRun returns count=25, no deletion |
| 3 | row count unchanged |
| 4 | real delete returns count=25, auditImpulseId present |
| 5 | audit impulse contains the 25 deleted ids, operation=delete |
| 6 | row count dropped to 25 |
| 7 | idempotent — second run deletes 0 |
| 8 | non-admin key rejected at DB layer |
| 9 | MiniBob (or goal resolver) recommends/runs the template |
| 10 | fixtures cleaned up |

If every step passes, we've validated that (a) the destructive resolver
surface works end-to-end, (b) RBAC is enforced at the DB level, (c) audit
records are emitted correctly, and (d) activities can compose the whole
loop through impulse resolution with no hardcoded REST calls.
