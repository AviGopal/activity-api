# Migration 074: Comprehensive Testing Plan

## Overview

This migration fixes org_id type mismatch issues in PERMISSIONS clauses across 12 critical tables. Testing must verify:
1. API key authentication works for all endpoints
2. Multi-tenant isolation is maintained
3. Thompson Sampling updates work correctly
4. Composition graph queries work correctly
5. No performance degradation

## Pre-Migration Checklist

- [ ] Backup SurrealDB database
- [ ] Document current system state
- [ ] Verify canary deployment is healthy
- [ ] Check current error rate in logs

## Test Environment Setup

```bash
# Set up test environment variables
export METABOB_API_KEY="your-api-key-here"
export CANARY_ENDPOINT="https://activity.metabob.com"
export ORG_ID="metabob_internal"  # Your test org

# Verify API key authentication works
curl -H "Authorization: ApiKey $METABOB_API_KEY" \
  $CANARY_ENDPOINT/health
```

## Phase 1: Critical Endpoints (Templates & Composition)

### Test 1: Templates Endpoint
**Objective**: Verify GET /v2/activities/templates works with API key auth

```bash
# Before migration: Should return 500 error
curl -v -H "Authorization: ApiKey $METABOB_API_KEY" \
  $CANARY_ENDPOINT/v2/activities/templates

# After migration: Should return 200 with template list
curl -H "Authorization: ApiKey $METABOB_API_KEY" \
  $CANARY_ENDPOINT/v2/activities/templates | jq '.templates | length'

# Expected: > 0 templates returned
```

**Success Criteria**:
- [ ] Returns 200 OK status
- [ ] Returns array of templates
- [ ] Templates have variant_id, activity_id, tasks fields
- [ ] Only returns templates for authenticated org

### Test 2: Composition Graph Endpoint
**Objective**: Verify GET /v2/activities/composition/graph works (fixes NULL parent/child bug)

```bash
# Before migration: Returns records with NULL parent_activity_id, child_activity_id
curl -H "Authorization: ApiKey $METABOB_API_KEY" \
  "$CANARY_ENDPOINT/v2/activities/composition/graph?limit=10"

# After migration: Should return proper parent/child relationships
curl -H "Authorization: ApiKey $METABOB_API_KEY" \
  "$CANARY_ENDPOINT/v2/activities/composition/graph?limit=10" | \
  jq '.graph[] | select(.parent_activity_id == null or .child_activity_id == null)'

# Expected: No records with NULL parent/child (empty output)
```

**Success Criteria**:
- [ ] Returns 200 OK status
- [ ] No NULL parent_activity_id values
- [ ] No NULL child_activity_id values
- [ ] Relationships are org-scoped correctly

### Test 3: Variant Performance Metrics
**Objective**: Verify Thompson Sampling alpha/beta updates work

```bash
# Query metrics before
curl -H "Authorization: ApiKey $METABOB_API_KEY" \
  "$CANARY_ENDPOINT/v2/activities/templates" | \
  jq '.templates[0] | {variant_id, thompson_alpha, thompson_beta}'

# Trigger an execution (via MiniBob or test script)
# This should update the metrics

# Query metrics after
curl -H "Authorization: ApiKey $METABOB_API_KEY" \
  "$CANARY_ENDPOINT/v2/activities/templates" | \
  jq '.templates[0] | {variant_id, thompson_alpha, thompson_beta}'

# Expected: thompson_alpha or thompson_beta should increment
```

**Success Criteria**:
- [ ] Metrics query returns data
- [ ] Metrics update after execution
- [ ] thompson_alpha/beta values are correct
- [ ] Only org's metrics are visible

## Phase 2: Execution Tracking

### Test 4: Execution Trace Storage
**Objective**: Verify POST /v2/activities/execution-traces works

