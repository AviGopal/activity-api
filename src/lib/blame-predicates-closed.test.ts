/**
 * THE PREDICATES THAT DECIDE BLAME LIVE IN THE CLOSED MODULE (qa ruling, option (i)).
 *
 * Whether a failure is the environment's decides whether the arm is charged beta, so the environment classifier
 * (ENVIRONMENTAL_FAILURE_PATTERNS / isEnvironmentalFailureReason / isInfraFailure / gradeReach) is verdict logic, and
 * so is the external-condition judge (which records count, which failures they may move, the time they are judged at).
 * They live in src/lib/posterior-update.ts, which the autonomy scope excludes. If one were defined in, or imported from,
 * a lane-open module (reach-classify.ts, external-condition.ts), a lane landing there could widen it and excuse its own
 * arms. From the lane-open reader the closed module takes only the untrusted candidate list.
 *
 * MUST-FAIL: every blame predicate is DEFINED in posterior-update.ts and nowhere else under src/; posterior-update.ts
 *   takes no predicate binding from another module; the route's reach-gated sinks take gradeReach / posteriorGrade from
 *   posterior-update.ts. It is red on the tree where the predicate moved beside classifyReach (reach-classify.ts).
 * CONTROL: the scan sees the bindings posterior-update.ts does import (classifyReach from reach-classify.ts), so an
 *   empty result is a real result, not a parse that saw nothing.
 *
 * The walker is TypeScript's own parse (static, re-export and dynamic imports, type-only erased), as development-vessel's
 * environment-class-imports.test.ts does it.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..', '..');
const CLOSED = 'src/lib/posterior-update.ts';
/** The blame predicates: each must be declared in CLOSED, and only there. */
export const BLAME_PREDICATES = [
  'ENVIRONMENTAL_FAILURE_PATTERNS', 'isEnvironmentalFailureReason', 'isInfraFailure', 'gradeReach',
  // The external-condition judge: which records count, which failures they may move, and the time they are judged at.
  'judgeExternalCondition', 'conditionForFailure', 'conditionEligible', 'conditionTimeMs', 'isEvidencePointer',
  'CONDITION_ATTRIBUTION_RULE', 'EXTERNAL_CONDITION_SHAPE', 'traceRecordedAt',
];
/** A binding name that is (or wraps) a blame predicate. */
const PREDICATE = /environmentalfailure|infrafailure|^gradereach$|judgeexternalcondition|condition(?:forfailure|eligible|verdict|timems)|evidencepointer|attributionrule|recordedat|istransient/i;
/** The one binding posterior-update.ts takes from the lane-open reader: the untrusted candidate list. */
const READER = 'src/lib/external-condition.ts';

