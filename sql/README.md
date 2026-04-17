# SQL Schema and Migrations

This directory contains SurrealDB schema definitions and migration scripts for the Activity API learning system.

## Directory Structure

```
sql/
├── schemas/              # Core schema definitions
│   ├── 020-paradigm-core-tables.surql    # Unified paradigm schema
│   ├── 021-paradigm-computed-views.surql # Computed views
│   ├── 022-paradigm-compat-views.surql   # Backward compatibility
│   └── 011-executions.surql              # Legacy execution schema
├── migrations/           # Incremental schema changes
│   ├── 001-*.surql      # Early migrations
│   ├── 02X-*.surql      # Paradigm alignment migrations
│   ├── 06X-*.surql      # Feature additions
│   └── 067-add-resolver-tracking.surql  # Latest migration
├── data/                 # Seed data and test fixtures
├── migrate.ts            # Migration runner script
└── README.md             # This file
```

## Schema Versions

### Current Schema: Paradigm (v2)

**Introduced:** March 2026 (Migration 020)

The paradigm schema aligns with the foundational model defined in `docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md`:

**Core Tables:**
- `activity` - Activity templates and variants
- `execution` - Execution traces with state transitions
- `impulse` - Universal data pointers
- `vessel` - Vessel registry

**Computed Views:**
- `v_activity_score` - Real-time Thompson Sampling statistics
- `v_execution_tree` - Execution composition graph
- `v_shape_execution_stats` - Shape-conditioned Thompson Sampling

### Legacy Schema: Multi-table (v1)

**Status:** Deprecated (End of Life: April 2027)

Legacy tables include:
- `activity_template` (use `activity` instead)
- `variant_performance_metrics` (use `v_activity_score` instead)
- `activity_execution_traces` (use `execution` instead)

**Migration guide:** [`docs/SCHEMA_MIGRATION_GUIDE.md`](../docs/SCHEMA_MIGRATION_GUIDE.md)

## Migration Numbering

Migrations use a 3-digit numbering scheme:

| Range | Purpose | Examples |
|-------|---------|----------|
| `001-019` | Initial schema setup | `001-init-schema.surql` |
| `020-029` | Paradigm core tables | `020-paradigm-core-tables.surql` |
| `030-049` | Multi-tenant and RBAC | `030-fix-org-id-format.surql` |
| `050-059` | Learning system enhancements | `055-add-learning-table-permissions.surql` |
| `060-069` | Pattern extraction and tracking | `062-execution-patterns.surql`, `067-add-resolver-tracking.surql` |
| `070-089` | Feature additions | (reserved) |
| `090-099` | Cleanup and optimization | (reserved) |

## Running Migrations

### Manual Migration

```bash
# Apply a specific migration
bun run migrate.ts sql/migrations/067-add-resolver-tracking.surql

# Apply all pending migrations
bun run migrate.ts
```

### Automated Migration (Kubernetes)

Migrations are applied automatically via Kubernetes Job on deployment:

```yaml
# charts/metabob-activity-api/templates/migration-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: activity-api-migration
spec:
  template:
    spec:
      containers:
      - name: migration
        command: ["bun", "run", "migrate.ts"]
```

**Note:** Migrations are idempotent (use `IF NOT EXISTS` or `OVERWRITE` where appropriate).

## Paradigm Alignment

The paradigm schema migration (020-029 series) introduced breaking changes to align with foundation principles:

**Key Changes:**
1. **Canonical field names:** `variant_id` → `id`, `variant_name` → `name`
2. **Computed metrics:** Thompson Sampling scores computed from execution data
3. **Multi-tenant by default:** RBAC enforced via SurrealDB PERMISSIONS
4. **Flexible trace structure:** JSON-like trace field for extensibility

**Migration timeline:**
- **March 2026:** Paradigm schema introduced (dual-write enabled)
- **April 2026:** Gradual rollout with `PARADIGM_READ_PERCENTAGE`
- **October 2026:** Legacy schema deprecated
- **April 2027:** Legacy schema removed (END OF LIFE)

## Schema Conventions

See [`SCHEMA_CONVENTIONS.md`](./SCHEMA_CONVENTIONS.md) for detailed conventions on:
- Table naming
- Field naming
- Index patterns
- PERMISSIONS clauses
- Multi-tenant isolation

## Feature Flags

Paradigm schema adoption is controlled via environment variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `DUAL_WRITE_ENABLED` | Write to both schemas | `true` |
| `PARADIGM_READ_ENABLED` | Read from paradigm tables | `true` |
| `PARADIGM_READ_PERCENTAGE` | Gradual rollout (0-100) | `100` |
| `PARADIGM_READ_NO_FALLBACK` | Skip legacy fallback | `false` |

