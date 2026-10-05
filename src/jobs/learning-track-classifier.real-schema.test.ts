// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

/**
 * The learning-track classifier cycle must not pay one or more statements per template it lists,
 * checked against a REAL SurrealDB carrying the schema init-database.ts builds.
 *
 * Gap learning-track-classifier-reads-each-template-row-again-after-the-cycle-already-listed-it:
 * runClassifierCycle lists up to 2000 due templates and classifyOneTemplate re-reads each row by
 * id (~2,000 reads per cycle on the hub). The sibling n1 test counts statements matching the regex
 * `FROM activity WHERE id = $id` against a fake DB. A rewrite of the same read (`FROM $id`,
 * `type::thing('activity', $id)`, queryAll, queryRaw) escapes the regex and keeps the N+1.
 *
 * Here the property is counted, not pattern-matched: every statement the code sends through the
 * SDK is recorded (whatever client method it used), and the count is compared between a cycle over
 * 5 due templates and one over 50. A per-template statement of any syntax shows up as a difference.
 *
 * Why a real DB matters for THIS file: the cycle hands classifyOneTemplate the ids the listing
 * returned, and the SurrealDB SDK returns those as RecordId objects, not strings. A fake DB that
 * returns string ids hides that (measured at a79e70c): the in-process cadence map is keyed by a
 * fresh RecordId each cycle, so it never hits and an in-cadence cycle re-reads every template.
 * The first case below therefore requires the cadence guard to actually skip in-cadence templates
 * without a statement, and the second requires no row re-read on a first cycle.
 *
 * Needs the `surreal` binary on PATH (present in the substrate image); if it is missing the
 * instrument case FAILS rather than skipping.
 */

let rs: RealSurreal | null = null;
let startError = '';
let runClassifierCycle: () => Promise<{ evaluated: number }>;

const word = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => String.fromCharCode(97 + (b % 26))).join('');

/** Empty the template and digest tables, then seed `n` due templates (never classified). Returns their ids. */
async function seedDue(n: number, extra = ''): Promise<string[]> {
  await rs!.sql('DELETE activity; DELETE trace_digest;');
  const ids = Array.from({ length: n }, () => `tpl-${word()}`);
  await rs!.sql(ids.map((id) => `CREATE type::thing('activity', '${id}') CONTENT { name: '${id}', input_shapes: [], output_shapes: [], execution_type: 'template', scope: 'global', public: true, org_id: 'organizations:o1', created_at: time::now(), updated_at: time::now(), learning_track: 'unclassified' ${extra} };`).join('\n'));
  return ids;
}

/** Statements recorded while running one cycle. */
async function countedCycle(): Promise<{ statements: number; evaluated: number; sql: string[] }> {
  rs!.calls.length = 0;
  const r = await runClassifierCycle();
  const sql = rs!.calls.map((c) => `${c.sql} ${JSON.stringify(c.params ?? {})}`);
  return { statements: rs!.calls.length, evaluated: r.evaluated, sql };
}

beforeAll(async () => {
  try {
    rs = await startRealSurreal();
    await rs.connectModuleClient();
    ({ runClassifierCycle } = await import('./learning-track-classifier'));
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);

afterAll(async () => { await rs?.stop(); });

describe('learning-track classifier over the real schema: cycle cost does not grow with the due set', () => {
  it('instrument: surreal started, the activity and trace_digest tables carry the fields the classifier reads', async () => {
    expect(startError).toBe('');
    const a = Object.keys((await rs!.sql('INFO FOR TABLE activity;'))[0].result.fields ?? {});
    for (const f of ['execution_type', 'learning_track', 'last_classified_at', 'output_shapes']) expect(a).toContain(f);
    const d = Object.keys((await rs!.sql('INFO FOR TABLE trace_digest;'))[0].result.fields ?? {});
    for (const f of ['activity_id', 'task_summaries', 'output_impulse_shapes', 'executed_at']) expect(d).toContain(f);
  }, 60_000);

  it('an in-cadence cycle issues the same number of statements over 5 and over 50 due templates', async () => {
    await seedDue(5);
    await countedCycle(); // first cycle: evaluates each template once
    const small = await countedCycle(); // within cadence: nothing is due for re-evaluation
    await seedDue(50);
    await countedCycle();
    const large = await countedCycle();
    expect(small.evaluated).toBe(5);
    expect(large.evaluated).toBe(50);
    expect(large.statements).toBe(small.statements);
  }, 120_000);

  it('a first cycle costs at most one statement per newly due template beyond the listing (no row re-read)', async () => {
    await seedDue(5);
    const small = await countedCycle();
    await seedDue(50);
    const large = await countedCycle();
    // 45 more templates may cost one trace_digest read each, and nothing else.
    expect(large.statements - small.statements).toBeLessThanOrEqual(45);
  }, 120_000);

  it('control: a first cycle evaluates every due template and consults the trace digest for each of them', async () => {
    const ids = await seedDue(7);
    const c = await countedCycle();
    expect(c.evaluated).toBe(7);
    const digestReads = c.sql.filter((s) => /trace_digest/i.test(s)).join('\n');
    for (const id of ids) expect(digestReads).toContain(id);
  }, 60_000);

  it('control: a template the store says was classified within the cadence is not listed or evaluated', async () => {
    await seedDue(4);
    const fresh = `tpl-${word()}`;
    await rs!.sql(`CREATE type::thing('activity', '${fresh}') CONTENT { name: '${fresh}', input_shapes: [], output_shapes: [], execution_type: 'template', scope: 'global', public: true, org_id: 'organizations:o1', created_at: time::now(), updated_at: time::now(), learning_track: 'learning', last_classified_at: time::now() - 1h };`);
    const c = await countedCycle();
    expect(c.evaluated).toBe(4);
    expect(c.sql.filter((s) => !/execution_type/.test(s)).join('\n')).not.toContain(fresh);
  }, 60_000);
});
