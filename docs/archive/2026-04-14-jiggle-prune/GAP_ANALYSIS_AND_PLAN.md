# Gap Analysis: Activity System Architecture vs Implementation

## Executive Summary

After inspecting the **live API at https://activity.metabob.com** (2026-04-06), we found:

1. **Infrastructure is deployed and healthy** - SurrealDB (4ms), Redis (1ms) connected
2. **Templates exist** - 45 activity templates with shapes defined
3. **Recommendation endpoint works** - Returns Thompson Sampling metadata with boost breakdowns
4. **CRITICAL: Learning loop is NOT active** - No execution traces, composition data, or goal paths in production

The learning infrastructure exists but **no MiniBob instances are sending execution traces to production**. This means Thompson Sampling has no data to learn from - all scores are based on heuristic priors only.

### Live API State (2026-04-06)

| Endpoint | Data Present | Notes |
|----------|--------------|-------|
| `/health` | ✅ Healthy | SurrealDB 4ms, Redis 1ms |
| `/v2/activities/templates` | ✅ 45 templates | Full shape definitions |
| `/v2/activities/recommend` | ✅ Works | Returns Thompson metadata, boost breakdown |
| `/v2/activities/composition/graph` | ❌ Empty | `edges: [], total: 0` |
| `/v2/activities/goal-paths` | ❌ Empty | `paths: [], total: 0` |
| `/v2/activities/tool-usage` | ❌ Empty | `patterns: [], total: 0` |
| `/v2/activities/impulse-relevance` | ❌ Empty | `metrics: [], total: 0` |
| `/v2/activities/execution-sequences` | ❌ Empty | `sequences: [], total: 0` |
| `/v2/activities/shapes/network` | ✅ 40+ activities | Shape data populated |

---

## Current State Assessment

### What's Working Well

| Component | Status | Evidence |
|-----------|--------|----------|
| **Thompson Sampling** | ✅ Excellent | Beta distribution via @stdlib, shape-conditioning, real-time computation from `v_activity_score` |
| **Shape-conditioned scores** | ✅ Excellent | `v_shape_conditioned_score` view with 3-tier matching (exact → subset → global) |
| **Execution traces** | ✅ Complete | Full `execution` table with input/output impulses, trace details |
| **Impulse storage** | ✅ Complete | `impulse` table with shapes, pointers, token estimates |
| **Composition tracking** | ✅ Complete | `activity_composition_graph` + `v_composition_graph` view |
| **Goal path tracking** | ✅ Complete | `goal_execution_paths` table with Thompson params |
| **Tool argument patterns** | ✅ Complete | `tool_argument_pattern` with success tracking, recommendations view |
| **Ribosome extraction** | ✅ Complete | `POST /v2/ribosome/extract` endpoint |
| **Heuristic boosts** | ✅ Complete | 8 boost categories in recommendation engine |

### Gaps Identified

| Gap ID | Description | Impact | Priority |
|--------|-------------|--------|----------|
| **GAP-00** | **Learning loop not active in production** | No execution traces being recorded; Thompson Sampling has no data | **CRITICAL** |
| **GAP-01** | Composition graph not used in recommendations | Activities that succeed as children of current context aren't boosted | HIGH |
| **GAP-02** | Goal paths not used in recommendations | Proven paths for similar goals aren't suggested | HIGH |
| **GAP-03** | Heuristic boosts may overwhelm learning | ~22 points of boosts can overpower data-driven signal | MEDIUM |
| **GAP-04** | No activity seeding workflow | No structured way to bootstrap activities from heuristic chains | MEDIUM |
| **GAP-05** | Missing impulse tracking feedback | Input shapes tracked but not fed back to relevance scoring | LOW |

---

## GAP-00: Learning Loop Not Active (CRITICAL)

### Problem

The production API at https://activity.metabob.com has:
- ✅ 45 activity templates defined
- ✅ Healthy SurrealDB and Redis connections
- ✅ Working recommendation endpoint
- ❌ **Zero execution traces**
- ❌ **Zero composition edges**
- ❌ **Zero goal path data**

This means **Thompson Sampling is running on heuristic priors only** - no learning is happening.

### Root Cause Investigation

Possible reasons no traces are being recorded:

1. **MiniBob not configured for production backend**
   - Check: `ACTIVITY_API_ENDPOINT` in MiniBob deployments
   - Expected: `https://activity.metabob.com`

