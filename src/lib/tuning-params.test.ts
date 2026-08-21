/**
 * writeTuningParam / getTuningParam — the write must not be able to no-op.
 *
 * Seam L3-tuning-06. `updated_by` and `evidence` are `option<string>`
 * (migration 152). SurrealDB accepts NONE for those and REJECTS NULL, and the
 * two UPSERT branches diverge on that rejection: the UPDATE branch raises
 * loudly, but the CREATE branch writes nothing and RAISES NOTHING, returning an
 * empty result set. The awaited promise resolved, and the caller logged success
 * over a row that did not exist.
 *
 * `accelerator-flag-tick` calls `writeTuningParam(flag, next)` with no meta at
 * all, so SF_BLEND took that silent create branch on every hourly tick —
 * logging `flipped=true` forever while every reader resolved null -> env unset
 * -> default 0, keeping psi blending off. Reproduced on two independent
 * deployments (hub sf_rows=1737, local sf_rows=2125).
 *
 * There was NO test over this function. These pin the two properties that make
 * the failure impossible to repeat:
 *   1. absent meta is never bound as NULL — the statement must omit the field;
 *   2. the write reads back and throws when the row did not persist.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';

const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
let storedValue: number | null = null;

mock.module('../db/surreal', () => ({
  surrealDB: {
    async query(sql: string, params: Record<string, unknown> = {}) {
      queries.push({ sql, params });
      if (sql.trimStart().startsWith('SELECT')) {
        return storedValue === null ? [] : [{ param_value: storedValue }];
      }
      // Emulate the UPSERT: a bound NULL against option<string> writes nothing
      // and raises nothing (the exact production behaviour being guarded).
      const bindsNull = Object.entries(params).some(
        ([k, v]) => (k === 'updated_by' || k === 'evidence') && v === null,
      );
      if (!bindsNull) storedValue = params.value as number;
      return [];
    },
  },
}));

const { writeTuningParam, __clearTuningParamCache } = await import('./tuning-params');

describe('writeTuningParam (L3-tuning-06)', () => {
  beforeEach(() => {
    queries.length = 0;
    storedValue = null;
    __clearTuningParamCache();
  });

  test('omits absent meta rather than binding NULL, and the row persists', async () => {
    await writeTuningParam('SF_BLEND', 1);

    const upsert = queries.find((q) => q.sql.includes('UPSERT'));
    expect(upsert).toBeDefined();
    // The precise regression: no NULL may reach an option<string> field.
    expect(upsert?.params.updated_by).toBeUndefined();
    expect(upsert?.params.evidence).toBeUndefined();
    expect(upsert?.sql).not.toContain('updated_by');
    expect(upsert?.sql).not.toContain('evidence');
    expect(storedValue).toBe(1);
  });

  test('still binds meta when supplied', async () => {
    await writeTuningParam('SF_BLEND', 1, { updated_by: 'flag-policy', evidence: 'sf_rows=2125' });
    const upsert = queries.find((q) => q.sql.includes('UPSERT'));
    expect(upsert?.sql).toContain('updated_by');
    expect(upsert?.params.evidence).toBe('sf_rows=2125');
    expect(storedValue).toBe(1);
  });

  test('THROWS when the write silently did not persist', async () => {
    // Force the old behaviour: the statement runs, writes nothing, raises nothing.
    const original = storedValue;
    void original;
    const { surrealDB } = (await import('../db/surreal')) as unknown as {
      surrealDB: { query: (sql: string, params?: Record<string, unknown>) => Promise<unknown> };
    };
    const realQuery = surrealDB.query;
    surrealDB.query = async (sql: string, params: Record<string, unknown> = {}) => {
      if (sql.trimStart().startsWith('SELECT')) return [];
      queries.push({ sql, params });
      return [];
    };
    try {
      await expect(writeTuningParam('SF_BLEND', 1)).rejects.toThrow(/did not persist/);
    } finally {
      surrealDB.query = realQuery;
    }
  });
});
