/**
 * AN UNSIGNED NON-ZERO DELTA IS COUNTED, AND ITS WARN NAMES THE EXECUTION (check-first).
 *
 * applyOutcomeToPosteriors writes the state-conditioned context_thompson_scores row only when the trace carries a
 * signature key. A graded trace with a non-zero delta and no signature dropped that row with a warn line that named
 * the activity but not the execution, and nothing counted it: 431 such drops in 24 h on node 1 (floor 396,
 * feature_compose 34) could be neither joined to an execution nor read as a rate. The variant_performance_metrics
 * delta is unaffected (it is still written or enqueued).
 *
 * THE RULE PINNED HERE:
 *   - posteriorCreditCounters().signature_row_dropped_no_signature (and the posteriorCreditCounters shape body)
 *     goes up by one per such trace;
 *   - the warn line carries execution_id, activity_id and both deltas;
 *   - the leaf VPM write still happens; a signed trace writes its signature row and is not counted.
 *
 * Child bun probe (the default-org harness): POSTERIOR_COALESCE=0 so the synchronous writes run against the fake
 * db, LOG_FORMAT=json so log lines are parseable, SURREALDB_URL on a closed port.
 */
// Must precede the import: config.ts validates these at module load.
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Counters = { signature_row_dropped_no_signature?: number };
type Log = { level: string; message: string; [k: string]: unknown };
type Probe = { before: Counters; after: Counters; shaped: Counters; writes: string[]; logs: Log[] };

const PROBE_MS = 90_000;

function probe(trace: Record<string, unknown>): Probe {
  const dir = mkdtempSync(join(tmpdir(), 'sig-drop-'));
  try {
    const p = join(dir, 'probe.ts');
    writeFileSync(p, `
      const PU = await import(${JSON.stringify(join(import.meta.dir, 'posterior-update.ts'))});
      globalThis.fetch = async () => new Response('{}', { status: 503 });
      const writes = [];
      const db = { query: async (sql) => {
        if (/UPDATE variant_performance_metrics/.test(sql)) { writes.push('vpm'); return [{ id: 'variant_performance_metrics:x' }]; }
        if (/CREATE context_thompson_scores/.test(sql)) { writes.push('cts'); return []; }
        if (/shape_score_counted/.test(sql)) return [{ counted: true, duplicate: false }];
        return [];
      } };
      const read = () => PU.posteriorCreditCounters();
      const before = read();
      await PU.applyOutcomeToPosteriors(JSON.parse(process.env.TRACE), db, 'organizations:substrate');
      const after = read();
      const shaped = PU.resolvePosteriorCreditCounters().body;
      console.log('RESULT ' + JSON.stringify({ before, after, shaped, writes }));
      process.exit(0);
    `);
    const r = Bun.spawnSync(['bun', p], {
      env: {
        HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '',
        POSTERIOR_COALESCE: '0', PRIOR_SEED_ENABLED: 'false', SURREALDB_URL: 'http://127.0.0.1:9',
        SURREALDB_NAMESPACE: 'activity-system', SURREALDB_DATABASE: 'learning_loop',
        LOG_FORMAT: 'json', LOG_LEVEL: 'info', TRACE: JSON.stringify(trace),
      },
      stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
    });
    const out = r.stdout.toString();
    const line = out.split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, `probe produced no result: ${r.stderr.toString().slice(0, 400)}`).toBeDefined();
    const logs: Log[] = [];
    for (const l of (out + '\n' + r.stderr.toString()).split('\n')) {
      if (!l.startsWith('{')) continue;
      try { logs.push(JSON.parse(l)); } catch { /* not a log line */ }
    }
    return { ...(JSON.parse(line!.slice('RESULT '.length)) as Omit<Probe, 'logs'>), logs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const graded = (extra: Record<string, unknown> = {}) => ({
  activity_id: 'development-vessel:floor',
  execution_id: 'exec-unsigned-1',
  success: true,
  tags: ['reached:true'],
  tasks: [{ resolver: 'llm' }],
  ...extra,
});
const dropWarns = (r: Probe) => r.logs.filter((l) => l.message.includes('execution carries no signature key'));
// A missing counter reads -1 (the MUST-FAIL is red where it does not exist); `absentAs` 0 keeps the controls neutral.
const delta = (r: Probe, absentAs = -1) => (r.after.signature_row_dropped_no_signature ?? absentAs) - (r.before.signature_row_dropped_no_signature ?? 0);

describe('an unsigned non-zero delta is counted, never silent', () => {
  test('MUST-FAIL: an unsigned graded trace increments signature_row_dropped_no_signature, and the warn carries execution_id', () => {
    const r = probe(graded());
    expect(delta(r)).toBe(1);
    expect(r.shaped.signature_row_dropped_no_signature).toBe(r.after.signature_row_dropped_no_signature);
    const w = dropWarns(r);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ execution_id: 'exec-unsigned-1', activity_id: 'development-vessel:floor' });
    expect(Number(w[0]!.alpha_delta) + Number(w[0]!.beta_delta)).toBeGreaterThan(0);
    // The VPM path is unchanged: the leaf delta is still written, only the signature row is lost.
    expect(r.writes).toEqual(['vpm']);
  }, PROBE_MS);

  test('CONTROL: a signed graded trace writes its signature row and is not counted', () => {
    const r = probe(graded({ signature: '0123456789abcdef', signature_version: 1 }));
    expect(delta(r, 0)).toBe(0);
    expect(dropWarns(r)).toHaveLength(0);
    expect(r.writes).toEqual(['vpm', 'cts']);
  }, PROBE_MS);

  test('CONTROL: an ungraded trace (zero deltas) is not a drop', () => {
    const r = probe(graded({ tags: [], success: true }));
    expect(delta(r, 0)).toBe(0);
    expect(dropWarns(r)).toHaveLength(0);
    expect(r.writes).toEqual([]);
  }, PROBE_MS);
});
