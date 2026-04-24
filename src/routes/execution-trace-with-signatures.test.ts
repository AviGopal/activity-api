/**
 * executionTraceWithSignatures resolver tests
 *
 * Unit-level tests against a mocked Surreal client. Mirrors the pattern in
 * `template-audit.test.ts`: the `db` argument is a minimal stub whose
 * `query()` returns canned rows per table. Tests exercise:
 *
 *   - Round-trip hydration: execution rows + impulse rows -> impulses_by_id
 *   - Per-task grouping: tasks array ordered by index, preserves task ids
 *   - Filters: `since`, `limit`, `success_only`, `activity_template_id`
 *   - Edge cases: empty result, orphaned impulse ids, bad input (ISO/limit)
 *   - Tenant isolation: API-key auth filters `org_id` in the SQL
 */

import { describe, test, expect } from 'bun:test';
import type { Surreal } from 'surrealdb';

import {
  runExecutionTraceWithSignatures,
  parseInput,
  _internals,
  type ExecutionTraceAuthContext,
} from './execution-trace-with-signatures';

// ---------------------------------------------------------------------------
// Test double: Surreal client that records (sql, params) calls and dispatches
// canned rows based on the first FROM-clause table name.
// ---------------------------------------------------------------------------

interface RecordedCall {
  sql: string;
  params: Record<string, unknown> | undefined;
  table: string;
}

interface MockDbOptions {
  /** Canned rows per SurrealDB table name. */
  rowsByTable: Record<string, unknown[]>;
  /** If present, custom dispatcher per table (overrides rowsByTable entry). */
  overrides?: Record<string, (sql: string, params?: Record<string, unknown>) => unknown[]>;
}

function makeDb(options: MockDbOptions): { db: Surreal; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      const m = sql.match(/\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
      const table = m ? m[1] : '';
      calls.push({ sql, params, table });

      const override = options.overrides?.[table];
      if (override) {
        const rows = override(sql, params);
        return [rows];
      }

      const rows = options.rowsByTable[table] ?? [];
      return [rows];
    },
  } as unknown as Surreal;
  return { db, calls };
}

const apikeyAuth: ExecutionTraceAuthContext = {
  orgId: 'org-test',
  authType: 'apikey',
};

const jwtAuth: ExecutionTraceAuthContext = {
  orgId: 'org-test',
  authType: 'jwt',
};

// ---------------------------------------------------------------------------
// Fixtures: 2 executions × 2 tasks × 2 impulses
// ---------------------------------------------------------------------------

const fixtureExecutions = [
  {
    id: 'exec-1',
    activity_id: 'template-a',
    success: true,
    duration_ms: 1234,
    executed_at: '2026-04-23T10:00:00.000Z',
    created_at: '2026-04-23T10:00:00.000Z',
    input_impulses: ['imp-1', 'imp-2'],
    output_impulses: ['imp-3'],
    parent_execution_id: null,
    composition_chain: [],
    impulse_resolutions: [],
    org_id: 'org-test',
    trace: {
      tasks: [
        {
          id: 'task-a',
          status: 'success',
          started_at: '2026-04-23T10:00:01.000Z',
          completed_at: '2026-04-23T10:00:02.000Z',
          inputState: { impulses: ['imp-1'] },
        },
        {
          id: 'task-b',
          status: 'success',
          started_at: '2026-04-23T10:00:02.000Z',
          completed_at: '2026-04-23T10:00:03.000Z',
          inputState: { impulses: ['imp-2'] },
          outputState: { impulses: ['imp-3'] },
        },
      ],
    },
  },
  {
    id: 'exec-2',
    activity_id: 'template-b',
    success: false,
    duration_ms: 500,
    executed_at: '2026-04-23T09:30:00.000Z',
    created_at: '2026-04-23T09:30:00.000Z',
    input_impulses: ['imp-4', 'imp-5'],
    output_impulses: [],
    parent_execution_id: null,
    composition_chain: [],
    impulse_resolutions: [],
    org_id: 'org-test',
    trace: {
      tasks: [
        {
          id: 'task-c',
          status: 'failure',
          inputState: { impulses: ['imp-4', 'imp-5'] },
        },
        {
          id: 'task-d',
          status: 'failure',
        },
      ],
    },
  },
];