```bash
# Create a test execution trace
curl -X POST -H "Authorization: ApiKey $METABOB_API_KEY" \
  -H "Content-Type: application/json" \
  $CANARY_ENDPOINT/v2/activities/execution-traces \
  -d '{
    "execution_id": "test-exec-'$(date +%s)'",
    "activity_id": "test-activity",
    "variant_id": "test-variant",
    "success": true,
    "duration_ms": 1000,
    "cost_usd": 0.01,
    "tokens_input": 100,
    "tokens_output": 50,
    "executed_at": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'"
  }'

# Query traces to verify storage
curl -H "Authorization: ApiKey $METABOB_API_KEY" \
  "$CANARY_ENDPOINT/v2/activities/execution-traces?limit=1" | \
  jq '.traces[0] | {execution_id, activity_id, org_id}'
```

**Success Criteria**:
- [ ] POST returns 201 or 200
- [ ] Trace is stored with correct org_id
- [ ] Trace is queryable via GET
- [ ] Only org's traces are visible

### Test 5: Execution Filtering by Org
**Objective**: Verify multi-tenant isolation in execution queries

```bash
# Query executions (should only see org's data)
curl -H "Authorization: ApiKey $METABOB_API_KEY" \
  "$CANARY_ENDPOINT/v2/activities/execution-traces?limit=10" | \
  jq '.traces[] | .org_id' | sort -u

# Expected: Only shows authenticated org's org_id
```

**Success Criteria**:
- [ ] Only returns executions for authenticated org
- [ ] No cross-org data leakage
- [ ] Correct org_id in all returned traces

## Phase 3: Thompson Sampling

### Test 6: Template Recommendation
**Objective**: Verify POST /v2/activities/recommend works

```bash
# Request template recommendation
curl -X POST -H "Authorization: ApiKey $METABOB_API_KEY" \
  -H "Content-Type: application/json" \
  $CANARY_ENDPOINT/v2/activities/recommend \
  -d '{
    "activity_id": "test-goal-seeking",
    "context": {
      "goal": "test goal"
    }
  }' | jq '.recommendation | {variant_id, score, reason}'
```

**Success Criteria**:
- [ ] Returns 200 OK status
- [ ] Returns recommended variant
- [ ] Recommendation is org-scoped
- [ ] Thompson Sampling score is calculated

### Test 7: Goal Execution Paths
**Objective**: Verify goal path queries work

```bash
# Query goal execution paths
curl -H "Authorization: ApiKey $METABOB_API_KEY" \
  "$CANARY_ENDPOINT/v2/activities/goal-execution-paths?limit=10" | \
  jq '.paths[] | {goal_hash, path_activities, thompson_alpha, thompson_beta}'
```

**Success Criteria**:
- [ ] Returns goal paths
- [ ] Paths are org-scoped
- [ ] Thompson Sampling parameters are present

## Phase 4: Impulse System

### Test 8: Impulse Queries
**Objective**: Verify impulse table queries work

```bash
# Query impulses (if endpoint exists)
curl -H "Authorization: ApiKey $METABOB_API_KEY" \
  "$CANARY_ENDPOINT/v2/impulses?limit=10" | \
  jq '.impulses[] | {id, shape, org_id}'
```

**Success Criteria**:
- [ ] Returns impulses for authenticated org only
- [ ] No cross-org data leakage

## Phase 5: Performance and Security

### Test 9: Query Performance
**Objective**: Verify no performance degradation from type casting

```bash
# Measure query time before migration
time curl -s -H "Authorization: ApiKey $METABOB_API_KEY" \
  "$CANARY_ENDPOINT/v2/activities/templates" > /dev/null

# Measure query time after migration (should be similar)
time curl -s -H "Authorization: ApiKey $METABOB_API_KEY" \
  "$CANARY_ENDPOINT/v2/activities/templates" > /dev/null

# Expected: Similar or faster response times
```

**Success Criteria**:
- [ ] Response time within 10% of baseline
- [ ] No timeout errors
- [ ] CPU usage normal

### Test 10: Multi-Tenant Isolation
**Objective**: Verify cross-org queries are blocked

