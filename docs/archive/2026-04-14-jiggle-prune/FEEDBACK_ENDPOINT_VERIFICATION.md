# Feedback Endpoint Verification Guide

## Overview

This guide demonstrates how to verify the `/v2/activities/feedback` endpoint works correctly, restoring manual feedback functionality for `/teach` and `/warn` commands in MiniBob.

## The Problem (Before)

```
MiniBob → POST /v2/activities/feedback → 404 NOT FOUND
           |
           └─ Feedback silently fails
           └─ Thompson parameters never update
           └─ /teach and /warn commands do nothing
```

## The Solution (After)

```
MiniBob → POST /v2/activities/feedback → 200 OK
           |
           ├─ Updates alpha/beta in impulse_shape_activity_score
           ├─ Invalidates Redis cache
           ├─ Emits WebSocket event
           └─ Returns updated parameters
```

## Manual Testing

### 1. Start the Backend

```bash
cd repos/metabob-activity-api
bun run dev
```

### 2. Create a Test Activity

```bash
curl -X POST http://localhost:8080/v2/activities/templates \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey your-api-key-here" \
  -d '{
    "id": "test-feedback-activity",
    "name": "Test Feedback Activity",
    "description": "Activity for testing feedback",
    "tags": ["test"],
    "scope": "org",
    "input_shapes": ["goal"],
    "output_shapes": ["solution"],
    "tasks": [{
      "id": "task1",
      "description": "Test task",
      "prompt": {
        "template": "Test prompt",
        "variables": []
      },
      "validation": {},
      "retry": {
        "maxAttempts": 3,
        "strategy": "exponential"
      }
    }]
  }'
```

### 3. Check Initial Thompson Parameters

```bash
curl "http://localhost:8080/v2/activities/templates/test-feedback-activity" \
  -H "Authorization: ApiKey your-api-key-here" | jq '.metrics'
```

Output should show:
```json
{
  "thompson_alpha": 1,
  "thompson_beta": 1,
  "total_executions": 0
}
```

### 4. Send Positive Feedback (Intensity 0 = 1.5x)

```bash
curl -X POST http://localhost:8080/v2/activities/feedback \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey your-api-key-here" \
  -d '{
    "activity_id": "test-feedback-activity",
    "direction": "positive",
    "intensity": 0,
    "reason": "Testing positive feedback"
  }'
```

Expected response:
```json
{
  "success": true,
  "affected_activities": ["test-feedback-activity"],
  "multiplier": 1.5,
  "direction": "positive",
  "message": "Positive feedback applied with 1.5x multiplier"
}
```

### 5. Verify Alpha Was Updated

```bash
# Query the shape scores directly
curl -X POST http://localhost:8080/sql \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey your-api-key-here" \
  -d '{
    "query": "SELECT * FROM impulse_shape_activity_score WHERE activity_id = \"test-feedback-activity\""
  }' | jq
```

Expected result:
- `alpha` should be 2 (was 1, multiplied by 1.5, rounded up)
- `beta` should still be 1 (unchanged)

### 6. Send Negative Feedback (Intensity 2 = 2.5x)

```bash
curl -X POST http://localhost:8080/v2/activities/feedback \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey your-api-key-here" \
  -d '{
    "activity_id": "test-feedback-activity",
    "direction": "negative",
    "intensity": 2,
    "reason": "Testing negative feedback"
  }'
```

Expected response:
```json
{
  "success": true,
  "affected_activities": ["test-feedback-activity"],
  "multiplier": 2.5,
  "direction": "negative",
  "message": "Negative feedback applied with 2.5x multiplier"
}
```

### 7. Verify Beta Was Updated

```bash
curl -X POST http://localhost:8080/sql \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey your-api-key-here" \
  -d '{
    "query": "SELECT * FROM impulse_shape_activity_score WHERE activity_id = \"test-feedback-activity\""
  }' | jq
```

Expected result:
- `alpha` should still be 2
- `beta` should be 3 (was 1, multiplied by 2.5, rounded up)

### 8. Test MiniBob Integration

```bash
# Start MiniBob
cd repos/minibob
bun run index.ts

# In the REPL:
> fix the bug in test.ts

# After execution completes:
> /teach!    # Intensity 1 (2x multiplier)

# Or if it failed:
> /warn!!   # Intensity 2 (2.5x multiplier)
```

Check logs - you should see:
```
[MCP] ✓ taught: test-feedback-activity
```

Or:
```
[MCP] ✓ warned: test-feedback-activity
```

## Automated Testing

Run the test suite:

```bash
cd repos/metabob-activity-api
bun test src/routes/activities.feedback.test.ts
```

Expected output:
```
✓ positive feedback with intensity 0 (1.5x multiplier)
✓ positive feedback with intensity 3 (3x multiplier)
✓ negative feedback with intensity 1 (2x multiplier)
✓ activity not found returns 404
✓ invalid direction returns 400
✓ invalid intensity returns 400
✓ initializes scores for activity without existing scores
✓ feedback affects Thompson Sampling selection probability
```

## Before/After Comparison

### BEFORE (Broken State)

