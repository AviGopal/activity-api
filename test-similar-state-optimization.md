# Similar-State Endpoint Optimization Test Plan

## Implementation Summary

Updated `/v2/activities/similar-state` endpoint to use state_signature for fast exact matching.

### Changes Made

1. **Fast Path (Exact Match)**:
   - Query `execution` table using indexed `state_signature` field
   - Returns instantly when state_signature matches exactly
   - Response includes `fast_path: true` indicator

2. **Fallback Path (Similarity)**:
   - Falls back to Jaccard similarity calculation on shapes
   - Used when no state_signature provided or no exact matches found
   - Response includes `fast_path: false` indicator

3. **Table Migration**:
   - Changed from `activity_execution_trace` (non-existent singular) to `execution` (correct paradigm table)
   - Fixed field names: `input_shapes` → `input_impulses`, `output_shapes` → `output_impulses`
   - Uses correct record ID field: `id` instead of `execution_id`

### Code Changes

**File**: `src/routes/activities.ts` (lines 4050-4210)

**Before**:
```typescript
// Single query path - always computed Jaccard similarity
const query = `
  SELECT ... FROM activity_execution_trace
  WHERE input_shapes CONTAINSANY $available_shapes
  ...
`;
```

**After**:
```typescript
// Fast path: exact state_signature match
if (state_signature) {
  const exactQuery = `
    SELECT ... FROM execution
    WHERE state_signature = $state_signature
    ORDER BY created_at DESC
    LIMIT $limit
  `;
  // Return immediately if matches found (similarity = 1.0)
}

// Fallback path: Jaccard similarity on shapes
const similarityQuery = `
  SELECT ... FROM execution
  WHERE input_impulses CONTAINSANY $available_shapes
  ORDER BY created_at DESC
  LIMIT 100
`;
```

## Test Scenarios

### Scenario 1: Fast Path Hit (Exact Match)

**Request**:
```bash
curl -X POST http://activity.metabob.com/v2/activities/similar-state \
  -H "Content-Type: application/json" \
  -d '{
    "state_signature": "abc123...",
    "available_shapes": ["file", "gitDiff", "error"],
    "min_similarity": 0.5,
    "limit": 10
  }'
```

**Expected Response**:
```json
{
  "executions": [
    {
      "execution_id": "execution:xyz",
      "activity_id": "activity:debug-failed-execution",
      "similarity": 1.0,
      "success": true,
      "duration_ms": 1234,
      "cost_usd": 0.05,
      "input_shapes": ["file", "gitDiff", "error"],
      "output_shapes": ["file", "memo"]
    }
  ],
  "total": 1,
  "fast_path": true
}
```

**Performance**: <50ms (index lookup only)

### Scenario 2: Fast Path Miss (Fallback to Similarity)

**Request**:
```bash
curl -X POST http://activity.metabob.com/v2/activities/similar-state \
  -H "Content-Type: application/json" \
  -d '{
    "state_signature": "nonexistent123",
    "available_shapes": ["file", "gitDiff"],
    "min_similarity": 0.5,
    "limit": 10
  }'
```

**Expected Logs**:
```
DEBUG Attempting fast path: exact state_signature match
DEBUG Fast path miss: no exact state_signature matches, falling back to similarity
INFO  Similarity fallback query result
```

**Expected Response**:
```json
{
  "executions": [
    {
      "execution_id": "execution:abc",
      "activity_id": "activity:some-activity",
      "similarity": 0.67,
      "success": true,
      "duration_ms": 2345,
      "cost_usd": 0.08,
      "input_shapes": ["file", "gitDiff", "memo"],
      "output_shapes": ["file"]
    }
  ],
  "total": 1,
  "fast_path": false
}
```

**Performance**: 100-500ms (Jaccard calculation on 100 candidates)

### Scenario 3: No State Signature (Pure Similarity)

**Request**:
```bash
curl -X POST http://activity.metabob.com/v2/activities/similar-state \
  -H "Content-Type: application/json" \
  -d '{
    "available_shapes": ["file", "error"],
    "min_similarity": 0.6,
    "limit": 5
  }'
```

**Expected Behavior**:
- Skips fast path (no state_signature provided)
- Directly uses similarity fallback
- Response includes `fast_path: false`

## Validation Checklist

- [x] Type checking passes (`bun run typecheck`)
- [ ] Database migration 061 applied (state_signature field exists)
- [ ] Index `idx_execution_state_sig` exists on execution table
- [ ] Fast path query returns results in <50ms (when signature exists)
- [ ] Fallback path works when no signature provided
- [ ] Fallback path works when signature has no matches
- [ ] Response includes correct `fast_path` indicator
- [ ] Logs show fast path hit/miss events

## Performance Impact

### Before Optimization
- All queries: Jaccard similarity on 100 candidates
- Response time: 100-500ms
- Database load: Full table scan with CONTAINSANY

### After Optimization (Fast Path Hit)
- Exact match: Index lookup only
- Response time: <50ms (10x faster)
- Database load: Single index scan

### After Optimization (Fast Path Miss)
- Same as before (backward compatible)
- Response time: 100-500ms
- Database load: Full table scan with CONTAINSANY

## Database Query Analysis

### Fast Path Query
```sql
SELECT id, activity_id, success, duration_ms, cost_usd, input_impulses, output_impulses
FROM execution
WHERE state_signature = $state_signature
ORDER BY created_at DESC
LIMIT $limit
```

**Index Usage**: `idx_execution_state_sig` (exact match)
**Scan Type**: Index seek
**Rows Examined**: ~1-10 (limited by LIMIT clause)

### Fallback Query
```sql
SELECT id, activity_id, success, duration_ms, cost_usd, input_impulses, output_impulses
FROM execution
WHERE input_impulses CONTAINSANY $available_shapes
ORDER BY created_at DESC
LIMIT 100
```

**Index Usage**: None (array containment requires scan)
**Scan Type**: Full table scan with filter
**Rows Examined**: All rows with matching shapes (filtered to 100)

## Integration with MiniBob

MiniBob goal-seeking workflow will benefit from this optimization:

1. **State Capture**: MiniBob computes state_signature from current environment
2. **Fast Lookup**: Queries similar-state endpoint with signature
3. **Instant Match**: Gets identical past executions instantly (fast path)
4. **Activity Selection**: Uses past successful activities for current state
5. **Fallback**: If no exact match, gets similar states via Jaccard

**Expected Flow**:
```
MiniBob captures state → computes signature → queries similar-state
  ↓
Fast path hit (50ms) → activity recommendations → execute
  OR
Fast path miss → fallback similarity (200ms) → activity recommendations → execute
```

## Next Steps

1. Deploy to canary environment
2. Monitor fast_path hit rate in production logs
3. Validate <50ms response time for exact matches
4. Track performance improvement metrics
5. Consider adding state_signature to dashboard metrics
