/**
 * F-49 regression coverage (2026-04-27): the canary registry surfaced
 * three templates whose record id was doubled-wrapped, e.g.
 * `activity:⟨activity:⟨hello-world-minimal⟩⟩` instead of the canonical
 * `activity:⟨hello-world-minimal⟩`. This was reproducible end-to-end:
 *
 *   curl https://activity.metabob.com/v2/activities/templates?limit=10
 *
 * Root cause: the POST /v2/activities/templates handler interpolated the
 * caller-supplied `id` field directly into the SurrealDB UPSERT
 * statement (`UPSERT activity:\`${activityId}\``). When a client
 * round-tripped a previously-fetched template id back into POST without
 * unwrapping the SurrealDB record-id form (e.g. `"activity:hello-world-minimal"`
 * or the angle-bracket form `"activity:⟨hello-world-minimal⟩"`), the
 * upsert created a *new* record with the activity prefix baked into the
 * id portion — a doubled wrap on subsequent reads.
 *
 * Fix: strip leading `activity:`, angle brackets, and backticks from
 * `activityId` before any DB interpolation so the upsert always targets
 * the canonical bare-name record.
 */

import { describe, test, expect, mock } from 'bun:test';
import { Hono } from 'hono';

// Capture every SurrealDB query the handler issues so the test can
// assert on the UPSERT record-id selector.
const surrealQueries: { sql: string; params: unknown }[] = [];

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params: unknown) => {
      surrealQueries.push({ sql, params });
      return [];
    },
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
}));

// Stub Redis so cache invalidation in POST /templates does not block
// against a missing local Redis (the test environment has no Redis
// container; we only care about the SurrealDB upsert SQL anyway).
mock.module('../db/redis', () => ({
  RedisClient: {
    getInstance: () => ({
      del: async () => 0,
      get: async () => null,
      set: async () => 'OK',
      sadd: async () => 0,
      smembers: async () => [],
      withLock: async (_lockKey: unknown, _cacheKey: unknown, fn: () => Promise<unknown>) => fn(),
    }),
  },
}));

// Loaded after the mocks so the handler picks them up.
const activitiesRouter = (await import('./activities')).default;

const app = new Hono();
app.route('/v2/activities', activitiesRouter);

const baseTemplate = {
  name: 'Test Template',
  description: 'F-49 regression fixture',
  category: 'tool',
  tasks: [
    { id: 't1', description: 'one', prompt: { template: 'do thing' } },
  ],
  scope: 'global' as const,
  public: false,
  output_shapes: ['tool_output'],
};

// Look at all SQL that the handler issued and find the upsert statement
// targeting the `activity:` table. Returns the record-id between the
// table prefix and the trailing `CONTENT {` so the assertion can match
// the bare-name without depending on whitespace.
function findActivityUpsertId(): string | null {
  for (const call of surrealQueries) {
    const m = call.sql.match(/UPSERT\s+activity:`([^`]+)`\s+CONTENT/);
    if (m) {
      return m[1];
    }
  }
  return null;
}

function resetCapturedQueries(): void {
  surrealQueries.length = 0;
}

describe('POST /v2/activities/templates — F-49 activity id normalization', () => {
  test('bare id passes through unchanged (regression: must still work)', async () => {
    resetCapturedQueries();
    const response = await app.request('/v2/activities/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseTemplate, id: 'hello-world-minimal' }),
    });

    expect(response.status).toBeLessThan(400);
    expect(findActivityUpsertId()).toBe('hello-world-minimal');
  });

  test('prefixed `activity:name` form is stripped before upsert (F-49 canary symptom)', async () => {
    resetCapturedQueries();
    const response = await app.request('/v2/activities/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...baseTemplate,
        // Client round-tripped the SurrealDB record-id string form back
        // into POST without unwrapping. Pre-fix, this produced a doubled
        // record id on canary.
        id: 'activity:hello-world-minimal',
      }),
    });

    expect(response.status).toBeLessThan(400);
    const upsertId = findActivityUpsertId();
    expect(upsertId).toBe('hello-world-minimal');
    // Negative assertion: the doubled form is the canary symptom we
    // want gone.
    expect(upsertId).not.toMatch(/^activity:/);
  });

  test('angle-bracket `activity:⟨name⟩` form is stripped before upsert', async () => {
    resetCapturedQueries();
    const response = await app.request('/v2/activities/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...baseTemplate,
        // The form a SurrealDB driver toString() would have produced;
        // some clients JSON.stringify the RecordId object directly.
        id: 'activity:⟨hello-world-minimal⟩',
      }),
    });

    expect(response.status).toBeLessThan(400);
    const upsertId = findActivityUpsertId();
    expect(upsertId).toBe('hello-world-minimal');
    expect(upsertId).not.toContain('⟨');
    expect(upsertId).not.toContain('⟩');
  });

  test('legacy variant_id field also normalized', async () => {
    resetCapturedQueries();
    const response = await app.request('/v2/activities/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...baseTemplate,
        id: undefined,
        variant_id: 'activity:execute-shell-command',
      }),
    });

    expect(response.status).toBeLessThan(400);
    expect(findActivityUpsertId()).toBe('execute-shell-command');
  });

  test('successful response surfaces the canonical (un-prefixed) id', async () => {
    resetCapturedQueries();
    const response = await app.request('/v2/activities/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...baseTemplate,
        id: 'activity:⟨my-template⟩',
      }),
    });

    expect(response.status).toBeLessThan(400);
    const json = await response.json();
    if (json && typeof json === 'object' && 'id' in json) {
      expect(json.id).toBe('my-template');
    }
  });
});
