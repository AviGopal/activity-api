// VERDICT-TOKEN PIN. src/lib/verdict-token.ts is a vendored, byte-identical copy of the
// super-repo's packages/verdict-token/verdict-token.ts, also vendored into development-vessel. activity-api
// STAMPS a failure class `deterministic:<token>`; development-vessel FILES one gap per class
// as `verdict-class-<token>`. If the copies drift, the filer can refuse a stamped class
// forever and count zero, silently. This test runs in this vessel's own suite, so the pull-sync
// test gate on every node refuses a commit that changes this copy alone.
//
// Do not "repair" a failure here by changing the pin: update all three copies and all three
// pins together (this file, development-vessel's pin test, and the super-repo's
// validation/scripts/verdict-token-copies.test.ts).
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const VERDICT_TOKEN_SHA256 = "abef6e3868676b61da93678728080c2cfde94f9c9d5cd29d981f1702f3b9a8ef"; // gitleaks:allow (a sha256 content pin, not a secret)
const COPY = resolve(import.meta.dir, "verdict-token.ts");

describe("verdict-token pin", () => {
  it("activity-api src/lib/verdict-token.ts matches the pinned sha256 shared by all three copies", () => {
    const got = createHash("sha256").update(readFileSync(COPY)).digest("hex");
    expect(got, "verdict-token drift: update all three copies and all three pins together").toBe(VERDICT_TOKEN_SHA256);
  });
});
