/**
 * Goal-paths route tests — sibling 2 §2 of OpenSpec change
 * `2026-04-26-shape-provider-goal-creation`.
 *
 * Locks in the read+write paths for the denormalised
 * `endpoint_output_shapes` field on `goal_execution_paths`:
 *
 *   - `accumulateEndpointShapes` correctly unions and dedupes the
 *     `output_shapes` of the activities referenced by a path.
 *   - The POST /goal-paths handler persists the accumulated shapes on
 *     create and on update.
 *   - The GET /goal-paths handler honours `endpoint_output_shape` as a
 *     SurrealDB `CONTAINS` filter.
 *   - The POST /goal-paths/recommend handler honours
 *     `endpoint_output_shape` as a hard constraint on the candidate set
 *     before Thompson Sampling.
 *
 * Tests are pure — the SurrealDB module is replaced with a stub that
 * records every query+params pair and serves canned rows back to the
 * route. Nothing here requires a live database.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Stubbed SurrealDB module
// ---------------------------------------------------------------------------
//
// The route imports `surrealDB` from `../db/surreal`. Replacing the module
// with a stub lets us drive the route from in-memory fixtures and inspect
// the resulting query/params.

type StubHandler = (sql: string, params?: Record<string, any>) => unknown;

interface QueryRecord {
  sql: string;
  params?: Record<string, any>;
}

const queryLog: QueryRecord[] = [];
let queryHandler: StubHandler = () => [];

mock.module('../../src/db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params?: Record<string, any>) => {
      queryLog.push({ sql, params });
      return queryHandler(sql, params);
    },
  },
}));

// Import AFTER the module mock is registered.
const goalPathsModule = await import('../../src/routes/goal-paths');
const { accumulateEndpointShapes } = goalPathsModule;
const goalPathsApp = goalPathsModule.default;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function setActivities(rows: Array<{ id: string; output_shapes: string[] }>) {
  // The helper does `surrealDB.query(...)` (untyped) and reads
  // `result[0]` as the row list. Our stub returns the raw shape it
  // expects — a single-result-set wrapped in an outer array.
  queryHandler = () => [rows];
}

function resetQueryLog() {
  queryLog.length = 0;
  queryHandler = () => [];
}

// ---------------------------------------------------------------------------
// accumulateEndpointShapes
// ---------------------------------------------------------------------------

describe('accumulateEndpointShapes', () => {
  beforeEach(resetQueryLog);

  test('empty path returns []', async () => {
    const result = await accumulateEndpointShapes([]);
    expect(result).toEqual([]);
    // No DB call should be issued for an empty path.
    expect(queryLog.length).toBe(0);
  });

  test('single-activity path returns that activity output_shapes', async () => {
    setActivities([
      { id: 'activity:a', output_shapes: ['shape-x', 'shape-y'] },
    ]);

    const result = await accumulateEndpointShapes(['activity:a']);
    expect(result.sort()).toEqual(['shape-x', 'shape-y'].sort());
    expect(queryLog.length).toBe(1);
    expect(queryLog[0]?.params).toEqual({ activity_ids: ['activity:a'] });
  });

  test('multi-activity path with overlapping shapes is deduplicated', async () => {
    setActivities([
      { id: 'activity:a', output_shapes: ['shape-x', 'shape-y'] },
      { id: 'activity:b', output_shapes: ['shape-y', 'shape-z'] },
      { id: 'activity:c', output_shapes: ['shape-z'] },
    ]);

    const result = await accumulateEndpointShapes([
      'activity:a',
      'activity:b',
      'activity:c',
    ]);

    // Union, deduplicated.
    expect(result.sort()).toEqual(['shape-x', 'shape-y', 'shape-z'].sort());
  });

  test('missing activity rows are skipped (no throw)', async () => {
    setActivities([
      { id: 'activity:a', output_shapes: ['shape-x'] },
      // activity:b not in the result set
    ]);

    const result = await accumulateEndpointShapes(['activity:a', 'activity:b']);
    expect(result).toEqual(['shape-x']);
  });

  test('DB error surfaces as empty array (graceful degradation)', async () => {
    queryHandler = () => {
      throw new Error('connection refused');
    };

    const result = await accumulateEndpointShapes(['activity:a']);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /goal-paths — write path persists endpoint_output_shapes
// ---------------------------------------------------------------------------

describe('POST /goal-paths persists endpoint_output_shapes', () => {
  beforeEach(resetQueryLog);

  test('create path stores accumulated shapes', async () => {
    // Multi-stage stub: first call (accumulateEndpointShapes) returns
    // activity rows; second call (existence check) returns empty;
    // third call (CREATE) echoes back a synthetic row.
    let stage = 0;
    queryHandler = (sql) => {
      stage++;
      if (sql.includes('FROM activity')) {
        return [[
          { id: 'activity:a', output_shapes: ['shape-x'] },
          { id: 'activity:b', output_shapes: ['shape-y', 'shape-x'] },
        ]];
      }
      if (sql.includes('SELECT * FROM goal_execution_paths')) {
        return []; // no existing row
      }
      if (sql.includes('CREATE goal_execution_paths')) {
        return [{ id: 'goal_execution_paths:fake' }];
      }
      return [];
    };

    const res = await goalPathsApp.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal_text: 'fix failing tests',
        goal_category: 'bugfix',
        path_activities: ['activity:a', 'activity:b'],
        success: true,
        duration_ms: 1234,
        cost_usd: 0.05,
      }),
    });

    expect(res.status).toBe(200);

    // Locate the CREATE call and inspect the params it stored.
    const createCall = queryLog.find(q =>
      q.sql.includes('CREATE goal_execution_paths')
    );
    expect(createCall).toBeDefined();
    expect(createCall?.params?.endpoint_output_shapes).toBeDefined();
    const stored = createCall?.params?.endpoint_output_shapes as string[];
    expect(stored.sort()).toEqual(['shape-x', 'shape-y'].sort());

    // And the SQL itself names the new field.
    expect(createCall?.sql).toContain('endpoint_output_shapes');
    // Suppress unused warning
    void stage;
  });

  test('update path stores accumulated shapes', async () => {
    queryHandler = (sql) => {
      if (sql.includes('FROM activity')) {
        return [[
          { id: 'activity:a', output_shapes: ['shape-x'] },
        ]];
      }
      if (sql.includes('SELECT * FROM goal_execution_paths')) {
        // Existing path returned -> route takes the UPDATE branch.
        return [{
          goal_hash: 'fakehash',
          path_signature: 'fakesig',
          total_executions: 5,
          successful_executions: 4,
          failed_executions: 1,
          avg_duration_ms: 1000,
          avg_cost_usd: 0.01,
          avg_token_usage: 100,
        }];
      }
      if (sql.includes('UPDATE goal_execution_paths')) {
        return [{ id: 'goal_execution_paths:fake' }];
      }
      return [];
    };

    const res = await goalPathsApp.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal_text: 'fix failing tests',
        goal_category: 'bugfix',
        path_activities: ['activity:a'],
        success: true,
        duration_ms: 800,
        cost_usd: 0.02,
      }),
    });

    expect(res.status).toBe(200);

    const updateCall = queryLog.find(q =>
      q.sql.includes('UPDATE goal_execution_paths') && q.sql.includes('endpoint_output_shapes')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall?.params?.endpoint_output_shapes).toEqual(['shape-x']);
  });
});

// ---------------------------------------------------------------------------
// GET /goal-paths — endpoint_output_shape query parameter
// ---------------------------------------------------------------------------

describe('GET /goal-paths honours endpoint_output_shape filter', () => {
  beforeEach(resetQueryLog);

  test('filter present → SQL contains CONTAINS clause and bound param', async () => {
    queryHandler = (sql) => {
      if (sql.includes('count()')) return [{ total: 0 }];
      return [];
    };

    const res = await goalPathsApp.request(
      '/?goal_hash=abc123&endpoint_output_shape=shape-y',
      { method: 'GET' }
    );

    expect(res.status).toBe(200);

    const selectCall = queryLog.find(q =>
      q.sql.includes('SELECT * FROM goal_execution_paths')
    );
    expect(selectCall).toBeDefined();
    expect(selectCall?.sql).toContain('endpoint_output_shapes CONTAINS $endpoint_output_shape');
    expect(selectCall?.params?.endpoint_output_shape).toBe('shape-y');
  });

  test('filter absent → SQL does not mention endpoint_output_shapes', async () => {
    queryHandler = (sql) => {
      if (sql.includes('count()')) return [{ total: 0 }];
      return [];
    };

    const res = await goalPathsApp.request('/?goal_hash=abc123', { method: 'GET' });
    expect(res.status).toBe(200);

    const selectCall = queryLog.find(q =>
      q.sql.includes('SELECT * FROM goal_execution_paths')
    );
    expect(selectCall).toBeDefined();
    expect(selectCall?.sql).not.toContain('endpoint_output_shapes');
    expect(selectCall?.params?.endpoint_output_shape).toBeUndefined();
  });

  test('empty-string filter is treated as absent', async () => {
    queryHandler = (sql) => {
      if (sql.includes('count()')) return [{ total: 0 }];
      return [];
    };

    const res = await goalPathsApp.request(
      '/?goal_hash=abc123&endpoint_output_shape=',
      { method: 'GET' }
    );
    expect(res.status).toBe(200);

    const selectCall = queryLog.find(q =>
      q.sql.includes('SELECT * FROM goal_execution_paths')
    );
    expect(selectCall?.sql).not.toContain('endpoint_output_shapes');
  });
});

// ---------------------------------------------------------------------------
// POST /goal-paths/recommend — endpoint_output_shape hard filter
// ---------------------------------------------------------------------------

describe('POST /goal-paths/recommend honours endpoint_output_shape', () => {
  beforeEach(resetQueryLog);

  test('filter present → candidate query bounded with CONTAINS', async () => {
    // Return an empty candidate set so the route returns early — we only
    // care about the WHERE clause it built.
    queryHandler = () => [];

    const res = await goalPathsApp.request('/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal_text: 'fix failing tests',
        endpoint_output_shape: 'shape-target',
        top_k: 3,
      }),
    });

    expect(res.status).toBe(200);

    const candidateQuery = queryLog.find(q =>
      q.sql.includes('SELECT * FROM goal_execution_paths')
    );
    expect(candidateQuery).toBeDefined();
    expect(candidateQuery?.sql).toContain('endpoint_output_shapes CONTAINS $endpoint_output_shape');
    expect(candidateQuery?.params?.endpoint_output_shape).toBe('shape-target');
  });

  test('filter absent → candidate query has no shape constraint', async () => {
    queryHandler = () => [];

    const res = await goalPathsApp.request('/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal_text: 'fix failing tests',
        top_k: 3,
      }),
    });

    expect(res.status).toBe(200);

    const candidateQuery = queryLog.find(q =>
      q.sql.includes('SELECT * FROM goal_execution_paths')
    );
    expect(candidateQuery).toBeDefined();
    expect(candidateQuery?.sql).not.toContain('endpoint_output_shapes');
    expect(candidateQuery?.params?.endpoint_output_shape).toBeUndefined();
  });

  test('paths whose endpoint_output_shapes lack the requested shape are excluded by the SQL filter', async () => {
    // We can verify the filter by observing what SurrealDB-side WHERE
    // clause was built. This is a proxy for the integration behaviour:
    // the DB enforces the constraint, the route just needs to emit it.
    queryHandler = () => [];

    await goalPathsApp.request('/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal_text: 'do thing',
        endpoint_output_shape: 'specific-shape',
      }),
    });

    const candidateQuery = queryLog.find(q =>
      q.sql.includes('SELECT * FROM goal_execution_paths')
    );
    // Both goal_hash and endpoint_output_shapes constraints AND'd together
    expect(candidateQuery?.sql).toMatch(/WHERE goal_hash = \$goal_hash[\s\S]*AND endpoint_output_shapes CONTAINS \$endpoint_output_shape/);
  });
});
