/**
 * accelerator-flag-tick — SF_BLEND must have an OFF path.
 *
 * Why this must hold (REALIGNMENT/WIRING step 1(b); WIRING-ADDENDUM C1 and §5(a)):
 *   evaluateSfBlend (8972cda) turns SF_BLEND on once successor_features holds >= 200 rows and
 *   then computes `next = current === 1 ? 1 : desired`, so once on it can never go off. A row
 *   count is not evidence that the psi blend helps reach (law 12; goal-host psi-inputs.ts says
 *   the blend must be enabled "against observed values, not ahead of them"). And an operator
 *   writing SF_BLEND=0 cannot turn it off either: the tick reads 0, recomputes desired=1 from
 *   the row count, and writes 1 back on the next tick.
 *
 * Contract under test (the minimal shape of the §5(a) reach-graded A/B outcome):
 *   a recorded verdict lives in the `substrate_tuning_param` row `SF_BLEND_VERDICT`, read through
 *   the reader the tick already uses (getTuningParam). Value 0 = the evidence says OFF; value 1
 *   = the evidence says ON; no row = no verdict yet (today's row-count behaviour is unchanged).
 *   With an OFF verdict present the tick writes SF_BLEND=0, and it stays 0 on later ticks for as
 *   long as the verdict stands, however many successor_features rows exist.
 *   The verdict is a distinct row because SF_BLEND=0 cannot carry it: the tick cannot tell an
 *   authored 0 from the absent-row default 0.
 *
 * Seams: spyOn the real `surrealDB.query` export over an in-memory substrate_tuning_param table
 * (restored after each test). No mock.module, no DB.
 */
import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { surrealDB } from '../db/surreal';
import { __clearTuningParamCache } from '../lib/tuning-params';
import { runAcceleratorFlagTick } from './accelerator-flag-tick';

const SF_ROWS_ABOVE_THRESHOLD = 250;

describe('accelerator-flag-tick: SF_BLEND has an off path', () => {
  let querySpy: ReturnType<typeof spyOn> | null = null;
  let tuning: Map<string, number>;
  let sfBlendWrites: number[];

  beforeEach(() => {
    __clearTuningParamCache();
    tuning = new Map();
    sfBlendWrites = [];
    querySpy = spyOn(surrealDB, 'query').mockImplementation((async (sql: string, params: Record<string, unknown> = {}) => {
      if (/FROM\s+substrate_tuning_param\b/i.test(sql) && /^\s*SELECT/i.test(sql)) {
        const name = String(params.name);
        return tuning.has(name) ? [{ param_value: tuning.get(name)! }] : [];
      }
      if (/^\s*UPSERT\s+substrate_tuning_param\b/i.test(sql)) {
        const name = String(params.name);
        const value = Number(params.value);
        tuning.set(name, value);
        if (name === 'SF_BLEND') sfBlendWrites.push(value);
        return [{ name, value }];
      }
      if (/FROM\s+successor_features\b/i.test(sql)) return [{ count: SF_ROWS_ABOVE_THRESHOLD }];
      return []; // the other two flags' evidence queries: no rows
    }) as any);
  });

  afterEach(() => {
    querySpy?.mockRestore();
    querySpy = null;
    __clearTuningParamCache();
  });

  async function tickSfBlend() {
    __clearTuningParamCache(); // ticks are an hour apart; the 30s cache never spans two
    const results = await runAcceleratorFlagTick();
    const sf = results.find((r) => r.flag === 'SF_BLEND');
    expect(sf).toBeDefined(); // a thrown evaluation is swallowed by the tick; refuse that as a pass
    return sf!;
  }

  test('CHECK: with SF_BLEND on and a recorded off verdict, the tick turns it off and it stays off', async () => {
    tuning.set('SF_BLEND', 1);
    tuning.set('SF_BLEND_VERDICT', 0);

    const first = await tickSfBlend();
    expect(first.value).toBe(0);
    expect(tuning.get('SF_BLEND')).toBe(0);

    const second = await tickSfBlend();
    expect(second.value).toBe(0);
    expect(tuning.get('SF_BLEND')).toBe(0);
    expect(sfBlendWrites).not.toContain(1); // never re-latched on by the row count
  });

  test('CONTROL: with no verdict and rows >= 200, SF_BLEND that is on stays on', async () => {
    tuning.set('SF_BLEND', 1);
    const r = await tickSfBlend();
    expect(r.value).toBe(1);
    expect(r.flipped).toBe(false);
    expect(tuning.get('SF_BLEND')).toBe(1);
    expect(sfBlendWrites).toEqual([]);
  });

  test('CONTROL: with no verdict and rows >= 200, SF_BLEND that is unset is switched on', async () => {
    const r = await tickSfBlend();
    expect(r.value).toBe(1);
    expect(r.flipped).toBe(true);
    expect(tuning.get('SF_BLEND')).toBe(1);
  });
});
