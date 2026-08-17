/**
 * A MOCK FACTORY THAT OMITS A REAL EXPORT SILENTLY DISABLES OTHER TEST FILES.
 *
 * MEASURED 2026-08-17. Six test files mocked `../db/redis` with factories exporting only
 * `RedisClient`. `mock.module` replaces a module GLOBALLY and the replacement OUTLIVES the
 * file that installed it, so every later file importing the real `redis` export died at
 * import:
 *
 *     SyntaxError: Export named 'redis' not found in module '.../src/db/redis.ts'
 *
 * 53 files failed that way — before running a single assertion. The suite reported green-ish
 * totals the whole time, because a file that never loads contributes no failures. Restoring
 * the missing export moved the suite from 509 pass / 114 fail to 769 pass / 136 fail: 260
 * assertions that had not been executing, and 22 real defects that had been hidden.
 *
 * That is the same defect class the repository guidance names for unreferenced scripts: a
 * check that never runs cannot be trusted when it passes. Absence of evidence was being
 * reported as evidence of absence.
 *
 * THIS TEST IS THE DETECTOR. It was filed as a gap ("assert every mock.module factory exports
 * every real export of its target") and is implemented here rather than left as a note,
 * because the class was found by hand and would otherwise be found by hand again.
 *
 * It reads the mocked module's REAL exports statically — no import, so it is immune to the
 * very pollution it detects.
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const SRC = new URL("./", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** Top-level named exports of a module, by static scan. Value exports only — `export type`
 *  and `export interface` are erased at runtime and cannot break an import. */
function realExports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const names = new Set<string>();
  const patterns = [
    /^export\s+(?:async\s+)?function\s+(\w+)/gm,
    /^export\s+(?:const|let|var)\s+(\w+)/gm,
    /^export\s+class\s+(\w+)/gm,
    /^export\s+enum\s+(\w+)/gm,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) names.add(m[1]!);
  }
  // `export { a, b }` re-export lists, excluding `export type { … }`.
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && !name.startsWith("type ")) names.add(name);
    }
  }
  return [...names];
}

