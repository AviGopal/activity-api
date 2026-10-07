/**
 * A CONSUMER'S FAILURE BLAMES ITS PRODUCERS ONLY WHEN IT IS A CONTENT FAILURE (check-first).
 *
 * Credit from use (user ruling 2026-10-05; qa requirement 10-06, before failed-step provenance goes
 * live). Under declared provenance (78fe52c) chain credit gave every CONSUMED producer a decayed β on
 * any failure, whatever the failure_mode. The leaf's own delta (computeDeltas) already abstains on an
 * environmental failure (provider outage, timeout, unreachable), on a victim (cascading), on a user
 * abort, and half-penalises a budget ceiling. Without the same gate upstream, one LLM outage would β
 * every producer that fed the failing step.
 *
 * THE RULE (reusing the leaf's classification, law 3): a consumed producer is blamed only when the
 * consumer's failure is one the leaf itself is blamed for (computeDeltas β > 0), scaled by that β; a
 * budget ceiling is the consumer's own resource limit, never the producer's output, so it blames no
 * producer. This supersedes 78fe52c's "cascading still reaches a consumed producer" expectation (a
 * victim's cause is blamed by its own trace).
 *
 * Child-bun probe as in consumer-outcome-credits-producer.test.ts (POSTERIOR_COALESCE=0, recording db).
 */
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Write = { activity_id: string; alpha_delta: number; beta_delta: number };

function ancestorWrites(failure_mode: unknown): Write[] {
  const dir = mkdtempSync(join(tmpdir(), 'consumer-failure-class-'));
  try {
    const probe = join(dir, 'probe.ts');
    writeFileSync(probe, `
      const { propagateCreditAlongChain } = await import(${JSON.stringify(join(import.meta.dir, 'posterior-update.ts'))});
      const writes = [];
      const db = { query: async (sql, vars) => { if (/UPDATE variant_performance_metrics/.test(sql)) writes.push({ activity_id: vars.activity_id, alpha_delta: vars.alpha_delta, beta_delta: vars.beta_delta }); if (/FROM execution WHERE id IN/.test(sql)) return Object.keys(vars ?? {}).filter((k) => k.startsWith('a_')).map((k) => ({ execution_id: vars[k], variant_id: vars[k] })); return []; } };
      await propagateCreditAlongChain({ activity_id: 'leaf', composition_chain: ['exec-gather', 'exec-plan'], success: false, failure_mode: JSON.parse(process.env.FM), consumed_producers: ['exec-gather'] }, db, 'org-1');
      console.log('RESULT ' + JSON.stringify(writes));
      process.exit(0);
    `);
    const r = Bun.spawnSync(['bun', probe], {
      env: {
        HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '',
        POSTERIOR_COALESCE: '0', SURREALDB_URL: 'http://127.0.0.1:9', TD_LAMBDA: '0.5',
        SURREALDB_NAMESPACE: 'activity-system', SURREALDB_DATABASE: 'learning_loop',
        FM: JSON.stringify(failure_mode),
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    const line = r.stdout.toString().split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, `probe produced no result: ${r.stderr.toString().slice(0, 400)}`).toBeDefined();
    return JSON.parse(line!.slice('RESULT '.length)) as Write[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// exec-gather is consumed, at depth 2 (chain reversed: exec-plan depth 1, exec-gather depth 2), TD_LAMBDA 0.5.
const FULL = 0.25;

describe('MUST-FAIL — a non-content consumer failure blames no consumed producer', () => {
  test('provider outage (execution_error: fetch failed) ⇒ no β', () => {
    expect(ancestorWrites({ type: 'execution_error', reason: 'LLM provider: fetch failed' })).toEqual([]);
  });
  test('timeout (execution_error: request timed out) ⇒ no β', () => {
    expect(ancestorWrites({ type: 'execution_error', reason: 'llm_completion: request timed out after 240000ms' })).toEqual([]);
  });
  test('gateway error (HTTP 503) ⇒ no β', () => {
    expect(ancestorWrites({ type: 'execution_error', reason: 'resolver returned HTTP 503 service unavailable' })).toEqual([]);
  });
  test('budget ceiling (budget_exhausted) ⇒ no β', () => {
    expect(ancestorWrites({ type: 'budget_exhausted' })).toEqual([]);
  });
  test('victim (cascading) ⇒ no β — its cause is blamed by its own trace', () => {
    expect(ancestorWrites({ type: 'cascading' })).toEqual([]);
  });
  test('user abort ⇒ no β', () => {
    expect(ancestorWrites({ type: 'user_abort' })).toEqual([]);
  });
});

describe('CONTROL — a content failure still blames the consumed producer (and only it)', () => {
  test('the consumer rejects the output (verifier_negative) ⇒ full decayed β to exec-gather', () => {
    expect(ancestorWrites({ type: 'verifier_negative' })).toEqual([{ activity_id: 'exec-gather', alpha_delta: 0, beta_delta: FULL }]);
  });
  test('an arm-fault execution_error (not environmental) ⇒ full decayed β', () => {
    expect(ancestorWrites({ type: 'execution_error', reason: 'cannot parse producer output: Unexpected token < in JSON' })).toEqual([{ activity_id: 'exec-gather', alpha_delta: 0, beta_delta: FULL }]);
  });
});

describe('MUST-FAIL — the producer β is scaled by the leaf\'s own β', () => {
  test('a half-penalty class scales the producer β the same way (prediction_disagreement intent_inconsistency ⇒ ½)', () => {
    expect(ancestorWrites({ type: 'prediction_disagreement', context: { sub_type: 'intent_inconsistency' } })).toEqual([{ activity_id: 'exec-gather', alpha_delta: 0, beta_delta: FULL * 0.5 }]);
  });
});
