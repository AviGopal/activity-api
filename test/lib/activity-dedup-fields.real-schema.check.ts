// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../support/real-surreal';

/**
 * coherence-recover's demotion marker must PERSIST, checked against a REAL SurrealDB carrying the schema
 * init-database.ts builds.
 *
 * `activity` is SCHEMAFULL. coherence-recover writes `SET proposed = true, deduped_into = <canonical>, deduped_at =
 * time::now()`, and SurrealDB silently drops fields a SCHEMAFULL table does not declare while still returning OK. On
 * node 1 (2026-10-07) neither field existed, so 813 live runs and 20,871 demotions kept only proposed=true: no
 * demotion recorded its canonical or its time, which hid a promote/demote loop from any audit.
 *
 * Needs the `surreal` binary on PATH; if it is missing every test FAILS rather than skipping.
 * NOT IN TEST DISCOVERY (named .check.ts, run by path), for the reason the sibling real-schema checks state.
 */
let rs: RealSurreal | null = null;
let startError = '';
beforeAll(async () => {
  try { rs = await startRealSurreal(); } catch (e) { startError = e instanceof Error ? e.message : String(e); }
}, 300_000);
afterAll(async () => { await rs?.stop(); });

describe('activity declares the fields coherence-recover writes', () => {
  it('instrument: a real SurrealDB with the real schema started and activity is SCHEMAFULL', async () => {
    expect(startError).toBe('');
    const r = await rs!.sql('INFO FOR DB;');
    expect(String(r[0]?.result?.tables?.activity ?? '')).toContain('SCHEMAFULL');
  });

  it('MUST-FAIL: activity declares deduped_into and deduped_at, so a demotion keeps its canonical and its time', async () => {
    expect(startError).toBe('');
    const r = await rs!.sql('INFO FOR TABLE activity;');
    const fields = Object.keys(r[0]?.result?.fields ?? {});
    expect(fields).toContain('deduped_into');
    expect(fields).toContain('deduped_at');
  });
});
