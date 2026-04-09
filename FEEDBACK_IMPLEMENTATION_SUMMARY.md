# Feedback Endpoint Implementation Summary

## Problem Statement

MiniBob's manual feedback commands (`/teach` and `/warn`) were silently failing because the backend endpoint they called (`POST /v2/activities/feedback`) **did not exist**.

### Impact
- Users couldn't provide manual feedback to guide learning
- Thompson Sampling parameters never updated from human input
- `/teach` and `/warn` commands appeared to work but had no effect
- Manual intervention in the learning loop was impossible

## Root Cause Analysis

### MiniBob Implementation (Existing)
Location: `repos/minibob/src/mcp.ts:1394-1452`

```typescript
async recordFeedback(params: {
  activityId: string
  direction: "positive" | "negative"
  intensity?: number
  sessionId?: string
  reason?: string
}): Promise<{ success: boolean; affectedActivities: string[]; multiplier: number }> {
  try {
    const response = await this.request("POST", "/v2/activities/feedback", {
      activity_id: params.activityId,
      direction: params.direction,
      intensity: params.intensity ?? 0,
      include_adjacent: params.direction === "positive",
      session_id: params.sessionId,
      reason: params.reason,
    })

    if (!response.ok) {
      // Silently fails - returns success: false but logs nothing critical
      return { success: false, affectedActivities: [], multiplier: 1.0 }
    }
    // ...
  }
}
```

**Behavior:**
1. User runs `/teach!` or `/warn!!` in MiniBob REPL
2. MiniBob calls `recordFeedback()`
3. HTTP request to `POST /v2/activities/feedback`
4. Backend returns **404 Not Found**
5. MiniBob logs failure but doesn't raise error
6. User sees no indication that feedback failed

### Backend (Missing Implementation)

Location: `repos/metabob-activity-api/src/routes/activities.ts`

**BEFORE:** No endpoint defined - 404 response

**EXPECTED:** Updates Thompson Sampling parameters in `impulse_shape_activity_score` table

## Solution Implementation

### 1. Request/Response Schemas

Location: `repos/metabob-activity-api/src/models/schemas.ts:1405-1447`

```typescript
export const ActivityFeedbackRequestSchema = z.object({
  activity_id: z.string(),
  direction: z.enum(['positive', 'negative']),
  intensity: z.number().int().min(0).max(3).default(0),
  include_adjacent: z.boolean().optional(),
  session_id: z.string().optional(),
  reason: z.string().optional(),
});

export const ActivityFeedbackResponseSchema = z.object({
  success: z.boolean(),
  affected_activities: z.array(z.string()),
  multiplier: z.number(),
  direction: z.string(),
  message: z.string().optional(),
});
```

### 2. Endpoint Implementation

Location: `repos/metabob-activity-api/src/routes/activities.ts:2410-2654`

**Route:** `POST /v2/activities/feedback`

**Algorithm:**
```
1. Authenticate request (JWT or session)
2. Validate request body (Zod schema)
3. Calculate multiplier from intensity: 1.5 + (intensity * 0.5)
   - intensity=0 → 1.5x
   - intensity=1 → 2.0x
   - intensity=2 → 2.5x
   - intensity=3 → 3.0x
4. Verify activity exists in database
5. Fetch existing shape scores for activity
6. If no scores exist, initialize for all input_shapes
7. Apply feedback:
   - Positive: newAlpha = ceil(currentAlpha * multiplier)
   - Negative: newBeta = ceil(currentBeta * multiplier)
8. Update impulse_shape_activity_score table
9. Invalidate Redis cache
10. Emit WebSocket event for dashboard
11. Return success response
```

**Code Structure:**
```typescript
app.post('/feedback', async (c) => {
  // 1. Auth
  const orgId = jwtAuth?.orgId || session?.org_id || null;
  if (!orgId) return c.json({ error: 'Unauthorized' }, 401);

  // 2. Validate
  const validated = ActivityFeedbackRequestSchema.parse(body);

  // 3. Calculate multiplier
  const multiplier = 1.5 + (validated.intensity * 0.5);

  // 4. Verify activity exists
  const activity = await surrealDB.query(...);
  if (!activity) return c.json({ error: 'Activity not found' }, 404);

  // 5-6. Get or initialize scores
  let existingScores = await surrealDB.query(...);
  if (existingScores.length === 0) {
    // Initialize scores for all input shapes
    for (const shape of inputShapes) {
      await surrealDB.query(`CREATE impulse_shape_activity_score ...`);
    }
  }

  // 7-8. Apply feedback
  if (validated.direction === 'positive') {
    // Update alpha for all shapes
    for (const score of existingScores) {
      const newAlpha = Math.ceil(score.alpha * multiplier);
      await surrealDB.query(`UPDATE impulse_shape_activity_score SET alpha = ...`);
    }
  } else {
    // Update beta for all shapes
    for (const score of existingScores) {
      const newBeta = Math.ceil(score.beta * multiplier);
      await surrealDB.query(`UPDATE impulse_shape_activity_score SET beta = ...`);
    }
  }

  // 9. Invalidate cache
  await redis.del(`${CACHE_KEY_PREFIX}*`);

  // 10. Emit WebSocket event
  broadcaster.emit({ type: 'feedback_recorded', ... });

  // 11. Return success
  return c.json({ success: true, affected_activities: [...], multiplier, direction });
});
```