2. **Execution trace recording disabled**
   - Check: MiniBob's `captureAndStoreTrace()` function
   - Check: Network connectivity from MiniBob pods to activity API

3. **Authentication failing silently**
   - Check: JWT/API key auth for `POST /v2/activities/executions`
   - Check: MiniBob logs for 401/403 errors

4. **No MiniBob instances running activities**
   - Check: MiniBob deployment status in production
   - Check: Boredom system activity

### Code Analysis: Trace Storage Flow

**MiniBob stores traces via:**
1. `mcp.storeExecutionTrace(execution)` in `src/activity.ts:1119`
2. Sends to: `POST ${endpoint}/v2/activities/execution-traces`
3. Requires JWT token from AuthService

**Configuration chain:**
```
ACTIVITY_API_ENDPOINT → loadConfig() → mcpEndpoint → initializeMCP() → MCPClient.endpoint
MINIBOB_INSTANCE_ID + MINIBOB_INSTANCE_API_KEY → identityClient.authenticate() → JWT token
```

**Possible failure points:**
1. `ACTIVITY_API_ENDPOINT` not set → defaults to local dev endpoint
2. Identity authentication failing → no JWT token → traces not sent
3. MiniBob not running activities → no traces generated
4. Backend health check failing → MCP client not initialized

### Verification Steps

```bash
# 1. Check MiniBob configuration
kubectl exec -it deployment/minibob -n activity-system -- \
  printenv | grep -E "ACTIVITY_API|IDENTITY|INSTANCE"

# 2. Check MiniBob logs for trace storage
kubectl logs -n activity-system -l app=minibob --tail=100 | \
  grep -i "execution.*trace\|store.*trace\|bootstrap"

# 3. Check if MCP is initialized
kubectl logs -n activity-system -l app=minibob --tail=100 | \
  grep -i "mcp\|client initialized\|backend unavailable"

# 4. Test trace storage endpoint directly
curl -X POST https://activity.metabob.com/v2/activities/execution-traces \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -d '{"activity_id":"test","success":true,"duration_ms":100}'

# 5. Check execution traces count over time
curl https://activity.metabob.com/v2/activities/execution-traces | jq '.total'
```

### Fix Plan

1. **Verify MiniBob pods are running** in production cluster
2. **Check environment variables** in MiniBob deployment:
   - `ACTIVITY_API_ENDPOINT=https://activity.metabob.com`
   - `IDENTITY_ENDPOINT=https://identity.metabob.com`
   - `MINIBOB_INSTANCE_ID` and `MINIBOB_INSTANCE_API_KEY` set
3. **Check bootstrap logs** for authentication failures
4. **Run a test activity** and verify trace appears in backend
5. **Monitor trace count** increasing over time

---

## Gap Details and Proposed Fixes

### GAP-01: Composition-Aware Recommendations

**Problem**: The `v_composition_graph` view tracks which activities succeed as children of other activities, but `POST /v2/activities/recommend` never queries this data.

**Example**: If "analyze-code" frequently calls "run-tests" successfully (weight=0.85), when recommending activities during an "analyze-code" execution, "run-tests" should be boosted.

**Current Code** (activities.ts ~2743-2870):
- Only uses: shape-conditioned scores, impulse relevancy, 8 heuristic boosts
- Does NOT query: `activity_composition_graph` or `v_composition_graph`

**Proposed Fix**:

```typescript
// In POST /v2/activities/recommend, after getting shape-conditioned scores:

// 9. Composition context boost (if parent_activity_id provided)
let compositionBoosts = new Map<string, number>();
if (parent_activity_id) {
  const compositionResult = await db.query(`
    SELECT child_activity_id, weight
    FROM v_composition_graph
    WHERE parent_activity_id = $parent
      AND org_id = $org
      AND execution_count >= 3
    ORDER BY weight DESC
    LIMIT 20
  `, { parent: parent_activity_id, org: orgId });

  for (const row of compositionResult) {
    // Convert weight (0-1) to boost (0-5)
    const boost = Math.floor(row.weight * 5);
    compositionBoosts.set(row.child_activity_id, boost);
  }
}

// Then in the boost calculation:
const compositionBoost = compositionBoosts.get(activityId) || 0;
totalBoost += compositionBoost;
```

