-- Migration 078: Register upkeep activity templates
-- Date: 2026-04-22
-- Purpose: First upkeep activity that exercises the destructive resolver
--          surface added in migrations 077 + the _delete/_update/_deprecate
--          resolvers. Designed to later become a boredom task; for now it's
--          the end-to-end test case validating that activities can perform
--          maintenance entirely through impulse resolution.

-- Template: cleanup-stale-traces-v1
-- Invokes: executionTraceList (read) -> activityExecutionTrace_delete (destructive)
-- Audit:   emits upkeepAuditLog via the delete resolver
-- Gating:  RBAC enforced at SurrealDB PERMISSIONS (admin role required for DELETE
--          on activity_execution_traces per migration 074).
INSERT INTO activity_template {
  variant_id: "cleanup-stale-traces-v1",
  activity_id: "cleanup-stale-traces",
  variant_name: "Cleanup Stale Execution Traces v1",
  description: "Prune execution traces older than a threshold. Defaults to dryRun=true so callers must explicitly opt into deletion. Emits an upkeepAuditLog impulse recording what was pruned.",
  category: "upkeep",
  tags: ["upkeep.cleanup.traces", "upkeep", "destructive", "bootstrap.primordial"],
  task_steps: [
    {
      id: "identify-candidates",
      description: "Resolve executionTraceList with filter derived from olderThanDays/successFilter/maxRows. Produces a stale_traces_candidates impulse listing matching trace ids without mutation."
    },
    {
      id: "decide-dryrun",
      description: "If dryRun is true, skip the destructive step and return a cleanup_report impulse with candidate count and 0 deleted. If false, proceed to task 3."
    },
    {
      id: "execute-delete",
      description: "Resolve activityExecutionTrace_delete with the same filter and dryRun=false. Resolver performs the DELETE at the DB layer (SurrealDB PERMISSIONS enforces admin role) and emits an upkeepAuditLog impulse referencing the deleted ids."
    },
    {
      id: "emit-report",
      description: "Compose the final cleanup_report impulse: candidate count, deleted count, auditImpulseId, duration. This is the output the caller consumes."
    }
  ],
  scope: "global",
  org_id: "00000000-0000-0000-0000-000000000000",
  project_id: NONE,
  genealogy: {
    primordial: true,
    bootstrap: true,
    level: 0,
    extracted: false,
    author: "system",
    purpose: "upkeep"
  },
  created_at: time::now(),
  updated_at: time::now()
};

-- Seed Thompson Sampling priors so Thompson Sampling can recommend this
-- template once it's been picked at least once (neutral Beta(1,1) prior).
INSERT INTO variant_performance_metrics {
  variant_id: "cleanup-stale-traces-v1",
  activity_id: "cleanup-stale-traces",
  org_id: "00000000-0000-0000-0000-000000000000",
  total_executions: 0,
  successful_executions: 0,
  failed_executions: 0,
  success_rate: 0.0,
  thompson_alpha: 1.0,
  thompson_beta: 1.0,
  total_selections: 0,
  avg_duration_ms: 0.0,
  avg_cost_usd: 0.0,
  created_at: time::now(),
  updated_at: time::now()
};

-- ============================================================================
-- Verification
-- ============================================================================
-- SELECT variant_id, category, tags FROM activity_template
--   WHERE variant_id = 'cleanup-stale-traces-v1';
-- SELECT variant_id, thompson_alpha, thompson_beta FROM variant_performance_metrics
--   WHERE variant_id = 'cleanup-stale-traces-v1';
