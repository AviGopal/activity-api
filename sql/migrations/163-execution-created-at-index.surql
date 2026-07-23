-- =============================================================================
-- 163 — idx_execution_created_at (RETIRED → REMOVE)
--
-- RETIRED. Formerly DEFINEd `idx_execution_created_at ON execution FIELDS
-- created_at`. It is maintained on EVERY insert to the >1M-row, high-write
-- `execution` table but NO runtime query filters/orders execution by created_at
-- (every created_at ORDER BY/WHERE in src targets activity/impulse/
-- goal_execution_paths/activity_template). Pure write cost, no reader. Converted
-- to REMOVE so the db-maintenance reconcile retires it durably. Idempotent.
-- =============================================================================

REMOVE INDEX IF EXISTS idx_execution_created_at ON execution;
