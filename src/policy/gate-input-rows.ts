/**
 * GATE-INPUT TUNING ROWS — the closed set of substrate_tuning_param rows a gate or verdict reads.
 *
 * POST /v2/tuning-params (routes/tuning-params.ts) lets any authenticated key author a learning
 * knob, so the system can keep tuning its own learner. A row in GATE_INPUT_ROWS is different: a
 * gate, a judge or a verdict computation reads it, so a key that could write it could loosen the
 * check that grades its own work. Writing one needs a policy-write principal (isPolicyWritePrincipal:
 * server-validated scope "policy:write", or "admin" interim; a key id; not on-behalf-of).
 *
 * THIS FILE IS CLOSED (it belongs in autonomyScope.excluded_paths), so the lane cannot shrink the
 * set. The set is built from evidence: every literal row name read by a closed reader.
 *   - In this repo, the readers are CLOSED_READER_FILES. src/policy/gate-input-rows.test.ts
 *     extracts every row name they read, statically from source, and fails when one is in neither
 *     GATE_INPUT_ROWS nor LEARNING_ROWS, or when a read's name is not a literal (fail closed).
 *   - Readers in other repos cannot be scanned from here; their rows are listed below with the
 *     file that reads them, and the test pins them. A new reader there is NOT caught by the test.
 *
 * Only rows outside GATE_INPUT_ROWS stay writable by any authenticated key (never on-behalf-of a
 * peer node), and a LEARNING_ROWS write must fall inside LEARNING_ROW_BOUNDS. A name in neither
 * list is writable by any key: the set is closed by evidence, not by default-deny, because the
 * learner's own knobs must stay live.
 */

/** activity-api files read for tuning rows by the enumeration test. Both are judges:
 *  posterior-update.ts (in excluded_paths) computes every posterior; variant-creator.ts decides
 *  retirement by posterior (NOT in excluded_paths today: listed here for qa). */
export const CLOSED_READER_FILES: readonly string[] = [
  'src/lib/posterior-update.ts',
  'src/services/variant-creator.ts',
];

/**
 * LEARNING_ROWS — rows a closed reader reads that are learning knobs, not gate inputs: exactly the
 * two rows the development-vessel learningPolicyWriteback tick authors (its CLAMPS keys). Both are
 * read by posterior-update.ts. Classifying them as gate inputs would make the reflect -> learner
 * loop inert (qa ruling: they stay learning rows, inside a bounded envelope). Moving a name from
 * here to GATE_INPUT_ROWS makes that tick's write of it a proposal (403 for its read/write key).
 */
export const LEARNING_ROWS: readonly string[] = ['TD_LAMBDA', 'YIELD_FLOOR'];

/**
 * LEARNING_ROW_BOUNDS — the closed envelope a learning-row write must fall inside, inclusive.
 * POST /v2/tuning-params refuses a value outside it (422, naming the bound) from EVERY caller:
 * policy:write and admin included. Widening or narrowing the envelope is a code change in this
 * closed file, never a write through the route.
 *
 * The values are the CURRENT clamps of the only writer, so nothing changes behaviourally today:
 * development-vessel src/resolvers/learning-policy-writeback.ts at origin/dev 2ac7e4a2,
 *   l.40  const CLAMPS: Record<string, { lo: number; hi: number }> = {
 *   l.41    TD_LAMBDA: { lo: 0.3, hi: 0.95 },
 *   l.42    YIELD_FLOOR: { lo: 0, hi: 1 },
 */
export const LEARNING_ROW_BOUNDS: Readonly<Record<string, { min: number; max: number }>> = {
  TD_LAMBDA: { min: 0.3, max: 0.95 },
  YIELD_FLOOR: { min: 0, max: 1 },
};

/** The bound a write of `name` = `value` violates, or null when it is inside (or `name` is unbounded). */
export function learningRowBoundViolation(name: string, value: number): { min: number; max: number } | null {
  const b = Object.prototype.hasOwnProperty.call(LEARNING_ROW_BOUNDS, name) ? LEARNING_ROW_BOUNDS[name]! : null;
  if (!b) return null;
  return value >= b.min && value <= b.max ? null : b;
}

export const GATE_INPUT_ROWS: readonly string[] = [
  // development-vessel src/resolvers/gap-to-feature.ts autoRevertRegressedLandings, via
  // GET /v2/tuning-params/:name (excluded_paths). Absent row => the guard refuses.
  'AUTO_REVERT_MAX_AGE_MS',
  'AUTO_REVERT_STRIKE_LIMIT',
  'AUTO_REVERT_HOLD_REVIEW_MS',
  // activity-api src/services/variant-creator.ts retire-by-posterior.
  'RETIREMENT_MIN_EXECUTIONS',
  'RETIREMENT_SUCCESS_FLOOR',
  // activity-api src/lib/posterior-update.ts (excluded_paths): every other row it reads.
  'YIELD_COST_REF',
  'YIELD_PROD_REF',
  'EMBEDDING_PRIOR_ENABLED',
  'THOMPSON_DECAY_HALFLIFE_DAYS',
  'CREDIT_PROPAGATION_EXCLUDED_ANCESTORS',
  // super-repo scripts/substrate/substrate-pull-sync.sh tuning_param (excluded_paths: the landing
  // and test-gate pacing); pull_sync.probe_window_max_seconds also scripts/substrate/vessel-ctl.sh.
  'pull_sync.probe_window_max_seconds',
  'pull_sync.stall_seconds',
  'pull_sync.owed_restart_max_hold_seconds',
  'pull_sync.testgate_budget_defer_max',
  'pull_sync.testgate_skip_recheck_ticks',
  'pull_sync.bounce_defer_max_ticks',
  'pull_sync.bounce_defer_max_seconds',
];

const GATE_INPUT_SET = new Set(GATE_INPUT_ROWS);

export function isGateInputRow(name: string): boolean {
  return GATE_INPUT_SET.has(name);
}
