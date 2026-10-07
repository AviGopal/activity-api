/**
 * A CALLER-FAULT OUTCOME NEVER COUNTS TOWARD A TEMPLATE'S RETIREMENT EVIDENCE (check-first).
 *
 * Gap: a-malformed-llm-request-is-graded-as-a-quality-failure-of-whichever-model-arm-was-drawn
 * (qa: caller-fault outcomes never count toward a template's retirement evidence).
 *
 * MEASURED, node 1, 2026-10-03. The walk ran the learned satisfier template for
 * llm_completion_dispatch with no prompt bound. The request was refused before any provider call —
 * a fault of the REQUEST — yet the template was graded failed on every run (~71 executions, 0
 * successes) and walked toward retirement.
 *
 * WHERE RETIREMENT EVIDENCE LIVES. checkAndRetireByPosterior (services/variant-creator.ts), fired
 * from POST /v2/activities/execution-traces on a graded failure, retires on the posterior mean of
 * variant_performance_metrics.thompson_alpha/_beta. Those are written only by
 * applyOutcomeToPosteriors, which skips the variant write when computeDeltas returns {0,0}. So the
 * exclusion belongs in computeDeltas, exactly where the environmental-failure abstention already
 * sits. (checkAndRetireTemplate reads `execution.success` and is inert — no fleet caller posts to its
 * route; documented in variant-creator.ts — so it is not tested here.)
 *
 * THE CARRIER (pinned). development-vessel refuses a prompt-less dispatch with
 * structuredError { failure_mode: "malformed_request" } (development-vessel
 * test/resolvers/llm-completion-dispatch-refuses-a-missing-prompt.test.ts); goal-host's proxy
 * resolver turns that into the thrown task error
 *     dev-vessel <shape> resolver returned structuredError (failure_mode=malformed_request): <detail>
 * which reaches this store as failure_mode { type: "execution_error", reason: <that text> }.
 * The token `malformed_request` in the reason is the caller-fault mark:
 *   - computeDeltas abstains ({0,0}): no alpha, no beta, so no retirement evidence;
 *   - failureClassOf names class `malformed_request` (closed vocabulary) and its step is the
 *     calling task, so the fault is recorded against the step that sent the bad request.
 *
 * THE SECOND WRITE SITE. propagateCreditAlongChain (posterior-update.ts) also writes
 * thompson_alpha/_beta — to every ANCESTOR in the leaf's composition_chain (the walk threads one:
 * runTemplate(..., { compositionChain })). Its only failure exemption is failure_mode.type ===
 * 'cascading', so a caller-fault leaf still blames each prior step's arm: retirement evidence for
 * templates that did nothing wrong. Pinned below through a child bun (POSTERIOR_COALESCE=0 so
 * ancestor deltas go through the injected db, SURREALDB_URL on a closed local port so nothing
 * real is reached; the module-level coalesce flag cannot be reset in-process).
 *
 * SCOPE. Only the caller-fault token abstains. "unbindable required input: <name>" — the walk
 * declining to invoke a producer it could not bind — stays blamed: after the binding gate, a
 * template that still cannot bind a required input carries a broken config of its own.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.ts throws at import without these and posterior-update imports it transitively.
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

const { computeDeltas } = await import('./posterior-update');
const { failureClassOf, FAILURE_CLASSES } = await import('./failure-class');

// ── CROSS-REPO CONTRACT FIXTURES ────────────────────────────────────────────────────────────────
// Vessels cannot import the super-repo's packages/; these blocks are copied verbatim from each
// string's emitter test so a super-repo check can compare the copies byte for byte.
// CONTRACT-FIXTURE malformed_request BEGIN (emitter: development-vessel test/resolvers/llm-completion-dispatch-refuses-a-missing-prompt.test.ts)
const MALFORMED_REQUEST = "malformed_request";
// CONTRACT-FIXTURE malformed_request END
// CONTRACT-FIXTURE malformed_request_carrier BEGIN (emitter: goal-host-vessel test/required-inputs-are-bound-before-a-producer-is-invoked.test.ts)
const CARRIER_FORMAT = "dev-vessel <shape> resolver returned structuredError (failure_mode=<token>): <detail>";
const formatCarrier = (shape: string, token: string, detail: string): string =>
  CARRIER_FORMAT.replace("<shape>", () => shape).replace("<token>", () => token).replace("<detail>", () => detail);
const carrierToken = (reason: string): string | null =>
  /\bresolver returned structuredError \(failure_mode=([a-z0-9_]+)\)/.exec(reason)?.[1] ?? null;
// CONTRACT-FIXTURE malformed_request_carrier END

// The dispatcher's detail (development-vessel) wrapped in goal-host's carrier, as it reaches this store.
const DISPATCHER_DETAIL = `${MALFORMED_REQUEST}: pointer must include a non-empty 'prompt' string`;
const PROXY_REASON = formatCarrier("llm_completion_dispatch", MALFORMED_REQUEST, DISPATCHER_DETAIL);
const w = (): string[] => [];

describe('MUST-FAIL — a caller-fault failure gives no alpha and no beta', () => {
  test('the goal-host proxy carrier (execution_error, failure_mode=malformed_request) abstains', () => {
    expect(computeDeltas(false, { type: 'execution_error', reason: PROXY_REASON } as never, w()))
      .toEqual({ alphaDelta: 0, betaDelta: 0 });
  });

  test('the bare dispatcher detail abstains too (same token, no proxy prefix)', () => {
    expect(computeDeltas(false, { type: 'execution_error', reason: DISPATCHER_DETAIL } as never, w()))
      .toEqual({ alphaDelta: 0, betaDelta: 0 });
  });
});

describe('MUST-FAIL — the caller fault is classified and attributed to the calling step', () => {
  test('failureClassOf names malformed_request, at the task that sent the request', () => {
    const fc = failureClassOf(
      { type: 'execution_error', reason: PROXY_REASON },
      { tasks: [{ task_id: 'gather', success: true }, { task_id: 'format_answer', success: false }] },
    );
    expect(fc).toEqual({ class: MALFORMED_REQUEST, step: 'format_answer' });
  });

  test('malformed_request is a member of the closed failure-class vocabulary', () => {
    expect(FAILURE_CLASSES.has(MALFORMED_REQUEST)).toBe(true);
  });
});

describe('CONTRACT CONFORMANCE (green at base) — the reason this store receives is the fixture carrier', () => {
  test('the carrier parses back to the malformed_request token, and a non-carrier reason does not', () => {
    expect(carrierToken(PROXY_REASON)).toBe(MALFORMED_REQUEST);
    expect(PROXY_REASON.startsWith('dev-vessel llm_completion_dispatch resolver returned structuredError (failure_mode=malformed_request): ')).toBe(true);
    expect(carrierToken('connect ECONNREFUSED 127.0.0.1:8090')).toBeNull();
  });
});

describe('CONTROL — real failures keep their blame and their class', () => {
  test('a resolver structuredError that is not a caller fault is still blamed (beta 1) and stays resolver_error', () => {
    const reason = formatCarrier('llm_completion_dispatch', 'verifier_negative', 'LLM vessel returned error or resolved=false');
    expect(computeDeltas(false, { type: 'execution_error', reason } as never, w())).toEqual({ alphaDelta: 0, betaDelta: 1 });
    expect(failureClassOf({ type: 'execution_error', reason }, {}).class).toBe('resolver_error');
  });

  test('an unbindable required input is the template\'s own fault: still blamed', () => {
    const reason = 'unbindable required input: prompt (producer llm_completion_dispatch)';
    expect(computeDeltas(false, { type: 'execution_error', reason } as never, w())).toEqual({ alphaDelta: 0, betaDelta: 1 });
  });

  test('an environmental failure still abstains, and a success still credits', () => {
    expect(computeDeltas(false, { type: 'execution_error', reason: 'connect ECONNREFUSED 127.0.0.1:8090' } as never, w()))
      .toEqual({ alphaDelta: 0, betaDelta: 0 });
    expect(computeDeltas(true, null, w())).toEqual({ alphaDelta: 1, betaDelta: 0 });
  });
});

/** Run propagateCreditAlongChain in a child bun with a recording fake db; return its ancestor writes. */
function ancestorWrites(failureMode: unknown): { coalesce: boolean; writes: Array<Record<string, unknown>> } {
  const dir = mkdtempSync(join(tmpdir(), 'caller-fault-chain-'));
  try {
    const probe = join(dir, 'probe.ts');
    writeFileSync(probe, `
      const { propagateCreditAlongChain } = await import(${JSON.stringify(join(import.meta.dir, 'posterior-update.ts'))});
      const { posteriorCoalesceEnabled } = await import(${JSON.stringify(join(import.meta.dir, 'posterior-aggregator.ts'))});
      const writes = [];
      const db = { query: async (sql, vars) => { if (/UPDATE variant_performance_metrics/.test(sql)) writes.push(vars); if (/FROM execution WHERE id IN/.test(sql)) return Object.keys(vars ?? {}).filter((k) => k.startsWith('a_')).map((k) => ({ execution_id: vars[k], variant_id: vars[k], org_id: 'org-1' })); return []; } };
      await propagateCreditAlongChain({ composition_chain: ['exec-gather', 'exec-plan'], success: false, failure_mode: JSON.parse(process.env.FM), activity_id: 'leaf' }, db, 'org-1');
      console.log('RESULT ' + JSON.stringify({ coalesce: posteriorCoalesceEnabled(), writes }));
      process.exit(0);
    `);
    const r = Bun.spawnSync(['bun', probe], {
      env: {
        HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '',
        POSTERIOR_COALESCE: '0', SURREALDB_URL: 'http://127.0.0.1:9', TD_LAMBDA: '0.5',
        SURREALDB_NAMESPACE: 'activity-system', SURREALDB_DATABASE: 'learning_loop',
        FM: JSON.stringify(failureMode),
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    const line = r.stdout.toString().split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, `probe produced no result: ${r.stderr.toString().slice(0, 400)}`).toBeDefined();
    return JSON.parse(line!.slice('RESULT '.length));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ancestor chain credit (the second posterior write site)', () => {
  test('CONTROL: a plain failed leaf still blames its ancestors (instrument proven through the same address)', () => {
    const r = ancestorWrites({ type: 'verifier_negative' });
    expect(r.coalesce).toBe(false);
    expect(r.writes.map((w) => w.activity_id)).toEqual(['exec-plan', 'exec-gather']);
    expect(r.writes.every((w) => (w.beta_delta as number) > 0)).toBe(true);
  });

  test('MUST-FAIL: a caller-fault leaf writes no alpha or beta to any ancestor', () => {
    const r = ancestorWrites({ type: 'execution_error', reason: PROXY_REASON });
    expect(r.coalesce).toBe(false);
    expect(r.writes).toEqual([]);
  });
});
