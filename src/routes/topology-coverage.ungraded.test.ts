// B2 write-back health metric on /v2/activities/topology-coverage (§12.6, 2026-08-14).
//
// The route counts selection-posterior cells that are OBSERVED (n_observations>0) yet still at
// Beta(1,1) (alpha==1 && beta==1) — the "walk grades into a table nothing reads" symptom: the
// observation never moved the posterior, so Thompson selection over that cell is blind despite
// traffic. This is a pure aggregation over rows already fetched by the route; importing the route
// module has DB/config import side effects, so — exactly like goal-paths.bucketsig.test.ts in this
// tree — the predicate is MIRRORED here and pinned: a change to the route's counting MUST change this.
import { describe, test, expect } from "bun:test";

type Row = { alpha: number; beta: number; n_observations: number };

// MIRROR of the counting loop in activities.ts `/topology-coverage`.
function ungradedStats(rows: Row[]): { cells_with_observation: number; ungraded_despite_observation: number; fraction: number } {
  let cellsWithObs = 0;
  let ungradedDespiteObs = 0;
  for (const row of rows) {
    const nObs = row.n_observations ?? 0;
    if (nObs > 0) {
      cellsWithObs += 1;
      if ((row.alpha ?? 1) === 1 && (row.beta ?? 1) === 1) ungradedDespiteObs += 1;
    }
  }
  const fraction = cellsWithObs > 0 ? Math.round((ungradedDespiteObs / cellsWithObs) * 10000) / 10000 : 0;
  return { cells_with_observation: cellsWithObs, ungraded_despite_observation: ungradedDespiteObs, fraction };
}

describe("topology-coverage ungraded-despite-observation (B2 write-back health)", () => {
  test("a graded cell (alpha or beta moved) is NOT counted ungraded", () => {
    const s = ungradedStats([{ alpha: 2, beta: 1, n_observations: 1 }, { alpha: 1, beta: 3, n_observations: 2 }]);
    expect(s.cells_with_observation).toBe(2);
    expect(s.ungraded_despite_observation).toBe(0);
    expect(s.fraction).toBe(0);
  });

  test("an OBSERVED Beta(1,1) cell IS the leak — counted", () => {
    const s = ungradedStats([{ alpha: 1, beta: 1, n_observations: 5 }]);
    expect(s.ungraded_despite_observation).toBe(1);
    expect(s.fraction).toBe(1);
  });

  test("a Beta(1,1) cell with ZERO observations is NOT the leak (never had traffic)", () => {
    const s = ungradedStats([{ alpha: 1, beta: 1, n_observations: 0 }]);
    expect(s.cells_with_observation).toBe(0);
    expect(s.ungraded_despite_observation).toBe(0);
    expect(s.fraction).toBe(0); // no trafficked cells => 0 by the route's guard
  });

  test("mixed: 1 of 4 trafficked cells is ungraded => fraction 0.25", () => {
    const s = ungradedStats([
      { alpha: 1, beta: 1, n_observations: 3 }, // leak
      { alpha: 5, beta: 2, n_observations: 6 },
      { alpha: 1, beta: 9, n_observations: 8 },
      { alpha: 3, beta: 3, n_observations: 1 },
      { alpha: 1, beta: 1, n_observations: 0 }, // not trafficked, ignored
    ]);
    expect(s.cells_with_observation).toBe(4);
    expect(s.ungraded_despite_observation).toBe(1);
    expect(s.fraction).toBe(0.25);
  });
});
