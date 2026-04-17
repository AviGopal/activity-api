# Migration 066: Variant Confidence Tracking

## Overview

**Created:** 2026-04-16
**Purpose:** Add statistical confidence tracking for variant lifecycle management (Sequence 4 requirement)
**Related:** `docs/architecture/sequences/04-improvisation-trailblazing.md`

## Summary

This migration extends the `variant_performance_metrics` table with fields necessary for statistically-informed variant deprecation decisions. It enables the system to:

1. Track confidence in success rate estimates using statistical methods
2. Count sample sizes for determining when confidence is meaningful
3. Mark variants as deprecated without deleting them
4. Document deprecation reasons for audit trails
5. Track deprecation timestamps for lifecycle analysis

## New Fields

### 1. `confidence_interval` (FLOAT)
- **Purpose:** Statistical confidence in success rate estimate (0.0 to 1.0)
- **Computation:** Wilson score interval based on sample size and success rate
- **Default:** 0.0
- **Usage:** Higher sample sizes yield narrower confidence intervals

### 2. `sample_size` (INT)
- **Purpose:** Number of executions for statistical significance
- **Recommendation:** Minimum 10 executions for meaningful confidence
- **Default:** 0
- **Usage:** Used for Thompson Sampling and deprecation decisions

### 3. `is_deprecated` (BOOL)
- **Purpose:** Marks variants that should no longer be recommended
- **Default:** false
- **Note:** Deprecated variants remain in database for historical analysis

### 4. `deprecation_reason` (OPTIONAL STRING)
- **Purpose:** Documents why variant was retired
- **Examples:**
  - `"poor_performance: success_rate=0.15 over 12 executions"`
  - `"superseded_by: variant-7f4a9e"`
  - `"untested: no executions in 90 days"`
  - `"manual_deprecation: security_issue"`

### 5. `deprecated_at` (OPTIONAL DATETIME)
- **Purpose:** Records when variant was deprecated
- **Usage:** Lifecycle analysis and cleanup queries

### 6. `last_executed_at` (OPTIONAL DATETIME) - Updated
- **Note:** Field already exists, enhanced comment for clarity
- **Purpose:** Track recency for identifying stale/untested variants

## New Indexes

1. **`idx_variant_performance_is_deprecated`**
   - Fields: `is_deprecated`
   - Purpose: Filter active variants for Thompson Sampling

2. **`idx_variant_performance_last_executed`**
   - Fields: `last_executed_at`, `sample_size`
   - Purpose: Find stale/untested variants

3. **`idx_variant_performance_confidence`**
   - Fields: `confidence_interval`, `success_rate`, `sample_size`
   - Purpose: Identify deprecation candidates

4. **`idx_variant_performance_active_selection`**
   - Fields: `is_deprecated`, `activity_id`, `success_rate`
   - Purpose: Optimize Thompson Sampling queries

## Deprecation Criteria

Variants should be deprecated when:

1. **Low Performance:** `success_rate < 0.3` AND `sample_size >= 10`
2. **Very Low Performance:** `success_rate < 0.2` AND `sample_size >= 5`
3. **Stale/Untested:** No executions in 90 days AND `sample_size < 3`
4. **Superseded:** Better variant exists in same family

## Wilson Score Interval Calculation

The confidence interval should be computed using the Wilson score interval method:

```typescript
function computeConfidenceInterval(successes: number, total: number, confidence = 0.95): number {
  const z = 1.96; // 95% confidence
  const phat = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = phat + (z * z) / (2 * total);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * total)) / total);
  return margin / denominator; // Return interval width (0.0 to 1.0)
}
```

## Usage Examples

### Update Confidence After Execution

```typescript
// After recording execution result
const interval = computeConfidenceInterval(successful_executions, total_executions);

await db.query(`
  UPDATE variant_performance_metrics
  SET confidence_interval = $interval,
      sample_size = $total
  WHERE variant_id = $variantId
`, { interval, total: total_executions, variantId });
```

### Deprecate Low-Performing Variant

```typescript
await db.query(`
  UPDATE variant_performance_metrics
  SET is_deprecated = true,
      deprecation_reason = "poor_performance: success_rate=0.18 over 15 executions",
      deprecated_at = time::now()
  WHERE variant_id = $variantId
    AND success_rate < 0.3
    AND sample_size >= 10
    AND is_deprecated = false
