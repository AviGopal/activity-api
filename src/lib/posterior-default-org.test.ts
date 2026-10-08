/**
 * NO LEARNING WRITE TO A DEFAULTED ORG (check-first).
 *
 * A trace posted with no org is stored under 'public' (execution.org_id is a required string), and the handler
 * now marks it org_defaulted. Its org is a guess, so:
 *   (a) applyOutcomeToPosteriors with org_defaulted writes NO leaf variant_performance_metrics delta and NO leaf
 *       context_thompson_scores (signature) row under the defaulted org, and counts the skip
 *       (posteriorCreditCounters.leaf_skipped_default_org). Chain credit still runs: a consumed producer is
 *       credited under ITS OWN org, which is known. Nor do the leaf's other org-keyed learning writes run: the
 *       reach-graded shape counter (paired with the VPM write), the decision_outcome row and the
 *       impulse-relevance penalty.
 *   (b) a producer whose own execution row carries metadata.org_defaulted has no knowable variant row either:
 *       no ancestor write, counted chain_ancestor_org_unresolved (the same branch as a row with no org). The
 *       org is not string-matched against 'public'.
 *
 * Child bun probe (the chain-credit harness): POSTERIOR_COALESCE=0 so the synchronous writes run against the fake
 * db, SURREALDB_URL on a closed port.
 */
// Must precede the import: config.ts validates these at module load.
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Write = { kind: 'leaf' | 'ancestor' | 'cts' | 'shape_count' | 'decision' | 'relevance'; activity_id?: string; org_id?: string };
type Counters = { leaf_skipped_default_org?: number; chain_ancestor_org_unresolved?: number; chain_ancestor_hits?: number };
type Probe = { before: Counters; after: Counters; writes: Write[] };

const SUBSTRATE = 'organizations:substrate';
// Each test spawns a child bun; leave it room past bun's 5s default. PRIOR_SEED_ENABLED=false keeps concept-db
// prior seeding (a discovery lookup) out of the leaf path.
const PROBE_MS = 90_000;

