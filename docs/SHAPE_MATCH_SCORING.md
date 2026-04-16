# Thompson Sampling with Shape Match Scoring

## Overview

Enhanced Thompson Sampling implementation that uses shape match scoring to influence the success score. This enables quality-aware learning that favors activities which produce the expected output shapes.

## Key Concepts

### Shape Match Score

Computed using **Jaccard similarity** between expected and actual output shapes:

```
shapeMatchScore = |intersection| / |union|
```

Where:
- `intersection` = shapes present in both expected and actual sets
- `union` = all unique shapes from both sets

**Example:**
- Expected: `['source_code', 'test_result', 'documentation']`
- Actual: `['source_code', 'config_file']`
- Intersection: `['source_code']` (1 shape)
- Union: `['source_code', 'test_result', 'documentation', 'config_file']` (4 shapes)
- Score: `1/4 = 0.25`

### Weighted Success Score

Combines execution success with shape match quality:

```typescript
if (executionSuccess) {
  weightedScore = 0.7 * shapeMatchScore + 0.3
} else {
  weightedScore = 0.0
}
```

**Rationale:**
- Base credit (0.3): Even successful executions with wrong shapes get some credit
- Shape quality bonus (0.7): Activities that produce expected shapes get higher scores
- Failure gets no credit: Failed executions score 0.0 regardless of shapes

**Example scores:**
- Success + perfect shapes (1.0): `0.7 * 1.0 + 0.3 = 1.0`
- Success + partial shapes (0.5): `0.7 * 0.5 + 0.3 = 0.65`
- Success + no shapes (0.0): `0.7 * 0.0 + 0.3 = 0.3`
- Failure (any shapes): `0.0`

### Thompson Sampling Updates

Updates alpha (successes) and beta (failures) using fractional increments:

```typescript
alphaDelta = weightedScore
betaDelta = 1.0 - weightedScore
```

**Example:**
- Perfect success (score 1.0): `α += 1.0, β += 0.0`
- Partial success (score 0.65): `α += 0.65, β += 0.35`
- Bare success (score 0.3): `α += 0.3, β += 0.7`
- Failure (score 0.0): `α += 0.0, β += 1.0`

## Implementation

### 1. Execution Trace Storage

When an execution completes, the system:

1. Fetches the activity template to get declared `output_shapes`
2. Extracts actual output shapes from `output_impulses` or `output_impulse_shapes`
3. Computes shape match score using Jaccard similarity
4. Computes weighted success score
5. Updates Thompson Sampling parameters with fractional increments
6. Stores shape match metadata in execution trace

**Code location:** `src/routes/execution-traces.ts` (lines 1022-1109)

### 2. Shape Match Validation

The system validates that output shapes match expectations and stores detailed metadata:

```typescript
{
  passed: boolean,              // true if shapeMatchScore >= 0.8
  expectedShapes: string[],
  actualShapes: string[],
  shapeMatchScore: number,      // Jaccard similarity (0-1)
  weightedSuccessScore: number, // Weighted score for Thompson Sampling
  missing: string[],            // Shapes expected but not produced
  unexpected: string[],         // Shapes produced but not expected
  validatedAt: string,          // ISO timestamp
}
```

**Validation threshold:** 80% shape overlap (0.8 Jaccard similarity)

**Code location:** `src/services/thompson-sampling.ts` (validateOutputShapes function)

### 3. Recommendation Logging

The recommendation endpoint logs shape match scores for top recommendations:

```typescript
logger.info('Recommendations generated', {
  count: recommendations.length,
  top: recommendations[0]?.template_id,
  correlationIds: recommendations.map(r => r.correlation_id),
  scoreMethod,
  fallbackTier,
  topRecommendation: {
    template_id: '...',
    thompson_sample: 0.85,
    alpha: 10.5,
    beta: 2.3,
    output_shapes: ['source_code', 'test_result'],
  },
});
```

**Code location:** `src/routes/activities.ts` (POST /recommend endpoint)

## Benefits

### 1. Shape Drift Detection

Activities that succeed but produce wrong shapes get lower scores:
- Execution succeeds but creates `config_file` instead of `source_code`
- Shape match score: 0.0 (no overlap)
- Weighted score: 0.3 (base credit only)
- Thompson Sampling: `α += 0.3, β += 0.7`