**MiniBob Call:**
```typescript
// repos/minibob/src/mcp.ts:1418
const response = await this.request("POST", "/v2/activities/feedback", { ... })
```

**Backend Response:**
```
404 Not Found
```

**Impact:**
- `/teach` command does nothing
- `/warn` command does nothing
- Thompson parameters never change from manual feedback
- Users can't guide the learning system

### AFTER (Working State)

**MiniBob Call:**
```typescript
// repos/minibob/src/mcp.ts:1418
const response = await this.request("POST", "/v2/activities/feedback", { ... })
```

**Backend Response:**
```json
{
  "success": true,
  "affected_activities": ["activity-id"],
  "multiplier": 1.5,
  "direction": "positive"
}
```

**Impact:**
- `/teach` increases alpha (success parameter)
- `/warn` increases beta (failure parameter)
- Thompson Sampling selection probabilities update immediately
- Users can actively guide learning

## Implementation Details

### Intensity to Multiplier Mapping

| Intensity | Exclamation Marks | Multiplier | Example |
|-----------|------------------|------------|---------|
| 0         | (none)           | 1.5x       | `/teach` or `/warn` |
| 1         | !                | 2.0x       | `/teach!` or `/warn!` |
| 2         | !!               | 2.5x       | `/teach!!` or `/warn!!` |
| 3         | !!!              | 3.0x       | `/teach!!!` or `/warn!!!` |

### Thompson Sampling Update Logic

**Positive Feedback:**
```typescript
newAlpha = Math.ceil(currentAlpha * multiplier)
// Beta remains unchanged
```

**Negative Feedback:**
```typescript
newBeta = Math.ceil(currentBeta * multiplier)
// Alpha remains unchanged
```

**Selection Probability:**
```typescript
// Thompson Sampling draws from Beta(alpha, beta)
// Expected value (belief): alpha / (alpha + beta)

// Example:
// Before: alpha=6, beta=6 → belief=0.5 (50%)
// After /teach!!: alpha=15, beta=6 → belief=0.71 (71%)
```

### Database Schema

The endpoint updates the `impulse_shape_activity_score` table:

```sql
DEFINE TABLE impulse_shape_activity_score SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD shape ON impulse_shape_activity_score TYPE string;
DEFINE FIELD activity_id ON impulse_shape_activity_score TYPE string;
DEFINE FIELD org_id ON impulse_shape_activity_score TYPE string;
DEFINE FIELD success_count ON impulse_shape_activity_score TYPE int;
DEFINE FIELD failure_count ON impulse_shape_activity_score TYPE int;
DEFINE FIELD alpha ON impulse_shape_activity_score TYPE int;
DEFINE FIELD beta ON impulse_shape_activity_score TYPE int;
DEFINE FIELD updated_at ON impulse_shape_activity_score TYPE datetime;
```

## Edge Cases Handled

1. **Activity doesn't exist**: Returns 404
2. **No shape scores exist yet**: Initializes scores for all input_shapes
3. **Invalid direction**: Returns 400 validation error
4. **Invalid intensity**: Returns 400 validation error (must be 0-3)
5. **Missing org context**: Returns 401 unauthorized
6. **Redis unavailable**: Logs warning, continues without cache invalidation
7. **WebSocket unavailable**: Logs warning, continues without event emission

## Next Steps

1. **Deploy to canary**: Push to `dev` branch triggers canary deployment
2. **Test in canary**: Use `https://activity.metabob.com/v2/activities/feedback`
3. **Monitor logs**: Check for feedback events in activity logs
4. **Validate dashboard**: Verify Thompson parameters update in real-time
5. **Promote to production**: After successful canary validation

## Troubleshooting

### Feedback returns 404

**Check:** Is the activity registered?
```bash
curl "http://localhost:8080/v2/activities/templates/YOUR_ACTIVITY_ID" \
  -H "Authorization: ApiKey your-api-key-here"
```

### Alpha/Beta not updating

**Check:** Are shape scores initialized?
```bash
curl -X POST http://localhost:8080/sql \
  -H "Authorization: ApiKey your-api-key-here" \
  -d '{
    "query": "SELECT * FROM impulse_shape_activity_score WHERE activity_id = \"YOUR_ACTIVITY_ID\""
  }'
```

If empty, the endpoint will initialize them on first feedback.

### MiniBob still shows failure

**Check:** MiniBob logs for the actual error
```bash
# In MiniBob console
> /teach
# Check output - should show:
[MCP] ✓ taught: activity-id
```

**Check:** MiniBob config points to correct endpoint
```json
// ~/.metabob/config.json
{
  "metabob": {
    "endpoint": "https://activity.metabob.com"
  }
}
```

## Success Criteria

- ✅ Endpoint responds with 200 for valid feedback
- ✅ Alpha multiplies on positive feedback
- ✅ Beta multiplies on negative feedback
- ✅ Intensity correctly maps to multiplier (1.5x to 3x)
- ✅ Redis cache invalidates
- ✅ WebSocket event emitted
- ✅ MiniBob `/teach` and `/warn` commands work
- ✅ Thompson Sampling selection probabilities change
- ✅ Dashboard shows updated parameters