```bash
# Try to query another org's data (should fail or return empty)
# This requires a test with multiple orgs

# Query with org A's API key
curl -H "Authorization: ApiKey $ORG_A_API_KEY" \
  "$CANARY_ENDPOINT/v2/activities/templates" | jq '.templates[0].org_id'

# Query with org B's API key
curl -H "Authorization: ApiKey $ORG_B_API_KEY" \
  "$CANARY_ENDPOINT/v2/activities/templates" | jq '.templates[0].org_id'

# Expected: Each org only sees their own data
```

**Success Criteria**:
- [ ] Each org sees only their own templates
- [ ] No cross-org data leakage
- [ ] PERMISSIONS enforced correctly

## Phase 6: Integration Testing

### Test 11: End-to-End MiniBob Workflow
**Objective**: Verify complete MiniBob workflow with new PERMISSIONS

```bash
# Run a complete MiniBob execution
minibob --single "list available activities" --api-key $METABOB_API_KEY

# Should:
# 1. Authenticate with API key
# 2. Query templates (uses activity table)
# 3. Select template via Thompson Sampling
# 4. Execute activity
# 5. Store execution trace
# 6. Update metrics
```

**Success Criteria**:
- [ ] Execution completes successfully
- [ ] No authentication errors
- [ ] Trace is stored correctly
- [ ] Metrics are updated

### Test 12: Dashboard Integration
**Objective**: Verify activity dashboard works with new PERMISSIONS

```bash
# Check dashboard health
curl $CANARY_ENDPOINT/dashboard/health

# Load dashboard in browser and verify:
# - Templates list loads
# - Execution traces display
# - Composition graph renders
# - Metrics charts work
```

**Success Criteria**:
- [ ] Dashboard loads without errors
- [ ] All visualizations work
- [ ] Data is org-scoped correctly

## Post-Migration Verification

### Automated Test Suite

```bash
# Run full test suite
cd /home/avi/documents/work/exp-repo/metabob-devbob/repos/metabob-activity-api
bun test

# Expected: All tests pass
```

### Log Analysis

```bash
# Check for authentication errors in logs
kubectl logs -n activity-system -l app=metabob-activity-api --tail=100 | \
  grep -i "authentication"

# Expected: No "There was a problem with authentication" errors
```

### Database Verification

```bash
# Verify PERMISSIONS are correctly defined
curl -X POST http://surql.metabob.local/sql \
  -u 'root:surrealdb-password' \
  -d 'INFO FOR TABLE activity;'

# Check that PERMISSIONS include type casting
# Expected: See "org_id = <string>$auth.org_id" patterns
```

## Rollback Criteria

Rollback migration if:
- [ ] Any endpoint returns 500 errors
- [ ] Cross-org data leakage detected
- [ ] Performance degrades > 20%
- [ ] Thompson Sampling breaks
- [ ] Composition graph returns NULL values

## Rollback Procedure

```bash
# 1. Revert to previous schema state
cd /home/avi/documents/work/exp-repo/metabob-devbob/repos/metabob-activity-api
git revert <migration-commit>

# 2. Re-apply schema without migration 074
./scripts/apply-schema.sh

# 3. Restart services
kubectl rollout restart deployment -n activity-system metabob-activity-api

# 4. Verify rollback success
curl -H "Authorization: ApiKey $METABOB_API_KEY" \
  $CANARY_ENDPOINT/health
```

## Success Metrics

Migration is successful when ALL of the following are true:

- [ ] All 12 tests pass
- [ ] No authentication errors in logs (24h period)
- [ ] Templates endpoint returns 200 OK
- [ ] Composition graph has no NULL values
- [ ] Thompson Sampling updates work
- [ ] Multi-tenant isolation verified
- [ ] Performance within acceptable range
- [ ] No regressions in existing functionality

## Sign-Off

**Tested By**: _________________
**Date**: _________________
**Result**: ☐ Pass ☐ Fail ☐ Rollback Required

**Notes**:
