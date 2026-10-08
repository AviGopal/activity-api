/**
 * A LATE REACH VERDICT MUST NOT GRADE A LEAF UNDER THE PRE-FIX 'public' DEFAULT (check-first).
 *
 * MEASURED (node 1, 031e8a2): 6 of 56 leaf drops under org 'public' immediately followed
 * "[reach-patch] late reach verdict graded". POST /reach flags org_defaulted only when the stored row carries
 * metadata.org_defaulted or has no string org. Rows stored BEFORE the poster fix carry neither: the old handler wrote
 * the bare literal `body.org_id || jwtAuth?.orgId || session?.org_id || 'public'` and no flag, so their late verdicts
 * still graded the leaf under 'public'.
 *
 * Bare 'public' is only ever the fallback: identity-vessel issues orgs in record form (`organizations:<slug>`), and
 * no producer sends a bare 'public'. So a bare 'public' with no resolved flag is a guess. `organizations:public` is
 * NOT treated so: identity's signup derives `organizations:<slug>` from the org name with no reserved slugs, so it
 * can be a real tenant.
 *
 * In-process: surrealDB.query is replaced by a recorder that answers the pre-read; POSTERIOR_COALESCE=0 so the leaf
 * write is the synchronous UPDATE through that recorder. Nothing connects to a database.
 *   MUST-FAIL: pre-fix row (org 'public', no flag), reached:false ⇒ no leaf write; leaf_skipped_default_org +1.
 *   CONTROL: organizations:substrate ⇒ the leaf write lands under it; organizations:public ⇒ lands under it too.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { join as pathJoin, relative as pathRelative } from 'node:path';

// RUNS IN ITS OWN bun PROCESS. This file reads module-level state that other files in one `bun test` process set
// first and never reset: posterior-aggregator caches POSTERIOR_COALESCE at its first import (a file that sets it to
// '0' turns coalescing off for every later file), and the surrealDB client and logger are process-wide singletons that
// several suites mock or patch. So when this file is part of a larger run it registers ONE test that re-runs this file
// alone in a child `bun test` with a clean env, and asserts the child's counts; the real cases run only in the child,
// and set their env, patch the db and import the modules only there — nothing leaks back into the parent either.
const ISOLATED_ENV = 'ACTIVITY_API_ISOLATED_TEST';
const ISOLATED = process.env[ISOLATED_ENV] === import.meta.path;
if (!ISOLATED) {
  test('runs isolated in its own bun process (4 cases)', () => {
    const root = pathJoin(import.meta.dir, '..', '..');
    const r = Bun.spawnSync(['bun', 'test', './' + pathRelative(root, import.meta.path)], {
      cwd: root,
      env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '', [ISOLATED_ENV]: import.meta.path },
      stdout: 'pipe', stderr: 'pipe', timeout: 240_000,
    });
    const out = (r.stdout.toString() + '\n' + r.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, '');
    const count = (k: string) => Number(out.match(new RegExp(`^\\s*(\\d+) ${k}\\s*$`, 'm'))?.[1] ?? -1);
    expect({ exit: r.exitCode, pass: count('pass'), fail: count('fail') }, out.split('\n').filter((l) => !l.startsWith('{') && !/^\d{4}-\d\d-\d\dT/.test(l)).join('\n').slice(-4000))
      .toEqual({ exit: 0, pass: 4, fail: 0 });
  }, 250_000);
}

if (ISOLATED) {
  process.env.SURREALDB_NAMESPACE ??= 'activity-system';
  process.env.SURREALDB_DATABASE ??= 'learning_loop';
  process.env.SURREALDB_URL = 'http://127.0.0.1:9';
  process.env.SURREALDB_USERNAME ??= 'test';
  process.env.SURREALDB_PASSWORD ??= 'test';
  process.env.POSTERIOR_COALESCE = '0';
  process.env.PRIOR_SEED_ENABLED = 'false';
  process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';

  type LeafWrite = { activity_id: unknown; org_id: unknown };
  let rows: Record<string, Record<string, unknown>> = {};
  const leafWrites: LeafWrite[] = [];
  let ET: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
  let PU: typeof import('../lib/posterior-update');

  beforeAll(async () => {
    const { surrealDB } = await import('../db/surreal');
    (surrealDB as unknown as { query: unknown }).query = async (sql: string, vars?: Record<string, unknown>) => {
      if (/^\s*SELECT variant_id, activity_id, success, tags/.test(sql) && /type::thing\('execution', \$execution_id\)/.test(sql)) {
        const r = rows[String(vars?.execution_id)];
        return r ? [r] : [];
      }
      if (/UPDATE variant_performance_metrics/.test(sql) && vars && 'new_alpha' in vars) {
        leafWrites.push({ activity_id: vars.activity_id, org_id: vars.org_id });
        return [{ id: 'variant_performance_metrics:x' }];
      }
      return [];
    };
    // Route first: posterior-update and posterior-aggregator import each other.
    ET = (await import('./execution-traces')).default as typeof ET;
    PU = await import('../lib/posterior-update');
  });

  const skipped = () => PU.resolvePosteriorCreditCounters().body.leaf_skipped_default_org;

  async function grade(execId: string, org: unknown, extra: Record<string, unknown> = {}) {
    rows[execId] = { activity_id: `act-${execId}`, success: true, tags: ['dispatcher_used:goal-host'], cost_usd: 0, ...(org === undefined ? {} : { org_id: org }), ...extra };
    const before = { writes: leafWrites.length, skipped: skipped() };
    const res = await ET.request('/reach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ execution_id: execId, reached: false }) });
    expect(res.status).toBe(200);
    // The credit call is fire-and-forget: wait (bounded) for either outcome.
    for (let i = 0; i < 150 && leafWrites.length === before.writes && skipped() === before.skipped; i++) await new Promise((r) => setTimeout(r, 20));
    return { writes: leafWrites.slice(before.writes), skippedDelta: skipped() - before.skipped };
  }

  describe('MUST-FAIL — a pre-fix row stored under the bare \'public\' default is graded as org-defaulted', () => {
    test("org 'public', no metadata.org_defaulted ⇒ no leaf write, counted leaf_skipped_default_org", async () => {
      const r = await grade('exec-prefix-public', 'public');
      expect(r.writes).toEqual([]);
      expect(r.skippedDelta).toBe(1);
    }, 30_000);
  });

  describe('CONTROL — a known org is graded under that org', () => {
    test('organizations:substrate ⇒ the leaf write lands under it', async () => {
      const r = await grade('exec-known-org', 'organizations:substrate');
      expect(r.writes).toEqual([{ activity_id: 'act-exec-known-org', org_id: 'organizations:substrate' }]);
      expect(r.skippedDelta).toBe(0);
    }, 30_000);

    test('organizations:public is a mintable tenant, not the fallback ⇒ graded under it', async () => {
      const r = await grade('exec-record-public', 'organizations:public');
      expect(r.writes).toEqual([{ activity_id: 'act-exec-record-public', org_id: 'organizations:public' }]);
      expect(r.skippedDelta).toBe(0);
    }, 30_000);

    test('an already-flagged row is still skipped (the poster fix, unchanged)', async () => {
      const r = await grade('exec-flagged', 'public', { org_defaulted: true });
      expect(r.writes).toEqual([]);
      expect(r.skippedDelta).toBe(1);
    }, 30_000);
  });
}