function probe(mode: 'leaf' | 'chain', opts: Record<string, unknown>): Probe {
  const dir = mkdtempSync(join(tmpdir(), 'default-org-'));
  try {
    const p = join(dir, 'probe.ts');
    writeFileSync(p, `
      const PU = await import(${JSON.stringify(join(import.meta.dir, 'posterior-update.ts'))});
      const O = JSON.parse(process.env.OPTS);
      const writes = [];
      // The impulse-relevance penalty crosses as a shaped resolve over fetch: record it, answer as the sink would.
      globalThis.fetch = async (url, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        if (body.includes('impulseRelevancePenalty_write')) {
          writes.push({ kind: 'relevance', org_id: JSON.parse(body).impulse.pointer.org_id });
          return new Response(JSON.stringify({ body: { written: 1 } }), { status: 200 });
        }
        return new Response('{}', { status: 503 });
      };
      const db = { query: async (sql, vars) => {
        // countShapeOutcome (reach-graded shape counter) and recordExecutionDecisionOutcome (decision_outcome row).
        if (/shape_score_counted/.test(sql)) { writes.push({ kind: 'shape_count' }); return [{ counted: true, duplicate: false }]; }
        if (/decision_outcome/.test(sql) || /org_id = \$oid/.test(sql)) { writes.push({ kind: 'decision', org_id: vars?.oid }); return []; }
        if (/UPDATE variant_performance_metrics/.test(sql)) {
          writes.push({ kind: 'new_alpha' in (vars ?? {}) ? 'leaf' : 'ancestor', activity_id: vars.activity_id, org_id: vars.org_id });
          return [{ id: 'variant_performance_metrics:x' }];
        }
        if (/context_thompson_scores/.test(sql) && /CREATE context_thompson_scores/.test(sql)) {
          writes.push({ kind: 'cts', activity_id: vars.activity_id, org_id: vars.org_id });
          return [];
        }
        if (/FROM execution WHERE id IN/.test(sql)) {
          const selectsFlag = /org_defaulted/.test(sql);
          return Object.keys(vars ?? {}).filter((k) => k.startsWith('a_')).map((k) => vars[k]).filter((id) => O.table[id])
            .map((id) => ({ execution_id: id, variant_id: O.table[id].variant_id,
              ...(O.table[id].org_id ? { org_id: O.table[id].org_id } : {}),
              ...(selectsFlag && O.table[id].org_defaulted ? { org_defaulted: true } : {}) }));
        }
        return [];
      } };
      const read = () => PU.resolvePosteriorCreditCounters().body;
      const before = read();
      if (process.env.MODE === 'leaf') {
        await PU.applyOutcomeToPosteriors(O.trace, db, O.orgId);
        // chain credit is fire-and-forget inside applyOutcomeToPosteriors: wait (bounded) for it to land.
        for (let i = 0; i < 100 && !writes.some((w) => w.kind === 'ancestor'); i++) await new Promise((r) => setTimeout(r, 20));
      } else {
        await PU.propagateCreditAlongChain({ activity_id: 'leaf-consumer', composition_chain: Object.keys(O.table), success: true,
          failure_mode: null, consumed_producers: Object.keys(O.table) }, db, O.consumerOrg);
      }
      const after = read();
      console.log('RESULT ' + JSON.stringify({ before, after, writes }));
      process.exit(0);
    `);
    const r = Bun.spawnSync(['bun', p], {
      env: {
        HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '',
        POSTERIOR_COALESCE: '0', PRIOR_SEED_ENABLED: 'false', SURREALDB_URL: 'http://127.0.0.1:9', TD_LAMBDA: '0.5',
        SURREALDB_NAMESPACE: 'activity-system', SURREALDB_DATABASE: 'learning_loop',
        MODE: mode, OPTS: JSON.stringify(opts),
      },
      stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
    });
    const line = r.stdout.toString().split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, `probe produced no result: ${r.stderr.toString().slice(0, 400)}`).toBeDefined();
    return JSON.parse(line!.slice('RESULT '.length)) as Probe;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A reached consumer that consumed one producer's output; the producer's own row is under the substrate org.
const leafTrace = (extra: Record<string, unknown> = {}) => ({
  activity_id: 'leaf-consumer',
  success: true,
  tags: ['reached:true'],
  execution_id: 'exec-leaf',
  composition_chain: ['exec-prod'],
  signature: '0123456789abcdef',
  signature_version: 1,
  tasks: [{ resolver: 'llm', consumed_provenance: [{ impulse_id: 'imp-1', producer_execution_id: 'exec-prod' }] }],
  ...extra,
});
const PRODUCER_TABLE = { 'exec-prod': { variant_id: 'satisfier:prod', org_id: SUBSTRATE } };
// A graded verifier failure that consumed the producer's output and read one impulse: on a known org this runs the
// leaf VPM write, the shape counter, the decision-outcome row and the impulse-relevance penalty, plus chain blame.
const failedLeafTrace = (extra: Record<string, unknown> = {}) => leafTrace({
  success: false,
  tags: ['reached:false'],
  failure_mode: { type: 'verifier_negative' },
  tasks: [{ resolver: 'llm', input_impulse_ids: ['imp-1'], consumed_provenance: [{ impulse_id: 'imp-1', producer_execution_id: 'exec-prod' }] }],
  ...extra,
});
const kinds = (r: Probe, kind: Write['kind']) => r.writes.filter((w) => w.kind === kind);

describe('no learning write to a defaulted org', () => {
  test('CONTROL: without org_defaulted the leaf VPM and signature rows are written under the given org', () => {
    const r = probe('leaf', { trace: leafTrace(), orgId: 'public', table: PRODUCER_TABLE });
    expect(r.writes.filter((w) => w.kind === 'leaf').map((w) => [w.activity_id, w.org_id])).toEqual([['leaf-consumer', 'public']]);
    expect(r.writes.filter((w) => w.kind === 'cts').map((w) => [w.activity_id, w.org_id])).toEqual([['leaf-consumer', 'public']]);
    expect(r.writes.filter((w) => w.kind === 'ancestor').map((w) => [w.activity_id, w.org_id])).toEqual([['satisfier:prod', SUBSTRATE]]);
  }, PROBE_MS);

  test("MUST-FAIL (a): org_defaulted writes no leaf VPM or signature row under 'public', still credits the producer under its own org, and counts the skip", () => {
    const r = probe('leaf', { trace: leafTrace({ org_defaulted: true }), orgId: 'public', table: PRODUCER_TABLE });
    expect(r.writes.filter((w) => w.kind === 'leaf')).toEqual([]);
    expect(r.writes.filter((w) => w.kind === 'cts')).toEqual([]);
    expect(r.writes.filter((w) => w.kind === 'ancestor').map((w) => [w.activity_id, w.org_id])).toEqual([['satisfier:prod', SUBSTRATE]]);
    expect((r.after.leaf_skipped_default_org ?? -1) - (r.before.leaf_skipped_default_org ?? 0)).toBe(1);
  }, PROBE_MS);

  test('CONTROL: a graded failure on a known org runs the shape counter, the decision outcome and the relevance penalty', () => {
    const r = probe('leaf', { trace: failedLeafTrace(), orgId: 'public', table: PRODUCER_TABLE });
    expect(kinds(r, 'leaf')).toHaveLength(1);
    expect(kinds(r, 'shape_count').length).toBeGreaterThan(0);
    expect(kinds(r, 'decision').length).toBeGreaterThan(0);
    expect(kinds(r, 'relevance').map((w) => w.org_id)).toEqual(['public']);
    expect(kinds(r, 'ancestor').map((w) => [w.activity_id, w.org_id])).toEqual([['satisfier:prod', SUBSTRATE]]);
  }, PROBE_MS);

  test('MUST-FAIL (a2): with org_defaulted none of the shape counter, decision outcome or relevance penalty runs; the producer is still blamed under its own org', () => {
    const r = probe('leaf', { trace: failedLeafTrace({ org_defaulted: true }), orgId: 'public', table: PRODUCER_TABLE });
    expect(kinds(r, 'leaf')).toEqual([]);
    expect(kinds(r, 'shape_count')).toEqual([]);
    expect(kinds(r, 'decision')).toEqual([]);
    expect(kinds(r, 'relevance')).toEqual([]);
    expect(kinds(r, 'ancestor').map((w) => [w.activity_id, w.org_id])).toEqual([['satisfier:prod', SUBSTRATE]]);
  }, PROBE_MS);

  test('MUST-FAIL (b): a producer row carrying org_defaulted gets no ancestor write and counts org-unresolved', () => {
    const r = probe('chain', { table: { 'exec-prod': { variant_id: 'satisfier:prod', org_id: 'public', org_defaulted: true } }, consumerOrg: SUBSTRATE });
    expect(r.writes).toEqual([]);
    expect((r.after.chain_ancestor_org_unresolved ?? -1) - (r.before.chain_ancestor_org_unresolved ?? 0)).toBe(1);
    expect((r.after.chain_ancestor_hits ?? -1) - (r.before.chain_ancestor_hits ?? 0)).toBe(0);
  }, PROBE_MS);

  test("CONTROL (b): a producer whose real org is 'public' (not defaulted) is credited", () => {
    const r = probe('chain', { table: { 'exec-prod': { variant_id: 'satisfier:prod', org_id: 'public' } }, consumerOrg: SUBSTRATE });
    expect(r.writes.map((w) => [w.activity_id, w.org_id])).toEqual([['satisfier:prod', 'public']]);
  }, PROBE_MS);
});
