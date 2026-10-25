import { describe, test, expect } from "bun:test";
import * as mod from "./reach-correction";

// PRE_READ_SQL (reach-correction.ts) is `SELECT success, tags, reached, metadata.reach_retraction AS
// retraction FROM type::thing('execution', $eid)`. It never selects metadata.superseded_verdicts or any
// "history" field, and PreRow (`{ success?, tags?, reached?, retraction? }`) carries no such field either.
// So a history-reading guard inside applyReachCorrection can only see history on a row shaped EXACTLY like
// what PRE_READ_SQL actually returns in production — never richer. This test builds that production-shaped
// row (only success/tags/reached/retraction, no metadata at all) for an otherwise-correctable latched
// reach:false row, and asserts the retraction still succeeds. It documents that any reached:true-from-history
// refusal is unreachable with a real pre-read: the row simply has nowhere to carry that history.

describe("reach-correction sees only what PRE_READ_SQL selects", () => {
  test("a latched reach:false row shaped exactly like the PRE_READ_SQL projection is retracted, never refused", async () => {
    const execution_id = "execution:production-shaped-row";

    let call = 0;
    const db = {
      query: async <T = unknown>(_sql: string, _vars?: Record<string, unknown>) => {
        call++;
        if (call === 1) {
          // Exactly PreRow's shape: success, tags, reached, retraction. No metadata, no history field —
          // because PRE_READ_SQL never projects one.
          return [
            {
              success: true,
              tags: ["dispatcher_used:light-dispatch", "reach_graded:true", "reached:false"],
              reached: false,
              retraction: null,
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

    // No history field exists on the row PRE_READ_SQL can actually produce, so a history-based
    // reached_true refusal has nothing to read and never fires here: the retraction proceeds.
    expect("refused" in outcome).toBe(false);
    expect("status" in outcome && outcome.status).toBe("retracted");
  });
});
