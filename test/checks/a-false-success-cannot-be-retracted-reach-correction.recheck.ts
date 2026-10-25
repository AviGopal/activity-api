import { describe, test, expect } from "bun:test";
import * as mod from "../../src/lib/reach-correction";

// Recheck: applying a correction must refuse if history evidences a prior reached:true
// even when the current tags/columns suggest a latched reached:false.

describe("reach-correction inverse protection (history prevents retract)", () => {
  test("applyReachCorrection refuses when history shows earlier reached:true", async () => {
    const execution_id = "execution:prior-reached-then-overwritten";

    // DB stub: first read returns a shape with metadata.superseded_verdicts
    // signalling an earlier reached:true; writes return a truthy array.
    let call = 0;
    const db = {
      query: async <T = unknown>(_sql: string, _vars?: Record<string, unknown>) => {
        call++;
        if (call === 1) {
          return [
            {
              id: execution_id,
              success: true,
              // No tags provided; implementation should consult history.
              reached: false,
              metadata: {
                superseded_verdicts: [ { verdict: "reach:true", prior_reached: true } ],
              },
            },
          ] as unknown as T[];
        }
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
    expect("refused" in outcome).toBe(true);
    if ("refused" in outcome) expect(outcome.refused).toBe("reached_true");
  });
});