/** Every `mock.module('<spec>', () => ({ … }))` in a test file, with the factory's top-level keys. */
function mockFactories(testFile: string): Array<{ spec: string; keys: string[]; raw: string }> {
  const src = readFileSync(testFile, "utf8");
  const out: Array<{ spec: string; keys: string[]; raw: string }> = [];
  const re = /mock\.module\(\s*['"]([^'"]+)['"]\s*,/g;
  for (const m of src.matchAll(re)) {
    const start = m.index! + m[0].length;
    // Walk to the end of the factory's returned object literal.
    const open = src.indexOf("{", start);
    if (open === -1) continue;
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    // Strip comments before scanning keys. A comment between `{` and the first key would
    // otherwise read as "entry already started" and hide that key — which is exactly what
    // happened when this scanner was first run against factories carrying explanatory
    // comments, and would have made the detector under-report the very class it detects.
    const body = src
      .slice(open, i + 1)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    // Top-level keys only. Track nesting and collect the identifier that starts each entry
    // at depth 1, accepting `key:`, `key(`, shorthand `key,` and the `get key()` accessor
    // form — the last of which is how a factory can delegate to a stub it already builds.
    const keys: string[] = [];
    let d = 0;
    let atEntryStart = false;
    for (let j = 0; j < body.length; j++) {
      const ch = body[j]!;
      if (ch === "{" || ch === "(" || ch === "[") {
        d++;
        atEntryStart = d === 1;
        continue;
      }
      if (ch === "}" || ch === ")" || ch === "]") {
        d--;
        continue;
      }
      if (d === 1 && ch === ",") {
        atEntryStart = true;
        continue;
      }
      if (d === 1 && atEntryStart && /[A-Za-z_$]/.test(ch)) {
        const km = /^(?:get\s+|set\s+|async\s+)?([A-Za-z_$][\w$]*)/.exec(body.slice(j));
        if (km) keys.push(km[1]!);
        atEntryStart = false;
      } else if (d === 1 && !/\s/.test(ch)) {
        atEntryStart = false;
      }
    }
    out.push({ spec: m[1]!, keys: [...new Set(keys)], raw: body });
  }
  return out;
}

function resolveSpec(testFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // package mocks are out of scope
  const base = resolve(dirname(testFile), spec);
  for (const cand of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

describe("mock.module factories must not amputate a module's exports", () => {
  const testFiles = walk(SRC).filter((f) => !f.endsWith("mock-module-completeness.test.ts"));

  it("finds test files and factories (guards the scanner itself)", () => {
    // A scanner that silently matches nothing would make every assertion below vacuously
    // green — the exact shape of the bug being detected.
    expect(testFiles.length).toBeGreaterThan(20);
    const total = testFiles.flatMap(mockFactories).filter((f) => f.spec.startsWith(".")).length;
    expect(total).toBeGreaterThan(5);
  });

  /** `file → spec` pairs whose factory is known to omit exports as of 2026-08-17.
   *
   *  These are LATENT, not harmless: each becomes a 53-file outage the moment any test file
   *  imports the omitted export from the same module. They are frozen rather than fixed
   *  because completing them means inventing stub behaviour for functions these tests never
   *  exercise, and a stub that returns the wrong thing is a worse failure than an honest
   *  omission — it makes assertions pass for the wrong reason.
   *
   *  The list may SHRINK freely. It may not grow: a new omission fails the test below. */
  const KNOWN_INCOMPLETE = new Set<string>([
    "src/cli/migrate-org-to-account.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/middleware/jwtAuth.account-id.test.ts mocks '../db/surreal' but omits: getDbStats, queryWithAuth, dbStats, surrealDB",
    "src/middleware/jwtAuth.account-id.test.ts mocks '../services/auth' but omits: isTransientIdentityFailure, validateJwtToken, validateApiKeyViaIdentityVessel",
    "src/middleware/jwtAuth.apikey-fallthrough.test.ts mocks '../db/surreal' but omits: getDbStats, queryWithAuth, dbStats, surrealDB",
    "src/middleware/jwtAuth.apikey-fallthrough.test.ts mocks '../services/auth' but omits: isTransientIdentityFailure, validateJwtToken, validateApiKeyViaIdentityVessel",
    "src/routes/__tests__/phase10-atomic-alpha-beta.test.ts mocks '../../db/paradigm' but omits: isParadigmReadEnabled, getParadigmReadPercentage, shouldUseParadigmRead, shouldSkipLegacyFallback, logDualWriteConfig, transformLegacyTemplate, computeShapeSignature, queryActivitiesByEmbeddingDense, updateShapeActivityScores, getActivityShapePatterns",
    "src/routes/__tests__/phase10-atomic-alpha-beta.test.ts mocks '../../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/__tests__/phase10-atomic-alpha-beta.test.ts mocks '../../services/variant-creator' but omits: shouldCreateVariant, createVariant, checkAndRetireByPosterior",
    "src/routes/activities-mint-dedup.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/activities-template-id-normalize.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/activities.account-id.test.ts mocks '../db/paradigm' but omits: isParadigmReadEnabled, getParadigmReadPercentage, shouldUseParadigmRead, shouldSkipLegacyFallback, logDualWriteConfig, transformLegacyTemplate, computeShapeSignature, queryActivitiesByEmbeddingDense, updateShapeActivityScores, getActivityShapePatterns",
    "src/routes/activities.account-id.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/activities.account-id.test.ts mocks '../services/variant-creator' but omits: shouldCreateVariant, createVariant, checkAndRetireByPosterior",
    "src/routes/activities.thompson-account-id.test.ts mocks '../db/paradigm' but omits: isParadigmReadEnabled, getParadigmReadPercentage, shouldUseParadigmRead, shouldSkipLegacyFallback, logDualWriteConfig, transformLegacyTemplate, computeShapeSignature, queryActivitiesByEmbeddingDense, updateShapeActivityScores, getActivityShapePatterns",
    "src/routes/activities.thompson-account-id.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/activities.thompson-account-id.test.ts mocks '../services/variant-creator' but omits: shouldCreateVariant, createVariant, checkAndRetireByPosterior",
    "src/routes/b-followup-account-id.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/b3-account-id.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/execution-traces.account-id.test.ts mocks '../db/paradigm' but omits: isParadigmReadEnabled, getParadigmReadPercentage, shouldUseParadigmRead, shouldSkipLegacyFallback, logDualWriteConfig, transformLegacyTemplate, computeShapeSignature, queryActivitiesByEmbeddingDense, getActivityShapePatterns",
    "src/routes/execution-traces.account-id.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/execution-traces.account-id.test.ts mocks '../services/variant-creator' but omits: shouldCreateVariant, createVariant, checkAndRetireByPosterior",
    "src/routes/goal-paths.endpoint-shapes.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/impulses-deprecate-rbac.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/impulses-goal-verification-label.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/impulses-resolve-auth.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/impulses-templates-by-metrics.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/impulses.account-id.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/impulses.account-id.test.ts mocks '../services/variant-creator' but omits: shouldCreateVariant, createVariant, checkAndRetireByPosterior",
    "src/routes/impulses.goal-execution-path-scoping.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/impulses.goal-execution-path-scoping.test.ts mocks '../services/variant-creator' but omits: shouldCreateVariant, createVariant, checkAndRetireByPosterior",
    "src/routes/impulses.relevance-account-id.test.ts mocks '../db/paradigm' but omits: isParadigmReadEnabled, getParadigmReadPercentage, shouldUseParadigmRead, shouldSkipLegacyFallback, logDualWriteConfig, transformLegacyTemplate, computeShapeSignature, queryActivitiesByEmbeddingDense, getActivityShapePatterns",
    "src/routes/impulses.relevance-account-id.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/routes/impulses.relevance-account-id.test.ts mocks '../services/variant-creator' but omits: shouldCreateVariant, createVariant, checkAndRetireByPosterior",
    "src/services/b4a-account-id.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/services/b4b-account-id.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/services/trace-retention.fts-defer.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/services/trace-retention.poison-row.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/services/variant-creator.retire-by-posterior.test.ts mocks '../db/surreal' but omits: getDbStats, dbStats",
    "src/services/variant-creator.retire-by-posterior.test.ts mocks '../lib/tuning-params' but omits: writeTuningParam, __clearTuningParamCache",
  ]);

  function currentViolations(): string[] {
    const seen = new Set<string>();
    for (const testFile of testFiles) {
      for (const factory of mockFactories(testFile)) {
        const target = resolveSpec(testFile, factory.spec);
        if (!target) continue;
        const missing = realExports(target).filter((name) => !factory.keys.includes(name));
        if (missing.length > 0) {
          seen.add(`${testFile.replace(SRC, "src/")} mocks '${factory.spec}' but omits: ${missing.join(", ")}`);
        }
      }
    }
    return [...seen].sort();
  }

  it("THE REGRESSION: the module whose omission caused the outage is complete", () => {
    // The specific instance, asserted directly. `redis` is the export whose absence killed 53
    // files at import; no factory anywhere may drop it again.
    const offenders = currentViolations().filter((v) => /db\/redis' but omits:.*\bredis\b/.test(v));
    expect(offenders).toEqual([]);
  });

  it("no NEW incomplete factory is introduced", () => {
    const now = currentViolations();
    const added = now.filter((v) => !KNOWN_INCOMPLETE.has(v));
    // The failure message IS the fix instruction — it names the file, the module and the
    // exact missing exports, which a bare count would not.
    expect(added).toEqual([]);
  });

  it("records the debt honestly rather than hiding it", () => {
    // A frozen baseline that silently drifts upward is how a detector stops detecting. If
    // this number falls, shrink KNOWN_INCOMPLETE; the test then holds the new, lower line.
    expect(currentViolations().length).toBeLessThanOrEqual(KNOWN_INCOMPLETE.size);
  });
});