### 3. Database Schema

Location: `repos/metabob-activity-api/sql/schemas/043-impulse-shape-scoring.surql`

**Table:** `impulse_shape_activity_score`

```sql
DEFINE TABLE impulse_shape_activity_score SCHEMAFULL;

DEFINE FIELD shape ON impulse_shape_activity_score TYPE string;
DEFINE FIELD activity_id ON impulse_shape_activity_score TYPE string;
DEFINE FIELD org_id ON impulse_shape_activity_score TYPE string;
DEFINE FIELD success_count ON impulse_shape_activity_score TYPE int;
DEFINE FIELD failure_count ON impulse_shape_activity_score TYPE int;
DEFINE FIELD alpha ON impulse_shape_activity_score TYPE int;
DEFINE FIELD beta ON impulse_shape_activity_score TYPE int;
DEFINE FIELD updated_at ON impulse_shape_activity_score TYPE datetime;

DEFINE INDEX idx_shape_activity_score_unique
  ON impulse_shape_activity_score FIELDS org_id, shape, activity_id UNIQUE;
```

**Update Pattern:**
```sql
-- Positive feedback: multiply alpha
UPDATE impulse_shape_activity_score
SET alpha = $new_alpha, updated_at = time::now()
WHERE org_id = $org_id AND shape = $shape AND activity_id = $activity_id;

-- Negative feedback: multiply beta
UPDATE impulse_shape_activity_score
SET beta = $new_beta, updated_at = time::now()
WHERE org_id = $org_id AND shape = $shape AND activity_id = $activity_id;
```

### 4. Tests

Location: `repos/metabob-activity-api/src/routes/activities.feedback.test.ts`

**Test Coverage:**
1. ✅ Positive feedback with intensity 0 (1.5x multiplier)
2. ✅ Positive feedback with intensity 3 (3x multiplier)
3. ✅ Negative feedback with intensity 1 (2x multiplier)
4. ✅ Activity not found returns 404
5. ✅ Invalid direction returns 400
6. ✅ Invalid intensity returns 400
7. ✅ Initializes scores for activity without existing scores
8. ✅ Feedback affects Thompson Sampling selection probability

**Run Tests:**
```bash
cd repos/metabob-activity-api
bun test src/routes/activities.feedback.test.ts
```

## Before/After Behavior

### Scenario: User runs `/teach!` after successful activity

**BEFORE:**
```
User: /teach!
MiniBob: [Calls POST /v2/activities/feedback]
Backend: 404 Not Found
MiniBob: [Logs debug message, returns success: false]
Result: No visible error, no parameter update
```

**AFTER:**
```
User: /teach!
MiniBob: [Calls POST /v2/activities/feedback]
Backend: 200 OK { success: true, multiplier: 2.0, ... }
MiniBob: "[MCP] ✓ taught: activity-id"
Database: alpha *= 2.0 for all shapes
Redis: Cache invalidated
WebSocket: Event emitted → Dashboard updates
Result: Thompson Sampling parameters updated, visible feedback
```

### Scenario: User runs `/warn!!` after failed activity

**BEFORE:**
```
User: /warn!!
MiniBob: [Calls POST /v2/activities/feedback]
Backend: 404 Not Found
MiniBob: [Logs debug message, returns success: false]
Result: No visible error, no parameter update
```

**AFTER:**
```
User: /warn!!
MiniBob: [Calls POST /v2/activities/feedback]
Backend: 200 OK { success: true, multiplier: 2.5, ... }
MiniBob: "[MCP] ✓ warned: activity-id"
Database: beta *= 2.5 for all shapes
Redis: Cache invalidated
WebSocket: Event emitted → Dashboard updates
Result: Thompson Sampling parameters updated, visible feedback
```

## Thompson Sampling Impact

### Before Feedback
```
Activity: debug-null-pointer
Shape: error
Alpha: 6 (5 successes + 1 prior)
Beta: 6 (5 failures + 1 prior)
Belief: 6/(6+6) = 0.5 (50% expected success)
```

### After `/teach!!` (intensity=2, multiplier=2.5x)
```
Activity: debug-null-pointer
Shape: error
Alpha: 15 (6 * 2.5 = 15)
Beta: 6 (unchanged)
Belief: 15/(15+6) = 0.71 (71% expected success)
```