**Example gradual rollout:**
```bash
# Start with 10% traffic on paradigm
PARADIGM_READ_PERCENTAGE=10

# Increase to 50%
PARADIGM_READ_PERCENTAGE=50

# Full rollout
PARADIGM_READ_PERCENTAGE=100

# Disable fallback (fail fast)
PARADIGM_READ_NO_FALLBACK=true
```

## Backward Compatibility

Compatibility views enable legacy queries during migration:

| Compat View | Maps To | Status |
|-------------|---------|--------|
| `activity_template_view` | `activity` | Until April 2027 |
| `activity_executions_view` | `execution` | Until April 2027 |

**Example:**
```sql
-- Legacy query (still works via compat view)
SELECT * FROM activity_template_view WHERE variant_id = $id

-- Equivalent paradigm query
SELECT * FROM activity WHERE id = $id
```

## Migration Examples

### Adding a New Field

```sql
-- sql/migrations/067-add-resolver-tracking.surql
-- Add resolver tracking fields to execution table

DEFINE FIELD IF NOT EXISTS resolved_by_vessel_id ON execution TYPE option<string>
  COMMENT "Vessel ID that resolved impulses for this execution";

DEFINE INDEX IF NOT EXISTS idx_execution_vessel ON execution FIELDS resolved_by_vessel_id;
```

### Creating a Computed View

```sql
-- sql/schemas/021-paradigm-computed-views.surql
-- Compute Thompson Sampling scores from execution data

DEFINE TABLE IF NOT EXISTS v_activity_score AS
  SELECT
    activity_id,
    org_id,
    count() as total_executions,
    count(IF success THEN 1 ELSE NONE END) + 1 as alpha,
    count(IF !success THEN 1 ELSE NONE END) + 1 as beta,
    avg(duration_ms) as avg_duration_ms
  FROM execution
  GROUP BY activity_id, org_id;
```

### Adding Multi-Tenant Permissions

```sql
-- All tables use org_id filtering via PERMISSIONS
DEFINE TABLE execution SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';
```

## Testing Migrations

### Local Testing

```bash
# Start local SurrealDB
docker run -p 8000:8000 surrealdb/surrealdb:v2.3.3 start

# Apply migration
SURREALDB_URL=http://localhost:8000 bun run migrate.ts

# Verify schema
surreal sql --conn http://localhost:8000 --ns activity-system --db learning_loop
INFO FOR DB;
```

### Verification Scripts

Some migrations include verification scripts:

```bash
# Example: Verify impulse budget tracking migration
bash sql/migrations/verify-065-impulse-budget-tracking.sh
```

## Troubleshooting

### Migration Fails with "Field already exists"

**Solution:** Check if migration uses `IF NOT EXISTS`:
```sql
-- Good
DEFINE FIELD IF NOT EXISTS new_field ON table TYPE string;

-- Bad (fails on re-run)
DEFINE FIELD new_field ON table TYPE string;
```

### Paradigm queries return empty results

**Solution:** Verify RBAC tokens are being used:
```typescript
// Use authenticated query
const result = await queryWithAuth(jwtToken, query, params);

// NOT: Direct query (bypasses RBAC)
const result = await db.query(query, params);
```

### Thompson Sampling scores differ between schemas

**Solution:** Paradigm schema computes scores in real-time from execution data. Run reconciliation:
```sql
-- Compare scores
SELECT
  legacy.variant_id,
  legacy.success_count as legacy_successes,
  paradigm.successes as paradigm_successes
FROM variant_performance_metrics as legacy
LEFT JOIN v_activity_score as paradigm ON legacy.variant_id = paradigm.activity_id
WHERE legacy.success_count != paradigm.successes;
```

## Related Documentation

- [`docs/SCHEMA_MIGRATION_GUIDE.md`](../docs/SCHEMA_MIGRATION_GUIDE.md) - Complete migration guide
- [`SCHEMA_CONVENTIONS.md`](./SCHEMA_CONVENTIONS.md) - Schema conventions and patterns
- [`docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md`](../../docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md) - Foundation principles
- [`docs/MULTI_TENANT_ARCHITECTURE.md`](../docs/MULTI_TENANT_ARCHITECTURE.md) - Multi-tenant patterns

## Latest Migrations

| Migration | Date | Description |
|-----------|------|-------------|
| 067 | 2026-04-16 | Add resolver tracking fields to execution table |
| 066 | 2026-04-16 | Add variant confidence tracking |
| 065 | 2026-04-16 | Add impulse budget tracking |
| 064 | 2026-04-16 | Add API key token access method |
| 063 | 2026-04-15 | Add composition edge tracking |
| 062 | 2026-04-15 | Add execution pattern learning |

For the complete migration history, see [`sql/migrations/`](./migrations/).
