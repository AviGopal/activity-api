# Templates API 500 Error - Quick Fix Guide

**Error**: "The access method cannot be used in the requested operation"
**Endpoint**: `GET /v2/activities/templates`
**Status**: Migration 074 fixes this issue

## Quick Diagnosis

```bash
# Check if the error is occurring
curl -H "Authorization: ApiKey <your-api-key>" \
  https://activity.metabob.com/v2/activities/templates

# Expected error response (if migration not applied):
# {"error": "Failed to fetch templates", "message": "The access method cannot be used in the requested operation"}
```

## Quick Fix

### Step 1: Apply Migration 074

```bash
# Navigate to metabob-activity-api
cd repos/metabob-activity-api

# For Kubernetes deployment (canary):
./scripts/apply-migration-074-k8s.sh canary

# For Kubernetes deployment (production):
./scripts/apply-migration-074-k8s.sh production

# For local development:
./scripts/apply-migration-074-k8s.sh local
```

### Step 2: Verify Fix

```bash
# Test templates endpoint again
curl -H "Authorization: ApiKey <your-api-key>" \
  https://activity.metabob.com/v2/activities/templates

# Expected: 200 OK with JSON response containing templates array
```

### Step 3: Monitor Logs

```bash
# Check activity-api logs for authentication errors
kubectl logs -n activity-system -l app.kubernetes.io/name=metabob-activity-api --tail=100 -f

# Should NOT see:
# - "The access method cannot be used in the requested operation"
# - "There was a problem with authentication"
```

## What Migration 074 Does

Fixes **type mismatch in PERMISSIONS clauses** by adding explicit type casting:

```surql
-- BEFORE (fails with type mismatch)
FOR select WHERE org_id = $auth.org_id

-- AFTER (handles all type combinations)
FOR select WHERE
  org_id = $auth.org_id
  OR org_id = <string>$auth.org_id
  OR <string>org_id = $auth.org_id
  OR <string>org_id = <string>$auth.org_id
```

Affects 12 critical tables:
- `activity` (primary template table)
- `activity_template` (legacy)
- `variant_performance_metrics`
- `activity_execution_traces`
- `execution`
- `activity_composition_graph`
- `composition_edge`
- `dataflow_connection`
- `prerequisite`
- `composition_instance`
- `goal_execution_paths`
- `impulse`

## Troubleshooting

### Issue: Migration script fails

```bash
# Check if SurrealDB is accessible
kubectl get pods -n activity-system | grep surreal

# Check if secrets exist
kubectl get secret surrealdb-auth -n activity-system

# Manual port-forward and apply
kubectl port-forward -n activity-system svc/surrealdb 8000:8000 &
curl -X POST "http://localhost:8000/sql" \
  -u "root:<password>" \
  -H "NS: activity-system" \
  -H "DB: learning_loop" \
  --data-binary "@sql/migrations/074-fix-org-id-type-mismatch-comprehensive.surql"
```

### Issue: Still getting 500 error after migration

1. **Check JWT_SECRET matches ACCESS KEY:**
   ```bash
   # Check environment variable
   kubectl get deployment metabob-activity-api -n activity-system -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="JWT_SECRET")].value}'

   # Should be: 'dev-secret-change-in-production' (development)
   # Or your production secret
   ```

2. **Verify ACCESS method exists:**
   ```bash
   kubectl port-forward -n activity-system svc/surrealdb 8000:8000 &
   curl -X POST "http://localhost:8000/sql" \
     -u "root:<password>" \
     -H "NS: activity-system" \
     -H "DB: learning_loop" \
     -d "INFO FOR DB;" | jq '.access'

   # Should show: apikey_token (TYPE JWT)
   ```

3. **Restart Activity-API:**
   ```bash
   kubectl rollout restart deployment -n activity-system metabob-activity-api
   kubectl rollout status deployment -n activity-system metabob-activity-api
   ```

### Issue: Migration applied but templates still return error

Check if the PERMISSIONS clause was actually updated:

```bash
kubectl port-forward -n activity-system svc/surrealdb 8000:8000 &
curl -X POST "http://localhost:8000/sql" \
  -u "root:<password>" \
  -H "NS: activity-system" \
  -H "DB: learning_loop" \
  -d "INFO FOR TABLE activity;" | jq '.permissions'

# Should contain: "<string>org_id" and "<string>$auth.org_id"
```

## Success Criteria

✅ Templates endpoint returns 200 OK
✅ Response contains `{"templates": [...], "total": N}`
✅ No authentication errors in logs
✅ Dashboard displays template list correctly

## Related Fixes

Migration 074 also fixes:
- Composition graph NULL values
- Thompson Sampling metric update failures
- Multi-tenant isolation issues

## Documentation

Full documentation: `/repos/metabob-activity-api/FIX_TEMPLATES_API.md`

Migration details: `/repos/metabob-activity-api/sql/migrations/MIGRATION-074-SUMMARY.md`

## Emergency Rollback

If migration causes critical issues:

```bash
# Revert to previous schema (WARNING: Re-introduces the bug)
kubectl port-forward -n activity-system svc/surrealdb 8000:8000 &
curl -X POST "http://localhost:8000/sql" \
  -u "root:<password>" \
  -H "NS: activity-system" \
  -H "DB: learning_loop" \
  --data-binary "@sql/migrations/073-add-times-failed-to-tool-argument-pattern.surql"

# Restart Activity-API
kubectl rollout restart deployment -n activity-system metabob-activity-api
```

## Support

- Full analysis: `FIX_TEMPLATES_API.md`
- Testing plan: `sql/migrations/074-TESTING-PLAN.md`
- Migration script: `scripts/apply-migration-074-k8s.sh`
- Issue: Workbench getting HTTP 500 from templates endpoint
- Root cause: SurrealDB PERMISSIONS type mismatch (org_id comparison)
- Solution: Migration 074 adds explicit type casting
