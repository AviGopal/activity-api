/**
 * A PRODUCER IS CREDITED BY WHAT ITS CONSUMER DID WITH ITS OUTPUT (check-first).
 *
 * Core-loop bootstrap, credit from use (user ruling 2026-10-05, "follow the recommended order").
 *
 * MEASURED (docs-session audit, node 1, 2026-10-05; re-read at bd7ff19):
 *   - propagateCreditAlongChain credits every CALL ANCESTOR in composition_chain with the leaf's
 *     goal-level verdict: α to all of them on a reach, β to all of them on a failure. Whether an
 *     ancestor's output was ever consumed does not enter.
 *   - goal-host already sends the data-flow edge: each composite task carries
 *     consumedProvenance [{ impulseId, producerExecutionId, origin }] (goal-host
 *     buildCompositeTraceFromChain). activity-api drops it at ingest: normalizePersistedTask
 *     keeps consumed_from_task_ids but not consumedProvenance, and nothing in src reads
 *     producerExecutionId (0 reads).
 *
 * THE RULE PINNED HERE. When a trace DECLARES provenance (any task carries a consumed_provenance
 * array), ancestor credit follows the data flow: only an ancestor whose output a task of this trace
 * consumed is credited (α on a reach) or blamed (β on a failure). An ancestor that was called but
 * whose output nobody consumed earns nothing either way. The leaf can never name itself.
 * A trace that declares no provenance keeps today's call-lineage behaviour (CONTROL), so posters
 * that do not send provenance are not silently stripped of chain credit.
 *
 * Child bun probe (same harness as caller-fault-abstains.test.ts): POSTERIOR_COALESCE=0 so the
 * ancestor deltas go through the injected recording db; SURREALDB_URL on a closed port.
 */
// Must precede the import: config.ts validates these at module load.
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PU = (await import('./posterior-update')) as Record<string, unknown>;
const { normalizePersistedTask } = await import('../routes/execution-traces');

type Write = { activity_id: string; alpha_delta: number; beta_delta: number };

