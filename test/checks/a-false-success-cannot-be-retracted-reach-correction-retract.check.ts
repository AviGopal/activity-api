import { describe, test, expect } from "bun:test";
import * as mod from "../../src/lib/reach-correction";

// This check targets the inverse guarantee noted in reach-correction.ts:
// a later graded not-reached must NOT be able to retract an earlier reached:true.
// The current implementation of applyReachCorrection only enforces that the row is a
// latched reached:false; it does not refuse when history shows a prior reached:true —
// leading to an incorrect 'retracted' outcome. This test expects a refusal ("reached_true").
// It fails today because the defect allows retraction instead of refusing.

describe("reach-correction inverse (cannot retract earlier reached:true)", () => {
  test("applyReachCorrection should refuse when prior reached:true exists, but it retracts (defect)", async () => {
    const execution_id = "execution:prior-reached-then-overwritten";

    // Minimal DB stub: first query returns the execution row shape applyReachCorrection inspects;
    // subsequent queries (UPDATEs, side-effects) return a truthy array to avoid write_failed paths.
    let call = 0;
    const executionRow = {
      id: execution_id,
      success: true,
      reach_graded: true,
      // Later not-reached overwrote an earlier reached:true; current column is false
      // so the retraction path would proceed unless it checks the prior reached:true history.
      reached: false,
      metadata: {
        // Simulate a history entry evidencing the earlier reached:true verdict.
        // Exact internals are intentionally loose; the defect is that history isn't consulted.
        superseded_verdicts: [
          { verdict: "reach:true", at: Date.now() - 10_000 },
        ],
      },
    } as const;

    const db = {
      query: async <T = unknown>(_sql: string, _vars?: Record<string, unknown>) => {
        call++;
        if (call === 1) {
          // Load of the target execution row.
          return [executionRow] as unknown as T[];
        }
        // Updates / decision-outcome corrections / tag writes — return a truthy array
        // to avoid triggering write_failed paths in the current implementation.
        return [{ ok: true }] as unknown as T[];
      },
    };

    const provenance = {
      list_sha: mod.listShaOf([execution_id]),
      rule: "deterministic-oracle-overwrote-earlier-reached-true",
      commit: "deadbeef",
    };

    const correction: mod.ReachCorrection = {
      execution_id,
      correction_of: mod.CORRECTION_OF_REACH_FALSE,
      provenance,
    };

    const outcome = await mod.applyReachCorrection(db as any, correction);

    // What SHOULD happen: the correction is refused because the execution previously
    // held reached:true and a later not-reached cannot retract it. The implementation
    // currently proceeds to retract, so 'refused' is absent and this assertion fails —
    // failing for the defect, not for load/typing reasons.
    expect("refused" in outcome).toBe(true);
    if ("refused" in outcome) {
      expect(outcome.refused).toBe("reached_true");
    }
  });
});
