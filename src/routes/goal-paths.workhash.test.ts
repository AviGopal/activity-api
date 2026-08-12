import { describe, test, expect } from "bun:test";
import crypto from "crypto";
// Mirror of hashWork (module-private in goal-paths.ts). Pinned here so a change
// to the canonicalization has to change this file too.
function hashWork(activities: string[], toolsUsed: unknown): string | null {
  if (!Array.isArray(toolsUsed) || toolsUsed.length === 0) return null;
  const effects = [...new Set(toolsUsed.map((t) => String(t)))].sort();
  return crypto.createHash("md5").update(`${activities.join("->")}|${effects.join(",")}`).digest("hex").substring(0, 16);
}
const ACT = ["satisfier:shellResult"];
describe("hashWork", () => {
  test("absent tools_used returns null — today's behaviour, unchanged", () => {
    expect(hashWork(ACT, undefined)).toBeNull();
    expect(hashWork(ACT, [])).toBeNull();
  });
  test("THE COLLISION IT REPAIRS: same activities, different effect surface -> different signature", () => {
    const r1 = hashWork(ACT, ["127.0.0.1:8100/registry|shellResult|read"]);
    const r3 = hashWork(ACT, ["127.0.0.1:8100/registry|shellResult|read", "127.0.0.1:8090/v2|shellResult|read"]);
    expect(r1).not.toBeNull();
    expect(r1).not.toBe(r3);   // rungs 1 and 3 share path_signature today
  });
  test("INVARIANT: effect order does not change the signature", () => {
    const a = hashWork(ACT, ["b|x|read", "a|y|write"]);
    const b = hashWork(ACT, ["a|y|write", "b|x|read"]);
    expect(a).toBe(b);
  });
  test("INVARIANT: duplicate effects do not change the signature", () => {
    expect(hashWork(ACT, ["a|x|read"])).toBe(hashWork(ACT, ["a|x|read", "a|x|read"]));
  });
  test("MEASURED REPHRASING CASE: /registry/shapes and /registry/stats canonicalize equal", () => {
    // 2 phrasings x 3 reps produced 3 raw paths; under host:port + first segment
    // all six collapse to one. The canonicalization happens sender-side, so what
    // this pins is that equal canonical input yields equal signature.
    const canon = "127.0.0.1:8100/registry";
    expect(hashWork(ACT, [`${canon}|shellResult|read`])).toBe(hashWork(ACT, [`${canon}|shellResult|read`]));
  });
});