**Effect:** Activity is now **42% more likely** to be selected by Thompson Sampling

### After `/warn!!!` (intensity=3, multiplier=3x)
```
Activity: debug-null-pointer
Shape: error
Alpha: 6 (unchanged)
Beta: 18 (6 * 3 = 18)
Belief: 6/(6+18) = 0.25 (25% expected success)
```

**Effect:** Activity is now **50% less likely** to be selected by Thompson Sampling

## Files Changed

### New Files
1. `repos/metabob-activity-api/src/routes/activities.feedback.test.ts` (251 lines)
   - Comprehensive test suite
   - 8 test cases covering all edge cases

2. `repos/metabob-activity-api/FEEDBACK_ENDPOINT_VERIFICATION.md` (401 lines)
   - Manual testing guide
   - Integration verification steps
   - Troubleshooting guide

3. `repos/metabob-activity-api/FEEDBACK_IMPLEMENTATION_SUMMARY.md` (this file)
   - Complete implementation documentation
   - Before/after comparison

### Modified Files
1. `repos/metabob-activity-api/src/models/schemas.ts`
   - Added `ActivityFeedbackRequestSchema` (lines 1411-1425)
   - Added `ActivityFeedbackResponseSchema` (lines 1431-1441)
   - Added type exports (lines 1443-1444)

2. `repos/metabob-activity-api/src/routes/activities.ts`
   - Added imports for feedback schemas (lines 81-84, 99-101)
   - Added `POST /feedback` endpoint (lines 2410-2654)

## Integration Points

### 1. MiniBob REPL Commands

**Location:** `repos/minibob/src/repl.ts`

Commands that trigger feedback:
- `/teach` → intensity=0 (1.5x)
- `/teach!` → intensity=1 (2.0x)
- `/teach!!` → intensity=2 (2.5x)
- `/teach!!!` → intensity=3 (3.0x)
- `/warn` → intensity=0 (1.5x)
- `/warn!` → intensity=1 (2.0x)
- `/warn!!` → intensity=2 (2.5x)
- `/warn!!!` → intensity=3 (3.0x)

### 2. MCP Client

**Location:** `repos/minibob/src/mcp.ts:1410-1452`

Function: `recordFeedback()`
- Calls: `POST /v2/activities/feedback`
- Request: `{ activity_id, direction, intensity, include_adjacent, session_id, reason }`
- Response: `{ success, affected_activities, multiplier }`

### 3. Activity Dashboard

**WebSocket Event:** `feedback_recorded`

```typescript
{
  type: 'feedback_recorded',
  timestamp: '2026-04-08T12:34:56.789Z',
  data: {
    activity_id: 'debug-null-pointer',
    direction: 'positive',
    intensity: 2,
    multiplier: 2.5,
    affected_activities: ['debug-null-pointer'],
    org_id: 'org-123'
  }
}
```

Dashboard can subscribe to this event to update Thompson parameters in real-time.

### 4. Redis Cache

**Invalidation Pattern:**
```typescript
// Invalidate all activity template cache entries
const keys = await redis.keys(`${CACHE_KEY_PREFIX}*`);
await redis.del(...keys);
```

This ensures that the next Thompson Sampling selection uses updated parameters.

## Edge Cases Handled

### 1. Activity Not Found
```typescript
// Returns 404
{ error: 'Activity not found', message: 'Activity X does not exist' }
```

### 2. No Existing Shape Scores
```typescript
// Initializes scores for all input_shapes
for (const shape of activity.input_shapes) {
  await surrealDB.query(`CREATE impulse_shape_activity_score ...`);
}
```

### 3. Invalid Direction
```typescript
// Zod validation error (400)
{ error: 'Validation error', message: 'Invalid enum value...' }
```

### 4. Invalid Intensity
```typescript
// Zod validation error (400)
{ error: 'Validation error', message: 'Number must be less than or equal to 3' }
```

### 5. Missing Org Context
```typescript
// Auth error (401)
{ error: 'Unauthorized', message: 'Missing organization context' }
```

### 6. Redis Unavailable
```typescript
// Logs warning, continues without cache invalidation
logger.warn('Failed to invalidate Redis cache', { error });
```

### 7. WebSocket Unavailable
```typescript
// Logs warning, continues without event emission
logger.warn('Failed to emit WebSocket event', { error });
```

## Deployment Steps

### 1. Local Testing
```bash
cd repos/metabob-activity-api
bun install
bun test src/routes/activities.feedback.test.ts
bun run dev
```

### 2. Canary Deployment
```bash
git add .
git commit -m "feat(activity-api): implement /v2/activities/feedback endpoint"
git push origin dev
```

CI/CD will automatically:
- Run tests
- Build Docker image
- Deploy to canary (`https://activity.metabob.com`)

