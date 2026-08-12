// Pins that a satisfier pseudo-id contributes its own output shape.
//
// THE DEFECT: `accumulateEndpointShapes` resolved path activities by querying the
// `activity` table. `satisfier:<shape>` ids are NOT rows there, and ~40% of
// recorded path steps (63.5% of accepted pathways) are exactly those — so the
// function returned [] for the majority of pathways and rows were written with an
// empty `endpoint_output_shapes`. Measured on a live store: 0 of 200 rows had a
// non-empty value, which makes every `WHERE $shape IN endpoint_output_shapes`
// lookup return nothing and silently voids migration 092's denormalisation.
import { describe, test, expect, mock } from 'bun:test';

// FIXTURE FIDELITY. The first version of this test mocked `query` as `[[]]` — a
// length-1 envelope wrapping an empty row set. Live, a query matching nothing
// returns an EMPTY envelope, which trips the function's
// `activitiesResult.length === 0` early return. The naive fix passed this test
// and did nothing in production, because the mock skipped the branch that
// actually fires. Mock the empty envelope.
mock.module('../db/surreal', () => ({
  surrealDB: { query: async () => [], getInstance: async () => ({}) },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
}));
mock.module('../db/redis', () => ({
  redis: { get: async () => null, set: async () => 'OK', del: async () => 0 },
  RedisClient: { getInstance: () => ({ get: async () => null, set: async () => 'OK' }) },
}));

const { accumulateEndpointShapes, SATISFIER_PREFIX } = await import('./goal-paths');

describe('accumulateEndpointShapes — satisfier pseudo-ids', () => {
  test('a satisfier-ONLY pathway yields its shapes, not []', async () => {
    // The live majority case that was writing empty rows.
    const out = await accumulateEndpointShapes(['satisfier:shellResult', 'satisfier:memoryNote_write']);
    expect(out.sort()).toEqual(['memoryNote_write', 'shellResult']);
  });

  test('the prefix constant is the one the walk writes', () => {
    expect(SATISFIER_PREFIX).toBe('satisfier:');
  });

  test('duplicate satisfier steps collapse to one shape', async () => {
    expect(await accumulateEndpointShapes(['satisfier:shellResult', 'satisfier:shellResult']))
      .toEqual(['shellResult']);
  });

  test('a bare "satisfier:" with no suffix contributes nothing', async () => {
    // Must not add an empty-string shape, which would match nothing and pollute
    // every shape-keyed query.
    expect(await accumulateEndpointShapes(['satisfier:'])).toEqual([]);
  });

  test('an empty pathway is still []', async () => {
    expect(await accumulateEndpointShapes([])).toEqual([]);
  });

  test('satisfier shapes survive an EMPTY activity-query result', async () => {
    // The live failure: the query short-circuits on an empty envelope, and a
    // fix that only ran inside the loop was discarded before it executed.
    expect(await accumulateEndpointShapes(['satisfier:shellResult', 'activity:⟨unknown⟩']))
      .toEqual(['shellResult']);
  });

  test('a real template id with no activity row still contributes nothing', async () => {
    // The pre-existing behaviour for genuine templates is unchanged: this fix
    // must not invent shapes for ids it cannot resolve.
    expect(await accumulateEndpointShapes(['activity:⟨some-real-template⟩'])).toEqual([]);
  });
});
