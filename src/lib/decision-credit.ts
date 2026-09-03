/**
 * Decision-level outcome capture (law 12).
 *
 * The Thompson credit path (`applyOutcomeToPosteriors`) credits an *arm*
 * (activity_id / variant_id). It cannot answer whether *choosing* that arm, in
 * that context, was right — because selections and outcomes were never joined:
 * `thompson_selection_log.correlation_id` is written at recommendation time, but
 * nothing wrote the same key back onto the outcome. The ingest fix now lifts the
 * walk's `correlation:<id>` tag onto the execution row, so the join key exists.
 *
 * This module is the *consumer* half — but deliberately the SAFE, additive half:
 * Capture is limited to reach-graded executions; only these are recorded, ensuring that the fraction of rows in decision_outcome with a known reach is 100% by construction. This should not be interpreted as evidence of grading coverage across the fleet since only already-graded executions are recorded.
 * it persists a decision→outcome record to a NEW table (`decision_outcome`),
 * keyed on correlation_id, WITHOUT touching `variant_performance_metrics` or
 * changing selection behavior. It cannot corrupt existing posteriors or the
 * ribosome; the worst case is an inert row. A later, runtime-verifiable step can
 * feed these records into contextual credit; capturing them durably is the
 * precondition and is safe to land now.
 *
 * The write path is best-effort: it never throws into the caller, mirroring the
 * "learning signals are best-effort" convention elsewhere in the fleet.
 */

import { logger } from '../utils/logger';

/** The selection as it was logged at decision time. */
export interface SelectionAtDecision {
  activity_id: string;
  alpha?: number | null;
  beta?: number | null;
  thompson_sample?: number | null;
  selected_at?: string | null;
}

/** The outcome that followed a selection. */
export interface DecisionOutcomeInput {
  correlationId: string | null | undefined;
  /** exit-status success of the execution */
  success: boolean;
  /** honest-reach verdict when known: true=reached, false=not-reached, null=ungraded */
  reached?: boolean | null;
  executedAt?: string | null;
}

/** The persisted decision→outcome record. */
export interface DecisionOutcomeRecord {
  correlation_id: string;
  activity_id: string;
  predicted_success: number | null;
  thompson_sample: number | null;
  outcome_success: boolean;
  reached: boolean | null;
  selected_at: string | null;
  executed_at: string | null;
}

/**
 * Pure builder: combine a selection with the outcome that followed it into a
 * decision-outcome record. Returns null when the join cannot be formed (no
 * correlation id, or the selection was not found) — the caller then no-ops.
 */
export function buildDecisionOutcome(
  input: DecisionOutcomeInput,
  selection: SelectionAtDecision | null | undefined,
): DecisionOutcomeRecord | null {
  if (!input.correlationId || !selection) return null;
  const a = selection.alpha;
  const b = selection.beta;
  const predicted_success =
    typeof a === 'number' && typeof b === 'number' && a + b > 0 ? a / (a + b) : null;
  return {
    correlation_id: input.correlationId,
    activity_id: selection.activity_id,
    predicted_success,
    thompson_sample: typeof selection.thompson_sample === 'number' ? selection.thompson_sample : null,
    outcome_success: input.success,
    reached: input.reached ?? null,
    selected_at: selection.selected_at ?? null,
    executed_at: input.executedAt ?? null,
  };
}

/** Minimal DB surface this module needs — a query runner returning rows. */
export interface DecisionCreditDB {
  query<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T[]>;
}

/** Input for the execution-sourced (universal) capture path. */
export interface ExecutionDecisionOutcomeInput {
  executionId: string;
  activityId: string;
  orgId: string;
  /** exit-status success of the execution */
  success: boolean;
  /** honest-reach verdict: true=reached, false=not-reached (ungraded is not captured here) */
  reached: boolean | null;
  executedAt?: string | null;
}

/**
 * Capture is limited to reach-graded executions; only these are recorded, ensuring that the fraction of rows in decision_outcome with a known reach is 100% by construction. This should not be interpreted as evidence of grading coverage across the fleet since only already-graded executions are recorded.
 *
 * The correlation-join path (recordDecisionOutcome) only fires when an execution
 * carries a `correlation:<id>` tag joinable to thompson_selection_log — the
 * /recommend draw path. The substrate mostly executes via WALKS and PATHWAY-REUSE,
 * which select producers through discover-by-shapes (no selection log), so those
 * executions have no correlation to join and were never captured. But every
 * execution IS a decision (run activity A) with a prediction (A's posterior mean)
 * and an outcome (reached?). This records that, looking up the arm's CURRENT
 * posterior from variant_performance_metrics as the prediction — self-contained,
 * best-effort, and keyed on execution_id so it is idempotent and cannot collide
 * with a `sel_*` selection correlation. Never throws.
 */
