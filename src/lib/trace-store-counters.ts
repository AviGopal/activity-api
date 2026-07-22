/**
 * trace_store_counters — O(1) row-count bookkeeping for
 * activity_execution_traces (AET).
 *
 * Part of openspec/changes/2026-07-08-substrate-self-managed-db-reconciliation.
 * `SELECT count() FROM activity_execution_traces GROUP ALL` is a full-table
 * scan (86.5s measured at 218K rows) — never do that on a hot path. Instead,
 * both AET insert sites (src/routes/execution-traces.ts,
 * src/routes/activities.ts) call `incrementTraceStoreCounter()` once per
 * successful insert; the observer and the `db_admin reconcile_trace_store`
 * op read the single counters row instead of counting AET.
 *
 * Fire-and-forget by contract: callers MUST NOT `await` this in the trace
 * insert's critical path — a counter-write failure must never block trace
 * storage. Root path (`surrealDB.query`), never `queryWithAuth` — this is
 * substrate-internal bookkeeping, not tenant data (see CLAUDE.md SurrealDB
 * constraint #2).
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';

export const TRACE_STORE_COUNTER_ID = 'trace_store_counters:activity_execution_traces';

/**
 * Increment the activity_execution_traces row counter by 1. UPSERT semantics
 * so the first insert after migration 156 (no seed row) still succeeds.
 * Never throws — logs a warning on failure and returns.
 */
export async function incrementTraceStoreCounter(): Promise<void> {
  try {
    // Null-coalescing accumulation (matches llm_router_decisions /
    // src/routes/llm-router.ts): correct on both the first-ever write (no
    // seed row per migration 156 — `row_count` reads as NONE, coalesces to 0)
    // and every subsequent UPSERT, and is safe under concurrent writers.
    await surrealDB.query(
      `UPSERT ${TRACE_STORE_COUNTER_ID} SET
         table_name = 'activity_execution_traces',
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