### 3. Verification
```bash
# Test feedback endpoint
curl -X POST https://activity.metabob.com/v2/activities/feedback \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey YOUR_KEY" \
  -d '{
    "activity_id": "test-activity",
    "direction": "positive",
    "intensity": 0
  }'

# Expected: 200 OK with success response
```

### 4. MiniBob Integration Test
```bash
cd repos/minibob
bun run index.ts

# In REPL:
> fix the login bug
# After completion:
> /teach!
# Should see: [MCP] ✓ taught: activity-id
```

### 5. Production Promotion
After successful canary validation:
```bash
./scripts/promote-canary-to-production.sh
```

## Success Metrics

### Before Fix
- ❌ Feedback endpoint: 0 successful requests (100% 404)
- ❌ Manual parameter updates: 0
- ❌ User feedback integration: Broken

### After Fix
- ✅ Feedback endpoint: Expected 100% success rate
- ✅ Manual parameter updates: Working
- ✅ User feedback integration: Functional
- ✅ Thompson Sampling: Responsive to human guidance

## Monitoring

### Logs to Watch
```bash
# Backend logs (activity-api)
grep "POST /v2/activities/feedback" /var/log/activity-api.log
grep "Updated alpha for positive feedback" /var/log/activity-api.log
grep "Updated beta for negative feedback" /var/log/activity-api.log

# MiniBob logs
grep "[MCP] ✓ taught:" /var/log/minibob.log
grep "[MCP] ✓ warned:" /var/log/minibob.log
```

### Metrics to Track
- Feedback requests per day
- Average multiplier used
- Positive vs negative feedback ratio
- Activities most frequently taught/warned
- Thompson parameter delta before/after feedback

### Dashboard Widgets (Future)
- Recent feedback events (last 24h)
- Feedback effectiveness (does teaching improve success rate?)
- User engagement with feedback system
- Activities with highest manual feedback frequency

## Known Limitations

1. **Adjacent activity boosting not implemented**
   - `include_adjacent` flag is accepted but not processed
   - Would require composition graph traversal
   - Planned for future enhancement

2. **No feedback history tracking**
   - Each feedback overwrites previous state
   - No audit trail of manual interventions
   - Could add `activity_feedback_history` table

3. **No feedback decay**
   - Manual boosts persist forever
   - Could implement time-based decay
   - Planned for future enhancement

4. **No user-specific feedback**
   - Feedback applies org-wide
   - No per-user feedback preferences
   - Could add user_id tracking

## Future Enhancements

### 1. Adjacent Activity Boosting (Composition Graph)
```typescript
if (validated.include_adjacent && validated.session_id) {
  // Query composition graph for activities used in same session
  const adjacentActivities = await queryCompositionGraph(
    validated.activity_id,
    validated.session_id
  );

  // Apply reduced multiplier (e.g., 0.5x of original)
  const adjacentMultiplier = 1 + ((multiplier - 1) * 0.5);
  for (const adjacent of adjacentActivities) {
    await updateShapeScores(adjacent.id, 'positive', adjacentMultiplier);
  }
}
```

### 2. Feedback History Tracking
```sql
DEFINE TABLE activity_feedback_history SCHEMAFULL;
DEFINE FIELD activity_id ON activity_feedback_history TYPE string;
DEFINE FIELD direction ON activity_feedback_history TYPE string;
DEFINE FIELD intensity ON activity_feedback_history TYPE int;
DEFINE FIELD multiplier ON activity_feedback_history TYPE float;
DEFINE FIELD user_id ON activity_feedback_history TYPE string;
DEFINE FIELD reason ON activity_feedback_history TYPE string;
DEFINE FIELD timestamp ON activity_feedback_history TYPE datetime;
```

### 3. Time-Based Decay
```typescript
// Decay manual boosts over time
// Every 7 days, reduce boost by 10%
const decayFactor = 0.9;
const daysSinceBoost = getDaysSince(lastFeedbackTimestamp);
if (daysSinceBoost >= 7) {
  const decayMultiplier = Math.pow(decayFactor, Math.floor(daysSinceBoost / 7));
  alpha = alpha * decayMultiplier;
  beta = beta * decayMultiplier;
}
```

### 4. Feedback Analytics Dashboard
- Most taught activities
- Most warned activities
- Feedback effectiveness analysis
- User feedback patterns
- Correlation with success rates

## Conclusion

This implementation **fixes the broken feedback loop** by restoring manual feedback functionality in MiniBob. Users can now actively guide the learning system through `/teach` and `/warn` commands, with immediate updates to Thompson Sampling parameters.

**Key Achievement:** The manual feedback mechanism that was **silently failing** now **actively contributes to the learning loop**, enabling human-in-the-loop reinforcement of activity selection.