`, { variantId });
```

### Thompson Sampling (Active Variants Only)

```typescript
const recommendations = await db.query(`
  SELECT variant_id, activity_id, thompson_alpha, thompson_beta, success_rate
  FROM variant_performance_metrics
  WHERE is_deprecated = false
    AND activity_id = $activityId
    AND sample_size >= 3
  ORDER BY success_rate DESC
`, { activityId });
```

### Find Stale Variants for Deprecation

```typescript
const staleVariants = await db.query(`
  SELECT variant_id, activity_id, last_executed_at, sample_size
  FROM variant_performance_metrics
  WHERE is_deprecated = false
    AND sample_size < 3
    AND (last_executed_at IS NONE
         OR last_executed_at < time::now() - 90d)
`);
```

## Application Changes Required

1. **Activity API (`src/services/thompson-sampling.ts`):**
   - Update recommendation logic to exclude `is_deprecated = true` variants
   - Compute confidence intervals after each execution
   - Implement automatic deprecation checks

2. **MiniBob (`src/activity.ts`):**
   - Update variant creation to initialize `sample_size = 0`
   - Track execution counts accurately

3. **Background Jobs:**
   - Create periodic job to deprecate low-performing variants
   - Create job to identify and deprecate stale variants

4. **Dashboard:**
   - Display confidence intervals in variant performance views
   - Show deprecation status and reasons
   - Add variant lifecycle visualizations

## Rollback Plan

If migration causes issues, fields can be safely ignored (all are optional with defaults). To fully rollback:

```sql
-- Remove indexes
REMOVE INDEX idx_variant_performance_is_deprecated ON variant_performance_metrics;
REMOVE INDEX idx_variant_performance_last_executed ON variant_performance_metrics;
REMOVE INDEX idx_variant_performance_confidence ON variant_performance_metrics;
REMOVE INDEX idx_variant_performance_active_selection ON variant_performance_metrics;

-- Remove fields
REMOVE FIELD confidence_interval ON variant_performance_metrics;
REMOVE FIELD sample_size ON variant_performance_metrics;
REMOVE FIELD is_deprecated ON variant_performance_metrics;
REMOVE FIELD deprecation_reason ON variant_performance_metrics;
REMOVE FIELD deprecated_at ON variant_performance_metrics;
```

## Testing

### Validation Script

Run the validation script to verify migration correctness:

```bash
cd repos/metabob-activity-api
./scripts/validate-migration-066.sh
```

### Application Script

Apply the migration to your database:

```bash
cd repos/metabob-activity-api
SURREALDB_PASSWORD=your-password ./scripts/apply-migration-066.sh
```

### Integration Tests

1. Create a variant with low success rate
2. Verify confidence interval is computed
3. Trigger deprecation logic
4. Verify deprecated variants are excluded from Thompson Sampling
5. Check deprecation reason is logged

## Sequence 4 Alignment

This migration directly supports the Sequence 4 (Improvisation & Trailblazing) workflow:

- **Trailblazing:** Variants created from failures get fresh Thompson scores
- **Variant Lifecycle:** Statistical confidence determines when to retire variants
- **Learning Loop:** Thompson Sampling learns from variant performance over time
- **Audit Trail:** Deprecation reasons provide visibility into system learning

See `docs/architecture/sequences/04-improvisation-trailblazing.md` for complete workflow.

## Files

- **Migration:** `repos/metabob-activity-api/sql/migrations/066-variant-confidence.surql`
- **Apply Script:** `repos/metabob-activity-api/scripts/apply-migration-066.sh`
- **Validation Script:** `repos/metabob-activity-api/scripts/validate-migration-066.sh`
- **This Summary:** `repos/metabob-activity-api/MIGRATION_066_SUMMARY.md`

## Next Steps

1. Apply migration to development database
2. Implement confidence interval computation in Thompson Sampling service
3. Add deprecation logic to background jobs
4. Update dashboard to display new fields
5. Write integration tests for variant lifecycle
6. Apply to canary environment
7. Monitor for issues
8. Promote to production

---

**Status:** Ready for review and deployment
**Dependencies:** SurrealDB 3.x, existing variant_performance_metrics table
**Breaking Changes:** None (all fields have defaults)
