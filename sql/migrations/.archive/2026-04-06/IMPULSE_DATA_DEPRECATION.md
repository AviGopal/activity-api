# Impulse Data Table Deprecation Guide (R004)

## Overview

The `impulse_data` table (defined in `013-impulse-tool-usage.surql`) is **DEPRECATED** in favor of the new paradigm-aligned `impulse` table (defined in `020-paradigm-core-tables.surql`).

This document provides guidance for migrating from the legacy schema to the new canonical schema.

## Why the Change?

The `impulse` table aligns with the core paradigm defined in `IMPULSE_ACTIVITY_FOUNDATION.md`:

1. **Consistent Identity**: Uses `id` instead of `impulse_id` for record identity
2. **Paradigm Alignment**: Uses `pointer` + `shape` pattern consistent with activity/execution tables
3. **Cleaner RBAC**: Uses `org_id` directly, removes deprecated `api_key` field
4. **Reduced Redundancy**: Removes fields that can be derived or tracked elsewhere
5. **Better Integration**: Designed to work with `activity`, `execution`, and `vessel` tables

## Field Mapping

| impulse_data (legacy)   | impulse (new)           | Notes |
|-------------------------|-------------------------|-------|
| `impulse_id`            | `id`                    | Record identity |
| `impulse_data` (object) | `pointer` + `content` + `metadata` | Split into semantic parts |
| `impulse_type`          | `pointer.type` / `shape` | `shape` for activity matching, `pointer.type` for resolution |
| `budget`                | *(tracked elsewhere)*   | Move to `impulse_usage_history` or activity config |
| `priority`              | *(tracked elsewhere)*   | Move to `impulse_usage_history` or activity config |
| `loaded`                | *(derived)*             | Derived: `content != null` |
| `size_bytes`            | `metadata.size_bytes`   | Optional, in metadata |
| `token_count`           | `token_estimate`        | Renamed for clarity |
| `usage_count`           | *(query history)*       | Query `impulse_usage_history` instead |
| `last_used_at`          | *(query history)*       | Query `impulse_usage_history` instead |
| `expires_at`            | `expires_at`            | Same |
| `created_at`            | `created_at`            | Same |
| `updated_at`            | *(removed)*             | Not needed - impulses are typically immutable |
| `org_id`                | `org_id`                | Same |
| `project_id`            | `project_id`            | Same |
| `created_by`            | `created_by`            | Same |
| `api_key`               | *(REMOVED)*             | Use `org_id` for isolation |
| `pointer` (optional)    | `pointer`               | Now required, not optional |
| `content` (optional)    | `content`               | Same |
| *(none)*                | `shape`                 | NEW: Semantic type for activity matching |
| *(none)*                | `summary`               | NEW: Human-readable description |
| *(none)*                | `vessel_id`             | NEW: Vessel that created this impulse |

## Migration Strategy

### Phase 1: Dual-Write (Current)

Both tables exist. New code should:
- **Read**: Try `impulse` table first, fall back to `impulse_data`
- **Write**: Write to both tables during transition

This is partially implemented in `POST /v2/impulses/resolve` which tries the new `execution` table before falling back to `activity_execution_traces`.

### Phase 2: Migration Script

Run a one-time migration to copy data from `impulse_data` to `impulse`:

```surql
-- Migration script (run once, adjust as needed)
-- Note: Test in non-production first!

LET $migrated = (
  SELECT
    impulse_id AS id,
    {
      type: impulse_type,
      -- Additional pointer fields from impulse_data object
      ...impulse_data.pointer
    } AS pointer,
    impulse_type AS shape,  -- Or derive from impulse_data context
    impulse_data.summary AS summary,
    token_count AS token_estimate,
    content,
    org_id,
    project_id,
    created_by,
    created_at,
    expires_at,
    impulse_data AS metadata  -- Preserve original data
  FROM impulse_data
  WHERE impulse_id NOT IN (SELECT id FROM impulse)
);

FOR $record IN $migrated {
  CREATE impulse CONTENT $record;
};
```

### Phase 3: Update Application Code

Update all routes in `repos/metabob-activity-api/src/routes/impulses.ts`:

1. **POST /v2/impulses** - Create in `impulse` table with new schema
2. **GET /v2/impulses/:id** - Query from `impulse` table using `id`
3. **GET /v2/impulses** - List from `impulse` table with RBAC filtering
4. **POST /v2/impulses/:id/usage** - Update `impulse_usage_history` only

Search for `TODO [R004-MIGRATION]` comments in the codebase to find all affected locations.

### Phase 4: Deprecation Period

Keep `impulse_data` table for backward compatibility with:
- Older MiniBob versions
- External integrations using the legacy API

During this period:
- Log warnings when `impulse_data` is accessed
- Provide clear migration errors/documentation

### Phase 5: Removal

After sufficient migration period (suggest: 2-3 release cycles):
1. Remove `impulse_data` table definition from `013-impulse-tool-usage.surql`
2. Remove fallback code from application layer
3. Archive or drop the table data

## Verification Steps

Before considering migration complete:

1. **Data Integrity**: All impulses from `impulse_data` exist in `impulse`
   ```surql
   SELECT count() FROM impulse_data WHERE impulse_id NOT IN (SELECT id FROM impulse);
   -- Should return 0
   ```

2. **API Compatibility**: All endpoints work with new schema
   ```bash
   # Test create
   curl -X POST http://api.minibob.local/v2/impulses -d '{...}'

   # Test retrieve
   curl http://api.minibob.local/v2/impulses/{id}?project_id={pid}

   # Test list
   curl http://api.minibob.local/v2/impulses?project_id={pid}
   ```

3. **Usage Tracking**: `impulse_usage_history` records properly reference impulses
   ```surql
   SELECT count() FROM impulse_usage_history
   WHERE impulse_id NOT IN (SELECT id FROM impulse)
     AND impulse_id NOT IN (SELECT impulse_id FROM impulse_data);
   -- Should return 0 (all usage records reference valid impulses)
   ```

4. **RBAC**: Permissions work correctly on new table
   ```surql
   -- With user auth context
   SELECT * FROM impulse WHERE org_id != $auth.org_id;
   -- Should return empty (RBAC enforced)
   ```

## Timeline Recommendation

| Phase | Target | Duration |
|-------|--------|----------|
| Phase 1: Dual-Write | Current | Ongoing |
| Phase 2: Migration Script | v1.x+1 | 1 release |
| Phase 3: Update Code | v1.x+2 | 1-2 releases |
| Phase 4: Deprecation Period | v1.x+3 to v1.x+5 | 2-3 releases |
| Phase 5: Removal | v1.x+6 | 1 release |

## Related Files

- **Legacy Schema**: `repos/metabob-activity-api/sql/schemas/013-impulse-tool-usage.surql`
- **New Schema**: `repos/metabob-activity-api/sql/schemas/020-paradigm-core-tables.surql`
- **Routes**: `repos/metabob-activity-api/src/routes/impulses.ts`
- **Foundation Doc**: `docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md`

## Questions?

Refer to `docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md` for the canonical paradigm definition that drives this migration.