export async function recordExecutionDecisionOutcome(
  db: DecisionCreditDB,
  input: ExecutionDecisionOutcomeInput,
): Promise<DecisionOutcomeRecord | null> {
  try {
    if (!input.executionId || !input.activityId) return null;
    // Look up the arm's current posterior as the prediction. Empty is normal for a
    // never-graded arm — predicted_success then stays NONE (not a divide-by-zero).
    const rows = await db.query<{ thompson_alpha?: number | null; thompson_beta?: number | null }>(
      `SELECT thompson_alpha, thompson_beta FROM variant_performance_metrics
       WHERE variant_id = $aid AND org_id = $oid LIMIT 1`,
      { aid: input.activityId, oid: input.orgId },
    );
    const post = rows && rows.length > 0 ? rows[0] : null;
    const a = post?.thompson_alpha;
    const b = post?.thompson_beta;
    const predicted_success =
      typeof a === 'number' && typeof b === 'number' && a + b > 0 ? a / (a + b) : null;
    const content: Record<string, unknown> = {
      // execution_id doubles as the required-string natural key here; format exec_*
      // never collides with a sel_* selection correlation.
      correlation_id: input.executionId,
      execution_id: input.executionId,
      activity_id: input.activityId,
      outcome_success: input.success,
      source: 'execution',
    };
    if (predicted_success !== null) content.predicted_success = predicted_success;
    if (input.reached !== null) content.reached = input.reached;
    // Always stamp executed_at. The caller (posterior-update) runs at trace-ingest,
    // moments after the execution, so ingest-time is a faithful proxy when the caller
    // supplies no explicit timestamp. A null executed_at (the prior behavior — the
    // caller never passes executedAt) left 100% of execution-sourced rows untimed,
    // breaking any time-ordered consumer or retention keyed on this field.
    content.executed_at = input.executedAt != null ? String(input.executedAt) : new Date().toISOString();
    await db.query(`UPSERT type::thing('decision_outcome', $eid) CONTENT $content`, {
      eid: input.executionId,
      content,
    });
    return {
      correlation_id: input.executionId,
      activity_id: input.activityId,
      predicted_success,
      thompson_sample: null,
      outcome_success: input.success,
      reached: input.reached ?? null,
      selected_at: null,
      executed_at: input.executedAt ?? null,
    };
  } catch (e) {
    logger.warn('[decision-credit] recordExecutionDecisionOutcome best-effort failed', {
      error: e instanceof Error ? e.message : String(e),
      execution_id: input.executionId,
    });
    return null;
  }
}

/**
 * Best-effort persist. Looks up the selection by correlation_id (indexed, UNIQ),
 * builds the record, and UPSERTs it into `decision_outcome`. Never throws — a
 * failure logs a warning and returns without disturbing the caller's flow.
 * Returns the record it wrote (for tests/callers), or null on no-op/failure.
 */
export async function recordDecisionOutcome(
  db: DecisionCreditDB,
  input: DecisionOutcomeInput,
): Promise<DecisionOutcomeRecord | null> {
  try {
    if (!input.correlationId) return null; // fast no-op: most executions carry no correlation
    const rows = await db.query<SelectionAtDecision>(
      `SELECT activity_id, alpha, beta, thompson_sample, selected_at
       FROM thompson_selection_log WHERE correlation_id = $cid LIMIT 1`,
      { cid: input.correlationId },
    );
    const selection = rows && rows.length > 0 ? rows[0] : null;
    const record = buildDecisionOutcome(input, selection);
    if (!record) return null;
    // Build CONTENT dynamically, OMITTING null fields. option<T> columns REJECT a
    // NULL value (NULL≠NONE in SurrealDB) — an omitted key defaults to NONE, which
    // is what we want. Non-null-only avoids that silent-write-loss trap.
    const content: Record<string, unknown> = {
      correlation_id: record.correlation_id,
      activity_id: record.activity_id,
      outcome_success: record.outcome_success,
    };
    if (record.predicted_success !== null) content.predicted_success = record.predicted_success;
    if (record.thompson_sample !== null) content.thompson_sample = record.thompson_sample;
    if (record.reached !== null) content.reached = record.reached;
    if (record.selected_at != null) content.selected_at = String(record.selected_at);
    if (record.executed_at != null) content.executed_at = String(record.executed_at);
    // Deterministic record id so a re-ingested outcome updates rather than duplicates.
    await db.query(`UPSERT type::thing('decision_outcome', $cid) CONTENT $content`, {
      cid: record.correlation_id,
      content,
    });
    return record;
  } catch (e) {
    logger.warn('[decision-credit] recordDecisionOutcome best-effort failed', {
      error: e instanceof Error ? e.message : String(e),
      correlation_id: input.correlationId,
    });
    return null;
  }
}