**Schema Change**: Add `parent_activity_id` optional parameter to `ActivityRecommendRequestSchema`.

**Effort**: ~2-3 hours

---

### GAP-02: Goal Path Recommendations

**Problem**: `goal_execution_paths` stores successful activity sequences for goals with Thompson params, but `POST /v2/activities/recommend` doesn't suggest proven paths.

**Current API**: `POST /v2/activities/goal-paths/recommend` exists but is separate from main recommendations.

**Proposed Fix**: Integrate goal path data into main recommendations:

```typescript
// In POST /v2/activities/recommend, if task_description provided:

// 10. Goal path similarity boost
let goalPathBoosts = new Map<string, number>();
const similarGoals = await db.query(`
  SELECT path_activities, thompson_alpha, thompson_beta, success_rate
  FROM goal_execution_paths
  WHERE org_id = $org
    AND string::similarity::fuzzy(goal_text, $task) > 0.6
  ORDER BY success_rate DESC, total_executions DESC
  LIMIT 5
`, { org: orgId, task: task_description });

for (const goalPath of similarGoals) {
  // First activity in proven paths gets boost based on path success
  const firstActivity = goalPath.path_activities[0];
  if (firstActivity) {
    const existingBoost = goalPathBoosts.get(firstActivity) || 0;
    const pathBoost = Math.floor(goalPath.success_rate * 4); // 0-4 boost
    goalPathBoosts.set(firstActivity, Math.max(existingBoost, pathBoost));
  }
}
```

**Effort**: ~3-4 hours

---

### GAP-03: Heuristic Boost Calibration

**Problem**: Current boosts can add up to ~22-25 points:
- Tag match: +0 to +6
- Shape compatible: +3
- Recency: +1
- Execution history: +1 to +5
- Scope: +1
- Impulse relevancy: variable
- Category match: +3
- Output shape coverage: +0 to +4

With default alpha=1, beta=1, this means a new activity with all boosts gets alpha=24 before any real data.

**Impact**: Learning signal gets overwhelmed; activities don't need to prove themselves.

**Proposed Fix**: Scale boosts based on data confidence:

```typescript
// Scale boosts inversely with data confidence
const totalExecutions = (scores?.successes || 0) + (scores?.failures || 0);
const dataConfidence = Math.min(1.0, totalExecutions / 20); // Reaches 1.0 at 20 executions

// Apply diminishing boost scaling based on how much data we have
// With no data: full boost (let heuristics guide)
// With 20+ executions: minimal boost (let data speak)
const boostScale = 1.0 - (dataConfidence * 0.8); // Never fully zero out boosts

alpha += Math.floor(totalBoost * boostScale);
```

**Effort**: ~1 hour

---

### GAP-04: Activity Seeding Workflow

**Problem**: No structured way to bootstrap the activity network with heuristic chains.

**Current State**:
- Ribosome extracts templates from successful executions
- No way to seed "untested but plausible" activity chains

**Proposed Solution**: Add `/v2/activities/seed-chain` endpoint:

```typescript
// POST /v2/activities/seed-chain
// Creates a sequence of related activities with initial heuristic weights

interface SeedChainRequest {
  goal_category: 'feature' | 'bugfix' | 'refactor' | 'tool';
  chain_name: string;
  activities: Array<{
    name: string;
    description: string;
    input_shapes: string[];
    output_shapes: string[];
    tasks: ActivityTask[];
    initial_alpha?: number; // Heuristic prior (default: 2)
  }>;
  // Register as goal path with initial optimistic scores
  register_goal_path?: boolean;
}
```

**Use Case**: Seed "feature development" chain: analyze-requirements → design-solution → implement-code → write-tests → document-changes

**Effort**: ~4-6 hours

---

### GAP-05: Impulse Relevance Feedback Loop

**Problem**: `impulse_usage_history` and `impulse_relevance_metrics` track which impulses helped, but this data isn't systematically fed back.

**Current State**:
- `calculateImpulseRelevancyBoosts()` does query some relevance data
- But tracked data includes success/fail correlation that isn't fully used

**Proposed Fix**: Enhance impulse relevance computation:

