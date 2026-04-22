-- Migration 077: Register upkeepAuditLog shape
-- Date: 2026-04-22
-- Purpose: Register the upkeepAuditLog impulse shape. Destructive write
--          resolvers (activityExecutionTrace_delete, activityTemplate_update,
--          activityTemplate_deprecate) emit one of these impulses per
--          operation to record what changed, who did it, and why.
--
-- Why a shape, not a dedicated table:
--   - The impulse table already enforces org_id PERMISSIONS for tenancy
--   - Impulse expiry fields support retention policies if we later need them
--   - Audit records are data (just typed data), not a special kind of storage
--   - Keeping them in `impulse` means activities can resolve them like any
--     other learning signal (e.g. "show me last week's deletes")

INSERT INTO shape_definition {
  name: "upkeepAuditLog",
  version: "1.0.0",
  description: "Audit record for destructive upkeep operations (DELETE, UPDATE, DEPRECATE) performed via write resolvers. Emitted by the resolver as an impulse; captures operation, target rows, who performed it, and when.",
  schema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["delete", "update", "deprecate"],
        description: "Kind of destructive op performed"
      },
      target_table: {
        type: "string",
        description: "Database table affected (e.g. activity_execution_traces, activity)"
      },
      target_ids: {
        type: "array",
        items: { type: "string" },
        description: "Primary keys of affected rows"
      },
      filter_used: {
        type: "object",
        description: "Filter criteria used to select the rows (e.g. { olderThan: '2026-01-01T00:00:00Z', success: false })"
      },
      dry_run: {
        type: "boolean",
        description: "If true, no rows were modified; the audit records a preview"
      },
      count: { type: "integer", description: "Number of rows affected (or that would be affected on dryRun)" },
      performed_by: {
        type: "string",
        description: "Subject of the JWT that invoked the op — typically an API key id or user id"
      },
      org_id: { type: "string", description: "Tenant owning the op (always populated)" },
      performed_at: {
        type: "string",
        format: "date-time",
        description: "ISO timestamp of the operation"
      },
      reason: { type: "string", description: "Optional human-readable reason (used by deprecate)" },
      diff: {
        type: "object",
        description: "Optional before/after diff map (used by update operations)"
      }
    },
    required: ["operation", "target_table", "count", "performed_by", "org_id", "performed_at", "dry_run"]
  },
  example: {
    operation: "delete",
    target_table: "activity_execution_traces",
    target_ids: ["exec_old_0", "exec_old_1"],
    filter_used: { olderThan: "2026-03-01T00:00:00Z", success: false },
    dry_run: false,
    count: 2,
    performed_by: "api_key_abc",
    org_id: "org_test",
    performed_at: "2026-04-22T12:00:00Z",
    reason: "routine stale-trace cleanup"
  },
  tags: ["audit", "upkeep", "learning-loop"],
  public: true,
  org_id: null,
  deprecated: false,
  created_at: time::now()
};

-- ============================================================================
-- Verification
-- ============================================================================
-- SELECT * FROM shape_definition WHERE name = 'upkeepAuditLog';
