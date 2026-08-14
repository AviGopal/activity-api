// The per-goal-path posterior CELL key buckets by WORK, not surface form (§12.6 step 5).
// Same work -> one cell (concentrated evidence); different work -> different cells (no 1-op/3-op
// merge); no effects -> path-signature fallback (legacy behaviour preserved).
//
// bucketSignature is EXPORTED from goal-paths.ts, but importing that route module has config-time
// side effects (config.ts requires env), so — exactly like the hashWork test in this dir — the
// implementation is MIRRORED here and pinned: a change to bucketSignature MUST change this file too.
import { describe, test, expect } from "bun:test";
import crypto from "crypto";

function hashWork(activities: string[], toolsUsed: unknown): string | null {
  if (!Array.isArray(toolsUsed) || toolsUsed.length === 0) return null;
  const effects = [...new Set(toolsUsed.map((t) => String(t)))].sort();
  return crypto.createHash("md5").update(`${activities.join("->")}|${effects.join(",")}`).digest("hex").substring(0, 16);
}
function hashPath(activities: string[]): string {
  return crypto.createHash("md5").update(activities.join("->")).digest("hex").substring(0, 16);
}
// MIRROR of bucketSignature in goal-paths.ts.
function bucketSignature(activities: string[], toolsUsed: unknown): string {
  return hashWork(activities, toolsUsed) ?? hashPath(activities);
}

const ACT = ["satisfier:shellResult"];

describe("bucketSignature — evidence lands on the right cell (step 5)", () => {
  test("same work (same effect surface) => same cell key", () => {
    const t = ["127.0.0.1:8100/registry|shellResult|read"];
    expect(bucketSignature(ACT, t)).toBe(bucketSignature(ACT, [...t]));
  });
  test("different work => different cell key (the 1-op vs 3-op collision is gone)", () => {
    const oneOp = ["127.0.0.1:8100/registry|shellResult|read"];
    const threeOp = ["127.0.0.1:8100/registry|shellResult|read", "127.0.0.1:8090/v2|shellResult|read"];
    expect(bucketSignature(ACT, oneOp)).not.toBe(bucketSignature(ACT, threeOp));
  });
  test("effects present => keyed by WORK, not the path-only signature", () => {
    expect(bucketSignature(ACT, ["a|x|read"])).not.toBe(bucketSignature(ACT, undefined));
  });
  test("no effects => path-signature fallback (legacy behaviour byte-for-byte)", () => {
    expect(bucketSignature(ACT, undefined)).toBe(bucketSignature(ACT, []));
    expect(bucketSignature(ACT, undefined)).not.toBe(bucketSignature(["other:act"], undefined));
    expect(bucketSignature(ACT, undefined)).toBe(hashPath(ACT));
  });
});