### 2. Quality-Aware Learning

The system learns which activities reliably produce specific shapes:
- Activity consistently produces expected shapes
- High shape match scores (>0.8) accumulate over time
- Thompson Sampling favors this activity for similar goals

### 3. Partial Credit for Near-Misses

Activities that produce some expected shapes get partial credit:
- Expected: `['source_code', 'test_result', 'documentation']`
- Actual: `['source_code', 'test_result']`
- Shape match: 0.67 (2/3 shapes)
- Weighted score: 0.77 (good partial credit)

## Testing

Comprehensive test suite validates all components:

```bash
cd repos/metabob-activity-api
bun test src/services/thompson-sampling.test.ts
```

**Test coverage:**
- Jaccard similarity computation (perfect, partial, no overlap)
- Weighted success score (all success/failure combinations)
- Thompson Sampling parameter updates (fractional increments)
- Output shape extraction (multiple formats)
- Shape validation metadata (all threshold cases)

**All 27 tests pass** (53 expect calls)

## Usage Example

### Creating an Activity with Output Shapes

```json
POST /v2/activities/templates
{
  "id": "feature.vessel.add-auth",
  "name": "Add authentication to vessel",
  "description": "Implement user authentication",
  "output_shapes": ["source_code", "test_result"],
  "tasks": [...]
}
```

### Execution with Shape Matching

```json
POST /v2/activities/execution-traces
{
  "execution_id": "exec-123",
  "template_id": "feature.vessel.add-auth",
  "success": true,
  "output_impulses": [
    { "shape": "source_code", "pointer": {...} },
    { "shape": "test_result", "pointer": {...} }
  ]
}
```

**Result:**
- Shape match score: 1.0 (perfect match)
- Weighted success: 1.0
- Thompson Sampling: `α += 1.0, β += 0.0`
- Metadata stored in trace for analysis

### Execution with Shape Drift

```json
POST /v2/activities/execution-traces
{
  "execution_id": "exec-124",
  "template_id": "feature.vessel.add-auth",
  "success": true,
  "output_impulses": [
    { "shape": "config_file", "pointer": {...} }
  ]
}
```

**Result:**
- Shape match score: 0.0 (no overlap)
- Weighted success: 0.3 (base credit only)
- Thompson Sampling: `α += 0.3, β += 0.7`
- Warning logged: "Low shape match score"

## Monitoring

### Logs

**Shape validation:**
```
[Shape Validation] Shapes validated successfully
  shapeMatchScore: 1.0
  actualShapes: ["source_code", "test_result"]
```

**Shape mismatch:**
```
[Shape Validation] Low shape match score
  shapeMatchScore: 0.5
  missing: ["test_result"]
  unexpected: ["config_file"]
```

**Thompson Sampling update:**
```
[Thompson Sampling] Using shape-weighted updates
  execution_id: "exec-123"
  activity_id: "feature.vessel.add-auth"
  executionSuccess: true
  shapeMatchScore: 1.0
  weightedScore: 1.0
  alphaDelta: 1.0
  betaDelta: 0.0
```

### Metadata Query

Query execution traces for shape match metadata:

```sql
SELECT
  execution_id,
  activity_id,
  success,
  metadata.shape_match AS shape_validation
FROM activity_execution_traces
WHERE metadata.shape_match IS NOT NONE
ORDER BY executed_at DESC
LIMIT 10
```

## Future Enhancements

### 1. Shape-Conditioned Thompson Sampling

Use different alpha/beta parameters for different input shape contexts:
- Activity A with shapes `[X, Y]` → `α=10, β=2`
- Activity A with shapes `[X, Z]` → `α=5, β=5`

### 2. Shape Decay Over Time

Reduce weight of old shape matches to adapt to evolving templates.

### 3. Shape Confidence Intervals

Use beta distribution confidence intervals to quantify uncertainty in shape match predictions.

## References

- **Implementation:** `src/services/thompson-sampling.ts`
- **Integration:** `src/routes/execution-traces.ts` (POST endpoint)
- **Tests:** `src/services/thompson-sampling.test.ts`
- **Foundation:** `docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md`
