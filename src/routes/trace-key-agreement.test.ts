/**
 * EVERY KEY THE TRACE WRITE EMITS MUST BE READ BY THE TRACE READ.
 *
 * The producer/consumer key mismatch is this codebase's most persistent defect class — the
 * 2026-08-13 wiring audit called it systemic in 5 of 6 subsystems, and every instance since
 * has been found by hand, after the fact, usually days later. Two more were found by hand on
 * 2026-08-17, in this very boundary:
 *
 *   - `normalizePersistedTask` wrote nothing for resolver config; the read projection had a
 *     comment saying it would prefer "a real persisted config if a future write carries one"
 *   - when that write was added it landed `resolved_config`, and the read still looked at
 *     `tt.config` — so the fix was inert until the seam was joined
 *
 * The signature is always the same: both sides are individually correct and the conjunction
 * is false. Neither a type checker nor a unit test on either side can see it, because neither
 * side is wrong.
 *
 * THIS TEST IS THE DETECTOR for that boundary. It reads the write path's declared output keys
 * and asserts the read path mentions each one. It is deliberately narrow — it proves only that
 * a written key is LOOKED AT, not that it is handled correctly — because a cheap check that
 * runs is worth more than a thorough one that never gets written. A key written and never read
 * is either a silent starvation of the consumer or dead weight in the row; both are worth a
 * failing test.
 */

process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

import { describe, test, expect } from 'bun:test';

const WRITE = new URL('./execution-traces.ts', import.meta.url);
const READ = new URL('./execution-trace-with-signatures.ts', import.meta.url);

/** The declared return-type keys of normalizePersistedTask — what the write path can emit. */
async function writtenTaskKeys(): Promise<string[]> {
  const src = await Bun.file(WRITE).text();
  const start = src.indexOf('export function normalizePersistedTask');
  expect(start).toBeGreaterThan(-1);
  const open = src.indexOf('{', src.indexOf('):', start));
  const close = src.indexOf('\n} {', open);
  const block = src.slice(open, close);
  const keys = [...block.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!);
  return [...new Set(keys)];
}

describe('trace boundary — the write and read agree on key names', () => {
  test('the write path exposes its key set (guards the parser)', async () => {
    const keys = await writtenTaskKeys();
    // If this parse breaks, every assertion below passes vacuously — the failure mode that
    // let the original mismatch survive review.
    expect(keys.length).toBeGreaterThanOrEqual(10);
    expect(keys).toContain('task_id');
    expect(keys).toContain('resolved_config');
  });

  /** Written by the trace boundary and read by NOTHING in this service, as of 2026-08-17.
   *
   *  `consumed_from_task_ids` is computed at four sites in the executor, shipped by the trace
   *  sink, and persisted here. Its comment states it "feeds the composition-edge reconcile's
   *  genuine producer->consumer edge derivation" — but no reader exists, in this repo or in
   *  ribosome-vessel, goal-host-vessel, development-vessel or analysis-vessel. The edge
   *  derivation that does exist derives its edges some other way.
   *
   *  Recorded rather than deleted: the field may be the right input for a reconcile that was
   *  planned and never wired, and removing a producer is the harder direction to reverse.
   *  What is NOT acceptable is it sitting here unnoticed, which is what this entry prevents. */
  const KNOWN_ORPHANS = new Set(['consumed_from_task_ids']);

  test('THE REGRESSION: every written task key has a reader somewhere', async () => {
    const written = await writtenTaskKeys();
    const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

    // Scope matters here, and getting it wrong makes the detector useless. Checking only the
    // signatures projection reported 5 orphans, 4 of which were false: cost_usd, resolver_tier
    // and child_activity_id each have readers in other modules. A key is orphaned only if
    // NOTHING outside the write path and the tests reads it.
    const { Glob } = await import('bun');
    const sources: string[] = [];
    for await (const f of new Glob('**/*.ts').scan({ cwd: new URL('../', import.meta.url).pathname, absolute: true })) {
      if (f.endsWith('.test.ts') || f.endsWith('/routes/execution-traces.ts')) continue;
      sources.push(await Bun.file(f).text());
    }
    expect(sources.length).toBeGreaterThan(50); // guards the scan itself

    const corpus = sources.join('\n');
    const unread = written.filter(
      (k) => !KNOWN_ORPHANS.has(k) && !corpus.includes(k) && !corpus.includes(camel(k)),
    );
    // Naming the offenders, not counting them: the message must say which key was orphaned.
    expect(unread).toEqual([]);
  });

  test('a known orphan is still genuinely unread — the list must not go stale', async () => {
    const { Glob } = await import('bun');
    let corpus = '';
    for await (const f of new Glob('**/*.ts').scan({ cwd: new URL('../', import.meta.url).pathname, absolute: true })) {
      if (f.endsWith('.test.ts') || f.endsWith('/routes/execution-traces.ts')) continue;
      corpus += await Bun.file(f).text();
    }
    // If someone wires the reconcile, this fails and the entry gets removed — a stale
    // exemption is how a detector quietly stops detecting.
    for (const orphan of KNOWN_ORPHANS) {
      expect(corpus.includes(orphan)).toBe(false);
    }
  });

  test('the specific mismatch that broke composition replay cannot recur', async () => {
    const readSrc = await Bun.file(READ).text();
    // The write lands `resolved_config`. If the read ever goes back to consulting only
    // `tt.config`, extracted compositions silently revert to argument-less shells and replay
    // fails with "got undefined" — the exact measured symptom.
    expect(readSrc).toContain('tt.resolved_config');
  });
});
