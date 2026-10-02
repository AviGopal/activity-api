/**
 * GET /v2/activities/deliverable-shapes — the deliverable vocabulary must be EARNED, not declared.
 *
 * goal-host unions this list into goal->target inference (fetchLearnedDeliverableShapes ->
 * fetchKnownShapes), so every entry is a shape a goal can be AIMED at. The gate was `ev > 0`
 * over learned-/composed-cap templates, and every such template sits at ev = 0.5 (638/638
 * measured), so it filtered nothing: `obsidian:write_note` stayed on the list after the vault
 * that serves it was gone, and goals were aimed at a shape nothing can produce.
 *
 * The gate under test (REALIGNMENT output-shapes APPROACH step 0, V1): a terminal shape is a
 * deliverable only with BOTH
 *   - evidence of a reached run producing it, and
 *   - a live advertiser for it in discovery (>= 1 producer).
 *
 * Seams mocked (the real ones the handler can read):
 *   - surrealDB.query (mock.module '../db/surreal'):
 *       `... FROM activity ...`           -> learned-/composed-cap template rows (ev 0.5 each)
 *       `... FROM goal_execution_paths ...` -> path rows { endpoint_output_shapes,
 *         successful_executions, total_executions }. goal-host posts `success: reached` to
 *         POST /v2/goal-paths, so successful_executions counts REACHED runs. The mock honours a
 *         shape filter bound in params and a `successful_executions` predicate in the SQL text,
 *         so the reach check may live in the query or in JS.
 *   - globalThis.fetch to discovery (DISCOVERY_VESSEL_ENDPOINT), both real forms:
 *       POST /resolve { pointer: { type: 'vesselCapability', shape } }
 *         -> { content: { shape, vessels: [{ vesselId }], found }, metadata }
 *       GET  /registry/shapes -> { shapes: string[] }
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';

const DISCOVERY = 'http://discovery.test';
process.env.DISCOVERY_VESSEL_ENDPOINT = DISCOVERY;

type PathRow = { endpoint_output_shapes: string[]; successful_executions: number; total_executions: number };

let templateRows: Array<{ id: string; ev: number; retired: boolean; tasks: unknown[] }> = [];
let pathRows: PathRow[] = [];
let advertised: Record<string, string[]> = {};
const sqlSeen: string[] = [];

function stringsIn(v: unknown, out: Set<string>): Set<string> {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, out);
  return out;
}

mock.module('../db/surreal', () => ({
  surrealDB: {
    async query(sql: string, params: Record<string, unknown> = {}) {
      sqlSeen.push(sql);
      if (/FROM\s+goal_execution_paths/i.test(sql)) {
        let rows = pathRows;
        const bound = stringsIn(params, new Set());
        const known = new Set(pathRows.flatMap((r) => r.endpoint_output_shapes));
        const asked = [...bound].filter((s) => known.has(s));
        if (asked.length > 0) rows = rows.filter((r) => r.endpoint_output_shapes.some((s) => asked.includes(s)));
        if (/successful_executions\s*(>|>=|!=)/i.test(sql)) rows = rows.filter((r) => r.successful_executions > 0);
        return rows.map((r) => ({ ...r }));
      }
      if (/FROM\s+activity\b/i.test(sql)) return templateRows.map((r) => ({ ...r }));
      return [];
    },
  },
  // Stubs to satisfy mock-module-completeness.test.ts
  getDbStats: () => ({}),
  dbStats: { snapshot: () => ({}) },
  createAuthenticatedClient: async () => ({ query: async () => [], close: () => {} }),
  queryWithAuth: async () => [],
}));

const redisStub = {
  del: async () => 0,
  get: async () => null,
  set: async () => 'OK',
  sadd: async () => 0,
  smembers: async () => [],
  withLock: async (_l: unknown, _k: unknown, fn: () => Promise<unknown>) => fn(),
};
mock.module('../db/redis', () => ({
  RedisClient: { getInstance: () => redisStub },
  redis: redisStub,
}));

const activitiesRouter = (await import('./activities')).default;
const app = new Hono();
app.route('/v2/activities', activitiesRouter);

/** FLOOR is 5 distinct composites per terminal; give each terminal 6. */
function composites(terminal: string, n = 6) {
  return Array.from({ length: n }, (_, i) => ({
    id: `learned-${terminal.replace(/[^a-zA-Z0-9]/g, '_')}-${i}`,
    ev: 0.5,
    retired: false,
    tasks: [
      { id: 's1', inputShapes: ['goal'], outputShapes: [`mid${i}`] },
      { id: 's2', inputShapes: [`mid${i}`], outputShapes: [terminal] },
    ],
  }));
}

