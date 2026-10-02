/**
 * The failure CLASS and STEP of one failed execution, computed in code from what the
 * trace already carries (slice Y, step Y1a).
 *
 * Why: `failure_mode.type` has three live values, and a HOLLOW verdict, an unregistered
 * resolver and a refused connection all record as `execution_error`. The fact that
 * tells them apart lives only in `reason` prose, which no detector parses. This is the
 * single classifier the store applies at write time (the insert path and the late
 * /reach verdict), so every reader keys on one closed vocabulary instead of re-parsing
 * prose, and a class gap can be filed and measured per class.
 *
 * Contract:
 *  - The result is exactly `{ class, step }`. It carries NO `type`: posterior-update maps
 *    `failure_mode.type` to beta, and law 12 (change one thing) keeps learning untouched
 *    by classification. A caller merges the result as sub-fields beside `type`.
 *  - `class` is a member of FAILURE_CLASSES, or `deterministic:<token>` for a verdict that
 *    names its own token in the canonical form. Nothing else is ever returned.
 *  - FAIL CLOSED: an unrecognised reason is `unclassified`, an absent reason is
 *    `unreasoned`, and a `deterministic:` prefix whose token is not canonical (spaces,
 *    capitals, overlong, a trailing or double hyphen, a date / epoch / uuid) is not
 *    trusted as a class; a non-canonical run is refused whole, never cut to a canonical
 *    prefix. Nothing is guessed from a near miss, so a class count never absorbs rows
 *    that do not belong to it.
 *  - The floor judge (metadata.floor) and a HOLLOW-headed reason are `judged_hollow`
 *    BEFORE any error rule: judge prose quotes errors it is grading.
 *  - `type` stands in for a class only for the six typed variants, never any other value.
 */

// The token rule is shared with the dev-vessel's verdict-class gap filer (vendored
// byte-identical from packages/verdict-token), so every class stamped here is a class the
// filer can file as `verdict-class-<token>`.
import { VERDICT_CLASS_PREFIX, verdictTokenOfClass, verdictTokenOfReason } from './verdict-token';

/** The closed vocabulary (besides `deterministic:<token>`). */
export const FAILURE_CLASSES: ReadonlySet<string> = new Set([
  // Not a failure verdict: the grader declined to grade.
  'abstain',
  // The call never reached its peer (invalid URL, refused or reset connection, timeout).
  'transport',
  // The fleet has no such resolver / producer / input: a routing or authoring fact.
  'structural:not-registered',
  'structural:no-producer',
  'structural:missing-input',
  // A template bound an input to a shape nothing produces.
  'input_binding',
  // A safety cap refused to go deeper.
  'refused:chain-depth',
  // The resolver reported its own output as degraded.
  'degraded_output',
  // The resolver answered with a structured error that is not a transport fault.
  'resolver_error',
  // The floor judge's free-text not-reached verdict.
  'judged_hollow',
  // No reason was recorded at all.
  'unreasoned',
  // A reason was recorded, but it matches no class: never a guessed class.
  'unclassified',
  // The canonical typed variants, used only when the reason names no class of its own.
  'verifier_negative',
  'budget_exhausted',
  'safety_breach',
  'cascading',
  'user_abort',
  'prediction_disagreement',
]);

/** The six typed failure_mode variants that may stand in for a class when the reason names none. */
const TYPED_VARIANTS: ReadonlySet<string> = new Set([
  'verifier_negative', 'budget_exhausted', 'safety_breach', 'cascading', 'user_abort', 'prediction_disagreement',
]);

/** Ordered rules: the first match wins. Order is load-bearing (see the notes). */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Before transport: a depth refusal can mention a dispatch that "would target" a peer.
  [/composition chain depth|chain depth \(\d+\)|max(?:imum)? (?:chain )?depth/i, 'refused:chain-depth'],
  // Before resolver_error: a structuredError whose cause is a failed fetch is transport.
  [/URL is invalid|fetch failed|ECONNREFUSED|ECONNRESET|operation timed out|socket hang up|Unable to connect|network error/i, 'transport'],
  [/is not registered|no vessel advertises/i, 'structural:not-registered'],
  [/template_not_found|no producer|no template produces/i, 'structural:no-producer'],
  [/requires shape '[^']*' but no matching impulses/i, 'structural:missing-input'],
  [/never produced for binding|unresolved placeholder/i, 'input_binding'],
  [/convergent_validity\[degraded\]|metadata\.degraded=true/i, 'degraded_output'],
  [/returned structuredError/i, 'resolver_error'],
];

/** The longest reason prefix the rules read: classification is a head-of-reason fact. */
const MAX_REASON_SCAN = 2000;
const MAX_STEP_LEN = 128;

export interface FailureModeLike {
  type?: unknown;
  reason?: unknown;
  context?: unknown;
  upstream_task_id?: unknown;
}

export interface FailureClassContext {
  /** The trace's tasks, in execution order. */
  tasks?: ReadonlyArray<{ task_id?: unknown; id?: unknown; success?: unknown }> | null;
  /** The trace's metadata; `floor: true` marks the floor judge's row. */
  metadata?: Record<string, unknown> | null;
}

export interface FailureClass {
  class: string;
  step: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function stepName(v: unknown): string {
  const s = str(v);
  return s.length > MAX_STEP_LEN ? s.slice(0, MAX_STEP_LEN) : s;
}

function classOf(fm: FailureModeLike | null | undefined, floor: boolean): string {
  // A non-string reason is no reason: never stringify an object into a class match.
  const reason = str(fm?.reason).slice(0, MAX_REASON_SCAN);
  const token = verdictTokenOfReason(reason);
  if (token) return `${VERDICT_CLASS_PREFIX}${token}`;
  if (!reason) return 'unreasoned';
  if (/^abstain:/i.test(reason)) return 'abstain';
  // BEFORE the error rules: the floor judge's prose routinely QUOTES an error ("the output
  // says the resolver is not registered"); that is a judgement about an answer, not the error.
  if (floor || /^HOLLOW\b/.test(reason)) return 'judged_hollow';
  for (const [re, cls] of RULES) if (re.test(reason)) return cls;
  const type = str(fm?.type);
  if (TYPED_VARIANTS.has(type)) return type;
  return 'unclassified';
}

function stepOf(fm: FailureModeLike | null | undefined, ctx: FailureClassContext, floor: boolean): string {
  const tasks = Array.isArray(ctx.tasks) ? ctx.tasks : [];
  // A task not KNOWN to have succeeded is a candidate failure site (unknown is not success).
  const failed = tasks.find((t) => !t || t.success !== true);
  if (failed) return stepName(failed?.task_id) || stepName(failed?.id) || 'unknown_task';
  const context = fm?.context && typeof fm.context === 'object' ? (fm.context as Record<string, unknown>) : null;
  const named = stepName(context?.['task_id']) || stepName(fm?.upstream_task_id);
  if (named) return named;
  if (floor) return 'floor';
  if (tasks.length > 0) return 'post_tasks';
  return 'walk';
}

/**
 * Class and step of a failure. Pure: reads only its arguments. The result never carries
 * `type` and must be merged beside it, never over it.
 */
export function failureClassOf(fm: FailureModeLike | null | undefined, ctx: FailureClassContext = {}): FailureClass {
  const floor = ctx.metadata?.['floor'] === true;
  return { class: classOf(fm, floor), step: stepOf(fm, ctx, floor) };
}

/** True for a value this module could have returned as a class. */
export function isFailureClass(c: unknown): c is string {
  if (typeof c !== 'string') return false;
  return FAILURE_CLASSES.has(c) || verdictTokenOfClass(c) !== null;
}