const sourceFile = (name: string, text: string): ts.SourceFile => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function walk(n: ts.Node, visit: (n: ts.Node) => void): void { visit(n); n.forEachChild((c) => walk(c, visit)); }
function resolveSpec(fromRel: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = join(ROOT, fromRel, '..', spec);
  for (const c of [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]) {
    try { if (statSync(c).isFile()) return relative(ROOT, c); } catch { /* next */ }
  }
  return `unresolved:${spec}`;
}
/** Runtime imports with the names each takes ("*" for a namespace, a default or an import passed on whole). */
export function importBindings(fromRel: string, text: string): Array<{ target: string | null; names: string[] }> {
  const out: Array<{ target: string | null; names: string[] }> = [];
  walk(sourceFile(fromRel, text), (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause;
      if (!c || c.isTypeOnly) return;
      const names: string[] = [];
      if (c.name) names.push('*');
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) names.push('*');
      if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) if (!e.isTypeOnly) names.push((e.propertyName ?? e.name).text);
      if (names.length) out.push({ target: resolveSpec(fromRel, n.moduleSpecifier.text), names });
    }
    if (ts.isExportDeclaration(n) && !n.isTypeOnly && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const names = n.exportClause && ts.isNamedExports(n.exportClause) ? n.exportClause.elements.map((e) => (e.propertyName ?? e.name).text) : ['*'];
      out.push({ target: resolveSpec(fromRel, n.moduleSpecifier.text), names });
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      let e: ts.Node = n;
      while (e.parent && (ts.isParenthesizedExpression(e.parent) || ts.isAwaitExpression(e.parent))) e = e.parent;
      const p = e.parent;
      const names: string[] = [];
      if (p && ts.isPropertyAccessExpression(p) && p.expression === e) names.push(p.name.text);
      else if (p && ts.isVariableDeclaration(p) && p.initializer === e && ts.isObjectBindingPattern(p.name)) for (const b of p.name.elements) { const k = b.propertyName ?? b.name; names.push(!b.dotDotDotToken && ts.isIdentifier(k) ? k.text : '*'); }
      else names.push('*');
      out.push({ target: resolveSpec(fromRel, n.arguments[0].text), names });
    }
  });
  return out;
}
/** Top-level function / const / let declarations of a file, by name. */
export function topLevelDeclarations(fromRel: string, text: string): Set<string> {
  const out = new Set<string>();
  for (const st of sourceFile(fromRel, text).statements) {
    if (ts.isFunctionDeclaration(st) && st.name) out.add(st.name.text);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) out.add(d.name.text);
  }
  return out;
}
function srcFiles(dir = 'src'): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...srcFiles(rel));
    else if (e.isFile() && rel.endsWith('.ts') && !/\.test\.ts$|\.d\.ts$/.test(rel)) out.push(rel);
  }
  return out;
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('MUST-FAIL — the blame predicates are the closed module\'s', () => {
  test('each blame predicate is declared in posterior-update.ts', () => {
    const decl = topLevelDeclarations(CLOSED, read(CLOSED));
    expect(BLAME_PREDICATES.filter((n) => !decl.has(n))).toEqual([]);
  });

  test('no other src/ module declares one', () => {
    const elsewhere: string[] = [];
    for (const f of srcFiles()) {
      if (f === CLOSED) continue;
      const decl = topLevelDeclarations(f, read(f));
      for (const n of BLAME_PREDICATES) if (decl.has(n)) elsewhere.push(`${f}: ${n}`);
    }
    expect(elsewhere).toEqual([]);
  });

  test('posterior-update.ts takes no predicate binding from another module', () => {
    const bad = importBindings(CLOSED, read(CLOSED)).flatMap((b) => b.names.filter((n) => PREDICATE.test(n)).map((n) => `${n} from ${b.target}`));
    expect(bad).toEqual([]);
  });

  test('from the lane-open reader it takes only the candidate list', () => {
    const fromReader = importBindings(CLOSED, read(CLOSED)).filter((b) => b.target === READER).flatMap((b) => b.names);
    expect(fromReader).toEqual(['readExternalConditionCandidates']);
  });

  test('the route\'s reach-gated sinks take gradeReach and posteriorGrade from posterior-update.ts', () => {
    const route = 'src/routes/execution-traces.ts';
    const from = new Map<string, string | null>();
    for (const b of importBindings(route, read(route))) for (const n of b.names) if (n === 'gradeReach' || n === 'posteriorGrade') from.set(n, b.target);
    expect(Object.fromEntries(from)).toEqual({ gradeReach: CLOSED, posteriorGrade: CLOSED });
  });
});

describe('CONTROL — the scan sees real imports', () => {
  test('posterior-update.ts imports classifyReach from reach-classify.ts', () => {
    const b = importBindings(CLOSED, read(CLOSED)).find((x) => x.names.includes('classifyReach'));
    expect(b?.target).toBe('src/lib/reach-classify.ts');
  });

  test('an import of a predicate from a lane-open module IS flagged (the detector works)', () => {
    const text = "import { isEnvironmentalFailureReason, classifyReach } from './reach-classify';";
    const bad = importBindings(CLOSED, text).flatMap((b) => b.names.filter((n) => PREDICATE.test(n)));
    expect(bad).toEqual(['isEnvironmentalFailureReason']);
  });
});
