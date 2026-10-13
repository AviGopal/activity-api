import { describe, test, expect } from "bun:test";
import * as mod from "../../src/routes/template-audit";

// This check encodes the contract required by the feature request:
// expose a decision provider for TypeSafe's Jev so the substrate can
// compute a JEV decision without hardcoding endpoint/model/credentials.
//
// The module loads fine today; the failure is that the exported symbol
// isn't present yet. No network, timers, or services are used.

describe("route-edit-ac873224-narrowed: template-audit Jev decision provider wiring", () => {
  test("exports getTypesafeJevDecision (non-hardcoded provider entry)", () => {
    // Sanity: module loads and public entry exists today.
    expect(typeof (mod as Record<string, unknown>)["runTemplateAuditReport"]).toBe("function");

    // Gap (fails until implemented): a provider entry for TypeSafe Jev
    // must be exported so callers can obtain a decision without any
    // hardcoded endpoint/model/credential in this module.
    expect(typeof (mod as Record<string, unknown>)["getTypesafeJevDecision"]).toBe("function");
  });
});
