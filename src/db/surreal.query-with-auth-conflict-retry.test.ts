/**
 * queryWithAuth RETRIES A RETRYABLE WRITE CONFLICT, as the root client (exec) has since 2026-06-21.
 *
 * Trace ingest runs as the caller's JWT, so its learning writes go through queryWithAuth. SurrealDB aborts concurrent
 * writers to the same rows with "Failed to commit transaction due to a read or write conflict. This transaction can be
 * retried" (the transaction rolled back whole), and queryWithAuth ran each query exactly once: measured on node 1,
 * 2026-10-16, 1,959 context re-derive writes in 6 h were dropped this way, none retried.
 *
 * Same harness as surreal.query-with-auth-sql.test.ts: the real module under a query-suffixed key, the pool steered by
 * spying enabled(), the clients faked by spying the pool and the Surreal prototype. No SurrealDB instance.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Surreal } from 'surrealdb';

const realSurreal = (await import('./surreal.ts?conflictretry')) as typeof import('./surreal');
const { queryWithAuth } = realSurreal;
const { authSessionPool } = await import('./auth-session-pool');

const CONFLICT = 'Failed to commit transaction due to a read or write conflict. This transaction can be retried';
const SQL = 'UPDATE context_thompson_scores SET alpha += 1 WHERE context_bucket = $b';
type Restorable = { mockRestore: () => void };
let spies: Restorable[] = [];
beforeEach(() => { spies = []; });
afterEach(() => { for (const s of spies.reverse()) s.mockRestore(); });

function assertReal(): void {
  if (!String(queryWithAuth).includes('authSessionPool')) throw new Error('CONTAMINATED: queryWithAuth is not the real implementation');
}
/** A query that throws `errors` in order, then answers. */
function scripted(errors: string[]) {
  const calls: unknown[] = [];
  const query = async (sql: unknown) => {
    calls.push(sql);
    const e = errors[calls.length - 1];
    if (e) throw new Error(e);
    return [[{ ok: true }]];
  };
  return { calls, query };
}
function pooled(query: (sql: unknown) => Promise<unknown>) {
  spies.push(
    spyOn(authSessionPool, 'enabled').mockImplementation(() => true) as unknown as Restorable,
    spyOn(authSessionPool, 'acquire').mockImplementation(async () => ({ db: { query } as unknown as Surreal, key: 'k', jwtExp: Date.now() + 900_000 })) as unknown as Restorable,
    spyOn(authSessionPool, 'release').mockImplementation(() => {}) as unknown as Restorable,
  );
}
function legacy(query: (sql: unknown) => Promise<unknown>) {
  const proto = Surreal.prototype as any;
  spies.push(
    spyOn(authSessionPool, 'enabled').mockImplementation(() => false) as unknown as Restorable,
    spyOn(proto, 'connect').mockImplementation(async () => true) as unknown as Restorable,
    spyOn(proto, 'use').mockImplementation(async () => ({})) as unknown as Restorable,
    spyOn(proto, 'authenticate').mockImplementation(async () => ({})) as unknown as Restorable,
    spyOn(proto, 'query').mockImplementation(query as any) as unknown as Restorable,
    spyOn(proto, 'close').mockImplementation(async () => true) as unknown as Restorable,
  );
}

describe('queryWithAuth retries a retryable write conflict (both paths)', () => {
  for (const [name, install] of [['pooled', pooled], ['legacy', legacy]] as const) {
    test(`[MUST-FAIL] ${name}: a conflict on the first try is retried and the second answer is returned`, async () => {
      assertReal();
      const s = scripted([CONFLICT]);
      install(s.query);
      const rows = await queryWithAuth('jwt', SQL, { b: 'abcd1234' });
      expect(s.calls.length).toBe(2);
      expect(rows).toEqual([{ ok: true }]);
    });
    test(`[CONTROL] ${name}: a non-conflict error propagates after one try`, async () => {
      assertReal();
      const s = scripted(['Parse error: Unexpected token']);
      install(s.query);
      await expect(queryWithAuth('jwt', SQL, {})).rejects.toThrow('Parse error');
      expect(s.calls.length).toBe(1);
    });
  }
  test('[NEW] the retry is bounded: a conflict that never clears is thrown after 5 tries', async () => {
    assertReal();
    const s = scripted([CONFLICT, CONFLICT, CONFLICT, CONFLICT, CONFLICT, CONFLICT]);
    pooled(s.query);
    await expect(queryWithAuth('jwt', SQL, {})).rejects.toThrow('read or write conflict');
    expect(s.calls.length).toBe(5);
  });
});
