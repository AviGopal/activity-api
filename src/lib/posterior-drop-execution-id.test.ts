/**
 * A DROPPED POSTERIOR DELTA NAMES THE EXECUTIONS IT CAME FROM (check-first).
 *
 * The `posterior_delta_dropped_no_row` WARN carried variant, org and deltas but no execution id, so attributing the
 * ~36/h 'public' drops on node 1 meant reading the journal line BEFORE each drop (50/56 followed a
 * POST /v2/goal-paths, 6 a late reach grading) — attribution by adjacency, which a concurrent flush breaks.
 *
 * The coalesced flush folds several executions into one Σδ write, so the line carries a BOUNDED list:
 * `execution_ids` (the first 5 distinct ids folded into that row's delta) plus `execution_ids_overflow` (how many more).
 * The ring record served in posteriorCreditCounters.recent_drops carries the same list.
 *
 * In-process: surrealDB.query is replaced by a recorder whose UPDATE matches no row. Coalescing is ON (the default),
 * so the drop is the flush's. Nothing connects to a database.
 */
import { describe, expect, test } from 'bun:test';
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
  test('runs isolated in its own bun process (2 cases)', () => {
    const root = pathJoin(import.meta.dir, '..', '..');
    const r = Bun.spawnSync(['bun', 'test', './' + pathRelative(root, import.meta.path)], {
      cwd: root,
      env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '', [ISOLATED_ENV]: import.meta.path },
      stdout: 'pipe', stderr: 'pipe', timeout: 240_000,
    });
    const out = (r.stdout.toString() + '\n' + r.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, '');
    const count = (k: string) => Number(out.match(new RegExp(`^\\s*(\\d+) ${k}\\s*$`, 'm'))?.[1] ?? -1);
    expect({ exit: r.exitCode, pass: count('pass'), fail: count('fail') }, out.split('\n').filter((l) => !l.startsWith('{') && !/^\d{4}-\d\d-\d\dT/.test(l)).join('\n').slice(-4000))
      .toEqual({ exit: 0, pass: 2, fail: 0 });
  }, 250_000);
}

if (ISOLATED) {
  process.env.SURREALDB_NAMESPACE ??= 'activity-system';
  process.env.SURREALDB_DATABASE ??= 'learning_loop';
  process.env.SURREALDB_URL = 'http://127.0.0.1:9';
  process.env.SURREALDB_USERNAME ??= 'test';
  process.env.SURREALDB_PASSWORD ??= 'test';
  delete process.env.POSTERIOR_COALESCE;

  describe('posterior_delta_dropped_no_row carries execution_id', () => {
    test('a flushed delta that matched no row logs the execution ids folded into it, bounded to 5', async () => {
      const { surrealDB } = await import('../db/surreal');
      const { logger } = await import('../utils/logger');
      (surrealDB as unknown as { query: unknown }).query = async () => [];
      // posterior-update first: it and posterior-aggregator import each other.
      const PU = await import('./posterior-update');
      const AGG = await import('./posterior-aggregator');
      const drops: Array<Record<string, unknown>> = [];
      const origWarn = logger.warn.bind(logger);
      (logger as unknown as { warn: unknown }).warn = (msg: string, ctx?: Record<string, unknown>) => {
        if (ctx?.event === 'posterior_delta_dropped_no_row') drops.push(ctx);
        origWarn(msg, ctx);
      };
      try {
        // One execution on its own row.
        expect(AGG.enqueueVariantDelta('v-one', 'public', 0, 1, 'leaf', undefined, 'exec-solo')).toBe(true);
        // Seven executions (one repeated) folded into one hot row's Σδ.
        for (const id of ['e1', 'e2', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']) AGG.enqueueVariantDelta('v-hot', 'public', 0, 1, 'leaf', undefined, id);
        await AGG.flushPosteriors();
        const solo = drops.find((d) => d.variant_id === 'v-one');
        const hot = drops.find((d) => d.variant_id === 'v-hot');
        expect(solo?.execution_ids).toEqual(['exec-solo']);
        expect(solo?.execution_ids_overflow).toBe(0);
        expect(hot?.execution_ids).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
        expect(hot?.execution_ids_overflow).toBe(2);
        const ring = PU.resolvePosteriorCreditCounters().body.recent_drops.find((d) => d.variant_id === 'v-hot') as unknown as Record<string, unknown>;
        expect(ring.execution_ids).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
      } finally {
        (logger as unknown as { warn: unknown }).warn = origWarn;
      }
    }, 30_000);

    test('the synchronous ancestor fallback names its execution too', async () => {
      const { logger } = await import('../utils/logger');
      const AGG = await import('./posterior-aggregator');
      const drops: Array<Record<string, unknown>> = [];
      const origWarn = logger.warn.bind(logger);
      (logger as unknown as { warn: unknown }).warn = (msg: string, ctx?: Record<string, unknown>) => {
        if (ctx?.event === 'posterior_delta_dropped_no_row') drops.push(ctx);
        origWarn(msg, ctx);
      };
      try {
        const db = { query: async () => [] };
        await AGG.recordNoRowDrop(db as never, 'v-anc', 'organizations:o', ['ancestor'], 0.5, 0, ['exec-anc']);
        expect(drops.find((d) => d.variant_id === 'v-anc')?.execution_ids).toEqual(['exec-anc']);
      } finally {
        (logger as unknown as { warn: unknown }).warn = origWarn;
      }
    });
  });
}