```typescript
// Current: Simple presence-based boost
// Proposed: Bayesian P(success|impulse_loaded) vs P(success|not_loaded)

async function calculateImpulseRelevancyBoosts(
  activityIds: string[],
  loadedImpulses: string[]
): Promise<Map<string, ImpulseBoost>> {

  // Query actual relevance metrics
  const metrics = await db.query(`
    SELECT
      activity_variant_id,
      impulse_id,
      times_execution_succeeded,
      times_execution_failed,
      times_not_loaded_succeeded,
      times_not_loaded_failed,
      relevance_score  -- P(success | loaded)
    FROM impulse_relevance_metrics
    WHERE activity_variant_id IN $activities
  `, { activities: activityIds });

  // Calculate lift: P(success|loaded) / P(success|not_loaded)
  for (const m of metrics) {
    const pSuccessLoaded = m.times_execution_succeeded /
      (m.times_execution_succeeded + m.times_execution_failed + 1);
    const pSuccessNotLoaded = m.times_not_loaded_succeeded /
      (m.times_not_loaded_succeeded + m.times_not_loaded_failed + 1);

    const lift = pSuccessLoaded / (pSuccessNotLoaded + 0.001);
    // lift > 1 means impulse helps; < 1 means it hurts
  }
}
```

**Effort**: ~2-3 hours

---

## Implementation Priority

### Phase 0: Activate Learning Loop (IMMEDIATE - Day 1)

| Task | Gap | Effort | Impact |
|------|-----|--------|--------|
| Diagnose why no traces in production | GAP-00 | 2h | **CRITICAL** |
| Verify MiniBob → Activity API connectivity | GAP-00 | 1h | **CRITICAL** |
| Fix authentication/configuration issues | GAP-00 | 2h | **CRITICAL** |
| Run test activity end-to-end | GAP-00 | 1h | **CRITICAL** |
| Verify trace count increasing | GAP-00 | 1h | **CRITICAL** |

**Without Phase 0, all other improvements are meaningless** - there's no data to learn from.

### Phase 1: Quick Wins (Week 1, after Phase 0)

| Task | Gap | Effort | Impact |
|------|-----|--------|--------|
| Add composition boost to recommendations | GAP-01 | 3h | HIGH |
| Add goal path boost to recommendations | GAP-02 | 4h | HIGH |
| Add `parent_activity_id` to recommend request | GAP-01 | 1h | HIGH |

### Phase 2: Calibration (Week 2)

| Task | Gap | Effort | Impact |
|------|-----|--------|--------|
| Implement boost scaling by data confidence | GAP-03 | 1h | MEDIUM |
| Add boost breakdown to recommendation response | - | Already done ✅ | - |
| Add A/B test flag for boost configurations | - | 2h | MEDIUM |

### Phase 3: Seeding & Feedback (Week 3-4)

| Task | Gap | Effort | Impact |
|------|-----|--------|--------|
| Implement `/v2/activities/seed-chain` | GAP-04 | 6h | MEDIUM |
| Enhance impulse relevance feedback | GAP-05 | 3h | LOW |
| Add shape network exploration endpoint enhancements | - | 4h | LOW |

---

## Verification Plan

After implementing Phase 1:

1. **Unit Tests**:
   - Test composition boost calculation
   - Test goal path similarity matching
   - Test boost scaling

2. **Integration Tests**:
   - Verify recommendations change when `parent_activity_id` provided
   - Verify proven goal paths boost first activities

3. **Observability**:
   - Add `composition_boost` and `goal_path_boost` to `boost_breakdown` in response
   - Log when composition/goal path data influences selection

4. **Dashboard**:
   - Show composition edges in template detail view
   - Show goal paths that include each template

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/routes/activities.ts` | Add composition/goal path queries to recommend endpoint |
| `src/models/schemas.ts` | Add `parent_activity_id` to ActivityRecommendRequestSchema |
| `src/db/paradigm.ts` | Add helper functions for composition and goal path queries |
| `src/routes/activities.test.ts` | Add tests for new boost calculations |

---

## Conclusion

The infrastructure for composition-aware and goal-aware learning **already exists** in the database. The gap is purely in the recommendation engine not utilizing this data. Phase 1 can be completed quickly with high impact.

The heuristic boost calibration (GAP-03) is a more subtle issue that may require experimentation to tune properly. The activity seeding workflow (GAP-04) is valuable for bootstrapping but lower priority than fixing the learning signal.
