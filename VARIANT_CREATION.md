# Automatic Variant Creation from Failed Executions

## Overview

This feature implements automatic variant creation (trailblazing) when activity templates fail repeatedly. When a template fails 3+ times consecutively, the system automatically creates a variant with modified approaches to improve success rates.

## Implementation Date

2026-04-15

## Files Added/Modified

### New Files

1. **`sql/migrations/055-variant-tracking.surql`**
   - Adds `variant_generation`, `variant_reason`, `retired`, `retired_at`, `retired_reason` fields to activity table
   - Creates indexes for efficient querying
   - Creates views: `v_active_activities`, `v_variant_families`

2. **`src/services/variant-creator.ts`**
   - Core variant creation logic
   - Failure pattern detection
   - Variant modification generation
   - Template retirement policy

3. **`src/services/variant-creator.test.ts`**
   - Comprehensive test suite for variant creation
   - Tests consecutive failure detection, variant creation, retirement policy

### Modified Files

1. **`src/routes/activities.ts`**
   - Added variant creation hooks to execution recording endpoint
   - Added manual variant creation endpoint `POST /v2/activities/:id/variants`
   - Added retired template filtering in Thompson Sampling
   - Updated all template queries to filter `retired = false`

2. **`src/db/paradigm.ts`**
   - Updated `queryActivitiesByShapes()` to filter retired templates

3. **`src/websocket/types.ts`**
   - Added `variant_created` and `template_retired` event types

## Database Schema Changes

### New Fields on `activity` Table

```sql
-- Variant tracking
variant_generation: int    -- Generation number (0=original, 1=first variant, etc.)
variant_reason: string     -- Why this variant was created
retired: bool              -- Whether template is retired
retired_at: datetime       -- When template was retired
retired_reason: string     -- Why template was retired
```

### New Indexes

```sql
idx_activity_retired      -- (retired, variant_generation)
idx_activity_generation   -- (variant_of, variant_generation)
```

### New Views

```sql
v_active_activities        -- Non-retired templates only
v_variant_families         -- Variant statistics per base activity
```

## Core Features

### 1. Automatic Variant Creation

**Trigger Conditions:**
- 3 consecutive failures for a template
- No variant created in last hour (rate limiting)
- Maximum 5 variants per template

**Variant Modifications:**

1. **Error Awareness** - Prepends error context to prompts:
   ```
   IMPORTANT: Previous attempts failed with these errors:
   - Error message 1
   - Error message 2

   Please be especially careful to avoid these issues.
   ```

2. **Increased Retry Attempts** - For frequently failing tasks:
   - Adds retry configuration if missing
   - Increments retry attempts (max 5)

3. **Validation Steps** - Adds preparation task for early failures:
   ```typescript
   {
     id: 'prep_validation',
     description: 'Validate environment and prerequisites',
     resolver: 'bash',
     config: { command: 'echo "Validating..." && pwd && ls -la' }
   }
   ```

4. **Success Criteria Clarification** - Updates description with context:
   ```
   Variant created to address failure patterns.
   Success rate of parent: 25.0%.
   ```

### 2. Template Retirement

**Trigger Conditions:**
- Minimum 20 executions recorded
- Success rate < 30% over last 20 executions

**Retirement Effects:**
- Template marked as `retired = true`
- Excluded from Thompson Sampling recommendations
- Excluded from template list queries
- Remains queryable for historical analysis

### 3. Variant Competition

Thompson Sampling treats variants as separate templates:
- Parent and variants compete independently
- Each has own Thompson Sampling parameters (alpha, beta)
- Best-performing variant naturally gets selected more often
- Poor performers (parent or variant) can be retired

## API Endpoints

### Automatic Variant Creation

Integrated into execution recording endpoint:

```bash
POST /v2/activities/executions
```

After recording each execution, the system:
1. Checks if variant should be created (3 consecutive failures)
2. Creates variant if needed (non-blocking)
3. Checks if template should be retired (non-blocking)
4. Emits WebSocket events for variants/retirements

### Manual Variant Creation

```bash
POST /v2/activities/:id/variants

Request Body:
{
  "reason": "manual_improvement"  # Optional
}

Response:
{
  "success": true,
  "variant_id": "template.id.v1.1713187200000",
  "variant_generation": 1,
  "modifications": [
    "Added error awareness to task 'task1' prompt",
    "Increased retry attempts for task 'task1' to 3"
  ],
  "reason": "manual_improvement"
}
```

### Get Variant Family

