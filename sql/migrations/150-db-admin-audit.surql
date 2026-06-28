-- 150-db-admin-audit.surql
--
-- db_admin resolver audit trail (shape `db_admin`, src/routes/db-admin.ts).
--
-- The db_admin resolver gives the SUBSTRATE full self-management authority over
-- its own SurrealDB at runtime (diagnose / create_index / apply_migration /
-- repair / prune). Because that is write authority over the substrate's own
-- data, EVERY invocation — dry-run AND apply — writes one accountability row
-- here. This is the audit trail for autonomous DB management: who did what,
-- what the impact was, and whether it was actually applied.
--
-- One row per resolver invocation. Never deleted by the resolver itself
-- (the prune patterns whitelist excludes this table by construction).
--
-- IF NOT EXISTS throughout so this migration is re-run safe (re-application is
-- a no-op), matching the reconcile-mode contract the resolver itself exposes.

DEFINE TABLE IF NOT EXISTS db_admin_audit SCHEMALESS;

DEFINE FIELD IF NOT EXISTS operation     ON db_admin_audit TYPE string;
DEFINE FIELD IF NOT EXISTS params        ON db_admin_audit FLEXIBLE TYPE object;
DEFINE FIELD IF NOT EXISTS pattern       ON db_admin_audit TYPE option<string>;
DEFINE FIELD IF NOT EXISTS impact_count  ON db_admin_audit TYPE option<number>;
DEFINE FIELD IF NOT EXISTS applied       ON db_admin_audit TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS actor         ON db_admin_audit TYPE option<string>;
DEFINE FIELD IF NOT EXISTS detail        ON db_admin_audit FLEXIBLE TYPE option<object>;
DEFINE FIELD IF NOT EXISTS at            ON db_admin_audit TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS idx_db_admin_audit_at        ON db_admin_audit FIELDS at;
DEFINE INDEX IF NOT EXISTS idx_db_admin_audit_operation ON db_admin_audit FIELDS operation;
