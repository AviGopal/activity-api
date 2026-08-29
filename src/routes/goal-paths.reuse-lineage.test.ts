// REUSE LINEAGE MUST BE STORABLE *AND* READABLE.
//
// goal-host has been computing pathway reuse and throwing it away to a log line —
// "[goal-host] REUSE LINEAGE (not yet storable)" (index.ts:5628) — because the only
// lineage fields on this route, parent_goal_hash / parent_path_signature, mean SUB-GOAL
// lineage and carry the CC1 scope-narrowing assertion. Borrowed-pathway reuse is the
// opposite relation (a donor is accepted at cover >= 0.5, so up to half the reusing walk's
// shapes lie outside the donor's), and CC1 rejected the write: measured once on a REACHED
// 2-step reuse, sending parent_* did not add lineage, it DESTROYED the record with a 400.
//
// Consequence for the architecture: the claim "a repeated task runs over its learned
// pathway" was not merely unproven, it was UNTESTABLE — nothing in the store could confirm
// or deny which pathway a walk borrowed.
//
// TWO FAILURE MODES ARE PINNED HERE, because this field family has already exhibited both:
//   1. ACCEPTED BUT NOT STORED — goal_execution_paths is SCHEMAFULL, so an undefined field
//      is silently dropped. That is exactly how walk_tier was null for every row until
//      migration 181 defined it (see sql/migrations/181-goal-path-walk-tier.surql).
//   2. STORED BUT NOT RETURNED — GoalExecutionPathSchema.parse() strips unknown keys, so a
//      field missing from the RESPONSE schema is invisible to every reader, and the
//      mechanism looks dead when it is merely unreadable (the comment on walk_tier in
//      schemas.ts records that this already happened).
// A test that only asserted the request schema accepts the field would pass under both.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PathRecordRequestSchema, GoalExecutionPathSchema } from "../models/schemas.js";

const ROUTE = readFileSync(join(import.meta.dir, "goal-paths.ts"), "utf8");
const MIGRATION = readFileSync(
  join(import.meta.dir, "..", "..", "sql", "migrations", "204-goal-path-reuse-lineage.surql"),
  "utf8",
);

describe("reuse lineage — request contract", () => {
  test("the request schema accepts the reuse fields", () => {
    const parsed = PathRecordRequestSchema.parse({
      goal_text: "produce a system_load_report",
      goal_category: "meta",
      path_activities: ["satisfier:shellResult"],
      success: true,
      duration_ms: 10,
      cost_usd: 0,
      reused_from_goal_hash: "d925f1c6c299204e",
      reused_from_path_signature: "abc123def456",
    });
    expect(parsed.reused_from_goal_hash).toBe("d925f1c6c299204e");
    expect(parsed.reused_from_path_signature).toBe("abc123def456");
  });

  test("they remain optional — every existing caller keeps working", () => {
    const parsed = PathRecordRequestSchema.parse({
      goal_text: "g", goal_category: "meta", path_activities: ["a"],
      success: false, duration_ms: 1, cost_usd: 0,
    });
    expect(parsed.reused_from_goal_hash).toBeUndefined();
  });
});

describe("reuse lineage — read contract (failure mode 2)", () => {
  test("the RESPONSE schema does not strip the fields", () => {
    const row = GoalExecutionPathSchema.parse({
      goal_hash: "h", goal_text: "g", goal_category: "meta",
      path_activities: ["a"], path_signature: "s",
      success_count: 1, failure_count: 0, total_executions: 1, execution_count: 1,
      success_rate: 1, avg_duration_ms: 1, avg_cost_usd: 0, avg_token_usage: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      walk_tier: "learned_pathway",
      reused_from_goal_hash: "d925f1c6c299204e",
      reused_from_path_signature: "abc123def456",
    } as never) as Record<string, unknown>;
    // The whole point: a stored field absent from this schema is unreadable, so the
    // reuse rate stays unmeasurable from outside the vessel even once it is persisted.
    expect(row.reused_from_goal_hash).toBe("d925f1c6c299204e");
    expect(row.reused_from_path_signature).toBe("abc123def456");
  });
});

describe("reuse lineage — persistence (failure mode 1)", () => {
  test("a DEFINE FIELD migration exists for both fields on the SCHEMAFULL table", () => {
    expect(MIGRATION).toContain("DEFINE FIELD IF NOT EXISTS reused_from_goal_hash ON goal_execution_paths");
    expect(MIGRATION).toContain("DEFINE FIELD IF NOT EXISTS reused_from_path_signature ON goal_execution_paths");
  });

  test("BOTH the create and the update statement persist them", () => {
    // A field written only on CREATE can never be recorded for a path that already
    // exists — the exact defect the typical_tools_used comment in this route records
    // ("0/100 recent rows populated"), and reuse is by definition a repeat execution,
    // so the UPDATE path is the one that matters most here.
    expect(ROUTE).toContain("reused_from_goal_hash: $reused_from_goal_hash");
    expect(ROUTE).toContain("reused_from_goal_hash = $reused_from_goal_hash ?? reused_from_goal_hash");
    expect(ROUTE).toContain("reused_from_path_signature = $reused_from_path_signature ?? reused_from_path_signature");
  });

  test("the update never clobbers a recorded lineage back to null", () => {
    // Monotonic on purpose: a later non-reusing run of the same path must not erase the
    // evidence that this pathway was once borrowed.
    expect(ROUTE).toMatch(/reused_from_goal_hash = \$reused_from_goal_hash \?\? reused_from_goal_hash/);
  });
});

describe("reuse lineage — CC1 is a SIBLING semantics, not a loosened one", () => {
  // THE NEGATIVE CONTROL. The bug being fixed is that reuse was forced through parent_*,
  // which asserts scope narrowing. The fix must add a separate relation, NOT weaken CC1 —
  // otherwise sub-goal chains could silently expand their scope, which is what CC1 exists
  // to prevent (sql/migrations/100-cc1-scope-narrowing-assert.surql).
  test("CC1 still gates on parent_path_signature", () => {
    expect(ROUTE).toContain("if (validated.parent_path_signature)");
    expect(ROUTE).toContain("Scope-narrowing violation (CC1)");
  });

  test("the reuse fields are NOT inside the CC1 branch", () => {
    const cc1Start = ROUTE.indexOf("if (validated.parent_path_signature)");
    const cc1End = ROUTE.indexOf("Scope-narrowing violation (CC1)");
    expect(cc1Start).toBeGreaterThan(-1);
    const cc1Block = ROUTE.slice(cc1Start, cc1End);
    expect(cc1Block).not.toContain("reused_from_goal_hash");
    expect(cc1Block).not.toContain("reused_from_path_signature");
  });
});
