/**
 * SurrealDB has no COALESCE. A statement using it does not fail at runtime — it fails to PARSE,
 * so the entire statement never executes.
 *
 * Measured 2026-08-05: `context_thompson_scores` CREATE used `COALESCE($account_id, 'NONE')`.
 * Every new context bucket therefore failed to be created, and the error was caught as
 * "non-blocking" and logged 172 times in two hours while contextual Thompson scoring quietly had
 * no write path at all. The UPDATE branch kept working for buckets that already existed, so the
 * mechanism looked alive; only new buckets were lost. Classic swallowed failure — the log line
 * said "non-blocking", which was true of the request and false of the learning loop.
 *
 * `COALESCE(x, 'NONE')` was also wrong on its own terms: it would have stored the STRING 'NONE'
 * rather than the NONE value that `option<string>` wants.
 *
 * A parse error cannot be caught by types or by a unit test of the calling function, so it is
 * asserted against the SOURCE. Cheap, and it catches the whole class rather than this instance.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|surql)$/.test(e)) out.push(full);
  }
  return out;
}

// Functions that exist in other SQL dialects and DO NOT exist in SurrealDB. Each one fails at
// parse time, taking the whole statement with it.
const UNSUPPORTED = ['COALESCE', 'IFNULL', 'NVL', 'ISNULL'];

describe('no unsupported SQL functions in SurrealDB statements', () => {
  const files = walk(ROOT).filter((f) => !/__tests__|\.test\.ts$/.test(f));

  for (const fn of UNSUPPORTED) {
    it(`does not call ${fn}(`, () => {
      const offenders: string[] = [];
      for (const f of files) {
        const src = readFileSync(f, 'utf8');
        src.split('\n').forEach((line, i) => {
          // Skip comment lines — the fix note names COALESCE deliberately so the next reader
          // understands why the idiom below it looks roundabout.
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('--')) return;
          if (new RegExp(`\\b${fn}\\s*\\(`).test(line)) offenders.push(`${f}:${i + 1}`);
        });
      }
      expect(offenders).toEqual([]);
    });
  }

  // The supported idiom, kept visible so the replacement is discoverable from the test that
  // forbids the broken one.
  it('uses IF ... IS NULL THEN NONE ELSE ... END for option<string> coercion', () => {
    const src = readFileSync(join(ROOT, 'routes', 'execution-traces.ts'), 'utf8');
    expect(src).toContain('IF $account_id IS NULL THEN NONE ELSE $account_id END');
  });
});
