# Variant Confidence Tracking - Quick Reference

## Overview

Migration 066 adds statistical confidence tracking to variant performance metrics, enabling data-driven variant deprecation decisions.

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Confidence Interval** | Statistical measure of certainty in success rate (0.0 = no confidence, 1.0 = complete confidence) |
| **Sample Size** | Number of executions, determines confidence level (≥10 recommended) |
| **Deprecation** | Marking variants as inactive without deleting them |
| **Wilson Score** | Statistical method for computing confidence intervals |

## Quick Actions

### 1. Update Confidence After Execution

```typescript
import { computeWilsonScore } from './utils/statistics';

// After execution completes
const { successful_executions, total_executions } = metrics;
const confidence = computeWilsonScore(successful_executions, total_executions);

await db.query(`
  UPDATE variant_performance_metrics
  SET confidence_interval = $confidence,
      sample_size = $total
  WHERE variant_id = $variantId
`, { confidence, total: total_executions, variantId });
```

### 2. Check if Variant Should Be Deprecated

```typescript
const shouldDeprecate = (metrics: VariantMetrics): boolean => {
  // Rule 1: Low performance with confidence
  if (metrics.success_rate < 0.3 && metrics.sample_size >= 10) {
    return true;
  }

  // Rule 2: Very low performance
  if (metrics.success_rate < 0.2 && metrics.sample_size >= 5) {
    return true;
  }

  // Rule 3: Stale/untested (no execution in 90 days)
  const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
  if (metrics.sample_size < 3 &&
      (!metrics.last_executed_at || metrics.last_executed_at < ninetyDaysAgo)) {
    return true;
  }

  return false;
};
```

### 3. Deprecate a Variant

```typescript
async function deprecateVariant(
  variantId: string,
  reason: string
): Promise<void> {
  await db.query(`
    UPDATE variant_performance_metrics
    SET is_deprecated = true,
        deprecation_reason = $reason,
        deprecated_at = time::now()
    WHERE variant_id = $variantId
      AND is_deprecated = false
  `, { variantId, reason });
}

// Usage
await deprecateVariant(
  'improvise_solution:variant-7f4a9e',
  'poor_performance: success_rate=0.18 over 15 executions'
);
```

### 4. Thompson Sampling (Exclude Deprecated)

```typescript
const recommendations = await db.query(`
  SELECT variant_id, activity_id, thompson_alpha, thompson_beta,
         success_rate, confidence_interval, sample_size
  FROM variant_performance_metrics
  WHERE is_deprecated = false
    AND activity_id = $activityId
    AND sample_size >= 3
  ORDER BY success_rate DESC
  LIMIT $limit
`, { activityId, limit: 5 });
```

### 5. Find Variants Needing Review

```typescript
// Low confidence variants (need more data)
const lowConfidence = await db.query(`
  SELECT variant_id, activity_id, success_rate, confidence_interval, sample_size
  FROM variant_performance_metrics
  WHERE is_deprecated = false
    AND confidence_interval < 0.5
    AND sample_size < 10
  ORDER BY sample_size ASC
`);

// Stale variants (no recent executions)
const stale = await db.query(`
  SELECT variant_id, activity_id, last_executed_at, sample_size
  FROM variant_performance_metrics
  WHERE is_deprecated = false
    AND sample_size < 3
    AND (last_executed_at IS NONE OR last_executed_at < time::now() - 90d)
`);
```

## Wilson Score Interval Formula

```typescript
/**
 * Compute Wilson score confidence interval width
 *
 * @param successes - Number of successful executions
 * @param total - Total number of executions
 * @param confidence - Confidence level (default 0.95 for 95%)
 * @returns Confidence interval width (0.0 to 1.0)
 */
export function computeWilsonScore(
  successes: number,
  total: number,
  confidence: number = 0.95
): number {
  if (total === 0) return 0.0;

  const z = confidence === 0.95 ? 1.96 :
            confidence === 0.99 ? 2.576 :
            1.645; // 90% confidence

  const phat = successes / total;
  const denominator = 1 + (z * z) / total;
  const margin = z * Math.sqrt(
    (phat * (1 - phat) + (z * z) / (4 * total)) / total
  );

  return margin / denominator;
}
```

## Interpretation Guide

### Confidence Interval Values

| Range | Interpretation | Action |
|-------|---------------|--------|
| 0.0 - 0.2 | Very high confidence | Safe to make decisions |
| 0.2 - 0.4 | Moderate confidence | Decisions reasonable |
| 0.4 - 0.6 | Low confidence | Need more data |
| 0.6 - 1.0 | Very low confidence | Insufficient data |

### Sample Size Guidelines

| Sample Size | Status | Note |
|-------------|--------|------|
| 0-2 | Insufficient | Don't make decisions |
| 3-9 | Minimal | Use caution |
| 10-29 | Adequate | Good for most decisions |
| 30+ | Strong | High statistical power |

## Deprecation Reasons (Standard Format)

