# Feedback Endpoint ID Normalization Fix

## Problem

The feedback endpoint at `/v2/activities/feedback` (lines 2921-3130 in `src/routes/activities.ts`) was returning 404 errors for all activity IDs because the activity lookup query used a simple `WHERE id = $activity_id` condition that didn't handle SurrealDB's various ID formats.

## Root Cause

SurrealDB uses three different ID formats for activity records:

1. **Simple ID**: `acquire-codebase-context`
2. **Angle-bracket wrapped**: `⟨report-metrics⟩` (SurrealDB auto-format)
3. **Full record ID**: `activity:⟨Enforce Specification Compliance⟩`

The original query at line 2957 only checked for exact ID matches:
```typescript
'SELECT id, input_shapes FROM activity WHERE id = $activity_id LIMIT 1'
```

This failed because:
- Simple IDs like `acquire-codebase-context` would be stored as `⟨acquire-codebase-context⟩` in SurrealDB
- The query didn't normalize or try alternative formats
- No fallback mechanism existed for full record IDs

## Solution

Applied the same ID normalization logic used by the template endpoint (lines 1360-1389), which works correctly.

### Implementation (lines 2955-2998)

```typescript
// Normalize ID format - wrap in angle brackets if not already present
const normalizedActivityId = validated.activity_id.includes('⟨') || validated.activity_id.includes('⟩')
  ? validated.activity_id
  : `⟨${validated.activity_id}⟩`;

// First attempt: Try meta::id() with both raw and normalized formats
let activityLookup = await surrealDB.query<{ id: string; input_shapes?: string[] }>(
  `SELECT id, input_shapes FROM activity
   WHERE (meta::id(id) = $activity_id OR meta::id(id) = $normalized_id)
     AND (execution_type = 'template' OR execution_type IS NONE OR execution_type IS NULL)
   LIMIT 1`,
  {
    activity_id: validated.activity_id,
    normalized_id: normalizedActivityId,
  }
);

// Second attempt: If not found and ID contains ':', try as full record ID
if (activityLookup.length === 0 && validated.activity_id.includes(':')) {
  try {
    activityLookup = await surrealDB.query<{ id: string; input_shapes?: string[] }>(
      `SELECT id, input_shapes FROM activity
       WHERE id = type::record($activity_id)
         AND (execution_type = 'template' OR execution_type IS NONE OR execution_type IS NULL)
       LIMIT 1`,
      { activity_id: validated.activity_id }
    );
  } catch (recordError) {
    logger.debug('Record ID query failed for activity lookup', {
      activity_id: validated.activity_id,
      error: recordError
    });
  }
}
```

### Query Strategy

**Step 1: Try `meta::id()` with both formats**
- `meta::id(id)` extracts the ID part without the `activity:` prefix and angle brackets
- Checks both the raw `activity_id` parameter and the normalized angle-bracket version
- Handles: `acquire-codebase-context` and `⟨acquire-codebase-context⟩`

**Step 2: Fallback to `type::record()` for full IDs**
- Only attempted if first query returns no results AND the ID contains `:`
- `type::record()` parses full record IDs like `activity:⟨name⟩`
- Handles: `activity:⟨Enforce Specification Compliance⟩`

**Filtering**
Both queries filter for templates only:
```sql
AND (execution_type = 'template' OR execution_type IS NONE OR execution_type IS NULL)
```

This ensures we only match activity templates, not execution instances.

## Testing

### Manual Test
```bash
bun test-feedback-id-normalization.ts
```

This script validates the ID normalization logic without requiring a live database connection.

### Integration Test (requires live API)
```bash
# Simple ID format
curl -X POST http://activity.metabob.local/v2/activities/feedback \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "activity_id": "acquire-codebase-context",
    "feedback_type": "positive",
    "weight": 1
  }'

# Angle-bracket format
curl -X POST http://activity.metabob.local/v2/activities/feedback \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "activity_id": "⟨report-metrics⟩",
    "feedback_type": "positive",
    "weight": 1
  }'

# Full record ID format
curl -X POST http://activity.metabob.local/v2/activities/feedback \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "activity_id": "activity:⟨Enforce Specification Compliance⟩",
    "feedback_type": "positive",
    "weight": 1
  }'
```

All three should succeed (200 OK) instead of returning 404.

## Impact

### Fixed
- Feedback endpoint now finds activities regardless of ID format
- Users can provide feedback using any ID format from SurrealDB responses
- Consistent behavior with template endpoint

### Unchanged
- No breaking changes to API contract
- Response format remains the same
- Thompson Sampling logic unchanged
- All other endpoints unaffected

## Related Code

- **Template endpoint** (lines 1360-1389): Original implementation that works correctly
- **Feedback endpoint** (lines 2955-2998): Now uses same ID normalization logic
- **Test script**: `test-feedback-id-normalization.ts` - Validates normalization logic

## Files Modified

- `/home/avi/documents/work/exp-repo/metabob-devbob/repos/metabob-activity-api/src/routes/activities.ts`
  - Lines 2955-2998: Updated activity lookup with ID normalization

## Files Added

- `/home/avi/documents/work/exp-repo/metabob-devbob/repos/metabob-activity-api/test-feedback-id-normalization.ts`
  - Test script to verify ID normalization logic

- `/home/avi/documents/work/exp-repo/metabob-devbob/repos/metabob-activity-api/FEEDBACK_ENDPOINT_FIX.md`
  - This documentation file
