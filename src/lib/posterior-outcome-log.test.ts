/**
 * THE POSTERIOR OUTCOME LINE SAYS WHAT HAPPENED, AFTER IT HAPPENED (check-first).
 *
 * applyOutcomeToPosteriors logged 'posterior variant update APPLIED' BEFORE writing anything: under coalescing the
 * VPM delta is only enqueued (and can still end posterior_delta_dropped_no_row), the signature row can still be
 * dropped for want of a signature key, and a defaulted org (every leaf write skipped) also logged APPLIED.
 * 2251 APPLIED lines in 24 h on node 1 therefore did not count applied writes.
 *
 * THE RULE PINNED HERE: one line per leaf decision, emitted after both leaf writes are decided, carrying
 * execution_id and the outcome of each write (vpm, signature_row):
 *   - SKIPPED   nothing written for the leaf (now including reason 'org_defaulted');
 *   - ENQUEUED  the coalescing aggregator holds the VPM delta;
 *   - APPLIED   the synchronous VPM UPDATE ran and the signature row was written;
 *   - PARTIAL   the synchronous VPM UPDATE ran and the signature row was not;
 *   - FAILED    the synchronous VPM UPDATE threw.
 *
 * Child bun probe (the default-org harness), LOG_FORMAT=json so log lines are parseable, SURREALDB_URL on a closed
 * port; POSTERIOR_COALESCE per test.
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

function probe(trace: Record<string, unknown>, coalesce: '0' | '1' = '0'): Probe {
  const dir = mkdtempSync(join(tmpdir(), 'outcome-log-'));
  try {
    const p = join(dir, 'probe.ts');
    writeFileSync(p, `
      const PU = await import(${JSON.stringify(join(import.meta.dir, 'posterior-update.ts'))});
      globalThis.fetch = async () => new Response('{}', { status: 503 });
      const writes = [];
      const db = { query: async (sql) => {
        if (/UPDATE variant_performance_metrics/.test(sql)) { writes.push('vpm'); if (process.env.VPM_THROWS) throw new Error('boom'); return [{ id: 'variant_performance_metrics:x' }]; }
        if (/CREATE context_thompson_scores/.test(sql)) { writes.push('cts'); return []; }
        if (/shape_score_counted/.test(sql)) return [{ counted: true, duplicate: false }];
        return [];
      } };
      const read = () => PU.posteriorCreditCounters();
      const before = read();
      await PU.applyOutcomeToPosteriors(JSON.parse(process.env.TRACE), db, 'organizations:substrate');
      writes.push('returned');
      const after = read();
      const shaped = PU.resolvePosteriorCreditCounters().body;
      console.log('RESULT ' + JSON.stringify({ before, after, shaped, writes }));
      process.exit(0);
    `);
    const r = Bun.spawnSync(['bun', p], {
      env: {
        HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '',
        POSTERIOR_COALESCE: coalesce, PRIOR_SEED_ENABLED: 'false', SURREALDB_URL: 'http://127.0.0.1:9',
        SURREALDB_NAMESPACE: 'activity-system', SURREALDB_DATABASE: 'learning_loop',
        LOG_FORMAT: 'json', LOG_LEVEL: 'info', TRACE: JSON.stringify(trace), ...(trace.__vpmThrows ? { VPM_THROWS: '1' } : {}),
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
  execution_id: 'exec-outcome-1',
  success: true,
  tags: ['reached:true'],
  tasks: [{ resolver: 'llm' }],
  ...extra,
});
const SIGNED = { signature: '0123456789abcdef', signature_version: 1 };
const decisions = (r: Probe) => r.logs.filter((l) => l.message.startsWith('posterior variant update '));
const saysApplied = (r: Probe) => r.logs.filter((l) => /\bAPPLIED\b/.test(l.message));

describe('the posterior outcome line is honest', () => {
  test('MUST-FAIL: an unsigned trace (signature row dropped) is not logged APPLIED, and the line states both outcomes', () => {
    const r = probe(graded());
    expect(r.writes).toEqual(['vpm', 'returned']);
    expect(saysApplied(r)).toEqual([]);
    const d = decisions(r);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ message: 'posterior variant update PARTIAL', execution_id: 'exec-outcome-1', vpm: 'written', signature_row: 'dropped_no_signature' });
  }, PROBE_MS);

  test('MUST-FAIL: an org-defaulted trace (every leaf write skipped) is not logged APPLIED; it is SKIPPED org_defaulted', () => {
    const r = probe(graded({ ...SIGNED, org_defaulted: true }));
    expect(r.writes).toEqual(['returned']);
    expect(saysApplied(r)).toEqual([]);
    const d = decisions(r);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ message: 'posterior variant update SKIPPED', reason: 'org_defaulted', execution_id: 'exec-outcome-1', vpm: 'skipped_org_defaulted', signature_row: 'skipped_org_defaulted' });
  }, PROBE_MS);

  test('MUST-FAIL: under coalescing the VPM delta is ENQUEUED, not APPLIED, and the signature row outcome is stated', () => {
    const r = probe(graded(SIGNED), '1');
    expect(saysApplied(r)).toEqual([]);
    const d = decisions(r);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ message: 'posterior variant update ENQUEUED', execution_id: 'exec-outcome-1', vpm: 'enqueued', signature_row: 'written' });
  }, PROBE_MS);

  test('MUST-FAIL: a VPM UPDATE that throws is logged FAILED', () => {
    const r = probe(graded({ ...SIGNED, __vpmThrows: true }));
    expect(saysApplied(r)).toEqual([]);
    expect(decisions(r)).toEqual([expect.objectContaining({ message: 'posterior variant update FAILED', vpm: 'write_failed', signature_row: 'written' })]);
  }, PROBE_MS);

  test('CONTROL: a signed synchronous write (both leaf writes ran) is still logged APPLIED, once', () => {
    const r = probe(graded(SIGNED));
    expect(r.writes).toEqual(['vpm', 'cts', 'returned']);
    expect(decisions(r)).toEqual([expect.objectContaining({ message: 'posterior variant update APPLIED' })]);
  }, PROBE_MS);

  test('MUST-FAIL: the APPLIED line states execution_id and both write outcomes', () => {
    const r = probe(graded(SIGNED));
    expect(decisions(r)).toEqual([expect.objectContaining({ message: 'posterior variant update APPLIED', execution_id: 'exec-outcome-1', vpm: 'written', signature_row: 'written' })]);
  }, PROBE_MS);

  test('CONTROL: an ungraded trace is SKIPPED reach_ungraded, as before', () => {
    const r = probe(graded({ tags: [] }));
    expect(decisions(r)).toEqual([expect.objectContaining({ message: 'posterior variant update SKIPPED', reason: 'reach_ungraded' })]);
  }, PROBE_MS);
});
