/**
 * THE FLUSH TIMER STOPS WHEN THE QUEUE IS IDLE, AND A FLUSH ISSUED DURING ANOTHER WAITS FOR IT (check-first).
 *
 * The aggregator's flush interval was started by the first enqueue and never cleared, so once any file in a process
 * had enqueued a delta the timer ticked for the rest of the process, flushing through whatever store each later file
 * had in place. And flushPosteriors returned at once while a flush was running, so a caller that enqueued, flushed
 * and then read the store could read before its own delta was written.
 *
 * In-process: surrealDB.query is replaced by a recorder whose SELECT answers one row and whose UPDATE matches it.
 * The interval is observed by wrapping setInterval/clearInterval before the aggregator is imported.
 *   MUST-FAIL: after the last enqueue and its flush, the aggregator's interval is cleared within a few ticks.
 *   MUST-FAIL: a flush issued while another is running resolves only after the delta enqueued meanwhile is written.
 *   CONTROL:   one flush with nothing running writes its delta before it resolves (both before and after the fix).
 */
import { describe, expect, test } from 'bun:test';
import { join as pathJoin, relative as pathRelative } from 'node:path';

// RUNS IN ITS OWN bun PROCESS (the posterior-drop-execution-id pattern): it wraps the timer globals and patches the
// surrealDB singleton, and reads the aggregator's module-level queue and timer, which other files share.
const ISOLATED_ENV = 'ACTIVITY_API_ISOLATED_TEST';
const ISOLATED = process.env[ISOLATED_ENV] === import.meta.path;
if (!ISOLATED) {
  test('runs isolated in its own bun process (3 cases)', () => {
    const root = pathJoin(import.meta.dir, '..', '..');
    const r = Bun.spawnSync(['bun', 'test', './' + pathRelative(root, import.meta.path)], {
      cwd: root,
      env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '', [ISOLATED_ENV]: import.meta.path },
      stdout: 'pipe', stderr: 'pipe', timeout: 240_000,
    });
    const out = (r.stdout.toString() + '\n' + r.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, '');
    const count = (k: string) => Number(out.match(new RegExp(`^\\s*(\\d+) ${k}\\s*$`, 'm'))?.[1] ?? -1);
    expect({ exit: r.exitCode, pass: count('pass'), fail: count('fail') }, out.split('\n').filter((l) => !l.startsWith('{') && !/^\d{4}-\d\d-\d\dT/.test(l)).join('\n').slice(-4000))
      .toEqual({ exit: 0, pass: 3, fail: 0 });
  }, 250_000);
}

if (ISOLATED) {
  process.env.SURREALDB_NAMESPACE ??= 'activity-system';
  process.env.SURREALDB_DATABASE ??= 'learning_loop';
  process.env.SURREALDB_URL = 'http://127.0.0.1:9';
  process.env.SURREALDB_USERNAME ??= 'test';
  process.env.SURREALDB_PASSWORD ??= 'test';
  delete process.env.POSTERIOR_COALESCE;
  delete process.env.POSTERIOR_FLUSH_MS;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const updates: Array<{ variant: string; alpha: number }> = [];
  /** While set, the SELECT pre-read waits on it: a flush held in flight. */
  let hold: Promise<void> | null = null;

  // Every interval created from here on, and every one cleared. The aggregator's are the ones an enqueue creates.
  const created: unknown[] = [];
  const aggregatorTimers: unknown[] = [];
  const cleared = new Set<unknown>();
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const h = realSetInterval(fn, ms, ...rest);
    created.push(h);
    return h;
  }) as typeof setInterval;
  globalThis.clearInterval = ((h: unknown) => {
    cleared.add(h);
    realClearInterval(h as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;

  const { surrealDB } = await import('../db/surreal');
  (surrealDB as unknown as { query: unknown }).query = async (sql: string, params: Record<string, unknown> = {}) => {
    if (/^\s*SELECT thompson_alpha, thompson_beta, updated_at FROM variant_performance_metrics/.test(sql)) {
      if (hold) await hold;
      return [{ thompson_alpha: 1, thompson_beta: 1, updated_at: new Date().toISOString() }];
    }
    if (/UPDATE variant_performance_metrics/.test(sql)) {
      updates.push({ variant: String(params.activity_id), alpha: Number(params.new_alpha) });
      return [{ id: 'variant_performance_metrics:x' }];
    }
    return [];
  };
  // posterior-update first: it and posterior-aggregator import each other.
  await import('./posterior-update');
  const AGG = await import('./posterior-aggregator');
  const enqueue = (variant: string, executionId: string): boolean => {
    const before = created.length;
    const ok = AGG.enqueueVariantDelta(variant, 'public', 1, 0, 'leaf', undefined, executionId);
    aggregatorTimers.push(...created.slice(before));
    return ok;
  };

  describe('posterior-aggregator flush timer and in-flight flush', () => {
    test('CONTROL: one flush with nothing running writes its delta before it resolves', async () => {
      expect(enqueue('v-control', 'e-control')).toBe(true);
      await AGG.flushPosteriors();
      expect(updates.filter((u) => u.variant === 'v-control')).toHaveLength(1);
    }, 30_000);

    test('MUST-FAIL: a flush issued while another runs waits for it and writes the delta enqueued meanwhile', async () => {
      let release!: () => void;
      hold = new Promise<void>((r) => { release = r; });
      expect(enqueue('v-first', 'e-first')).toBe(true);
      const first = AGG.flushPosteriors();
      await sleep(20); // the first flush has taken its batch and waits on the pre-read
      expect(enqueue('v-second', 'e-second')).toBe(true);
      setTimeout(() => { hold = null; release(); }, 150);
      await AGG.flushPosteriors();
      expect(updates.filter((u) => u.variant === 'v-second')).toHaveLength(1);
      expect(updates.filter((u) => u.variant === 'v-first')).toHaveLength(1);
      await first;
    }, 30_000);

    test('MUST-FAIL: once the queue is idle the flush interval is cleared', async () => {
      expect(enqueue('v-idle', 'e-idle')).toBe(true);
      expect(aggregatorTimers.length).toBeGreaterThan(0); // the first enqueue started the interval
      await AGG.flushPosteriors();
      await sleep(1_000); // four default ticks
      expect(aggregatorTimers.filter((h) => !cleared.has(h))).toHaveLength(0);
    }, 30_000);
  });
}
