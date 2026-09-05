import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A RETIREMENT THAT DOES NOT SAY WHY IS UNAUDITABLE.
 *
 * `retired` is the operative flag selection filters on. Measured on the live store
 * 2026-09-05:
 *
 *   activity.retired = true          : 1,217 of 3,886
 *   activity.retired_reason NOT NONE :     0
 *   activity.retired_at     NOT NONE :     0
 *
 * So 1,217 arms had left the candidate pool and the store could say neither WHEN nor WHY for
 * a single one of them. `deprecated` does not fill the gap — it is a second boolean that
 * mirrors `retired` (1,214 of 1,217 agree), not a label.
 *
 * Two of the three offending writers already KNEW the reason and threw it away: the offender
 * sweep computes `o.reason` (e.g. 'self-satisfied-precondition') and the failed-out prune
 * reports `reason: 'failed_out'`, both in the API response, neither in the row.
 *
 * This matters because retirement is the only brake on arm growth, and arm count is the
 * binding constraint on learning: 49,074 selections across 4,089 arms is ~12 samples per arm
 * over the substrate's entire history, against the ~100 needed to tell two arms apart. Culling
 * arms is the cheap side of that inequality — but an operator cannot safely cull what the store
 * cannot explain afterwards.
 *
 * This is a STRUCTURAL test, not a test of the three call sites. It fails when someone adds a
 * FOURTH retirement path without a reason, which is the recurrence this class needs guarding
 * against.
 */

const SRC = join(import.meta.dir, '..');

function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { yield* tsFiles(p); continue; }
    if (!e.endsWith('.ts') || e.endsWith('.test.ts')) continue;
    yield p;
  }
}

/** Strip line comments so a commented-out example never trips the scan. */
function stripComments(src: string): string {
  return src
    .split('\n')
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
    .join('\n');
}

/**
 * A "retirement statement" is a SET clause that turns `retired` on. We take the text from
 * `SET` to the end of the statement (the closing backtick/quote or a WHERE), which is the
 * window in which a reason must also appear.
 */
function retirementStatements(src: string): string[] {
  const out: string[] = [];
  const re = /SET[\s\S]{0,400}?retired\s*=\s*true/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    const rest = src.slice(start, start + 600);
    const end = rest.search(/WHERE|`|'|"/);
    out.push(end > 0 ? rest.slice(0, end) : rest);
  }
  return out;
}

describe('every retirement path records why it retired', () => {
  const files = [...tsFiles(SRC)];

  test('the scanner finds the known retirement statements (positive control)', () => {
    // Without this control a regex that matches nothing would make the suite pass vacuously —
    // the exact failure mode that let retired_reason stay unset for 1,217 rows.
    const all = files.flatMap((f) => retirementStatements(stripComments(readFileSync(f, 'utf8'))));
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  test('no retirement statement sets `retired = true` without `retired_reason`', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'));
      for (const stmt of retirementStatements(src)) {
        if (!/retired_reason/i.test(stmt)) {
          offenders.push(`${f.replace(SRC, 'src')}: ${stmt.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('no retirement statement sets `retired = true` without `retired_at`', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'));
      for (const stmt of retirementStatements(src)) {
        if (!/retired_at/i.test(stmt)) {
          offenders.push(`${f.replace(SRC, 'src')}: ${stmt.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('a synthetic offending statement IS caught (negative control)', () => {
    // Proves the assertion above can fail. Without this, a scanner that silently matched
    // nothing would look identical to a clean codebase.
    const bad = 'UPDATE activity SET retired = true, updated_at = time::now() WHERE id = $x';
    const stmts = retirementStatements(bad);
    expect(stmts.length).toBe(1);
    expect(/retired_reason/i.test(stmts[0]!)).toBe(false);
  });
});