const fixtureImpulses = [
  { id: 'imp-1', pointer: { type: 'file', path: 'src/a.ts' }, shape: 'source_code', summary: 'src/a.ts' },
  { id: 'imp-2', pointer: { type: 'memo', content: 'x' }, shape: 'goal', summary: 'the goal' },
  { id: 'imp-3', pointer: { type: 'file', path: 'src/a.patch' }, shape: 'patch' },
  { id: 'imp-4', pointer: { type: 'file', path: 'src/b.ts' }, shape: 'source_code' },
  { id: 'imp-5', pointer: { type: 'gitDiff' }, shape: 'git_diff' },
];

// ---------------------------------------------------------------------------
// parseInput
// ---------------------------------------------------------------------------

describe('parseInput', () => {
  test('defaults since to 24h ago and limit to 100', () => {
    const result = parseInput({});
    expect(typeof result.since).toBe('string');
    expect(result.limit).toBe(100);
    const sinceMs = Date.parse(result.since);
    const now = Date.now();
    // 24h ago +/- 5s window for test execution time
    expect(now - sinceMs).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5000);
    expect(now - sinceMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5000);
  });

  test('accepts valid ISO since', () => {
    const iso = '2026-04-20T00:00:00.000Z';
    expect(parseInput({ since: iso }).since).toBe(iso);
  });

  test('rejects non-ISO since', () => {
    expect(() => parseInput({ since: 'not a date' })).toThrow();
    expect(() => parseInput({ since: 'not a date' })).toThrow(/since is not a valid ISO/);
  });

  test('rejects non-string since', () => {
    expect(() => parseInput({ since: 12345 })).toThrow(/since must be an ISO/);
  });

  test('clamps limit range', () => {
    expect(parseInput({ limit: 50 }).limit).toBe(50);
    expect(() => parseInput({ limit: 0 })).toThrow(/positive integer/);
    expect(() => parseInput({ limit: -1 })).toThrow(/positive integer/);
    expect(() => parseInput({ limit: 501 })).toThrow(/<=\s*500/);
    expect(() => parseInput({ limit: 1.5 })).toThrow(/positive integer/);
  });

  test('coerces string limit to number', () => {
    expect(parseInput({ limit: '42' }).limit).toBe(42);
  });

  test('accepts optional filters', () => {
    const r = parseInput({
      activity_template_id: 'tmpl',
      success_only: true,
      min_duration_ms: 500,
    });
    expect(r.activity_template_id).toBe('tmpl');
    expect(r.success_only).toBe(true);
    expect(r.min_duration_ms).toBe(500);
  });

  test('rejects negative min_duration_ms', () => {
    expect(() => parseInput({ min_duration_ms: -1 })).toThrow(/non-negative/);
  });
});

// ---------------------------------------------------------------------------
// Task extraction
// ---------------------------------------------------------------------------

