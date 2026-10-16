// Always-on guard for decision-credit.scratch.test.ts (which needs a scratch SurrealDB and is SKIPPED in the gate, where
// a skip reads as a pass). decision_outcome is SCHEMAFULL with `created_at TYPE datetime DEFAULT time::now()`; a DEFAULT
// applies only on CREATE, so `UPSERT … CONTENT` replaces the whole record and the SECOND write for an id is rejected
// ("Found NONE for field `created_at`"): 140 such events in 6 h on node 1 (2026-10-16). MERGE keeps created_at.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

const src = readFileSync(new URL('./decision-credit.ts', import.meta.url), 'utf8');
const writes = [...src.matchAll(/UPSERT type::thing\('decision_outcome', \$\w+\) (\w+) \$content/g)].map((m) => m[1]);

describe('[MUST-FAIL] decision_outcome writers merge into the record instead of replacing it', () => {
  test('both writers are present', () => { expect(writes.length).toBe(2); });
  test('every decision_outcome UPSERT uses MERGE, never CONTENT', () => { expect(writes).toEqual(['MERGE', 'MERGE']); });
});
