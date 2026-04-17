# Migration 065: Impulse Budget Tracking - Verification

## Purpose
Add budget tracking capabilities to the impulse system as per Sequence 2 requirements.

## Changes Made

### 1. Added Budget Fields to `impulse` Table
- `budget` (INT, default 10000): Total resource budget for the impulse
- `resources_consumed` (INT, default 0): Resources used during resolution
- `budget_exhausted` (BOOLEAN, default false): Whether budget was exceeded

### 2. Created `impulse_budget_log` Table
Tracks detailed budget consumption over time with the following structure:

**Core Fields:**
- `impulse_id` (string, required): Reference to impulse
- `activity_id` (string, required): Activity that consumed resources
- `execution_id` (optional string): Execution trace reference
- `budget_initial` (int): Starting budget
- `budget_consumed` (int): Resources consumed
- `budget_remaining` (int): Remaining budget (can be negative)
- `exhausted_at` (optional datetime): When budget was exhausted

**Multi-tenancy:**
- `org_id` (string, required): Organization ID for RBAC
- `project_id` (optional record): Project ID for scoping

**Metadata:**
- `created_at` (datetime): Budget consumption timestamp

### 3. Indexes Created
Single-column indexes:
- `idx_impulse_budget_log_org`: org_id
- `idx_impulse_budget_log_impulse`: impulse_id
- `idx_impulse_budget_log_activity`: activity_id
- `idx_impulse_budget_log_execution`: execution_id
- `idx_impulse_budget_log_exhausted`: exhausted_at

Composite indexes:
- `idx_impulse_budget_log_org_impulse`: (org_id, impulse_id)
- `idx_impulse_budget_log_org_activity`: (org_id, activity_id)

## Alignment with Existing Patterns

### ✅ Pattern Consistency
- Follows `062-execution-patterns.surql` for table definition
- Follows `063-composition-edges.surql` for PERMISSIONS clauses
- Uses `SCHEMAFULL` with explicit PERMISSIONS
- Includes comprehensive comments for all fields
- Provides usage examples in header comments

### ✅ RBAC Multi-tenancy
```surql
PERMISSIONS
  FOR select WHERE org_id = $auth.org_id
  FOR create WHERE $auth.org_id != NONE
  FOR update WHERE org_id = $auth.org_id
  FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin'
```

### ✅ Field Assertions
- All required fields have `ASSERT $value != NONE`
- Integer fields have `ASSERT $value >= 0`
- Default values use `VALUE $value OR <default>`

### ✅ Standard Multi-tenancy Fields
```surql
DEFINE FIELD IF NOT EXISTS org_id ON impulse_budget_log TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON impulse_budget_log TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";
```

## Sequence 2 Requirements Alignment

### Budget Tracking ✅
- ✅ Budget field added to impulse table (default 10000)
- ✅ Resources consumed tracking
- ✅ Budget exhausted flag

### Budget Logging ✅
- ✅ Detailed consumption logging per activity
- ✅ Initial/consumed/remaining budget tracking
- ✅ Exhaustion timestamp tracking

### Learning Capability ✅
The schema enables:
1. **Per-activity budget analysis**: Which activities consume most resources
2. **Optimal budget allocation**: P95 and max consumption per (activity, shape)
3. **Exhaustion pattern detection**: Activities that frequently exhaust budgets
4. **Historical trends**: Budget consumption over time

## Verification Queries

### 1. Verify Table and Field Creation
```surql
INFO FOR TABLE impulse_budget_log;
INFO FOR FIELD budget ON impulse;
INFO FOR FIELD resources_consumed ON impulse;
INFO FOR FIELD budget_exhausted ON impulse;
```

### 2. Test RBAC Permissions
```surql
-- Should work (authenticated user)
SELECT * FROM impulse_budget_log WHERE org_id = $auth.org_id LIMIT 1;

-- Should fail (different org)
SELECT * FROM impulse_budget_log WHERE org_id = 'other-org' LIMIT 1;
```

### 3. Test Budget Consumption Recording
```surql
INSERT INTO impulse_budget_log {
  impulse_id: "test-impulse-001",
  activity_id: "test-activity",
  budget_initial: 10000,
  budget_consumed: 3500,
  budget_remaining: 6500,
  org_id: $auth.org_id
};
```

### 4. Test Budget Analysis Query
```surql
SELECT activity_id,
       COUNT() as total_usages,
       math::sum(budget_consumed) as total_consumed,
       math::avg(budget_consumed) as avg_consumed
FROM impulse_budget_log
WHERE org_id = $auth.org_id
GROUP BY activity_id
ORDER BY avg_consumed DESC;
```

## Migration Safety

### Backward Compatibility ✅
- Uses `IF NOT EXISTS` for all definitions
- Adding fields to existing table is non-breaking
- New fields have default values
- No data migration required

### Rollback Strategy
If rollback is needed:
```surql
-- Remove budget fields from impulse table
REMOVE FIELD budget ON impulse;
REMOVE FIELD resources_consumed ON impulse;
REMOVE FIELD budget_exhausted ON impulse;

-- Drop budget log table
DROP TABLE impulse_budget_log;
```

## Next Steps

1. **Apply Migration**: Run this migration on canary environment
2. **Verify Schema**: Run verification queries
3. **Implement Backend Logic**: Update impulse resolver to record budget consumption
4. **Add Monitoring**: Track budget exhaustion rates
5. **Learning Integration**: Use budget logs for optimal budget allocation

## Related Files

- Migration file: `/repos/metabob-activity-api/sql/migrations/065-impulse-budget-tracking.surql`
- Impulse table definition: `/repos/metabob-activity-api/sql/schemas/020-paradigm-core-tables.surql`
- Usage tracking: `/repos/metabob-activity-api/sql/schemas/013-impulse-tool-usage.surql`
- Pattern reference: `/repos/metabob-activity-api/sql/migrations/062-execution-patterns.surql`
