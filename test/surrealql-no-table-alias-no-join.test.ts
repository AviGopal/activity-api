import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * CLASS LINT: SURREALQL HAS NO TABLE ALIASES AND NO JOIN.
 *
 * `FROM <table> AS <alias>` and `… JOIN …` are ANSI SQL. SurrealQL parses neither, so a query
 * string carrying one is a Parse error on EVERY call — a route built on it has never answered.
 * Measured on SurrealDB 2.3.10: /selection-outcomes counted with `FROM thompson_selection_log
 * AS sel` (Unexpected token AS), /calibration-summary and the former /selection-calibration
 * used `LEFT JOIN activity_execution_traces`. Each was found one at a time, by hand, months
 * after it shipped. This lint finds the class.
 *
 * It parses every non-test src/**\/*.ts file with the TypeScript compiler, takes each string
 * and template literal (template substitutions become a placeholder), keeps the ones that read
 * as SurrealQL (they contain FROM), and flags `FROM <ident> AS <ident>` and an uppercase JOIN
 * keyword. SurrealQL's own `FROM (subquery) AS …` is not an identifier and is not flagged.
 *
 * ALLOWLIST: only literals PROVEN not to be SurrealQL sent to the engine (prose, a log message).
 * Each entry names the file, a snippet of the literal, and why. Never allowlist a query.
 */

const ROOT = new URL('..', import.meta.url).pathname;

interface Finding { file: string; line: number; rule: 'table-alias' | 'join'; text: string }

const ALLOWLIST: Array<{ file: string; snippet: string; reason: string }> = [];

const ALIAS = /\bFROM\s+[A-Za-z_][\w:]*\s+AS\s+[A-Za-z_]\w*/;
const JOIN = /\b(?:(?:LEFT|RIGHT|INNER|OUTER|FULL|CROSS)\s+)*JOIN\b/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Every string / template literal in a file, with its start line; substitutions are `$__x`. */
function literals(file: string): Array<{ line: number; text: string }> {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (n: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n)) text = n.head.text + n.templateSpans.map((s) => ' $__x ' + s.literal.text).join('');
    if (text !== null) out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function scan(srcDir: string, base: string): Finding[] {
  const found: Finding[] = [];
  for (const file of tsFiles(srcDir)) {
    const rel = relative(base, file);
    for (const { line, text } of literals(file)) {
      if (!/\bFROM\b/.test(text)) continue;
      const allowed = ALLOWLIST.some((a) => a.file === rel && text.includes(a.snippet));
      if (allowed) continue;
      const a = text.match(ALIAS);
      if (a) found.push({ file: rel, line, rule: 'table-alias', text: a[0] });
      const j = text.match(JOIN);
      if (j) found.push({ file: rel, line, rule: 'join', text: j[0] });
    }
  }
  return found;
}

describe('SurrealQL class lint: no table aliases and no JOIN in src query strings', () => {
  it('the lint instrument flags both rules on a known-bad literal and passes a valid one', () => {
    const bad = 'SELECT count() AS total FROM thompson_selection_log AS sel GROUP ALL';
    expect(bad.match(ALIAS)?.[0]).toBe('FROM thompson_selection_log AS sel');
    expect('SELECT * FROM a AS x LEFT JOIN b AS y ON x.k = y.k'.match(JOIN)?.[0]).toBe('LEFT JOIN');
    expect('SELECT count() AS total FROM (SELECT id FROM t WHERE x = 1) GROUP ALL'.match(ALIAS)).toBeNull();
    expect('SELECT a AS b FROM t WHERE c = 1'.match(ALIAS)).toBeNull();
    expect('ids.join and Join and joined'.match(JOIN)).toBeNull();
    // The scanner reaches real literals: this repo has thousands of FROM strings.
    const total = tsFiles(ROOT + 'src').flatMap(literals).filter((l) => /\bFROM\b/.test(l.text)).length;
    expect(total).toBeGreaterThan(100);
  });

  it('no src query string uses a table alias or a JOIN', () => {
    const found = scan(ROOT + 'src', ROOT);
    expect(found.map((f) => `${f.file}:${f.line} ${f.rule} ${f.text}`)).toEqual([]);
  });

  it('every allowlist entry still matches a literal, so the allowlist cannot rot', () => {
    for (const a of ALLOWLIST) {
      const hit = literals(ROOT + a.file).some((l) => l.text.includes(a.snippet));
      expect(`${a.file} ${a.snippet} ${hit}`).toBe(`${a.file} ${a.snippet} true`);
    }
  });
});