const reached = (shape: string, n = 3): PathRow => ({ endpoint_output_shapes: [shape], successful_executions: n, total_executions: n + 2 });
const neverReached = (shape: string): PathRow => ({ endpoint_output_shapes: [shape], successful_executions: 0, total_executions: 6 });

async function deliverables(): Promise<{ status: number; body: any }> {
  const res = await app.request('/v2/activities/deliverable-shapes');
  return { status: res.status, body: await res.json() };
}

describe('deliverable-shapes gate (REALIGNMENT V1)', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    sqlSeen.length = 0;
    templateRows = [
      ...composites('memoryNote_write'),
      ...composites('traceAggregateReport'),
      ...composites('problem_detection'),
      ...composites('conceptDescription'),
      ...composites('obsidian:write_note'),
    ];
    advertised = {
      memoryNote_write: ['development-vessel'],
      traceAggregateReport: ['activity-api'],
      problem_detection: ['analysis-vessel'],
      conceptDescription: ['concept-db'],
      // obsidian:write_note: no advertiser — the vault is gone.
    };
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(DISCOVERY)) throw new Error(`unexpected fetch in test: ${url}`);
      const path = new URL(url).pathname;
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (path === '/registry/shapes') {
        return json({ shapes: Object.keys(advertised).filter((s) => advertised[s]!.length > 0) });
      }
      if (path === '/resolve') {
        const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}')));
        const shape = String(body?.pointer?.shape ?? '');
        const vessels = (advertised[shape] ?? []).map((vesselId) => ({ vesselId, health_score: 1 }));
        return json({ content: { shape, vessels, found: vessels.length > 0 }, metadata: { shape: 'vesselCapability' } });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('CHECK: a terminal with no live advertiser or no reached run is not offered as a deliverable', async () => {
    pathRows = [
      reached('memoryNote_write'),
      reached('traceAggregateReport'),
      reached('problem_detection'),
      neverReached('conceptDescription'), // advertised, learned, ev 0.5 — but never reached
      neverReached('obsidian:write_note'), // no advertiser AND never reached
    ];
    const { status, body } = await deliverables();
    expect(status).toBe(200);
    // Guard against a vacuous pass via the fail-open empty answer.
    expect(body.shapes).toContain('memoryNote_write');
    // must-fail control: unadvertised terminal, ev 0.5 — on the list under `ev > 0`.
    expect(body.shapes).not.toContain('obsidian:write_note');
    // discriminating: advertised learned terminal with zero reached runs.
    expect(body.shapes).not.toContain('conceptDescription');
  });

  test('CONTROL: advertised terminals with reached runs stay listed, as { shapes: string[] }', async () => {
    pathRows = [
      reached('memoryNote_write'),
      reached('traceAggregateReport'),
      reached('problem_detection'),
      reached('conceptDescription', 2),
    ];
    advertised['obsidian:write_note'] = ['obsidian-vessel']; // advertiser alone must not be the thing under test here
    pathRows.push(reached('obsidian:write_note', 1));
    const { status, body } = await deliverables();
    expect(status).toBe(200);
    expect(Array.isArray(body.shapes)).toBe(true);
    for (const s of body.shapes) expect(typeof s).toBe('string');
    for (const s of ['memoryNote_write', 'traceAggregateReport', 'problem_detection', 'conceptDescription', 'obsidian:write_note']) {
      expect(body.shapes).toContain(s);
    }
    // Intermediates (produced then consumed within a composite) are still not deliverables.
    expect(body.shapes.some((s: string) => /^mid\d+$/.test(s))).toBe(false);
  });
});