```typescript
// Format: "category: details"
const reasons = {
  poorPerformance: `poor_performance: success_rate=${rate} over ${n} executions`,
  superseded: `superseded_by: ${betterVariantId}`,
  stale: `untested: no executions in ${days} days`,
  manual: `manual_deprecation: ${explanation}`,
  security: `security_issue: ${cveOrDescription}`,
};
```

## Common Queries

### Variant Family Analysis

```sql
-- Compare all variants of an activity
SELECT variant_id,
       success_rate,
       confidence_interval,
       sample_size,
       is_deprecated,
       deprecation_reason
FROM variant_performance_metrics
WHERE activity_id = 'improvise_solution'
ORDER BY success_rate DESC, sample_size DESC;
```

### Deprecation Audit

```sql
-- Recent deprecations with reasons
SELECT variant_id,
       activity_id,
       deprecation_reason,
       deprecated_at,
       success_rate,
       sample_size
FROM variant_performance_metrics
WHERE is_deprecated = true
  AND deprecated_at > time::now() - 7d
ORDER BY deprecated_at DESC;
```

### Confidence Distribution

```sql
-- Histogram of confidence levels
SELECT
  CASE
    WHEN confidence_interval < 0.2 THEN 'High (0.0-0.2)'
    WHEN confidence_interval < 0.4 THEN 'Moderate (0.2-0.4)'
    WHEN confidence_interval < 0.6 THEN 'Low (0.4-0.6)'
    ELSE 'Very Low (0.6-1.0)'
  END AS confidence_level,
  count() AS variant_count,
  math::avg(sample_size) AS avg_sample_size
FROM variant_performance_metrics
WHERE is_deprecated = false
GROUP BY confidence_level;
```

## Background Jobs

### Automatic Deprecation Job (Recommended)

```typescript
// Run daily
async function autoDeprecateVariants() {
  // Find candidates
  const candidates = await db.query(`
    SELECT variant_id, activity_id, success_rate, sample_size, last_executed_at
    FROM variant_performance_metrics
    WHERE is_deprecated = false
      AND (
        (success_rate < 0.3 AND sample_size >= 10)
        OR (success_rate < 0.2 AND sample_size >= 5)
        OR (sample_size < 3 AND last_executed_at < time::now() - 90d)
      )
  `);

  for (const variant of candidates) {
    let reason = '';
    if (variant.success_rate < 0.2 && variant.sample_size >= 5) {
      reason = `poor_performance: success_rate=${variant.success_rate} over ${variant.sample_size} executions`;
    } else if (variant.success_rate < 0.3 && variant.sample_size >= 10) {
      reason = `poor_performance: success_rate=${variant.success_rate} over ${variant.sample_size} executions`;
    } else {
      reason = 'untested: no executions in 90 days';
    }

    await deprecateVariant(variant.variant_id, reason);
  }
}
```

## API Integration Points

### After Activity Execution

```typescript
// src/routes/activities.ts
router.post('/execution-traces', async (c) => {
  const trace = await c.req.json();

  // Store trace
  await storeExecutionTrace(trace);

  // Update variant metrics
  await updateVariantMetrics(trace.template_id, trace.success);

  // Compute and update confidence
  const metrics = await getVariantMetrics(trace.template_id);
  const confidence = computeWilsonScore(
    metrics.successful_executions,
    metrics.total_executions
  );

  await updateVariantConfidence(trace.template_id, confidence);

  return c.json({ success: true });
});
```

### Thompson Sampling Service

```typescript
// src/services/thompson-sampling.ts
async function recommendActivities(
  goal: string,
  category?: string,
  limit: number = 5
) {
  const query = `
    SELECT variant_id, thompson_alpha, thompson_beta, success_rate
    FROM variant_performance_metrics
    WHERE is_deprecated = false  -- ← KEY CHANGE
      ${category ? 'AND category = $category' : ''}
      AND sample_size >= 3
    ORDER BY success_rate DESC
    LIMIT $limit
  `;

  const results = await db.query(query, { category, limit });

  // Sample from Beta distributions
  return thompsonSample(results);
}
```

## Testing

```typescript
// Test confidence interval computation
describe('Wilson Score Interval', () => {
  it('should compute correct confidence', () => {
    expect(computeWilsonScore(8, 10)).toBeLessThan(0.3);  // High confidence
    expect(computeWilsonScore(1, 2)).toBeGreaterThan(0.5); // Low confidence
  });
});

// Test deprecation logic
describe('Variant Deprecation', () => {
  it('should deprecate low performers', async () => {
    const variant = {
      variant_id: 'test-variant',
      success_rate: 0.15,
      sample_size: 12
    };

    const should = shouldDeprecate(variant);
    expect(should).toBe(true);
  });
});
```

## References

- **Migration:** `sql/migrations/066-variant-confidence.surql`
- **Detailed Summary:** `MIGRATION_066_SUMMARY.md`
- **Sequence 4 Doc:** `docs/architecture/sequences/04-improvisation-trailblazing.md`
- **Wilson Score:** https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval

---

**Last Updated:** 2026-04-16
