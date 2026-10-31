/**
 * Score reads come from variant_performance_metrics, the canonical posterior store, and
 * from nothing else.
 *
 * getActivityScores used to try the v_activity_score view first, selected by the
 * PARADIGM_READ_* env flags (on by default), and overlaid the VPM posteriors on the view's
 * rows; getVariantScores did the same without a flag. The view is absent from the live
 * database and SurrealDB reads a missing table as an empty one, so live already ended on the
 * VPM query every time. The view branch was dead in production but still reachable: on any
 * database where the view exists, the row set and the descriptive columns came from
 * exit-status counts, and PARADIGM_READ_NO_FALLBACK=true turned an empty view into "no
 * scores at all". Both branches and the flags are removed; these tests pin that.
 *
 * WHY THE SHIPPED SOURCE IS LOADED THIS WAY. Many test files `mock.module` '../db/surreal'
 * or '../db/paradigm' itself, and the replacement is global and outlives its file, so an
 * import of paradigm.ts in the whole suite can get a mock instead of the code
 * (paradigm.org-id-binding.test.ts explains how that refused the gate twice). So this file
 * transpiles paradigm.ts from disk and runs it with its imports injected: the real function
 * bodies, a recording fake for the database, and no module cache involved. It is
 * order-independent by construction.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(import.meta.dir, 'paradigm.ts'), 'utf8');
const RETIREMENT = readFileSync(join(import.meta.dir, '..', 'lib', 'posterior-retirement.ts'), 'utf8');

const transpiler = new Bun.Transpiler({ loader: 'ts' });
function moduleBody(ts: string): string {
  return transpiler
    .transformSync(ts)
    .replace(/^import\s[\s\S]*?from\s*["'][^"']+["'];?[ \t]*$/gm, '')
    .replace(/^export\s*\{[^}]*\};?[ \t]*$/gm, '')
    .replace(/^export\s+(?=(async\s+)?function|const|let|var|class)/gm, '');
}

const VPM_TENANT_SCOPE_SQL: string = new Function(`"use strict";\n${moduleBody(RETIREMENT)}\nreturn VPM_TENANT_SCOPE_SQL;`)();

interface Fixture {
  vpm: Array<{ variant_id: string; thompson_alpha: number; thompson_beta: number; total_executions: number }>;
  view: Array<{ activity_id: string; alpha: number; beta: number; total_executions: number; successes: number }>;
  env?: Record<string, string>;
}

const bare = (id: string) => String(id).replace(/^activity:/, '').replace(/[⟨⟩`]/g, '');

/** The shipped getActivityScores/getVariantScores, run against a recording fake database. */
function load(fx: Fixture) {
  const seen: string[] = [];
  const query = async (sql: string, params: Record<string, any> = {}) => {
    seen.push(sql);
    const ids = new Set(((params.activity_ids ?? params.variant_ids ?? []) as string[]).map(bare));
    const keep = (id: string) => ids.size === 0 || ids.has(bare(id));
    if (/FROM\s+v_activity_score\b/.test(sql)) {
      return fx.view.filter((r) => keep(r.activity_id)).map((r) => ({
        ...r, success_rate: r.successes / r.total_executions, avg_duration_ms: 1, avg_cost_usd: 0,
      }));
    }
    if (/FROM\s+variant_performance_metrics\b/.test(sql)) {
      const rows = fx.vpm.filter((r) => keep(r.variant_id));
      if (/thompson_alpha\s+AS\s+alpha/.test(sql)) {
        return rows.map((r) => ({
          activity_id: r.variant_id, alpha: r.thompson_alpha, beta: r.thompson_beta,
          total_executions: r.total_executions, success_rate: 0.5, avg_duration_ms: 1, avg_cost_usd: 0,
        }));
      }
      return rows.map((r) => ({ ...r }));
    }
    return [];
  };
  const noop = () => undefined;
  const deps: Record<string, unknown> = {
    surrealDB: { query },
    queryWithAuth: async (_jwt: string, sql: string, params: Record<string, any>) => query(sql, params),
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    counterRowToScore: () => { throw new Error('not used by score reads'); },
    localEmbeddingService: {},
    getEmbeddingProvider: () => { throw new Error('not used by score reads'); },
    resolveLearningTrack: () => { throw new Error('not used by score reads'); },
    VPM_TENANT_SCOPE_SQL,
    process: { env: { ...(fx.env ?? {}) } },
  };
  const names = Object.keys(deps);
  const api = new Function(...names, `"use strict";\n${moduleBody(SOURCE)}\nreturn { getActivityScores, getVariantScores };`)(
    ...names.map((n) => deps[n]),
  );
  return { api, seen, viewReads: () => seen.filter((q) => /\bv_activity_score\b/.test(q)) };
}

