# Feedback Endpoint Quick Reference

## API Endpoint

```
POST /v2/activities/feedback
```

## Request

```json
{
  "activity_id": "activity-id",
  "direction": "positive" | "negative",
  "intensity": 0 | 1 | 2 | 3,
  "include_adjacent": false,
  "session_id": "optional-session-id",
  "reason": "Optional reason for feedback"
}
```

## Response (Success)

```json
{
  "success": true,
  "affected_activities": ["activity-id"],
  "multiplier": 1.5,
  "direction": "positive",
  "message": "Positive feedback applied with 1.5x multiplier"
}
```

## Response (Error)

```json
{
  "error": "Activity not found",
  "message": "Activity X does not exist"
}
```

## Intensity Mapping

| Intensity | MiniBob Command | Multiplier |
|-----------|----------------|------------|
| 0         | `/teach` or `/warn` | 1.5x |
| 1         | `/teach!` or `/warn!` | 2.0x |
| 2         | `/teach!!` or `/warn!!` | 2.5x |
| 3         | `/teach!!!` or `/warn!!!` | 3.0x |

## Thompson Sampling Updates

### Positive Feedback
```
newAlpha = ceil(currentAlpha × multiplier)
beta unchanged
```

### Negative Feedback
```
newBeta = ceil(currentBeta × multiplier)
alpha unchanged
```

## Example: Manual Test

```bash
# Positive feedback with 2x multiplier
curl -X POST http://localhost:8080/v2/activities/feedback \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey YOUR_KEY" \
  -d '{
    "activity_id": "debug-null-pointer",
    "direction": "positive",
    "intensity": 1,
    "reason": "Activity solved the problem quickly"
  }'

# Response:
# {
#   "success": true,
#   "affected_activities": ["debug-null-pointer"],
#   "multiplier": 2.0,
#   "direction": "positive",
#   "message": "Positive feedback applied with 2.0x multiplier"
# }
```

## Example: MiniBob Integration

```typescript
// In MiniBob REPL after activity execution:
> /teach!!    // Positive feedback, intensity 2 (2.5x)

// MiniBob calls:
await mcp.recordFeedback({
  activityId: lastActivityId,
  direction: "positive",
  intensity: 2,
  sessionId: currentSessionId,
  reason: "User provided strong positive feedback"
});

// Console output:
// [MCP] ✓ taught: debug-null-pointer
```

## Database Impact

### Before Feedback
```sql
SELECT * FROM impulse_shape_activity_score
WHERE activity_id = 'debug-null-pointer' AND shape = 'error';

-- Result:
-- alpha: 6, beta: 6, belief: 0.5 (50%)
```

### After `/teach!!` (intensity=2, multiplier=2.5x)
```sql
SELECT * FROM impulse_shape_activity_score
WHERE activity_id = 'debug-null-pointer' AND shape = 'error';

-- Result:
-- alpha: 15, beta: 6, belief: 0.71 (71%)
```

**Selection probability increased by 42%**

## Error Codes

| Status | Error | Description |
|--------|-------|-------------|
| 200 | - | Success |
| 400 | Validation error | Invalid direction, intensity, or request format |
| 401 | Unauthorized | Missing organization context |
| 404 | Activity not found | Activity ID doesn't exist |
| 500 | Failed to record feedback | Internal server error |

## Side Effects

1. **Database**: Updates `impulse_shape_activity_score` table
2. **Redis**: Invalidates template recommendation cache
3. **WebSocket**: Emits `feedback_recorded` event
4. **Logs**: Records feedback reason if provided

## Files Modified

- `src/models/schemas.ts` - Added request/response schemas
- `src/routes/activities.ts` - Added POST /feedback endpoint
- `src/routes/activities.feedback.test.ts` - Test suite (new file)

## Testing

```bash
# Run tests
cd repos/metabob-activity-api
bun test src/routes/activities.feedback.test.ts

# Manual test
bun run dev
# In another terminal:
curl -X POST http://localhost:8080/v2/activities/feedback \
  -H "Content-Type: application/json" \
  -d '{"activity_id": "test", "direction": "positive", "intensity": 0}'
```

## Deployment

```bash
# Local
bun run dev

# Canary (auto-deploys on push to dev)
git push origin dev

# Production (manual promotion)
./scripts/promote-canary-to-production.sh
```

## Monitoring

### Logs to Check
```bash
grep "POST /v2/activities/feedback" logs/activity-api.log
grep "Updated alpha for positive feedback" logs/activity-api.log
grep "Updated beta for negative feedback" logs/activity-api.log
```

### Metrics to Track
- Feedback requests per day
- Average multiplier
- Positive/negative ratio
- Most frequently taught/warned activities
