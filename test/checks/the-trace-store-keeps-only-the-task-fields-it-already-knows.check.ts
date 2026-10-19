import { describe, test, expect } from "bun:test";
import * as mod from "../../src/routes/execution-traces";

// Repro: normalizePersistedTask keeps only fields it already knows and
// silently drops all others. A producer cannot add a task-level signal
// (e.g. budget_exhausted, resolved) to the persisted trace.
// This check asserts the desirable behavior (carry through unknown fields)
// and is expected to FAIL under the current implementation.

describe("trace-store task normalization preserves producer-added task-level signals", () => {
  test("normalizePersistedTask carries through budget_exhausted and resolved", () => {
    const inputTask = {
      id: "task-1",
      // canonical per-task impulse grouping that the normalizer recognizes
      input_impulse_ids: ["imp-in-1"],
      output_impulse_ids: ["imp-out-1"],
      // task-level signals a producer (light-dispatch) wishes to persist
      budget_exhausted: true,
      resolved: false,
    };

    const out = (mod as any).normalizePersistedTask(inputTask);

    // Sanity: returns an object
    expect(typeof out).toBe("object");

    // EXPECTED (desirable) behavior: carry these through onto the persisted task record.
    // Current defect: these fields are silently dropped, so these assertions FAIL.
    expect((out as any).budget_exhausted).toBe(true);
    expect((out as any).resolved).toBe(false);
  });
});
