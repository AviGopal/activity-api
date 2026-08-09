// Pins the edge_liveness_report classification. The whole point of this shape is to
// separate three states that an advertised-only coverage measure conflates, so the
// states are what the test asserts — not the plumbing.
import { describe, it, expect } from "bun:test";

interface Row { activity_id: string; output_impulse_shapes?: string[]; success: boolean; executed_at: string }
interface EdgeAcc { attempts: number; successes: number; last_success_at: string | null; last_attempt_at: string | null }

// Mirrors the accumulation + classification in routes/impulses.ts case 'edge_liveness_report'.
function classify(rows: Row[]) {
  const acc = new Map<string, EdgeAcc>();
  for (const r of rows) {
    const actId = String(r.activity_id ?? "").trim();
    if (!actId) continue;
    const shapes = Array.isArray(r.output_impulse_shapes) ? r.output_impulse_shapes : [];
    const keys = shapes.length ? shapes.map((s) => `${actId} ${s}`) : [`${actId} (no-output-shape)`];
    for (const k of keys) {
      const cur = acc.get(k) ?? { attempts: 0, successes: 0, last_success_at: null, last_attempt_at: null };
      cur.attempts += 1;
      if (!cur.last_attempt_at || r.executed_at > cur.last_attempt_at) cur.last_attempt_at = r.executed_at;
      if (r.success) {
        cur.successes += 1;
        if (!cur.last_success_at || r.executed_at > cur.last_success_at) cur.last_success_at = r.executed_at;
      }
      acc.set(k, cur);
    }
  }
  return [...acc.entries()].map(([k, v]) => {
    const [activity_id, produced_shape] = k.split(" ");
    const attempts_since_success = v.last_success_at ? v.attempts - v.successes : v.attempts;
    const state = v.successes === 0
      ? "never_succeeded"
      : (v.last_attempt_at && v.last_success_at && v.last_attempt_at > v.last_success_at)
        ? "regressed"
        : "healthy";
    return { activity_id, produced_shape, state, attempts: v.attempts, attempts_since_success };
  });
}

const at = (n: number) => `2026-08-0${n}T00:00:00.000Z`;

describe("edge_liveness_report", () => {
  it("never_succeeded: dispatched repeatedly, never once worked — the reconcile's real state", () => {
    const e = classify([
      { activity_id: "reconcile", output_impulse_shapes: ["x"], success: false, executed_at: at(1) },
      { activity_id: "reconcile", output_impulse_shapes: ["x"], success: false, executed_at: at(2) },
      { activity_id: "reconcile", output_impulse_shapes: ["x"], success: false, executed_at: at(3) },
    ])[0]!;
    expect(e.state).toBe("never_succeeded");
    // every attempt counts against it, not just those after some success
    expect(e.attempts_since_success).toBe(3);
  });

  it("regressed: worked once, latest attempt failed", () => {
    const e = classify([
      { activity_id: "a", output_impulse_shapes: ["x"], success: true, executed_at: at(1) },
      { activity_id: "a", output_impulse_shapes: ["x"], success: false, executed_at: at(2) },
    ])[0]!;
    expect(e.state).toBe("regressed");
    expect(e.attempts_since_success).toBe(1);
  });

  it("healthy: most recent attempt succeeded, even with earlier failures", () => {
    const e = classify([
      { activity_id: "a", output_impulse_shapes: ["x"], success: false, executed_at: at(1) },
      { activity_id: "a", output_impulse_shapes: ["x"], success: true, executed_at: at(2) },
    ])[0]!;
    expect(e.state).toBe("healthy");
  });

  it("a producer that emits NO shape is still tracked — the loudest never_succeeded case", () => {
    const e = classify([
      { activity_id: "silent", success: false, executed_at: at(1) },
      { activity_id: "silent", success: false, executed_at: at(2) },
    ])[0]!;
    expect(e.produced_shape).toBe("(no-output-shape)");
    expect(e.state).toBe("never_succeeded");
  });

  it("one activity producing two shapes yields two independently-judged edges", () => {
    const edges = classify([
      { activity_id: "a", output_impulse_shapes: ["good", "bad"], success: true, executed_at: at(1) },
      { activity_id: "a", output_impulse_shapes: ["bad"], success: false, executed_at: at(2) },
    ]);
    expect(edges.length).toBe(2);
    expect(edges.find((e) => e.produced_shape === "good")!.state).toBe("healthy");
    expect(edges.find((e) => e.produced_shape === "bad")!.state).toBe("regressed");
  });

  it("an activity with no attempts never appears — that is a coverage hole, not an edge state", () => {
    expect(classify([]).length).toBe(0);
  });

  // THIS CASE EXISTS BECAUSE THE FIRST LIVE QUERY FAILED IT. The original code tested
  // `typeof executed_at === 'string'`, but SurrealDB returns a DATETIME — so every
  // timestamp was rejected and the report came back with attempts:10 alongside
  // last_attempt_at:null. The 6 tests above all passed, because they fed strings: the
  // suite tested the shape I imagined rather than the one production sends. Same family
  // as the TimestampSchema defect where timestamps serialize as {}.
  it("accepts a Date-valued executed_at, not only an ISO string", () => {
    const rows = [
      { activity_id: "a", output_impulse_shapes: ["x"], success: true, executed_at: new Date(at(1)) as unknown as string },
      { activity_id: "a", output_impulse_shapes: ["x"], success: false, executed_at: new Date(at(2)) as unknown as string },
    ];
    const e = classifyNormalised(rows)[0]!;
    expect(e.state).toBe("regressed");
    expect(e.last_success_at).not.toBeNull();
    expect(e.last_attempt_at).not.toBeNull();
  });
});

// Mirrors the SHIPPED normaliser (routes/impulses.ts), which accepts a datetime, an ISO
// string, or an epoch number. classify() above deliberately keeps the naive string path
// so the two can be compared.
function classifyNormalised(rows: Array<Record<string, unknown>>) {
  const acc = new Map<string, EdgeAcc>();
  for (const r of rows) {
    const actId = String(r["activity_id"] ?? "").trim();
    if (!actId) continue;
    const shapes = Array.isArray(r["output_impulse_shapes"]) ? (r["output_impulse_shapes"] as string[]) : [];
    const raw = r["executed_at"];
    let at: string | null = null;
    if (typeof raw === "string") at = raw;
    else if (raw instanceof Date) at = raw.toISOString();
    else if (raw != null) { const d = new Date(raw as string | number); at = Number.isNaN(d.getTime()) ? null : d.toISOString(); }
    const keys = shapes.length ? shapes.map((s) => `${actId} ${s}`) : [`${actId} (no-output-shape)`];
    for (const k of keys) {
      const cur = acc.get(k) ?? { attempts: 0, successes: 0, last_success_at: null, last_attempt_at: null };
      cur.attempts += 1;
      if (at && (!cur.last_attempt_at || at > cur.last_attempt_at)) cur.last_attempt_at = at;
      if (r["success"] === true) {
        cur.successes += 1;
        if (at && (!cur.last_success_at || at > cur.last_success_at)) cur.last_success_at = at;
      }
      acc.set(k, cur);
    }
  }
  return [...acc.entries()].map(([k, v]) => {
    const [activity_id, produced_shape] = k.split(" ");
    const state = v.successes === 0
      ? "never_succeeded"
      : (v.last_attempt_at && v.last_success_at && v.last_attempt_at > v.last_success_at)
        ? "regressed"
        : "healthy";
    return { activity_id, produced_shape, state, last_success_at: v.last_success_at, last_attempt_at: v.last_attempt_at };
  });
}
