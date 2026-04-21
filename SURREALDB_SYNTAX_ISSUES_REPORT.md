# SurrealDB Syntax Issues Report

**Date:** 2026-04-20
**File:** `/home/avi/documents/work/exp-repo/metabob-devbob/repos/metabob-activity-api/src/routes/activities.ts`
**SurrealDB Client Version:** `surrealdb@2.0.3` (package.json)
**Target SurrealDB Server:** 3.x (per documentation)

## Executive Summary

This report documents **5 critical syntax errors** in SurrealDB queries across the metrics endpoints in `activities.ts`. All issues stem from incompatibilities between SurrealDB 2.x/3.x syntax:

1. **HAVING clause usage** (4 occurrences) - Not supported in SurrealDB 3.x GROUP BY queries
2. **Wrong table name in GROUP ALL** (1 occurrence) - Using `activity` instead of `activity_template`

All affected queries will fail with syntax errors when executed against SurrealDB 3.x.

---

## Issue #1: HAVING Clause in /metrics/aggregate (Line 2432)

### Location
**File:** `src/routes/activities.ts`
**Line:** 2432
**Endpoint:** `GET /v2/activities/metrics/aggregate`

### Current Syntax
```sql
SELECT
  activity_id AS template_id,
  math::mean(IF success = true THEN 1.0 ELSE 0.0 END) AS success_rate,
  count() AS execution_count
FROM activity_execution_traces
GROUP BY activity_id
HAVING execution_count >= 3
ORDER BY success_rate DESC, execution_count DESC
LIMIT 10
```

### Why It's Wrong
**SurrealDB 3.x does not support the `HAVING` clause.** This is a fundamental limitation of the query engine. The `HAVING` clause is SQL-92 syntax for filtering aggregated results, but SurrealDB's GROUP BY implementation does not include this feature.

The query attempts to filter grouped results to only include activities with at least 3 executions, but the `HAVING` clause causes a syntax error.

### What It's Trying to Do
Query the top 10 templates by success rate, but only include templates that have been executed at least 3 times (to avoid statistical noise from low-sample-size data).

### Error Impact
This query will fail with a syntax error when executed, breaking the `/metrics/aggregate` endpoint completely. The endpoint is used to display system-wide aggregate metrics including top templates.

### Workaround Strategy
Use a subquery or computed view to pre-filter, then select from the filtered results. Alternatively, filter in application code after fetching all results.

---

## Issue #2: HAVING Clause in /composition/impulse-success (Line 4479)

### Location
**File:** `src/routes/activities.ts`
**Line:** 4479
**Endpoint:** `GET /v2/activities/composition/impulse-success`

### Current Syntax
```sql
SELECT
  edge_id,
  shape,
  direction,
  count() as total_count,
  count(IF execution_succeeded = true THEN 1 ELSE NONE END) as success_count,
  (count(IF execution_succeeded = true THEN 1 ELSE NONE END) * 1.0 / count()) as success_rate
FROM composition_impulse_flow
WHERE [optional conditions]
GROUP BY edge_id, shape, direction
HAVING count() >= $min_count
ORDER BY success_rate DESC
LIMIT $limit START $offset
```

### Why It's Wrong
Same fundamental issue: **SurrealDB 3.x does not support HAVING clause**. The query attempts to filter grouped results to only include edges with at least `$min_count` occurrences.

### What It's Trying to Do
Query impulse flow success rates across composition edges, filtering out edges with too few occurrences to be statistically meaningful (controlled by `$min_count` parameter, default is typically 1-3).

### Error Impact
This query will fail with a syntax error, breaking the endpoint that analyzes impulse flow patterns between composed activities. This is critical for learning which impulse shapes successfully flow between activities.

### Workaround Strategy
Use a subquery with WHERE clause on count(), or create a computed view that includes the count filter.

---

## Issue #3: HAVING Clause in /composition/impulse-success Count Query (Line 4491)

### Location
**File:** `src/routes/activities.ts`
**Line:** 4491
**Endpoint:** `GET /v2/activities/composition/impulse-success` (count query)

### Current Syntax
```sql
SELECT count() as total FROM (
  SELECT edge_id, shape, direction
  FROM composition_impulse_flow
  WHERE [optional conditions]
  GROUP BY edge_id, shape, direction
  HAVING count() >= $min_count
)
```

### Why It's Wrong
Same issue in the count query for pagination: **SurrealDB 3.x does not support HAVING clause**. This is a subquery that counts how many unique edge/shape/direction combinations meet the threshold, used for pagination calculations.

### What It's Trying to Do
Count the total number of valid impulse flow patterns (after filtering by minimum occurrence threshold) to provide accurate pagination metadata to the client.

### Error Impact
Pagination will be broken for the `/composition/impulse-success` endpoint. Even if the main query is fixed, the count query will still fail, causing incorrect total counts.