const ORG = 'organizations:substrate';
const VPM = [
  { variant_id: 'fix.bug', thompson_alpha: 23.76, thompson_beta: 10.86, total_executions: 33 },
  { variant_id: 'probe.only-in-vpm', thompson_alpha: 2, thompson_beta: 9, total_executions: 9 },
];
// Exit-status counts, as the view computed them: a different row set and different columns.
const VIEW = [
  { activity_id: 'fix.bug', alpha: 31, beta: 3, total_executions: 32, successes: 30 },
  { activity_id: 'view.only', alpha: 5, beta: 1, total_executions: 4, successes: 4 },
];
const EXPECTED = { 'fix.bug': [23.76, 10.86, 33], 'probe.only-in-vpm': [2, 9, 9] };
const byId = (rows: Array<{ activity_id: string; alpha: number; beta: number; total_executions: number }>) =>
  Object.fromEntries(rows.map((r) => [bare(r.activity_id), [r.alpha, r.beta, r.total_executions]]));
const IDS = ['activity:fix.bug', 'activity:probe.only-in-vpm', 'activity:view.only'];

describe('getActivityScores reads variant_performance_metrics only', () => {
  test('[MUST-FAIL] with the view present and default config, rows and posteriors are the VPM rows', async () => {
    const { api } = load({ vpm: VPM, view: VIEW });
    const res = await api.getActivityScores(ORG, IDS, null, null);
    expect(byId(res.data)).toEqual(EXPECTED);
  });

  test('[MUST-FAIL] no query names v_activity_score', async () => {
    const { api, viewReads } = load({ vpm: VPM, view: VIEW });
    await api.getActivityScores(ORG, IDS, null, null);
    await api.getActivityScores(ORG, undefined, 'jwt', 'acct-1');
    expect(viewReads()).toEqual([]);
  });

  test('[MUST-FAIL] PARADIGM_READ_NO_FALLBACK=true has no effect: an empty view still yields the VPM rows', async () => {
    const { api } = load({ vpm: VPM, view: [], env: { PARADIGM_READ_NO_FALLBACK: 'true' } });
    const res = await api.getActivityScores(ORG, IDS, null, null);
    expect(byId(res.data)).toEqual(EXPECTED);
  });

  test('[CONTROL] the live case (view absent, reads empty): the VPM posteriors, as before', async () => {
    const { api, seen } = load({ vpm: VPM, view: [] });
    const res = await api.getActivityScores(ORG, IDS, null, null);
    expect(byId(res.data)).toEqual(EXPECTED);
    expect(res.path).toBe('legacy');
    expect(seen.some((q) => /FROM\s+variant_performance_metrics\b/.test(q))).toBe(true);
  });
});

describe('getVariantScores reads variant_performance_metrics only', () => {
  test('[MUST-FAIL] with the view present, rows and posteriors are the VPM rows', async () => {
    const { api } = load({ vpm: VPM, view: VIEW });
    const res = await api.getVariantScores(['fix.bug', 'probe.only-in-vpm', 'view.only'], ORG, null, null);
    expect(byId(res.data)).toEqual(EXPECTED);
  });

  test('[MUST-FAIL] no query names v_activity_score', async () => {
    const { api, viewReads } = load({ vpm: VPM, view: VIEW });
    await api.getVariantScores(['fix.bug'], ORG, 'jwt', 'acct-1');
    expect(viewReads()).toEqual([]);
  });

  test('[CONTROL] the live case (view absent, reads empty): the VPM posteriors, as before', async () => {
    const { api } = load({ vpm: VPM, view: [] });
    const res = await api.getVariantScores(['fix.bug', 'probe.only-in-vpm'], ORG, null, null);
    expect(byId(res.data)).toEqual(EXPECTED);
    expect(res.path).toBe('new');
  });

  test('[CONTROL] no ids, no query', async () => {
    const { api, seen } = load({ vpm: VPM, view: VIEW });
    const res = await api.getVariantScores([], ORG, null, null);
    expect(res.data).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe('the PARADIGM_READ_* env flags are gone (law 1)', () => {
  const envReads = (src: string) => [...src.matchAll(/process\.env\.(PARADIGM_READ_\w+)/g)].map((m) => m[1]);

  test('[MUST-FAIL] paradigm.ts reads no PARADIGM_READ_* env name', () => {
    expect(envReads(SOURCE)).toEqual([]);
  });

  test('NEGATIVE CONTROL: the matcher sees such a read', () => {
    expect(envReads('const v = process.env.PARADIGM_READ_ENABLED;')).toEqual(['PARADIGM_READ_ENABLED']);
  });
});