/** Run propagateCreditAlongChain in a child bun with a recording fake db; return its ancestor writes. */
function ancestorWrites(execution: Record<string, unknown>): Write[] {
  const dir = mkdtempSync(join(tmpdir(), 'consumer-credit-'));
  try {
    const probe = join(dir, 'probe.ts');
    writeFileSync(probe, `
      const { propagateCreditAlongChain } = await import(${JSON.stringify(join(import.meta.dir, 'posterior-update.ts'))});
      const writes = [];
      const db = { query: async (sql, vars) => { if (/UPDATE variant_performance_metrics/.test(sql)) writes.push({ activity_id: vars.activity_id, alpha_delta: vars.alpha_delta, beta_delta: vars.beta_delta }); if (/FROM execution WHERE id IN/.test(sql)) return Object.keys(vars ?? {}).filter((k) => k.startsWith('a_')).map((k) => ({ execution_id: vars[k], variant_id: vars[k], org_id: 'org-1' })); return []; } };
      await propagateCreditAlongChain(JSON.parse(process.env.EXEC), db, 'org-1');
      console.log('RESULT ' + JSON.stringify(writes));
      process.exit(0);
    `);
    const r = Bun.spawnSync(['bun', probe], {
      env: {
        HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '',
        POSTERIOR_COALESCE: '0', SURREALDB_URL: 'http://127.0.0.1:9', TD_LAMBDA: '0.5',
        SURREALDB_NAMESPACE: 'activity-system', SURREALDB_DATABASE: 'learning_loop',
        EXEC: JSON.stringify(execution),
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

const touched = (ws: Write[]) => ws.map((w) => w.activity_id).sort();

// chain root-first: gather → plan; the leaf (the consumer) is not in the chain.
const CHAIN = ['exec-gather', 'exec-plan'];

describe('MUST-FAIL — ancestor credit follows the data flow when the trace declares it', () => {
  test('(b) a reach credits only the producer whose output was consumed; the unconsumed ancestor gets no α', () => {
    const ws = ancestorWrites({ activity_id: 'leaf', composition_chain: CHAIN, success: true, consumed_producers: ['exec-gather'] });
    expect(touched(ws)).toEqual(['exec-gather']);
    expect(ws[0]!.alpha_delta).toBeGreaterThan(0);
    expect(ws[0]!.beta_delta).toBe(0);
  });

  test('(a) a consumer failure blames the producer it consumed, and only that producer', () => {
    const ws = ancestorWrites({ activity_id: 'leaf', composition_chain: CHAIN, success: false, failure_mode: { type: 'verifier_negative' }, consumed_producers: ['exec-gather'] });
    expect(touched(ws)).toEqual(['exec-gather']);
    expect(ws[0]!.beta_delta).toBeGreaterThan(0);
    expect(ws[0]!.alpha_delta).toBe(0);
  });

  test('(a) a content failure reaches a consumed producer two steps up (the call-depth heuristic does not decide blame)', () => {
    const ws = ancestorWrites({ activity_id: 'leaf', composition_chain: CHAIN, success: false, failure_mode: { type: 'verifier_negative' }, consumed_producers: ['exec-gather'] });
    expect(touched(ws)).toEqual(['exec-gather']);
    expect(ws[0]!.beta_delta).toBeGreaterThan(0);
  });
  // A victim (cascading) blames no consumed producer: superseded 10-06 (qa), see
  // consumer-failure-class-gates-producer-blame.test.ts.

  test('a declared-empty provenance (nothing consumed) credits and blames no ancestor', () => {
    expect(ancestorWrites({ activity_id: 'leaf', composition_chain: CHAIN, success: true, consumed_producers: [] })).toEqual([]);
    expect(ancestorWrites({ activity_id: 'leaf', composition_chain: CHAIN, success: false, failure_mode: { type: 'verifier_negative' }, consumed_producers: [] })).toEqual([]);
  });

  test('a producer not in this chain is not credited by name alone (no self-award through provenance)', () => {
    expect(ancestorWrites({ activity_id: 'leaf', composition_chain: CHAIN, success: true, consumed_producers: ['exec-elsewhere'] })).toEqual([]);
  });
});

describe('MUST-FAIL — provenance survives ingest and becomes the consumed-producer set', () => {
  test('normalizePersistedTask keeps goal-host consumedProvenance as consumed_provenance', () => {
    const t = normalizePersistedTask({
      taskId: 'compose-step-2', inputImpulseIds: ['imp-1'],
      consumedProvenance: [{ impulseId: 'imp-1', producerExecutionId: 'exec-gather', origin: 'ancestor' }, { impulseId: 'imp-2', producerExecutionId: null, origin: 'ambient' }],
    }) as Record<string, unknown>;
    expect(t.consumed_provenance).toEqual([
      { impulse_id: 'imp-1', producer_execution_id: 'exec-gather', origin: 'ancestor' },
      { impulse_id: 'imp-2', producer_execution_id: null, origin: 'ambient' },
    ]);
  });

  test('consumedProducersOf: undefined when no task declares provenance; producers otherwise, never the trace itself', () => {
    const f = PU.consumedProducersOf as ((t: unknown) => string[] | undefined) | undefined;
    expect(typeof f).toBe('function');
    expect(f!({ execution_id: 'leaf-exec', tasks: [{ input_impulse_ids: ['a'] }] })).toBeUndefined();
    expect(f!({ execution_id: 'leaf-exec', tasks: [{ consumed_provenance: [] }] })).toEqual([]);
    expect(f!({
      execution_id: 'leaf-exec',
      tasks: [
        { consumed_provenance: [{ impulse_id: 'i1', producer_execution_id: 'exec-gather', origin: 'ancestor' }, { impulse_id: 'i2', producer_execution_id: null, origin: 'ambient' }] },
        { consumed_provenance: [{ impulse_id: 'i3', producer_execution_id: 'leaf-exec', origin: 'foreign' }, { impulse_id: 'i4', producer_execution_id: 'exec-gather', origin: 'ancestor' }] },
      ],
    })).toEqual(['exec-gather']);
  });
});

/** applyOutcomeToPosteriors end to end (the insert-path call site): which ancestors get a write. */
function appliedAncestorWrites(trace: Record<string, unknown>): Write[] {
  const dir = mkdtempSync(join(tmpdir(), 'consumer-credit-apply-'));
  try {
    const probe = join(dir, 'probe.ts');
    writeFileSync(probe, `
      const { applyOutcomeToPosteriors } = await import(${JSON.stringify(join(import.meta.dir, 'posterior-update.ts'))});
      const writes = [];
      const db = { query: async (sql, vars) => { if (/UPDATE variant_performance_metrics/.test(sql) && vars && typeof vars.activity_id === 'string' && vars.activity_id.startsWith('exec-')) writes.push({ activity_id: vars.activity_id, alpha_delta: vars.alpha_delta, beta_delta: vars.beta_delta }); if (/FROM execution WHERE id IN/.test(sql)) return Object.keys(vars ?? {}).filter((k) => k.startsWith('a_')).map((k) => ({ execution_id: vars[k], variant_id: vars[k], org_id: 'org-1' })); return []; }, queryAll: async () => [] };
      await applyOutcomeToPosteriors(JSON.parse(process.env.TRACE), db, 'org-1');
      await new Promise((r) => setTimeout(r, 300));
      console.log('RESULT ' + JSON.stringify(writes));
      process.exit(0);
    `);
    const r = Bun.spawnSync(['bun', probe], {
      env: {
        HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '',
        POSTERIOR_COALESCE: '0', SURREALDB_URL: 'http://127.0.0.1:9', TD_LAMBDA: '0.5',
        SURREALDB_NAMESPACE: 'activity-system', SURREALDB_DATABASE: 'learning_loop',
        RELEVANCE_SINK_ENDPOINT: 'http://127.0.0.1:9',
        TRACE: JSON.stringify(trace),
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

describe('MUST-FAIL — the insert path hands the declared data flow to chain credit', () => {
  test('a reached composite whose tasks consumed only exec-gather credits only exec-gather', () => {
    const ws = appliedAncestorWrites({
      activity_id: 'composition:gather-to-plan', execution_id: 'walk-composite-x', success: true, tags: ['reached:true'],
      composition_chain: CHAIN,
      tasks: [{ input_impulse_ids: ['imp-1'], consumed_provenance: [{ impulse_id: 'imp-1', producer_execution_id: 'exec-gather', origin: 'ancestor' }] }],
    });
    expect(touched(ws)).toEqual(['exec-gather']);
  });
});

describe('CONTROL — a trace that declares no provenance keeps call-lineage credit', () => {
  test('insert path: a reached trace with no provenance credits every ancestor', () => {
    const ws = appliedAncestorWrites({
      activity_id: 'composition:gather-to-plan', execution_id: 'walk-composite-y', success: true, tags: ['reached:true'],
      composition_chain: CHAIN, tasks: [{ input_impulse_ids: ['imp-1'] }],
    });
    expect(touched(ws)).toEqual(['exec-gather', 'exec-plan']);
  });

  test('a reach with no consumed_producers credits every ancestor (today\'s behaviour, instrument proven through the same address)', () => {
    const ws = ancestorWrites({ activity_id: 'leaf', composition_chain: CHAIN, success: true });
    expect(touched(ws)).toEqual(['exec-gather', 'exec-plan']);
    expect(ws.every((w) => w.alpha_delta > 0)).toBe(true);
  });

  test('a failure with no consumed_producers blames every ancestor', () => {
    const ws = ancestorWrites({ activity_id: 'leaf', composition_chain: CHAIN, success: false, failure_mode: { type: 'verifier_negative' } });
    expect(touched(ws)).toEqual(['exec-gather', 'exec-plan']);
    expect(ws.every((w) => w.beta_delta > 0)).toBe(true);
  });
});
