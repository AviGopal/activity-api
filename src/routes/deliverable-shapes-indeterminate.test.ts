/**
 * GET /v2/activities/deliverable-shapes — an indeterminate discovery read must never become a
 * shrunken list.
 *
 * goal-host (fetchKnownShapes) keeps its last good vocabulary on a non-2xx or EMPTY answer but
 * REPLACES it with any non-empty list. So if discovery is flaky and the gate silently drops the
 * shapes it could not confirm, real deliverables vanish from inference. The handler reads
 * discovery's advertised vocabulary ONCE, all-or-nothing: if that read times out, answers
 * non-2xx or returns a malformed body, the endpoint answers 503 discovery_indeterminate.
 *
 * Seams: spies on the real `surrealDB.query` export (restored after each test) and a
 * globalThis.fetch stub for discovery (restored after each test). No mock.module.
 */
import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import activitiesRouter from './activities';
import { surrealDB } from '../db/surreal';

const DISCOVERY = 'http://discovery-indeterminate.test';
const TERMINALS = ['memoryNote_write', 'traceAggregateReport', 'problem_detection'];

const app = new Hono();
app.route('/v2/activities', activitiesRouter);

function composites(terminal: string, n = 6) {
  return Array.from({ length: n }, (_, i) => ({
    id: `learned-${terminal}-${i}`,
    tasks: [
      { id: 's1', inputShapes: ['goal'], outputShapes: [`mid${i}`] },
      { id: 's2', inputShapes: [`mid${i}`], outputShapes: [terminal] },
    ],
  }));
}

type DiscoveryMode = 'ok' | 'timeout' | 'status500' | 'malformed';

describe('deliverable-shapes: indeterminate discovery answers 503, never a shrunken list', () => {
  const realFetch = globalThis.fetch;
  const prevEndpoint = process.env.DISCOVERY_VESSEL_ENDPOINT;
  let querySpy: ReturnType<typeof spyOn> | null = null;
  let discoveryCalls = 0;

  function stubDiscovery(mode: DiscoveryMode) {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(DISCOVERY)) throw new Error(`unexpected fetch in test: ${url}`);
      discoveryCalls++;
      if (mode === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
      if (mode === 'status500') return new Response('upstream down', { status: 500 });
      const body = mode === 'malformed' ? { vessels: [] } : { shapes: [...TERMINALS, 'unrelated_shape'] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  }

  beforeEach(() => {
    discoveryCalls = 0;
    process.env.DISCOVERY_VESSEL_ENDPOINT = DISCOVERY;
    querySpy = spyOn(surrealDB, 'query').mockImplementation((async (sql: string) => {
      if (/FROM\s+goal_execution_paths/i.test(sql)) {
        return TERMINALS.map((s) => ({ endpoint_output_shapes: [s], successful_executions: 3 }));
      }
      if (/FROM\s+activity\b/i.test(sql)) return TERMINALS.flatMap((t) => composites(t));
      return [];
    }) as any);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (prevEndpoint === undefined) delete process.env.DISCOVERY_VESSEL_ENDPOINT;
    else process.env.DISCOVERY_VESSEL_ENDPOINT = prevEndpoint;
    querySpy?.mockRestore();
    querySpy = null;
  });

  for (const mode of ['timeout', 'status500', 'malformed'] as const) {
    test(`discovery read ${mode} with 3 reached candidates -> 503 discovery_indeterminate`, async () => {
      stubDiscovery(mode);
      const res = await app.request('/v2/activities/deliverable-shapes');
      expect(res.status).toBe(503);
      const body: any = await res.json();
      expect(body.reason).toBe('discovery_indeterminate');
      expect(body.unresolved).toBe(3);
      expect(body.shapes).toBeUndefined();
    });
  }

  test('CONTROL: discovery answers -> 200 list of all 3 reached + advertised terminals, one discovery read', async () => {
    stubDiscovery('ok');
    const res = await app.request('/v2/activities/deliverable-shapes');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect([...body.shapes].sort()).toEqual([...TERMINALS].sort());
    expect(discoveryCalls).toBe(1);
  });
});