```bash
GET /v2/activities/:id/variants

Response:
{
  "variants": [
    {
      "id": "template.id.v1",
      "name": "Template Name (Variant 1)",
      "variant_of": "template.id",
      "variant_generation": 1,
      "variant_reason": "consecutive_failures",
      "created_at": "2026-04-15T10:00:00Z"
    }
  ],
  "total": 1
}
```

## WebSocket Events

### Variant Created

```json
{
  "type": "variant_created",
  "timestamp": "2026-04-15T10:00:00Z",
  "data": {
    "parent_activity_id": "template.id",
    "variant_id": "template.id.v1",
    "variant_generation": 1,
    "reason": "consecutive_failures",
    "modifications": [
      "Added error awareness to task 'task1' prompt",
      "Increased retry attempts for task 'task1' to 3"
    ]
  }
}
```

### Template Retired

```json
{
  "type": "template_retired",
  "timestamp": "2026-04-15T10:00:00Z",
  "data": {
    "activity_id": "template.id",
    "reason": "poor_performance"
  }
}
```

## Configuration

No configuration required. The feature is enabled by default with these hardcoded thresholds:

- **Consecutive failures for variant creation:** 3
- **Rate limit for variant creation:** 1 hour
- **Maximum variants per template:** 5
- **Minimum executions for retirement:** 20
- **Success rate threshold for retirement:** 30%

## Testing

### Unit Tests

```bash
cd repos/metabob-activity-api
bun test src/services/variant-creator.test.ts
```

**Test Cases:**
1. `shouldCreateVariant returns null when no failures`
2. `shouldCreateVariant detects 3 consecutive failures`
3. `createVariant generates a new variant`
4. `checkAndRetireTemplate retires poorly performing templates`
5. `autoCreateVariantIfNeeded creates variant after 3 failures`
6. `variant creation respects maximum variant limit`
7. `variant modifications include error awareness`

### Integration Test

```bash
# 1. Create a test template
POST /v2/activities/templates
{
  "id": "test.failing",
  "name": "Test Failing Template",
  "description": "Template for testing",
  "tags": ["test"],
  "tasks": [...]
}

# 2. Record 3 consecutive failures
for i in 1 2 3; do
  POST /v2/activities/executions
  {
    "activity_id": "test.failing",
    "success": false,
    "duration_ms": 1000,
    "cost": 0.01,
    "tokens": { "input": 100, "output": 100, "cache": 0 },
    "error_message": "Test error"
  }
done

# 3. Verify variant was created
GET /v2/activities/test.failing/variants
# Should return 1 variant

# 4. Check Thompson Sampling includes both
POST /v2/activities/recommend
{
  "task_description": "test task",
  "limit": 10
}
# Should include both parent and variant

# 5. Record 20 more failures on parent (total 23)
for i in 4..23; do
  POST /v2/activities/executions
  { "activity_id": "test.failing", "success": false, ... }
done

# 6. Verify parent was retired
GET /v2/activities/templates
# Parent should not be in list (retired)

GET /v2/activities/test.failing/variants
# Variant should still be active
```

## Performance Impact

- **Variant creation:** Non-blocking, runs asynchronously after execution recording
- **Retirement check:** Non-blocking, runs asynchronously after execution recording
- **Thompson Sampling:** Minimal impact (one additional WHERE clause)
- **Template queries:** Minimal impact (retired filter indexed)

## Monitoring

### Logs

```typescript
// Variant created
logger.info('Auto-created variant from consecutive failures', {
  parentTemplateId,
  variantId,
  variantGeneration,
  modifications: count
});

// Template retired
logger.info('Template retired due to poor performance', {
  activity_id,
  successRate,
  executionCount
});
```

### Dashboard

Real-time WebSocket events enable dashboard visualization:
- Variant creation notifications
- Retirement notifications
- Variant family tree visualization
- Performance comparison charts

## Future Enhancements

1. **Configurable Thresholds** - Move hardcoded values to configuration
2. **Variant Strategies** - Multiple modification strategies beyond error awareness
3. **A/B Testing Mode** - Force equal distribution between parent and variants
4. **Auto-Promotion** - Automatically promote best variant as new parent
5. **Variant Pruning** - Delete underperforming variants automatically
6. **Learning from Success** - Create variants from highly successful templates too

## Related Documentation

- [IMPULSE_ACTIVITY_FOUNDATION.md](../../docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md) - Core principles
- [CLAUDE.md](../../CLAUDE.md) - Development guidelines
- [variant-creator.ts](src/services/variant-creator.ts) - Implementation
- [activities.ts](src/routes/activities.ts) - Integration points