describe('extractTasks', () => {
  test('extracts per-task input/output impulse ids from inputState/outputState', () => {
    const row = {
      trace: {
        tasks: [
          { id: 't1', status: 'success', inputState: { impulses: ['a'] } },
          {
            id: 't2',
            status: 'success',
            inputState: { impulses: ['b'] },
            outputState: { impulses: ['c'] },
          },
        ],
      },
    };
    const tasks = _internals.extractTasks(row as any);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      task_id: 't1',
      task_index: 0,
      status: 'success',
      input_impulse_ids: ['a'],
      output_impulse_ids: [],
    });
    expect(tasks[1]).toMatchObject({
      task_id: 't2',
      task_index: 1,
      input_impulse_ids: ['b'],
      output_impulse_ids: ['c'],
    });
  });

  test('prefers explicit input_impulse_ids field when present', () => {
    const row = {
      tasks: [{ id: 't1', input_impulse_ids: ['x'], output_impulse_ids: ['y'] }],
    };
    const tasks = _internals.extractTasks(row as any);
    expect(tasks[0].input_impulse_ids).toEqual(['x']);
    expect(tasks[0].output_impulse_ids).toEqual(['y']);
  });

  test('falls back to task-index id when missing', () => {
    const row = { tasks: [{ status: 'success' }, { status: 'failure' }] };
    const tasks = _internals.extractTasks(row as any);
    expect(tasks[0].task_id).toBe('task-0');
    expect(tasks[1].task_id).toBe('task-1');
  });

  test('returns empty array when tasks is missing', () => {
    expect(_internals.extractTasks({} as any)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('runExecutionTraceWithSignatures - round trip', () => {
  test('hydrates impulses_by_id for every referenced impulse id', async () => {
    const { db, calls } = makeDb({
      rowsByTable: {
        execution: fixtureExecutions,
        impulse: fixtureImpulses,
      },
    });

    const report = await runExecutionTraceWithSignatures(db, {}, apikeyAuth);

    expect(report.count).toBe(2);
    expect(report.traces).toHaveLength(2);
    expect(report.generated_at).toMatch(/^\d{4}-/);

    // Exec 1: imp-1, imp-2 (input) + imp-3 (output) -> 3 entries
    const exec1 = report.traces.find((t) => t.id === 'exec-1')!;
    expect(exec1).toBeTruthy();
    expect(exec1.status).toBe('success');
    expect(exec1.input_impulses).toEqual(['imp-1', 'imp-2']);
    expect(exec1.output_impulses).toEqual(['imp-3']);
    expect(Object.keys(exec1.impulses_by_id).sort()).toEqual(['imp-1', 'imp-2', 'imp-3']);
    expect(exec1.impulses_by_id['imp-1']).toEqual({
      pointer_type: 'file',
      shape: 'source_code',
      summary: 'src/a.ts',
    });
    expect(exec1.impulses_by_id['imp-2']).toEqual({
      pointer_type: 'memo',
      shape: 'goal',
      summary: 'the goal',
    });
    expect(exec1.impulses_by_id['imp-3']).toEqual({
      pointer_type: 'file',
      shape: 'patch',
    });

    // Exec 2 (failure)
    const exec2 = report.traces.find((t) => t.id === 'exec-2')!;
    expect(exec2).toBeTruthy();
    expect(exec2.status).toBe('failure');
    expect(exec2.input_impulses).toEqual(['imp-4', 'imp-5']);
    expect(Object.keys(exec2.impulses_by_id).sort()).toEqual(['imp-4', 'imp-5']);

    // Two DB round trips: one for execution, one for impulse
    expect(calls.map((c) => c.table).sort()).toEqual(['execution', 'impulse']);
  });

  test('groups tasks per execution preserving order and ids', async () => {
    const { db } = makeDb({
      rowsByTable: {
        execution: fixtureExecutions,
        impulse: fixtureImpulses,
      },
    });
    const report = await runExecutionTraceWithSignatures(db, {}, apikeyAuth);

    const exec1 = report.traces.find((t) => t.id === 'exec-1')!;
    expect(exec1.tasks).toHaveLength(2);
    expect(exec1.tasks[0].task_id).toBe('task-a');
    expect(exec1.tasks[0].task_index).toBe(0);
    expect(exec1.tasks[0].input_impulse_ids).toEqual(['imp-1']);
    expect(exec1.tasks[1].task_id).toBe('task-b');
    expect(exec1.tasks[1].task_index).toBe(1);
    expect(exec1.tasks[1].input_impulse_ids).toEqual(['imp-2']);
    expect(exec1.tasks[1].output_impulse_ids).toEqual(['imp-3']);
    expect(exec1.task_count).toBe(2);
    expect(exec1.success_count).toBe(2);
    expect(exec1.failure_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe('runExecutionTraceWithSignatures - filters', () => {
  test('since filter is reflected in SQL params and filtered_by', async () => {
    const { db, calls } = makeDb({
      rowsByTable: { execution: [], impulse: [] },
    });
    const since = '2026-04-20T00:00:00.000Z';
    const report = await runExecutionTraceWithSignatures(db, { since }, apikeyAuth);

    expect(report.filtered_by.since).toBe(since);
    const execCall = calls.find((c) => c.table === 'execution')!;
    expect(execCall.params?.since).toBe(since);
    expect(execCall.sql).toMatch(/executed_at\s*>=\s*type::datetime\(\$since\)/);
  });

  test('limit is reflected in SQL params and filtered_by', async () => {
    const { db, calls } = makeDb({
      rowsByTable: { execution: [], impulse: [] },
    });
    const report = await runExecutionTraceWithSignatures(db, { limit: 7 }, apikeyAuth);
    expect(report.filtered_by.limit).toBe(7);
    const execCall = calls.find((c) => c.table === 'execution')!;
    expect(execCall.params?.lim).toBe(7);
    expect(execCall.sql).toMatch(/LIMIT\s+\$lim/);
  });

  test('success_only adds `success = true` predicate', async () => {
    const { db, calls } = makeDb({
      rowsByTable: { execution: [], impulse: [] },
    });
    await runExecutionTraceWithSignatures(db, { success_only: true }, apikeyAuth);
    const execCall = calls.find((c) => c.table === 'execution')!;
    expect(execCall.sql).toMatch(/success\s*=\s*true/);
  });

  test('activity_template_id adds filter', async () => {
    const { db, calls } = makeDb({
      rowsByTable: { execution: [], impulse: [] },
    });
    await runExecutionTraceWithSignatures(
      db,
      { activity_template_id: 'foo' },
      apikeyAuth,
    );
    const execCall = calls.find((c) => c.table === 'execution')!;
    expect(execCall.sql).toMatch(/activity_id\s*=\s*\$activityId/);
    expect(execCall.params?.activityId).toBe('foo');
  });

  test('min_duration_ms adds filter', async () => {
    const { db, calls } = makeDb({
      rowsByTable: { execution: [], impulse: [] },
    });
    await runExecutionTraceWithSignatures(db, { min_duration_ms: 500 }, apikeyAuth);
    const execCall = calls.find((c) => c.table === 'execution')!;
    expect(execCall.sql).toMatch(/duration_ms\s*>=\s*\$minDuration/);
    expect(execCall.params?.minDuration).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('runExecutionTraceWithSignatures - edge cases', () => {
  test('zero traces -> empty traces array, count 0, no error', async () => {
    const { db, calls } = makeDb({
      rowsByTable: { execution: [], impulse: [] },
    });
    const report = await runExecutionTraceWithSignatures(db, {}, apikeyAuth);
    expect(report.count).toBe(0);
    expect(report.traces).toEqual([]);
    // When there are no executions we still skip the impulse query (no ids to
    // look up) — that's a nice-to-have optimization check.
    const impulseCalls = calls.filter((c) => c.table === 'impulse');
    expect(impulseCalls.length).toBe(0);
  });

  test('orphaned impulse id yields {pointer_type: null, shape: null}', async () => {
    const execRow = {
      id: 'exec-orphan',
      activity_id: 'template-a',
      success: true,
      duration_ms: 100,
      executed_at: '2026-04-23T10:00:00.000Z',
      input_impulses: ['imp-missing', 'imp-present'],
      output_impulses: [],
      org_id: 'org-test',
    };
    const impulseRows = [
      { id: 'imp-present', pointer: { type: 'file' }, shape: 'source_code' },
      // imp-missing intentionally omitted
    ];

    const { db } = makeDb({
      rowsByTable: { execution: [execRow], impulse: impulseRows },
    });
    const report = await runExecutionTraceWithSignatures(db, {}, apikeyAuth);
    const t = report.traces[0];
    expect(t.impulses_by_id['imp-present']).toEqual({
      pointer_type: 'file',
      shape: 'source_code',
    });
    expect(t.impulses_by_id['imp-missing']).toEqual({
      pointer_type: null,
      shape: null,
    });
  });

  test('400 on invalid since', async () => {
    const { db } = makeDb({ rowsByTable: {} });
    let thrown: any = null;
    try {
      await runExecutionTraceWithSignatures(db, { since: 'not-a-date' }, apikeyAuth);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.status).toBe(400);
    expect(thrown.message).toMatch(/since/);
  });

  test('400 on limit out of range', async () => {
    const { db } = makeDb({ rowsByTable: {} });
    let thrown: any = null;
    try {
      await runExecutionTraceWithSignatures(db, { limit: 10000 }, apikeyAuth);
    } catch (err) {
      thrown = err;
    }
    expect(thrown.status).toBe(400);
  });

  test('handles missing optional fields gracefully', async () => {
    const minimalExec = {
      id: 'exec-min',
      activity_id: 'template-x',
      success: true,
      // No input_impulses/output_impulses/trace
    };
    const { db } = makeDb({
      rowsByTable: { execution: [minimalExec], impulse: [] },
    });
    const report = await runExecutionTraceWithSignatures(db, {}, apikeyAuth);
    expect(report.traces[0].input_impulses).toEqual([]);
    expect(report.traces[0].output_impulses).toEqual([]);
    expect(report.traces[0].impulses_by_id).toEqual({});
    expect(report.traces[0].tasks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('runExecutionTraceWithSignatures - tenant isolation', () => {
  test('apikey auth adds org_id filter in SQL', async () => {
    const { db, calls } = makeDb({
      rowsByTable: { execution: [], impulse: [] },
    });
    await runExecutionTraceWithSignatures(db, {}, apikeyAuth);

    const execCall = calls.find((c) => c.table === 'execution')!;
    expect(execCall.sql).toMatch(/org_id\s*=\s*\$orgId/);
    expect(execCall.params?.orgId).toBe('org-test');
  });

  test('jwt auth omits app-side org filter (relies on PERMISSIONS)', async () => {
    const { db, calls } = makeDb({
      rowsByTable: { execution: [], impulse: [] },
    });
    await runExecutionTraceWithSignatures(db, {}, jwtAuth);

    const execCall = calls.find((c) => c.table === 'execution')!;
    expect(execCall.sql).not.toMatch(/org_id\s*=\s*\$orgId/);
    expect(execCall.params?.orgId).toBeUndefined();
  });

  test('apikey auth filters impulse lookup by org_id too', async () => {
    const execRow = {
      id: 'exec-1',
      activity_id: 'template-a',
      success: true,
      input_impulses: ['imp-1'],
      output_impulses: [],
    };
    const { db, calls } = makeDb({
      rowsByTable: { execution: [execRow], impulse: [] },
    });
    await runExecutionTraceWithSignatures(db, {}, apikeyAuth);

    const impulseCall = calls.find((c) => c.table === 'impulse')!;
    expect(impulseCall).toBeTruthy();
    expect(impulseCall.sql).toMatch(/org_id\s*=\s*\$orgId/);
    expect(impulseCall.params?.orgId).toBe('org-test');
  });

  test('a trace belonging to a different org_id is not returned (via PERMISSIONS/app filter)', async () => {
    // Simulate PERMISSIONS: the mock db returns zero rows when orgId matches
    // 'org-test' but a hypothetical 'org-other' trace exists in another call.
    // Since the mock can't enforce PERMISSIONS, we simulate by returning rows
    // only when the query param matches.
    const { db } = makeDb({
      rowsByTable: { impulse: [] },
      overrides: {
        execution: (_sql, params) => {
          if (params?.orgId === 'org-test') return [];
          return [
            {
              id: 'exec-other',
              activity_id: 'template-x',
              success: true,
              input_impulses: [],
              output_impulses: [],
              org_id: 'org-other',
            },
          ];
        },
      },
    });
    const report = await runExecutionTraceWithSignatures(db, {}, apikeyAuth);
    expect(report.count).toBe(0);
    expect(report.traces).toEqual([]);
  });
});
