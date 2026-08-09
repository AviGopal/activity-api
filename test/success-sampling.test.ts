// Prove the sampling predicate: default MUST be a no-op, failures MUST never be
// sampled, and only the named families may be reduced.
type Cfg = { successSampleActivities: string[]; successSampleRate: number };

// Mirrors the condition at activities.ts (success && rate<1 && family match && rand>=rate).
function sampledOut(cfg: Cfg, activityId: string, success: boolean, rand: number): boolean {
  return (
    success === true &&
    cfg.successSampleRate < 1 &&
    cfg.successSampleActivities.some((f) => String(activityId ?? "").includes(f)) &&
    rand >= cfg.successSampleRate
  );
}

const DEFAULT: Cfg = { successSampleActivities: [], successSampleRate: 1 };
const TUNED: Cfg = { successSampleActivities: ["validator-dispatch", "slot-binding"], successSampleRate: 0.1 };

const cases: Array<[string, Cfg, string, boolean, number, boolean]> = [
  // label, cfg, activityId, success, rand, expect sampledOut
  ["DEFAULT keeps a sampled-family success", DEFAULT, "validator-dispatch", true, 0.99, false],
  ["DEFAULT keeps everything else", DEFAULT, "feature_compose", true, 0.99, false],
  ["TUNED drops most validator-dispatch successes", TUNED, "validator-dispatch", true, 0.5, true],
  ["TUNED keeps the ~10% below rate", TUNED, "validator-dispatch", true, 0.05, false],
  ["TUNED drops slot-binding successes", TUNED, "activity:slot-binding-v2", true, 0.9, true],
  ["TUNED NEVER drops a FAILURE", TUNED, "validator-dispatch", false, 0.99, false],
  ["TUNED never touches other families", TUNED, "feature_compose", true, 0.99, false],
  ["TUNED never touches goal-host walks", TUNED, "goal_execution", true, 0.99, false],
  ["rate 0 drops all successes in family", { ...TUNED, successSampleRate: 0 }, "validator-dispatch", true, 0.0, true],
  ["rate 0 still keeps failures", { ...TUNED, successSampleRate: 0 }, "validator-dispatch", false, 0.0, false],
];

import { describe, it, expect } from "bun:test";

describe("trace success-sampling predicate", () => {
  for (const [label, cfg, id, success, rand, want] of cases) {
    it(label, () => {
      expect(sampledOut(cfg, id, success, rand)).toBe(want);
    });
  }
});
