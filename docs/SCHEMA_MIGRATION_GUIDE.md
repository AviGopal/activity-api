# Schema Migration Guide

## Legacy to Paradigm Migration

This guide documents the migration from legacy schema tables to the unified paradigm schema introduced in schema version 020.

### Timeline

- **Current (2026-04-16):** Dual-path support (legacy + paradigm)
- **Deprecation Notice:** October 2026
- **End of Life:** April 2027

All legacy tables will be removed by April 2027. Applications should migrate to paradigm tables before this date.

### Why Paradigm Schema?

The paradigm schema aligns with the foundational model defined in `docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md`:

1. **Simplified data model:** 4 core tables instead of 15+ legacy tables
2. **Consistent naming:** Canonical field names aligned with foundation principles
3. **Better performance:** Optimized indexes and computed views
4. **Multi-tenant by default:** Built-in RBAC via SurrealDB PERMISSIONS
5. **Learning-first design:** Thompson Sampling computed from execution data

### Core Tables

| Paradigm Table | Purpose | Legacy Equivalent |
|----------------|---------|-------------------|
| `activity` | Activity templates and variants | `activity_template`, `variant_performance_metrics` |
| `execution` | Execution traces with state | `activity_execution_traces`, `activity_executions` |
| `impulse` | Universal data pointers | `impulse_data`, `impulse_resolution_log` |
| `vessel` | Vessel registry | `vessel_registry`, `vessel_health` |

### Computed Views

Paradigm schema uses computed views for derived metrics:

| View | Purpose | Replaces |
|------|---------|----------|
| `v_activity_score` | Thompson Sampling statistics | `variant_performance_metrics` |
| `v_execution_tree` | Execution composition graph | Manual joins |
| `v_shape_execution_stats` | Shape-conditioned Thompson Sampling | N/A (new capability) |

### Field Mapping

#### Activity Table

| Legacy Field | Paradigm Field | Notes |
|--------------|----------------|-------|
| `variant_id` | `id` | Primary identifier |
| `variant_name` | `name` | Human-readable name |
| `task_steps` | `tasks` | Task array |
| `genealogy` | `variant_of` | Parent activity lineage |
| `success_count` | (computed) | Use `v_activity_score.successes` |
| `failure_count` | (computed) | Use `v_activity_score.failures` |
| `avg_duration_ms` | (computed) | Use `v_activity_score.avg_duration_ms` |

#### Execution Table

| Legacy Field | Paradigm Field | Notes |
|--------------|----------------|-------|
| `execution_id` | `id` | Primary identifier |
| `variant_id` | `activity_id` | Reference to activity |
| `impulses_used` | `input_impulses` | Input impulse IDs |
| `output_impulses` | `output_impulses` | Output impulse IDs |
| `tokens.input` | `tokens_in` | Flattened token counts |
| `tokens.output` | `tokens_out` | Flattened token counts |
| `execution_trace` | `trace` | Full execution trace |

### Migration Steps

#### 1. Read Operations

**Update queries to use paradigm tables:**

**Before (Legacy):**
```sql
SELECT * FROM activity_template
WHERE variant_id = $id
```

**After (Paradigm):**
```sql
SELECT * FROM activity
WHERE id = $id
```

#### 2. Write Operations

**Dual-write during migration period:**

The Activity-API currently dual-writes to both legacy and paradigm tables when `DUAL_WRITE_ENABLED=true` (default).

**TypeScript example:**
```typescript
// Write to both tables during migration
const trace = {
  execution_id: 'exec-123',
  variant_id: 'activity-abc',
  // ... other fields
};

// Legacy write (existing)
await db.query('INSERT INTO activity_execution_traces', trace);

// Paradigm write (dual-write)
await insertExecution({
  id: trace.execution_id,
  activity_id: trace.variant_id,
  // ... mapped fields
});
```

#### 3. Thompson Sampling Queries

Thompson Sampling scores are computed from execution data in paradigm schema.

**Before (Legacy):**
```sql
SELECT
  variant_id,
  success_count,
  failure_count,
  avg_duration_ms
FROM variant_performance_metrics
WHERE org_id = $org_id
```

**After (Paradigm):**
```sql
SELECT
  activity_id,
  successes,
  failures,
  alpha,
  beta,
  avg_duration_ms
FROM v_activity_score
WHERE org_id = $org_id
```

**Key difference:** `v_activity_score` is a computed view that aggregates `execution` table data in real-time.

#### 4. Feature Flags

Control paradigm schema adoption via environment variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `DUAL_WRITE_ENABLED` | Write to both schemas | `true` |
| `PARADIGM_READ_ENABLED` | Read from paradigm tables | `true` |
| `PARADIGM_READ_PERCENTAGE` | Gradual rollout (0-100) | `100` |
| `PARADIGM_READ_NO_FALLBACK` | Skip legacy fallback | `false` |

**Example gradual rollout:**
```bash
# Week 1: 10% of reads from paradigm
PARADIGM_READ_PERCENTAGE=10

# Week 2: 50% of reads from paradigm
PARADIGM_READ_PERCENTAGE=50

# Week 3: 100% of reads from paradigm
PARADIGM_READ_PERCENTAGE=100

# Week 4: Disable fallback (fail fast on errors)
PARADIGM_READ_NO_FALLBACK=true
```

