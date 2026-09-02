/**
 * THE REACH VERDICT MUST BE VISIBLE, AND AN UNGRADED ROW MUST NOT LOOK FAILED.
 *
 * `reached` is a column on `execution` (migration 160). The compat view every
 * reader goes through — `v_paradigm_execution_traces`, newest definition in
 * migration 167 — does not project it, so the honest completion verdict never
 * reached any consumer of the trace read path. `hydrateReachedVerdicts` closes
 * that by point-looking-up the canonical rows by record id.
 *
 * The property that actually matters is the three-state one. A boolean field
 * hydrated with `||` or `?? false` collapses "graded, did not reach" and "never
 * graded" into the same `false`, which manufactures precisely the false picture
 * this fix exists to remove. So: true survives as true, FALSE SURVIVES AS FALSE,
 * and absent surfaces as null — including when the lookup itself fails.
 *
 * And it is additive: a consumer reading the old projection must see exactly what
 * it saw before.
 */

import { describe, test, expect } from 'bun:test';

// execution-traces.ts loads the DB config at import time and throws without
// these. Set BEFORE the import — the same constraint every colocated route test
// in this vessel has. No connection is made: hydrateReachedVerdicts takes its
// query function as an argument, and importing the REAL module is the point.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= 'http://127.0.0.1:8000';
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';

const { hydrateReachedVerdicts } = await import('./execution-traces');

const row = (execution_id: string, extra: Record<string, unknown> = {}) => ({
  id: `v_paradigm_execution_traces:${execution_id}`,
  execution_id,
  activity_id: 'feature_compose',
  status: 'completed',
  success: true,
  duration_ms: 1234,
  cost_usd: 0.01,
  tags: ['dispatcher_used:goal-host'],
  metadata: { task_count: 3 },
  ...extra,
});

describe('hydrateReachedVerdicts', () => {
  test('surfaces true, false and ungraded as three distinct states', async () => {
    const rows = [row('exec_a'), row('exec_b'), row('exec_c')];

    const out = await hydrateReachedVerdicts(rows, async () => [
      { eid: 'exec_a', reached: true },
      { eid: 'exec_b', reached: false },
      // exec_c is present in `execution` but never graded: the column is NONE,
      // which the client hands back as null/undefined. It must NOT become false.
      { eid: 'exec_c', reached: null },
    ]);

    expect(out[0].reached).toBe(true);
    expect(out[1].reached).toBe(false);
    expect(out[2].reached).toBeNull();

    // The distinction is the whole point — assert it rather than trusting the
    // three assertions above to have compared against the right literal.
    expect(out[1].reached).not.toBeNull();
    expect(out[2].reached).not.toBe(false);
  });

  test('a row missing from the lookup entirely surfaces null, not false', async () => {
    const out = await hydrateReachedVerdicts([row('exec_missing')], async () => []);
    expect(out[0].reached).toBeNull();
  });

  test('a FAILED lookup surfaces null for every row — never a fabricated false', async () => {
    const out = await hydrateReachedVerdicts(
      [row('exec_a'), row('exec_b')],
      async () => {
        throw new Error('surrealdb: connection reset');
      },
    );
    expect(out.map((r) => r.reached)).toEqual([null, null]);
  });

  test('does not change any pre-existing field — the projection is purely additive', async () => {
    const original = row('exec_a');
    const before = structuredClone(original);

    const out = await hydrateReachedVerdicts([original], async () => [
      { eid: 'exec_a', reached: true },
    ]);

    // Every old key, byte-identical.
    for (const key of Object.keys(before)) {
      expect(out[0][key]).toEqual((before as any)[key]);
    }
    // Exactly one new key.
    expect(Object.keys(out[0]).filter((k) => !(k in before))).toEqual(['reached']);
    // And the input array was not mutated in place.
    expect(original).toEqual(before as any);
  });

  test('keeps a verdict a unioned `execution` row already carried', async () => {
    // The parent_execution_id union path selects * FROM execution, so those rows
    // arrive with `reached` already on them. An empty point lookup must not wipe it.
    const out = await hydrateReachedVerdicts(
      [row('exec_union', { reached: false })],
      async () => [],
    );
    expect(out[0].reached).toBe(false);
  });

  test('addresses rows by record id, one bounded lookup for the whole page', async () => {
    const seen: string[] = [];
    await hydrateReachedVerdicts(
      [row('exec_a'), row('exec_b'), row('exec_a')],
      async (sql) => {
        seen.push(sql);
        return [];
      },
    );

    expect(seen).toHaveLength(1);
    // Direct record targets: no table scan, no WHERE, no ORDER BY.
    expect(seen[0]).toContain('FROM execution:⟨exec_a⟩, execution:⟨exec_b⟩');
    expect(seen[0]).not.toContain('WHERE');
    // Duplicates deduped.
    expect(seen[0].match(/exec_a/g)).toHaveLength(1);
  });

  test('never queries at all when there is nothing to look up', async () => {
    let called = 0;
    const bump = async () => {
      called++;
      return [];
    };

    expect(await hydrateReachedVerdicts([], bump)).toEqual([]);
    expect(called).toBe(0);

    const noIds = await hydrateReachedVerdicts([{ activity_id: 'x' } as any], bump);
    expect(called).toBe(0);
    expect(noIds[0].reached).toBeNull();
  });

  test('drops an id that could break out of the record-id quoting', async () => {
    // Record ids go into the query TEXT (a record target list is the only way to
    // address N rows by primary key), so an id carrying the ⟨⟩ brackets must be
    // refused outright. Refused means unknown, which means null.
    const seen: string[] = [];
    const out = await hydrateReachedVerdicts(
      [row('exec_ok'), row('exec_⟩; REMOVE TABLE execution; --')],
      async (sql) => {
        seen.push(sql);
        return [{ eid: 'exec_ok', reached: true }];
      },
    );

    expect(seen[0]).not.toContain('REMOVE TABLE');
    expect(seen[0]).toContain('execution:⟨exec_ok⟩');
    expect(out[0].reached).toBe(true);
    expect(out[1].reached).toBeNull();
  });
});
