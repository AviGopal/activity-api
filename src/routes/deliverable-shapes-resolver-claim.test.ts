/**
 * GET /v2/activities/deliverable-shapes — a learned composite's terminal is CLAIMED when every
 * task's resolver is advertised, even if nothing advertises the terminal shape itself.
 *
 * Why this must hold (REALIGNMENT/WIRING step 1(a); WIRING-ADDENDUM C§1 R1):
 *   B2 (2c91aaf) added this endpoint so goal->target inference could AIM a goal at a shape that
 *   only learned composites produce (goal-host names `conceptDescription`). 77785f4 (V1) then
 *   required a live discovery advertiser for the OUTPUT shape. A shape produced only by a
 *   composite is by definition not advertised by any vessel, so V1 removed every such terminal:
 *   the union into goal-host's fetchKnownShapes now adds zero names that /registry/shapes does
 *   not already carry, and B2 is dead. V1 fixed a real hole (obsidian:write_note stayed aimable
 *   after its vault left), but it tested the wrong thing. The narrow rule is RESOLVER-claim:
 *   a composite's terminal is admitted when each of its tasks names a resolver that is live in
 *   discovery. A task with no resolver claims nothing.
 *
 * "Claimed resolver" here: the id is a goal-host BUILTIN (BUILTIN_RESOLVER_IDS, see below), or the
 * task's `resolver` id (the field ias-executor dispatches on,
 * engine.ts) is in discovery's /registry/shapes, the same single all-or-nothing read the handler
 * already makes (7bec2ca). goal-host registers its cross-vessel proxy resolvers BY SHAPE NAME, so
 * a resolver id is advertised exactly when that name is in the registry. Qualified
 * (`vessel:shape`) resolver ids are deliberately not exercised here.
 *
 * The reached-run half of the gate (goal_execution_paths.successful_executions > 0) is satisfied
 * for every terminal in these fixtures so that only the advertisement half is under test.
 *
 * Seams: spyOn the real `surrealDB.query` export and a globalThis.fetch stub that answers only
 * discovery's /registry/shapes; both restored after each test. No mock.module.
 */
import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import * as activitiesModule from './activities';
import { surrealDB } from '../db/surreal';

const activitiesRouter = activitiesModule.default;

/**
 * Builtin resolver ids: resolvers goal-host registers in-process (ias-executor GoalHost plus
 * goal-host-vessel builtins), which discovery never advertises. The engine's own list is runtime
 * state (ResolverRegistry.list() on the host), not reachable from activity-api, so the ONE
 * activity-api source is the set the promote gate already keeps inline (activities.ts
 * `builtInResolvers`). The fix exports it as BUILTIN_RESOLVER_IDS and both gates read that one
 * set. Read through a namespace import so its absence today fails only the tests that need it.
 */
function builtinResolverIds(): string[] {
  const raw = (activitiesModule as Record<string, unknown>).BUILTIN_RESOLVER_IDS;
  if (raw instanceof Set) return [...raw].filter((x): x is string => typeof x === 'string');
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  return [];
}

const DISCOVERY = 'http://discovery-resolver-claim.test';

const app = new Hono();
app.route('/v2/activities', activitiesRouter);

type Task = { id: string; inputShapes: string[]; outputShapes: string[]; resolver?: string };
type TemplateRow = { id: string; tasks: Task[] };

/** FLOOR is 5 distinct composites per terminal; give each terminal 6. */
function composites(terminal: string, resolvers: [string | undefined, string | undefined], n = 6): TemplateRow[] {
  return Array.from({ length: n }, (_, i) => {
    const s1: Task = { id: 's1', inputShapes: ['goal'], outputShapes: [`mid${i}`] };
    const s2: Task = { id: 's2', inputShapes: [`mid${i}`], outputShapes: [terminal] };
    if (resolvers[0]) s1.resolver = resolvers[0];
    if (resolvers[1]) s2.resolver = resolvers[1];
    return { id: `learned-${terminal.replace(/[^a-zA-Z0-9]/g, '_')}-${i}`, tasks: [s1, s2] };
  });
}

