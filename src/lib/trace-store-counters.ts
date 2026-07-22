/**
 * trace_store_counters — O(1) row-count bookkeeping for the authoritative
 * `execution` store.
 *
 * Part of openspec/changes/2026-07-08-substrate-self-managed-db-reconciliation.
 * `SELECT count() FROM execution GROUP ALL` is a full-table scan — never do
 * that on a hot path. Instead, both execution insert sites
 * (src/routes/execution-traces.ts, src/routes/activities.ts) call
 * `incrementTraceStoreCounter()` once per insert and the retention sweep calls
 * `decrementTraceStoreCounter()` once per prune; the observer and `/metrics/db`
 * read the single counters row instead of counting `execution`. A coarse
 * `reconcileTraceStoreCounterToExecution()` snaps the row back to the real
 * count to correct accumulated drift (see below).
 *
 * Fire-and-forget by contract: callers MUST NOT `await` this in the trace
 * insert's critical path — a counter-write failure must never block trace
 * storage. Root path (`surrealDB.query`), never `queryWithAuth` — this is
 * substrate-internal bookkeeping, not tenant data (see CLAUDE.md SurrealDB
 * constraint #2).
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';

export const TRACE_STORE_COUNTER_ID = 'trace_store_counters:execution';

/**
 * Increment the activity_execution_traces row counter by 1. UPSERT semantics
 * so the first insert after migration 156 (no seed row) still succeeds.
 * Never throws — logs a warning on failure and returns.
 */
export async function incrementTraceStoreCounter(): Promise<void> {
  // Opportunistic baseline reconcile to the REAL `execution` count. Fires at
  // most once per RECONCILE_INTERVAL_MS (and on the first increment after boot,
  // seeding the row), detached — the increment below stays O(1).
  maybeReconcile();
  try {
    // Null-coalescing accumulation (matches llm_router_decisions /
    // src/routes/llm-router.ts): correct on both the first-ever write (no
    // seed row per migration 156 — `row_count` reads as NONE, coalesces to 0)
    // and every subsequent UPSERT, and is safe under concurrent writers.
    await surrealDB.query(
      `UPSERT ${TRACE_STORE_COUNTER_ID} SET
         table_name = 'execution',
         row_count = (row_count ?? 0) + 1`,
    );
  } catch (err: any) {
    logger.warn('trace_store_counters increment failed (non-blocking)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Decrement the row counter by `n` after a retention prune of the authoritative
 * `execution` store (src/services/trace-retention.ts). Clamped at 0 WITHOUT
 * math::* (unreliable on this deployment — see trace-retention.ts header) via an
 * IF/ELSE guard. Same root-path, fire-and-forget, never-throws contract as the
 * increment.
 */
export async function decrementTraceStoreCounter(n: number): Promise<void> {
  if (!Number.isFinite(n) || n <= 0) return;
  try {
    await surrealDB.query(
      `UPSERT ${TRACE_STORE_COUNTER_ID} SET
         row_count = IF ((row_count ?? 0) - $n) < 0 THEN 0 ELSE (row_count ?? 0) - $n END`,
      { n },
    );
  } catch (err: any) {
    logger.warn('trace_store_counters decrement failed (non-blocking)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Baseline reconcile — snap the counter to the REAL `execution` row count.
//
// The per-insert increment / per-prune decrement keep the counter O(1) and
// accurate between reconciles; this corrects accumulated drift (a failed insert
// that still incremented, a missed decrement, a stale op that clobbered the row)
// and seeds the row on first use. It is NEVER on the per-write path:
// incrementTraceStoreCounter fires it at most once per RECONCILE_INTERVAL_MS,
// detached and fire-and-forget. `SELECT count() ... GROUP ALL` is a full scan,
// so keep the cadence coarse.
// ---------------------------------------------------------------------------
const RECONCILE_INTERVAL_MS = 30 * 60_000;
let lastReconcileAt = 0;
let reconcileInFlight = false;

/**
 * Overwrite the counter's row_count with the authoritative `execution` count.
 * Root-path, never-throws, safe to call detached. Exported so a boot hook or
 * timer can also invoke it directly; the increment path already calls it via
 * `maybeReconcile()`.
 */
export async function reconcileTraceStoreCounterToExecution(): Promise<void> {
  if (reconcileInFlight) return;
  reconcileInFlight = true;
  try {
    const rows = await surrealDB.query<any>(
      `SELECT count() AS c FROM execution GROUP ALL`,
    );
    const row = (Array.isArray(rows) ? rows : [])[0];
    const c = row && typeof row.c === 'number' ? row.c : null;
    if (c === null) return;
    await surrealDB.query(
      `UPSERT ${TRACE_STORE_COUNTER_ID} SET
         table_name = 'execution',
         row_count = $c,
         last_reconciled_at = time::now()`,
      { c },
    );
  } catch (err: any) {
    logger.warn('trace_store_counters reconcile failed (non-blocking)', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    reconcileInFlight = false;
  }
}

function maybeReconcile(): void {
  const now = Date.now();
  if (now - lastReconcileAt < RECONCILE_INTERVAL_MS) return;
  lastReconcileAt = now;
  void reconcileTraceStoreCounterToExecution();
}