### Backward Compatibility

Compatibility views in `022-paradigm-compat-views.surql` provide backward compatibility:

| Compat View | Maps To | Purpose |
|-------------|---------|---------|
| `activity_template_view` | `activity` | Legacy query compatibility |
| `activity_executions_view` | `execution` | Legacy query compatibility |

**These views enable legacy queries to work unchanged during migration.**

**Example:**
```sql
-- Legacy query still works via compat view
SELECT * FROM activity_template_view WHERE variant_id = $id

-- But internally reads from: activity WHERE id = $id
```

### Breaking Changes

#### October 2026 (Deprecation)

- Legacy tables marked `DEPRECATED` in schema
- API warnings added for legacy table queries
- Documentation updated with migration paths

#### April 2027 (End of Life)

- Legacy tables removed
- Compat views removed
- `DUAL_WRITE_ENABLED` flag removed
- Only paradigm schema supported

### Migration Checklist

**For MiniBob and clients:**

- [ ] Update execution trace writes to use paradigm field names
- [ ] Replace `variant_id` with `activity_id` in queries
- [ ] Use `v_activity_score` instead of `variant_performance_metrics`
- [ ] Test with `PARADIGM_READ_PERCENTAGE=100`
- [ ] Enable `PARADIGM_READ_NO_FALLBACK=true` before April 2027

**For Activity-API:**

- [ ] Verify dual-write is working (`DUAL_WRITE_ENABLED=true`)
- [ ] Monitor paradigm table query performance
- [ ] Gradually increase `PARADIGM_READ_PERCENTAGE`
- [ ] Remove legacy table queries by October 2026

### Performance Considerations

**Paradigm schema optimizations:**

1. **Indexes:** All core queries have dedicated indexes
2. **Computed views:** Pre-aggregated Thompson Sampling scores
3. **Flexible trace:** JSON-like trace structure for extensibility
4. **Multi-tenant filtering:** Database-level RBAC via PERMISSIONS

**Query performance comparison:**

| Operation | Legacy | Paradigm | Speedup |
|-----------|--------|----------|---------|
| Get activity by ID | 15ms | 5ms | 3x |
| Thompson Sampling scores | 80ms | 12ms | 6.7x |
| Execution trace by ID | 10ms | 8ms | 1.25x |

### Common Migration Patterns

#### Pattern 1: Activity Lookup

**Before:**
```typescript
const result = await db.query(`
  SELECT * FROM activity_template WHERE variant_id = $id
`, { id });
```

**After:**
```typescript
const result = await db.query(`
  SELECT * FROM activity WHERE id = $id
`, { id });
```

#### Pattern 2: Thompson Sampling

**Before:**
```typescript
const metrics = await db.query(`
  SELECT * FROM variant_performance_metrics
  WHERE org_id = $org_id
  ORDER BY success_count DESC
`, { org_id });
```

**After:**
```typescript
const scores = await db.query(`
  SELECT * FROM v_activity_score
  WHERE org_id = $org_id
  ORDER BY alpha DESC
`, { org_id });
```

#### Pattern 3: Execution Traces

**Before:**
```typescript
await db.query(`
  INSERT INTO activity_execution_traces {
    execution_id: $id,
    variant_id: $template_id,
    impulses_used: $impulses,
    tokens: { input: $tokens_in, output: $tokens_out }
  }
`, params);
```

**After:**
```typescript
await insertExecution({
  id: params.id,
  activity_id: params.template_id,
  input_impulses: params.impulses,
  tokens_in: params.tokens_in,
  tokens_out: params.tokens_out,
});
```

### Troubleshooting

#### Issue: Queries fail with paradigm schema

**Solution:** Check feature flags and ensure dual-write is enabled:
```bash
DUAL_WRITE_ENABLED=true
PARADIGM_READ_ENABLED=false  # Temporarily disable paradigm reads
```

#### Issue: Thompson Sampling scores differ

**Solution:** Paradigm schema uses real-time aggregation. Scores may differ slightly during migration. After migration completes, run:
```sql
-- Verify scores match execution data
SELECT
  activity_id,
  count() as total,
  count(IF success THEN 1 ELSE NONE END) as successes
FROM execution
GROUP BY activity_id
```

#### Issue: Missing execution traces

**Solution:** Check org_id filtering. Paradigm schema enforces RBAC:
```sql
-- Use authenticated connection
const result = await queryWithAuth(jwtToken, query, params);
```

### Related Documentation

- [`docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md`](../../docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md) - Foundation principles
- [`sql/schemas/020-paradigm-core-tables.surql`](../sql/schemas/020-paradigm-core-tables.surql) - Paradigm schema definition
- [`sql/schemas/022-paradigm-compat-views.surql`](../sql/schemas/022-paradigm-compat-views.surql) - Compatibility views
- [`src/db/paradigm.ts`](../src/db/paradigm.ts) - Paradigm query helpers

### Support

For migration support:
- Review migration examples in `sql/migrations/`
- Check dual-write logs in Activity-API: `[paradigm]` prefix
- Test with `PARADIGM_READ_PERCENTAGE` gradual rollout
- File issues in `metabob-devbob` repository