describe('deliverable-shapes: a composite terminal is claimed when every task resolver is advertised', () => {
  const realFetch = globalThis.fetch;
  const prevEndpoint = process.env.DISCOVERY_VESSEL_ENDPOINT;
  let querySpy: ReturnType<typeof spyOn> | null = null;
  let templateRows: TemplateRow[] = [];
  let registryShapes: string[] = [];
  let unexpectedFetches: string[] = [];

  beforeEach(() => {
    unexpectedFetches = [];
    process.env.DISCOVERY_VESSEL_ENDPOINT = DISCOVERY;
    querySpy = spyOn(surrealDB, 'query').mockImplementation((async (sql: string) => {
      if (/FROM\s+goal_execution_paths/i.test(sql)) {
        // Every terminal in these fixtures has a reached run.
        const terminals = new Set<string>();
        for (const r of templateRows) for (const t of r.tasks) for (const s of t.outputShapes) if (!/^mid\d+$/.test(s)) terminals.add(s);
        return [...terminals].map((s) => ({ endpoint_output_shapes: [s], successful_executions: 3 }));
      }
      if (/FROM\s+activity\b/i.test(sql)) return templateRows.map((r) => ({ ...r }));
      return [];
    }) as any);
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(DISCOVERY) && new URL(url).pathname === '/registry/shapes') {
        return new Response(JSON.stringify({ shapes: registryShapes }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      unexpectedFetches.push(url);
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    querySpy?.mockRestore();
    querySpy = null;
    globalThis.fetch = realFetch;
    if (prevEndpoint === undefined) delete process.env.DISCOVERY_VESSEL_ENDPOINT;
    else process.env.DISCOVERY_VESSEL_ENDPOINT = prevEndpoint;
  });

  async function deliverables(): Promise<{ status: number; body: any }> {
    const res = await app.request('/v2/activities/deliverable-shapes');
    return { status: res.status, body: await res.json() };
  }

  test('CHECK: a terminal produced only by composites whose task resolvers are all advertised is admitted', async () => {
    templateRows = [
      ...composites('memoryNote_write', [undefined, undefined]),     // direct advertiser (guards a vacuous empty answer)
      ...composites('conceptDescription', ['concept_search', 'llm_completion']),
    ];
    // conceptDescription itself has NO direct advertiser; both of its composites' resolvers do.
    registryShapes = ['memoryNote_write', 'concept_search', 'llm_completion'];
    const { status, body } = await deliverables();
    expect(status).toBe(200);
    expect(unexpectedFetches).toEqual([]);
    expect(body.shapes).toContain('memoryNote_write');
    expect(body.shapes).toContain('conceptDescription');
  });

  test('MUST-FAIL: a terminal whose composite has an unadvertised task resolver, or a task with no resolver, is not admitted', async () => {
    templateRows = [
      ...composites('memoryNote_write', [undefined, undefined]),
      // obsidian:write_note: the vault left, so its resolver is gone; the llm step is still live.
      ...composites('obsidian:write_note', ['llm_completion', 'obsidian:write_note']),
      // a composite with resolver-less tasks claims nothing (no vacuous "every" over nothing).
      ...composites('unclaimedTerminal', [undefined, undefined]),
      // one live resolver and one resolver-less task: still not every task is claimed.
      ...composites('halfClaimedTerminal', ['concept_search', undefined]),
    ];
    registryShapes = ['memoryNote_write', 'concept_search', 'llm_completion'];
    const { status, body } = await deliverables();
    expect(status).toBe(200);
    expect(unexpectedFetches).toEqual([]);
    expect(body.shapes).toContain('memoryNote_write'); // not the fail-open empty answer
    expect(body.shapes).not.toContain('obsidian:write_note');
    expect(body.shapes).not.toContain('unclaimedTerminal');
    expect(body.shapes).not.toContain('halfClaimedTerminal');
  });

  test('CHECK: a composite whose task uses a BUILTIN resolver (not advertised in discovery) counts as claimed', async () => {
    const builtins = builtinResolverIds();
    expect(builtins.length).toBeGreaterThan(0); // BUILTIN_RESOLVER_IDS exported by ./activities
    const builtin = builtins.find((b) => b !== 'compose' && b !== 'compose_parallel') ?? builtins[0]!;
    templateRows = [
      ...composites('memoryNote_write', [undefined, undefined]),
      ...composites('builtinClaimedTerminal', [builtin, 'concept_search']),
    ];
    registryShapes = ['memoryNote_write', 'concept_search']; // the builtin id is NOT in the registry
    expect(registryShapes).not.toContain(builtin);
    const { status, body } = await deliverables();
    expect(status).toBe(200);
    expect(unexpectedFetches).toEqual([]);
    expect(body.shapes).toContain('memoryNote_write');
    expect(body.shapes).toContain('builtinClaimedTerminal');
  });

  test('MUST-FAIL: a resolver id that is neither builtin nor advertised is not claimed', async () => {
    const unknown = 'no_such_resolver_xyzzy';
    expect(builtinResolverIds()).not.toContain(unknown);
    templateRows = [
      ...composites('memoryNote_write', [undefined, undefined]),
      ...composites('unknownResolverTerminal', [unknown, 'concept_search']),
    ];
    registryShapes = ['memoryNote_write', 'concept_search'];
    const { status, body } = await deliverables();
    expect(status).toBe(200);
    expect(body.shapes).toContain('memoryNote_write');
    expect(body.shapes).not.toContain('unknownResolverTerminal');
  });

  /**
   * The engine's registered names as of 2026-10-02 (ias-executor-ts dev ed58e66):
   *   hosts/goal-host.ts GoalHost constructor (~663-740): file-read (id at :92), bash (:117),
   *     llm (:147), llm-prompt, impulse_preparation, iteration, impulse_pool_selection,
   *     producer_selection, impulse-resolve, validation, activity, learning_signal_writer;
   *   engine.ts:544 dispatches compose and compose_parallel itself (never looked up as resolvers).
   * goal-host-vessel adds activity_recommendation and impulse_cooccurrence (index.ts ~15354/15427).
   * The promote gate's inline set drifted: it has `file_read` (registered nowhere) and lacks
   * `file-read` and `compose_parallel`.
   */
  test('CHECK: BUILTIN_RESOLVER_IDS carries the engine-registered names (file-read, compose_parallel), not the drifted file_read', () => {
    const builtins = builtinResolverIds();
    for (const id of [
      'file-read', 'bash', 'llm', 'llm-prompt', 'impulse_preparation', 'iteration',
      'impulse_pool_selection', 'producer_selection', 'impulse-resolve', 'validation', 'activity',
      'learning_signal_writer', 'compose', 'compose_parallel',
      'activity_recommendation', 'impulse_cooccurrence',
    ]) {
      expect(builtins).toContain(id);
    }
    expect(builtins).not.toContain('file_read');
  });

  test('CHECK: the promote gate and deliverable-shapes consult the SAME exported BUILTIN_RESOLVER_IDS object', async () => {
    const shared = (activitiesModule as Record<string, unknown>).BUILTIN_RESOLVER_IDS;
    expect(shared instanceof Set).toBe(true);
    const set = shared as Set<string>;
    const builtin = [...set].find((b) => b !== 'compose' && b !== 'compose_parallel')!;
    const hasSpy = spyOn(set, 'has');
    try {
      // deliverable-shapes: a composite whose builtin task resolver is not in the registry
      templateRows = [
        ...composites('memoryNote_write', [undefined, undefined]),
        ...composites('builtinClaimedTerminal', [builtin, 'concept_search']),
      ];
      registryShapes = ['memoryNote_write', 'concept_search'];
      await deliverables();
      expect(hasSpy.mock.calls.some((args) => args[0] === builtin)).toBe(true);

      // promote gate: a proposed template whose only task uses that builtin
      hasSpy.mockClear();
      querySpy?.mockImplementation((async (sql: string) => {
        if (/FROM\s+activity:`/i.test(sql)) {
          return [{ id: 'activity:proposed-builtin', proposed: true, name: 'proposed-builtin', tasks: [{ id: 't1', resolver: builtin }], input_shapes: ['goal'], output_shapes: ['x'] }];
        }
        return [];
      }) as any);
      registryShapes = [];
      await app.request('/v2/activities/templates/proposed-builtin/promote', { method: 'POST' });
      expect(hasSpy.mock.calls.some((args) => args[0] === builtin)).toBe(true);
    } finally {
      hasSpy.mockRestore();
    }
  });

  test('CONTROL: a terminal with a direct live advertiser is admitted regardless of task resolvers', async () => {
    templateRows = [
      ...composites('memoryNote_write', [undefined, undefined]),
      ...composites('traceAggregateReport', ['not_advertised_resolver', undefined]),
    ];
    registryShapes = ['memoryNote_write', 'traceAggregateReport'];
    const { status, body } = await deliverables();
    expect(status).toBe(200);
    expect(body.shapes).toContain('memoryNote_write');
    expect(body.shapes).toContain('traceAggregateReport');
    // intermediates are still not deliverables
    expect(body.shapes.some((s: string) => /^mid\d+$/.test(s))).toBe(false);
  });
});