### Workaround Strategy
Match the workaround used for the main query (Issue #2) to ensure consistency between data query and count query.

---

## Issue #4: HAVING Clause in /composition/edges/successors (Line 4837)

### Location
**File:** `src/routes/activities.ts`
**Line:** 4837
**Endpoint:** `GET /v2/activities/composition/edges/successors`

### Current Syntax
```sql
SELECT
  to_activity as child_activity_id,
  shape_produced,
  math::sum(success_count) as successful_occurrences,
  math::sum(total_count) as total_occurrences,
  (math::sum(success_count) / math::sum(total_count)) as success_rate,
  math::mean(alpha) as avg_alpha,
  math::mean(beta) as avg_beta
FROM composition_edge
WHERE from_activity = $activity_id
  AND (org_id = $org_id OR public = true)
GROUP BY to_activity, shape_produced
HAVING math::sum(total_count) >= $min_occurrences
ORDER BY success_rate DESC
LIMIT $limit
```

### Why It's Wrong
**SurrealDB 3.x does not support HAVING clause**. The query attempts to filter grouped composition edges by minimum total occurrences using an aggregate function in the HAVING clause.

### What It's Trying to Do
Query successor activities (children) for a given parent activity, showing which shapes are produced and consumed. Filters out edges with too few occurrences (< `$min_occurrences`, typically 1-5) to ensure statistical reliability of success rates.

This is part of the activity composition graph used for recommending which activities to chain together based on successful historical patterns.

### Error Impact
This endpoint is critical for Thompson Sampling recommendations based on activity composition. Without it, the system cannot recommend successor activities based on historical shape flow patterns.

### Workaround Strategy
Use a subquery or computed view. Since this involves aggregate functions in the HAVING clause (`math::sum(total_count)`), the workaround needs to compute the sum first, then filter.

---

## Issue #5: Wrong Table Name in GROUP ALL Query (Line 2092)

### Location
**File:** `src/routes/activities.ts`
**Line:** 2092
**Endpoint:** `GET /v2/activities/metrics/summary`

### Current Syntax
```sql
SELECT count() AS count FROM activity GROUP ALL
```

### Why It's Wrong
**The table name is incorrect.** The query uses `activity` but the correct table name is `activity_template` (as seen in schema files and other queries throughout the codebase).

There is no table called `activity` in the SurrealDB schema. This appears to be:
1. Either a typo/copy-paste error
2. Or referencing an old table name from a previous schema version

### What It's Trying to Do
Count the total number of activity templates in the system for the metrics summary dashboard.

### Error Impact
This query will fail with a table-not-found error, breaking the `/metrics/summary` endpoint which provides high-level system statistics.

### Workaround Strategy
Simple fix: Change `activity` to `activity_template`.

---

## Additional Context: GROUP ALL Syntax

Throughout the file, `GROUP ALL` is used correctly in multiple places:

```sql
-- Line 2103 (correct)
FROM activity_execution_traces GROUP ALL

-- Line 2175 (correct)
FROM activity_execution_traces WHERE activity_id = $activity_id GROUP ALL

-- Line 2204 (correct)
FROM activity_execution_task_result WHERE activity_id = $activity_id GROUP ALL

-- Line 2288 (correct)
FROM activity_execution_traces WHERE activity_id = $template_id GROUP ALL

-- Line 2386 (correct)
FROM activity_execution_traces GROUP ALL

-- Line 2400 (correct - but wrong table)
FROM activity_template GROUP ALL

-- Line 2407 (correct)
FROM activity_execution_traces GROUP ALL
```

**Note:** `GROUP ALL` is SurrealDB syntax for aggregating all rows into a single result (equivalent to SQL's aggregate functions without GROUP BY). This is correct and should not be changed.

---

## SurrealDB Version Notes

### Client vs Server Version Mismatch
- **Client:** Using `surrealdb@2.0.3` (Node.js client library)
- **Server:** Targeting SurrealDB 3.x (per documentation and comments)

The client library version may not matter for query syntax, as the queries are sent as strings to the server. The server's SQL parser determines what syntax is valid.

### SurrealDB 3.x Limitations
Based on schema comments and documentation in the codebase:

```typescript
// From sql/schemas/021-paradigm-computed-views-v3.surql
// SurrealDB 3.0 Compatibility Notes:
// - Cannot use CASE expressions in views
// - Limited JOIN support in views
// - count(boolean_expr) counts truthy results (not standard SQL)
```

```typescript
// From sql/schemas/025-validation-traces.surql
-- This would be a computed view in future SurrealDB versions
-- FROM api_validation_trace
-- WHERE timestamp > time::now() - 24h
-- GROUP BY field_path, error_code
-- HAVING frequency >= 3  // COMMENTED OUT - NOT SUPPORTED
-- ORDER BY frequency DESC
```

The schema files explicitly comment out HAVING clauses as "not supported", confirming this is a known limitation.

---

## Summary Table

| Issue # | Line | Endpoint | Problem | Impact |
|---------|------|----------|---------|--------|
| 1 | 2432 | `/metrics/aggregate` | HAVING clause (execution_count >= 3) | Query fails, breaks top templates ranking |
| 2 | 4479 | `/composition/impulse-success` | HAVING clause (count() >= $min_count) | Query fails, breaks impulse flow analysis |
| 3 | 4491 | `/composition/impulse-success` | HAVING clause in count query | Pagination breaks |
| 4 | 4837 | `/composition/edges/successors` | HAVING clause (math::sum >= $min_occurrences) | Query fails, breaks composition recommendations |
| 5 | 2092 | `/metrics/summary` | Wrong table name (activity vs activity_template) | Query fails, breaks metrics summary |

---

## Next Steps

1. **DO NOT FIX YET** - This is a documentation-only report per user instructions
2. Prioritize fixes by endpoint criticality:
   - **High:** `/metrics/aggregate`, `/composition/edges/successors` (used by Thompson Sampling)
   - **Medium:** `/composition/impulse-success` (learning system)
   - **Low:** `/metrics/summary` (observability only)
3. Consider creating computed views or functions in SurrealDB to handle filtering logic
4. Add integration tests that actually execute these queries to catch syntax errors earlier
5. Review all other queries in the codebase for similar HAVING clause usage

---

## References

- **SurrealDB Documentation:** https://surrealdb.com/docs/surrealql/statements/select
- **Schema Files:** `sql/schemas/*.surql` (contain SurrealDB 3.x compatibility notes)
- **Migration 069:** `sql/migrations/069-paradigm-compat-views.surql` (shows GROUP BY patterns without HAVING)
