process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

import { describe, test, expect } from 'bun:test';

// AN ACTIVITY ID IS NOT A SHAPE — the write-boundary guard (2026-08-17).
//
// The only five-hop learned composition on this fleet,
// activity:<learned-composition-vessel-health-report-to-fs-read-to-concept-to-memorynote-to-acti>,
// carried four tasks whose outputShapes entry was an ACTIVITY IDENTIFIER:
//
//   task 4: in=[memoryNote]                          out=[activity:<learned-composition-...>]
//   task 5: in=[activity:<learned-composition-...>]  out=[activity:<...>]
//
// No resolver advertises a shape named after an activity, so tasks 5-8 could only be satisfied
// by the bogus output of the task before them. The composition was unexecutable the moment the
// ribosome wrote it. Population: 6 of 26 learned compositions (23%) carried such an entry, and
// five-hop executions completed 0 times in 12 runs.
//
// These tests pin the predicate rather than the route, which needs a DB. The predicate is the
// whole guard: an outputShapes entry beginning with "activity:" is malformed.

/** Mirrors the guard in routes/activities.ts. */
function badShapeTask(tasks: Array<{ outputShapes?: unknown[] }>): unknown[] | null {
  const shapeLike = (v: unknown): string => (typeof v === 'string' ? v : '');
  const hit = (tasks ?? []).find((t) =>
    ((t?.outputShapes ?? []) as unknown[]).some((o) => shapeLike(o).startsWith('activity:')),
  );
  if (!hit) return null;
  return ((hit.outputShapes ?? []) as unknown[]).map(shapeLike).filter((o) => o.startsWith('activity:'));
}

describe('an activity id is not a shape', () => {
  test('THE REGRESSION: the real five-hop composition is rejected', () => {
    const tasks = [
      { outputShapes: ['vessel_health_report'] },
      { outputShapes: ['fs_read'] },
      { outputShapes: ['concept'] },
      { outputShapes: ['memoryNote'] },
      { outputShapes: ['activity:⟨learned-composition-vessel-health-report-to-concept-to-shellresult-to-memorynote-wri⟩'] },
    ];
    expect(badShapeTask(tasks)).toEqual([
      'activity:⟨learned-composition-vessel-health-report-to-concept-to-shellresult-to-memorynote-wri⟩',
    ]);
  });

  test('a well-formed composition passes untouched', () => {
    // The three-hop compositions measured on this fleet are structurally clean and must stay
    // writable — they fail for a DIFFERENT, still-unidentified reason, and this guard must not
    // be blamed for or mistaken as fixing that.
    const tasks = [
      { outputShapes: ['vessel_health_report'] },
      { outputShapes: ['shellResult'] },
      { outputShapes: ['memoryNote_write'] },
    ];
    expect(badShapeTask(tasks)).toBeNull();
  });

  test('reports every offending entry on the failing task, not just the first', () => {
    const tasks = [{ outputShapes: ['activity:⟨a⟩', 'memoryNote', 'activity:⟨b⟩'] }];
    expect(badShapeTask(tasks)).toEqual(['activity:⟨a⟩', 'activity:⟨b⟩']);
  });

  test('tolerates missing or non-string outputShapes without throwing', () => {
    expect(badShapeTask([{}, { outputShapes: [] }, { outputShapes: [null, 42] as unknown[] }])).toBeNull();
  });

  test('a shape merely CONTAINING the word activity is fine — only the prefix is malformed', () => {
    // activity_template and activityVariant_write are real advertised shapes; a substring match
    // would reject them and turn a narrow guard into an outage.
    expect(badShapeTask([{ outputShapes: ['activity_template', 'activityVariant_write'] }])).toBeNull();
  });
});

// A COMPOSITION MAY NOT REQUIRE WHAT IT PRODUCES (2026-08-17).
//
// Measured across 26 learned compositions: 21 declare input_shapes [] and 5 declare something —
// and ALL FIVE list a shape produced by their own tasks. The clearest case:
//
//   learned-composition-vessel-health-report-to-json-path-extract-to-shellresult-to-memo
//     input_shapes: ['vessel_health_report']
//     task 0:       vessel_health_report  in=[]  out=['vessel_health_report']
//
// Read as a precondition, that composition can only run when a shape it produces itself is
// already in the pool — unsatisfiable on a cold walk.
//
// Worth recording as method: an earlier pass this session found ALL compositions carrying
// input_shapes [], added a ribosome rule to compute them, then RETRACTED the concern on
// measuring that 37 of 38 were genuinely self-contained so [] was correct. That retraction was
// right about the empty majority and never examined the non-empty minority, where the defect
// actually lived. Both halves of a population need checking before a question is closed.

/** Mirrors the precondition guard in routes/activities.ts. */
function selfSatisfied(inputShapes: unknown[], tasks: Array<{ outputShapes?: unknown[] }>): string[] {
  const produced = new Set<string>();
  for (const t of tasks ?? []) {
    for (const o of (t?.outputShapes ?? []) as unknown[]) if (typeof o === 'string') produced.add(o);
  }
  return (inputShapes ?? []).filter((i): i is string => typeof i === 'string').filter((i) => produced.has(i));
}

describe('a composition may not require what it produces', () => {
  test('THE REGRESSION: the real self-satisfied composition is rejected', () => {
    const tasks = [
      { outputShapes: ['vessel_health_report'] },
      { outputShapes: ['json_path_extract'] },
      { outputShapes: ['shellResult'] },
      { outputShapes: ['memoryNote_write'] },
    ];
    expect(selfSatisfied(['vessel_health_report'], tasks)).toEqual(['vessel_health_report']);
  });

  test('reports every self-satisfied entry, not just the first', () => {
    const tasks = [
      { outputShapes: ['vessel_health_report'] },
      { outputShapes: ['discovery_vessel_registry_observer'] },
      { outputShapes: ['shellResult'] },
    ];
    expect(selfSatisfied(['discovery_vessel_registry_observer', 'shellResult', 'vessel_health_report'], tasks))
      .toEqual(['discovery_vessel_registry_observer', 'shellResult', 'vessel_health_report']);
  });

  test('a GENUINE external requirement is allowed through', () => {
    // The whole point of input_shapes is to express what a composition needs from outside. A
    // guard that rejected every non-empty value would make first/last-mile adaptation
    // impossible, which is the opposite of the intent.
    const tasks = [{ outputShapes: ['memoryNote_write'] }];
    expect(selfSatisfied(['text'], tasks)).toEqual([]);
  });

  test('the self-contained majority (input_shapes []) is untouched', () => {
    expect(selfSatisfied([], [{ outputShapes: ['shellResult'] }])).toEqual([]);
  });
});
