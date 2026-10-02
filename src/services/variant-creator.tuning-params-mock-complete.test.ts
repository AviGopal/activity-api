/**
 * Check-first test for gap activity-api-mock-debt-tuning-params-factory-in-variant-creator.
 *
 * variant-creator.retire-by-posterior.test.ts replaces '../lib/tuning-params' process-wide
 * with a factory that exports only getTuningParam. The replacement outlives that file, so a
 * later test file importing getTuningParamList (it feeds the telemetry drain) or any other
 * omitted export fails at import, and its assertions never run. The completeness detector
 * (mock-module-completeness.test.ts) records it as debt in KNOWN_INCOMPLETE_LIST.
 *
 * The fix is in the retire-by-posterior test file: complete the factory with every real export,
 * or drop the module mock and spy on the real getTuningParam with restore. Either way, this test
 * reads the file statically (no import, so it cannot be polluted by the mock it checks).
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";

const HERE = new URL("./", import.meta.url).pathname;
const TARGET_TEST = `${HERE}variant-creator.retire-by-posterior.test.ts`;
const REAL_MODULE = `${HERE}../lib/tuning-params.ts`;

function realExports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const names = new Set<string>();
  for (const re of [
    /^export\s+(?:async\s+)?function\s+(\w+)/gm,
    /^export\s+(?:const|let|var)\s+(\w+)/gm,
    /^export\s+class\s+(\w+)/gm,
  ]) for (const m of src.matchAll(re)) names.add(m[1]!);
  return [...names].sort();
}

/** Top-level keys of every factory installed for `spec` in `file` (empty when none is installed). */
function factoryKeys(file: string, spec: string): string[][] {
  const src = readFileSync(file, "utf8");
  const out: string[][] = [];
  const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(String.raw`mock\.module\(\s*['"]` + esc + String.raw`['"]\s*,`, "g");
  for (const m of src.matchAll(re)) {
    const open = src.indexOf("{", m.index! + m[0].length);
    let depth = 0, i = open;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    const body = src.slice(open, i + 1).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, "");
    const keys: string[] = [];
    let d = 0, atStart = false;
    for (let j = 0; j < body.length; j++) {
      const ch = body[j]!;
      if ("{([".includes(ch)) { d++; atStart = d === 1; continue; }
      if ("})]".includes(ch)) { d--; continue; }
      if (d === 1 && ch === ",") { atStart = true; continue; }
      if (d === 1 && atStart && /[A-Za-z_$]/.test(ch)) {
        const km = /^(?:get\s+|set\s+|async\s+)?([A-Za-z_$][\w$]*)/.exec(body.slice(j));
        if (km) keys.push(km[1]!);
        atStart = false;
      } else if (d === 1 && !/\s/.test(ch)) atStart = false;
    }
    out.push(keys);
  }
  return out;
}

describe("variant-creator retire-by-posterior: the tuning-params mock does not amputate exports", () => {
  it("control: the real tuning-params module exports getTuningParamList and writeTuningParam", () => {
    const real = realExports(REAL_MODULE);
    expect(real).toContain("getTuningParam");
    expect(real).toContain("getTuningParamList");
    expect(real).toContain("writeTuningParam");
  });

  it("every '../lib/tuning-params' factory in retire-by-posterior exports every real export", () => {
    const real = realExports(REAL_MODULE);
    const missing = factoryKeys(TARGET_TEST, "../lib/tuning-params").map((keys) => real.filter((n) => !keys.includes(n)));
    // No factory at all (a spy on the real export instead) also satisfies this.
    for (const m of missing) expect(m).toEqual([]);
  });
});
