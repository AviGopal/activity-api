# Goal Paths Implementation Summary

## Overview

The POST /v2/goal-paths/recommend endpoint has been successfully implemented and configured to work with the Workbench frontend.

## Changes Made

### 1. Route Configuration Fix

**File**: `src/index.ts`

**Change**: Updated the route registration from `/v2/activities/goal-paths` to `/v2/goal-paths` to match the endpoint the Workbench is calling.

```typescript
// Before
app.route('/v2/activities/goal-paths', goalPathsRoutes);

// After
app.route('/v2/goal-paths', goalPathsRoutes);
```

This change ensures the endpoint is accessible at `/v2/goal-paths/recommend`, which is what the GoalInputBox component expects.

## Endpoint Details

### POST /v2/goal-paths/recommend

**URL**: `https://activity.metabob.com/v2/goal-paths/recommend`

**Authentication**: API Key via `Authorization: ApiKey <key>` header

**Request Body**:
```typescript
{
  goal_text: string;           // Goal description
  exploration_rate?: number;   // 0-1, default 0.1 (10% exploration)
  top_k?: number;              // Number of paths to return, default 3
  goal_category?: 'feature' | 'bugfix' | 'refactor' | 'tool' | 'infrastructure' | 'meta';
}
```

**Response**:
```typescript
{
  goal_hash: string;
  recommended_paths: Array<{
    path_activities: string[];        // Activity template IDs in sequence
    confidence: number;               // 0-1, Thompson Sampling score
    success_rate: number;             // 0-1, historical success rate
    avg_duration_ms: number;          // Average execution time
    avg_cost_usd: number;             // Average cost
    total_executions: number;         // How many times this path was executed
    exploration_bonus?: number;       // Optional, present if exploration path
  }>;
}
```

## Implementation Details

### Algorithm

The endpoint uses **Thompson Sampling** for path recommendation:

1. **Hash the goal text** to create a consistent `goal_hash` identifier
2. **Query database** for all paths matching the goal hash
3. **Decide mode** based on `exploration_rate`:
   - **Exploration** (rate% probability): Return paths with fewer executions (UCB-style)
   - **Exploitation** (1-rate% probability): Sample from Beta distributions using Thompson Sampling

4. **Exploration mode**:
   - Sort paths by `total_executions` ascending (fewer first)
   - Return top_k paths with neutral confidence (0.5)
   - Add `exploration_bonus` field

5. **Exploitation mode**:
   - Sample from Beta(thompson_alpha, thompson_beta) for each path
   - Sort by sample score descending
   - Return top_k paths with sample score as confidence

### Database Schema

The endpoint queries the `goal_execution_paths` table:

```sql
TABLE goal_execution_paths {
  goal_hash: string;           -- MD5 hash of normalized goal text
  goal_text: string;           -- Original goal text
  goal_category?: string;      -- Optional category
  path_activities: string[];   -- Sequence of activity IDs
  path_signature: string;      -- MD5 hash of path
  total_executions: int;
  successful_executions: int;
  failed_executions: int;
  thompson_alpha: float;       -- Beta distribution α parameter
  thompson_beta: float;        -- Beta distribution β parameter
  success_rate: float;         -- successful / total
  avg_duration_ms: float;
  avg_cost_usd: float;
  avg_token_usage: int;
  typical_files_modified: string[];
  typical_tools_used: string[];
  last_executed_at: datetime;
  created_at: datetime;
  updated_at: datetime;
}
```

### Thompson Sampling Implementation

```typescript
function sampleBeta(alpha: number, beta: number): number {
  // For small sample sizes (< 10 total executions)
  if (alpha + beta < 10) {
    // Use Wilson score interval approximation
    const n = alpha + beta - 2;
    const p = (alpha - 1) / n;
    const z = 1.96; // 95% confidence

    if (n === 0) return 0.5; // No data

    const wilson = (p + z*z/(2*n) - z * Math.sqrt((p*(1-p) + z*z/(4*n))/n)) / (1 + z*z/n);
    return Math.max(0, Math.min(1, wilson));
  }

  // For larger samples (>= 10)
  // Use simple mean with small noise
  const mean = (alpha - 1) / (alpha + beta - 2);
  const noise = (Math.random() - 0.5) * 0.1; // +/- 5%
  return Math.max(0, Math.min(1, mean + noise));
}
```

This implementation:
- Uses Wilson score for small samples (more conservative)
- Uses mean + noise for larger samples (exploitation)
- Always returns a value between 0 and 1

## Frontend Integration

The Workbench's `GoalInputBox` component calls this endpoint when the user clicks "Generate Path":

```typescript
// From: repos/workbench/src/components/trajectory/GoalInputBox.tsx

const response = await fetch(
  `${import.meta.env.VITE_ACTIVITY_API_URL || 'https://activity.metabob.com'}/v2/goal-paths/recommend`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `ApiKey ${apiKey}`,
    },
    body: JSON.stringify({
      goal_text: goal,
      exploration_rate: 0.2, // 20% exploration
      top_k: 5, // Return top 5 recommendations
    }),
  }
);
```

## Testing

### Manual Testing

A test script has been created for manual endpoint validation:

```bash
cd repos/metabob-activity-api
./test-goal-paths-endpoint.sh
```

This script sends a sample request and displays the expected response structure.

### TypeScript Validation

Type checking passes with no errors:

```bash
cd repos/metabob-activity-api
bun run typecheck  # ✓ No errors
```

### Integration Testing

To test the full workflow:

1. Start the Activity API server:
   ```bash
   cd repos/metabob-activity-api
   bun run dev
   ```

2. Start the Workbench:
   ```bash
   cd repos/workbench
   bun run dev
   ```

3. Navigate to the Trajectory Editor in the Workbench
4. Enter a goal in the Goal Input Box
5. Click "Generate Path"
6. Verify recommendations appear

## Files Modified

1. **src/index.ts**
   - Changed route registration from `/v2/activities/goal-paths` to `/v2/goal-paths`
   - This was the only code change needed

## Files Already Implemented (No Changes Needed)

1. **src/routes/goal-paths.ts**
   - Already implements POST /recommend endpoint
   - Already implements Thompson Sampling algorithm
   - Already includes exploration vs exploitation logic

2. **src/models/schemas.ts**
   - Already defines `PathRecommendationRequestSchema`
   - Already defines `RecommendedPathSchema`
   - Already defines `PathRecommendationResponseSchema`

## Deployment

The change is ready for deployment via the standard CI/CD pipeline:

1. **Local testing**: Run `bun test` and `bun run typecheck`
2. **Push to dev**: Changes automatically deploy to canary
3. **Validate canary**: Test at `https://activity.metabob.com/v2/goal-paths/recommend`
4. **Promote to production**: After canary validation succeeds

## Related Documentation

- **Foundation**: `docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md`
- **Deployment**: `repos/deployment/DEPLOYMENT_WORKFLOW.md`
- **API Guide**: `repos/metabob-activity-api/CLAUDE.md`
- **Workbench**: `repos/workbench/CLAUDE.md`

## Next Steps

1. Test the endpoint with real goal data
2. Monitor Thompson Sampling performance metrics
3. Consider adding caching for frequently requested goals
4. Add unit tests for the recommendation algorithm
5. Add integration tests for the full workflow
