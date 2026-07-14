#!/usr/bin/env bash
# backfill-aet-to-execution.sh — reconcile the canonical `execution` table with
# activity_execution_traces (AET) on ONE activity-api instance.
#
# WHY THIS EXISTS: dual-write into `execution` only began capturing reliably
# after the root-path persistence fix. Before that, `execution` was a sparse,
# lossy subset of AET. This script backfills every AET row that lacks an
# `execution` counterpart, so `execution` becomes a complete mirror of AET and
# readers can be repointed to the execution-backed compat view without
# regressing the learning signal.
#
# WHY A SCRIPT, NOT A MIGRATION: a single bulk INSERT...SELECT contends with the
# live dual-write path (SurrealDB optimistic concurrency -> "read or write
# conflict"), so it must be applied in small batches WITH retry. That control
# flow does not fit an init-database .surql migration. It is also a one-time,
# per-instance data reconciliation, not a schema change.
#
# SAFE / IDEMPOTENT: only inserts AET rows whose bare id is not already an
# `execution` record; re-run until it reports missing=0. Backfilled rows are
# tagged origin_substrate_id='BACKFILL-AET'. Does NOT normalize activity_id:
# composition activities are thing-format ("activity:⟨…⟩") in BOTH AET and
# `execution`, so the compat view must mirror AET verbatim.
#
# The materialized compat view is dropped for the duration (no reader depends on
# it yet) so 12k inserts do not each pay view-maintenance cost, then rebuilt.
#
# Env: SURREALDB_URL, SURREALDB_NAMESPACE, SURREALDB_DATABASE,
#      SURREALDB_USERNAME, SURREALDB_PASSWORD  (falls back to /etc/substrate/env)
# Usage (inside the vessel container):
#   sh scripts/backfill-aet-to-execution.sh
set -u

[ -f /etc/substrate/env ] && { set -a; . /etc/substrate/env 2>/dev/null; set +a; }
U="${SURREALDB_USERNAME:-root}"; P="${SURREALDB_PASSWORD:-changeme}"
NS="${SURREALDB_NAMESPACE:-activity-system}"; DB="${SURREALDB_DATABASE:-learning_loop}"
URL="${SURREALDB_URL:-http://localhost:8000}"
BATCH="${BATCH_SIZE:-250}"
MAXB="${MAX_BATCHES:-200}"

q(){ curl -s -m 90 -X POST "$URL/sql" -H "Accept: application/json" \
      -H "surreal-ns: $NS" -H "surreal-db: $DB" -u "$U:$P" "$@"; }
num(){ echo "$1" | grep -oE '"count":[0-9]+' | head -1 | grep -oE '[0-9]+'; }
miss(){ num "$(q -d "LET \$h=(SELECT VALUE meta::id(id) FROM execution); SELECT count() FROM activity_execution_traces WHERE execution_id NOT IN \$h GROUP ALL;")"; }

BATCH_SQL=$(cat <<SQL
USE NS \`$NS\` DB \`$DB\`;
LET \$have = (SELECT VALUE meta::id(id) FROM execution);
INSERT INTO execution (
  SELECT
    type::thing('execution', execution_id) AS id,
    activity_id, variant_id, success, status, duration_ms, cost_usd,
    tokens_input AS tokens_in, tokens_output AS tokens_out,
    (impulses_used ?? []) AS input_impulses, [] AS output_impulses,
    { tasks: (tasks ?? []), state_snapshot: {} } AS trace,
    (IF error_message { { message: error_message, type: error_type, task_id: failed_task_id } } ELSE { NONE }) AS error,
    signature, signature_version, repair_signature, failure_mode, correlation_id,
    component_changes, composition_chain, improvisation,
    input_impulse_shapes, output_impulse_shapes, metadata, tags,
    org_id, project_id, vessel_id, vessel_version, parent_execution_id,
    executed_at, created_at,
    'BACKFILL-AET' AS origin_substrate_id, 'aet-backfill' AS origin_instance, 0 AS version
  FROM activity_execution_traces
  WHERE execution_id NOT IN \$have
  LIMIT $BATCH
) RETURN NONE;
SQL
)

echo "[backfill] dropping compat view during backfill"
q -d "REMOVE TABLE IF EXISTS v_paradigm_execution_traces;" >/dev/null
M=$(miss); echo "[backfill] start missing=${M:-0}"
B=0
while [ "${M:-0}" -gt 0 ] && [ "$B" -lt "$MAXB" ]; do
  B=$((B+1)); TRY=0
  while [ "$TRY" -lt 20 ]; do
    TRY=$((TRY+1))
    R=$(printf '%s' "$BATCH_SQL" | q --data-binary @-)
    echo "$R" | grep -qi 'conflict' && { sleep 1; continue; }
    echo "$R" | grep -q '"status":"ERR"' && { echo "[backfill] b=$B ERR $(echo "$R"|head -c 160)"; break; }
    break
  done
  [ $((B % 8)) -eq 0 ] && { M=$(miss); echo "[backfill] b=$B missing=${M:-?}"; }
done
M=$(miss); echo "[backfill] drained missing=${M:-?}"

echo "[backfill] rebuilding compat view (migration 158) + execution_id index"
# The view was dropped for the backfill; rebuild it over the now-complete
# execution table and (re)create the bare-id point-lookup index.
VIEW158="$(dirname "$0")/../sql/migrations/158-extend-paradigm-exec-view.surql"
if [ -f "$VIEW158" ]; then
  q --data-binary @"$VIEW158" >/dev/null
else
  echo "[backfill] WARN 158 migration not found at $VIEW158 — apply it manually to rebuild the view"
fi
q -d "DEFINE INDEX IF NOT EXISTS idx_vpet_execution_id ON v_paradigm_execution_traces FIELDS execution_id;" >/dev/null

echo "[backfill] FINAL exec=$(num "$(q -d "SELECT count() FROM execution GROUP ALL;")") view=$(num "$(q -d "SELECT count() FROM v_paradigm_execution_traces GROUP ALL;")") aet=$(num "$(q -d "SELECT count() FROM activity_execution_traces GROUP ALL;")") missing=${M:-?}"
