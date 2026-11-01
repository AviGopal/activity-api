/**
 * /v2/impulses/resolve → activityTemplate_deprecate (and _update)
 *
 * The deprecate / update handlers used to combine the existence check and
 * the RBAC admin/org gate into a single SurrealQL WHERE clause. When the
 * caller lacked permission for an existing row, the query returned 0 rows and
 * the handler emitted `404 Template not found` — indistinguishable from "row
 * doesn't exist". This information leak caused callers to chase phantom
 * id-format issues.
 *
 * The fix splits the check: a permissionless existence query first, then an
 * application-level admin/org check. Tests below verify:
 *
 *   - Genuinely missing id → 404 "Template not found"
 *   - Existing global-scope row, non-admin caller → 403 "admin scope required"
 *   - Existing other-org row, non-admin caller → 403 "different org"
 *   - Existing same-org row → 200 success (UPDATE applied)
 *   - Existing global-scope row, admin caller → 200 success
 *
 * The SurrealDB module is replaced with a stub that intercepts queries and
 * returns canned rows. No live DB needed.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Stubbed SurrealDB module — must be registered before importing the route.
// ---------------------------------------------------------------------------

type StubHandler = (sql: string, params?: Record<string, any>) => unknown;

interface QueryRecord {
  sql: string;
  params?: Record<string, any>;
}

const queryLog: QueryRecord[] = [];
let queryHandler: StubHandler = () => [];

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params?: Record<string, any>) => {
      queryLog.push({ sql, params });
      return queryHandler(sql, params);
    },
  },
  queryWithAuth: async (
    _token: string,
    sql: string,
    params?: Record<string, any>,
  ) => {
    queryLog.push({ sql, params });
    return queryHandler(sql, params);
  },
  createAuthenticatedClient: async () => ({}),
}));

// Stub Redis so the 200 paths' template-cache invalidation does not retry against a
// missing local Redis until the test times out (same stub as activities-mint-dedup.test.ts).
const redisStub = {
  del: async () => 0,
  get: async () => null,
  set: async () => 'OK',
  sadd: async () => 0,
  smembers: async () => [],
  withLock: async (_lockKey: unknown, _cacheKey: unknown, fn: () => Promise<unknown>) => fn(),
};
mock.module('../db/redis', () => ({
  RedisClient: { getInstance: () => redisStub },
  redis: redisStub,
}));

// Import AFTER the module mock is registered.
const impulsesRoutes = (await import('./impulses')).default;

// ---------------------------------------------------------------------------
// Test app helpers
// ---------------------------------------------------------------------------

interface StubAuthOptions {
  orgId?: string;
  isAdmin?: boolean;
}

function buildAppWithStubAuth(opts: StubAuthOptions = {}): Hono {
  const app = new Hono();
  const orgId = opts.orgId ?? 'org-test';
  const role = opts.isAdmin ? 'admin' : 'user';
  app.use('*', async (c, next) => {
    c.set('jwtAuth', {
      orgId,
      projectId: undefined,
      projectIds: undefined,
      instanceId: undefined,
      authType: 'apikey',
      jwtToken: 'stub-jwt-for-tests',
      keyId: 'test-key',
      userId: 'test-user',
      role,
      scopes: opts.isAdmin ? ['admin'] : ['read', 'write'],
    });
    await next();
  });
  app.route('/v2/impulses', impulsesRoutes);
  return app;
}

async function resolve(
  app: Hono,
  pointer: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await app.request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointer }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

function resetQueryLog() {
  queryLog.length = 0;
  queryHandler = () => [];
}

/**
 * Configure the stub so the first query (the SELECT existence probe) returns
 * the given row (or null) and any subsequent queries (UPDATE, INSERT audit)
 * return an empty/echo result. This mirrors the call ordering in the handler:
 * SELECT existence → UPDATE → INSERT impulse audit.
 */
function withExistenceRow(row: Record<string, any> | null) {
  let calls = 0;
  queryHandler = (sql: string) => {
    calls += 1;
    if (calls === 1) {
      // First call: existence SELECT. Return canned row.
      return row ? [row] : [];
    }
    // Subsequent calls: UPDATE / INSERT audit. Echo back something benign.
    if (sql.includes('UPDATE')) {
      // RETURN AFTER expects a row; echo the existence row with deprecation set.
      return [{ ...(row ?? {}), deprecated: true }];
    }
    return [];
  };
}

// ---------------------------------------------------------------------------
// activityTemplate_deprecate
// ---------------------------------------------------------------------------

describe('POST /v2/impulses/resolve → activityTemplate_deprecate (404 vs 403)', () => {
  beforeEach(resetQueryLog);

  test('genuinely missing id returns 404 Template not found', async () => {
    withExistenceRow(null);
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_deprecate',
      templateId: 'no-such-template',
    });
    expect(status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error).toContain('not found');
  });

  test('existing global-scope row + non-admin caller without evidence returns 422 insufficient_evidence', async () => {
    withExistenceRow({
      id: 'activity:foo',
      scope: 'global',
      org_id: 'org-other',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_deprecate',
      templateId: 'foo',
    });
    // Policy change 2026-06-04: rescind admin-only RBAC; substrate can
    // deprecate global templates when Thompson evidence is supplied.
    expect(status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.error).toContain('insufficient_evidence');
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(false);
  });

  test('existing global-scope row + non-admin caller WITH sufficient evidence returns 200', async () => {
    withExistenceRow({
      id: 'activity:foo-2',
      scope: 'global',
      org_id: 'org-other',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_deprecate',
      templateId: 'foo-2',
      reason: 'winner dominates over 20 runs each',
      evidence: {
        reason: 'winner dominates over 20 runs each',
        winner_alpha: 18, winner_beta: 2,
        loser_alpha: 5, loser_beta: 15,
        loser_samples: 20,
      },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(true);
  });

  test('existing other-org row + non-admin caller returns 403 different-org', async () => {
    withExistenceRow({
      id: 'activity:bar',
      scope: 'org',
      org_id: 'org-other',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_deprecate',
      templateId: 'bar',
    });
    expect(status).toBe(403);
    expect(body.success).toBe(false);
    expect(body.error).toContain('different org');
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(false);
  });

  test('existing same-org row returns 200 with UPDATE issued', async () => {
    withExistenceRow({
      id: 'activity:baz',
      scope: 'org',
      org_id: 'org-test',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_deprecate',
      templateId: 'baz',
      reason: 'superseded',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.metadata.shape).toBe('activityTemplate_deprecate_result');
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(true);
  });

  test('existing global-scope row + admin caller returns 200', async () => {
    withExistenceRow({
      id: 'activity:global-foo',
      scope: 'global',
      org_id: 'org-platform',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: true });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_deprecate',
      templateId: 'global-foo',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// activityTemplate_update — same anti-pattern, fixed in lockstep.
// ---------------------------------------------------------------------------

describe('POST /v2/impulses/resolve → activityTemplate_update (404 vs 403)', () => {
  beforeEach(resetQueryLog);

  test('genuinely missing id returns 404', async () => {
    withExistenceRow(null);
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_update',
      templateId: 'no-such',
      updates: { name: 'renamed' },
    });
    expect(status).toBe(404);
    expect(body.error).toContain('not found');
  });

  test('existing global-scope row + non-admin without evidence returns 422', async () => {
    withExistenceRow({
      id: 'activity:foo',
      scope: 'global',
      org_id: 'org-other',
      name: 'orig',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_update',
      templateId: 'foo',
      updates: { name: 'renamed' },
    });
    expect(status).toBe(422);
    expect(body.error).toContain('insufficient_evidence');
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(false);
  });

  test('existing global-scope row + non-admin WITH reason-only evidence returns 200', async () => {
    withExistenceRow({
      id: 'activity:foo-3',
      scope: 'global',
      org_id: 'org-other',
      name: 'orig',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_update',
      templateId: 'foo-3',
      updates: { name: 'renamed' },
      evidence: { reason: 'rename for consistency with shape contract' },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(true);
  });

  test('existing other-org row + non-admin returns 403 different-org', async () => {
    withExistenceRow({
      id: 'activity:bar',
      scope: 'org',
      org_id: 'org-other',
      name: 'orig',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_update',
      templateId: 'bar',
      updates: { name: 'renamed' },
    });
    expect(status).toBe(403);
    expect(body.error).toContain('different org');
  });

  test('existing same-org row returns 200', async () => {
    withExistenceRow({
      id: 'activity:baz',
      scope: 'org',
      org_id: 'org-test',
      name: 'orig',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_update',
      templateId: 'baz',
      updates: { name: 'renamed' },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.metadata.shape).toBe('activityTemplate_update_result');
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// activityTemplate_update — the placeholder gate reads declarations from the
// row the UPDATE merges into (`activity`), not only the legacy table.
// ---------------------------------------------------------------------------

describe('POST /v2/impulses/resolve → activityTemplate_update placeholder gate reads declared variables from `activity`', () => {
  beforeEach(resetQueryLog);

  const TEMPLATE_ID = 'development-vessel:own-check-baseline';
  const row = { id: `activity:${TEMPLATE_ID}`, scope: 'org', org_id: 'org-test', name: 'own-check-baseline' };

  // Route each query by what it reads: the gate's `activity` variables read, the legacy
  // `activity_template` read, the existence SELECT, and the UPDATE.
  function withRows(opts: { activityVars?: unknown[] | null; legacyVars?: unknown[] | null }) {
    queryHandler = (sql: string) => {
      if (sql.includes('SELECT variables FROM activity_template')) {
        return opts.legacyVars ? [{ variables: opts.legacyVars }] : [];
      }
      if (sql.includes('SELECT variables FROM activity ')) {
        return opts.activityVars === null ? [] : [{ ...row, variables: opts.activityVars }];
      }
      if (sql.includes('SELECT * FROM activity')) return [row];
      if (sql.includes('UPDATE activity')) return [row];
      return [];
    };
  }

  const update = (tasks: unknown[]) =>
    resolve(buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false }), {
      type: 'activityTemplate_update',
      templateId: TEMPLATE_ID,
      updates: { tasks },
    });

  const declared = [{ name: 'gap_id' }, { name: 'base_ref' }];

  test('MUST-FAIL — placeholders declared on the `activity` row are accepted and the UPDATE runs', async () => {
    withRows({ activityVars: declared, legacyVars: null });
    const { status, body } = await update([
      { id: 'classify', resolver: 'own_check_baseline_classify', config: { gap: '{{gap_id}}', base: '{{base_ref}}' } },
    ]);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(true);
  });

  test('an undeclared placeholder on that same template is still refused', async () => {
    withRows({ activityVars: declared, legacyVars: null });
    const { status, body } = await update([
      { id: 'classify', resolver: 'own_check_baseline_classify', config: { gap: '{{gap_id}}', x: '{{x}}' } },
    ]);
    expect(status).toBe(400);
    expect(body.refused).toBe(true);
    expect(body.error).toContain('{{x}}');
    expect(body.error).not.toContain('{{gap_id}}');
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(false);
  });

  test('a template with no variables in either table still has its placeholder refused', async () => {
    withRows({ activityVars: undefined, legacyVars: null });
    const { status, body } = await update([{ id: 'classify', config: { gap: '{{gap_id}}' } }]);
    expect(status).toBe(400);
    expect(body.refused).toBe(true);
    expect(body.error).toContain('{{gap_id}}');
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(false);
  });

  test('the legacy table is not consulted when the `activity` row exists', async () => {
    withRows({ activityVars: undefined, legacyVars: declared });
    const { status, body } = await update([{ id: 'classify', config: { gap: '{{gap_id}}' } }]);
    expect(status).toBe(400);
    expect(body.error).toContain('{{gap_id}}');
    expect(queryLog.some((q) => q.sql.includes('FROM activity_template'))).toBe(false);
  });

  test('CONTROL — a task update with no placeholders is accepted as before', async () => {
    withRows({ activityVars: undefined, legacyVars: null });
    const { status, body } = await update([{ id: 'classify', resolver: 'own_check_baseline_classify' }]);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// activityTemplate_update — `variables` is updatable, so a row whose stored
// declarations were lost (variables NULL) can declare its placeholders again.
// ---------------------------------------------------------------------------

describe('POST /v2/impulses/resolve → activityTemplate_update accepts a shape-checked `variables` update', () => {
  beforeEach(resetQueryLog);

  const TEMPLATE_ID = 'development-vessel:own-check-baseline';
  // The live row after the fold: an `activity` row exists, its variables are NULL.
  const row = { id: `activity:${TEMPLATE_ID}`, scope: 'org', org_id: 'org-test', name: 'own-check-baseline', variables: null };

  function withNullVarsRow() {
    queryHandler = (sql: string) => {
      if (sql.includes('FROM activity_template')) return [];
      if (sql.includes('SELECT variables FROM activity ')) return [row];
      if (sql.includes('SELECT * FROM activity')) return [row];
      if (sql.includes('UPDATE activity')) return [row];
      return [];
    };
  }

  const update = (updates: Record<string, unknown>) =>
    resolve(buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false }), {
      type: 'activityTemplate_update',
      templateId: TEMPLATE_ID,
      updates,
    });

  const tasks = [{ id: 'classify', resolver: 'own_check_baseline_classify', config: { gap: '{{gap_id}}', base: '{{base_ref}}' } }];
  const updateCall = () => queryLog.find((q) => q.sql.includes('UPDATE activity MERGE'));

  test('MUST-FAIL — variables declared in the update cover its placeholders: accepted, and the UPDATE carries them', async () => {
    withNullVarsRow();
    const variables = [{ name: 'gap_id' }, { name: 'base_ref' }];
    const { status, body } = await update({ variables, tasks });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(updateCall()?.params?.updates?.variables).toEqual(variables);
  });

  test('a placeholder the update does not declare is still refused, naming it', async () => {
    withNullVarsRow();
    const { status, body } = await update({ variables: [{ name: 'gap_id' }], tasks });
    expect(status).toBe(400);
    expect(body.refused).toBe(true);
    expect(body.error).toContain('{{base_ref}}');
    expect(body.error).not.toContain('{{gap_id}}');
    expect(updateCall()).toBeUndefined();
  });

  for (const [label, variables] of [
    ['a string', 'gap_id'],
    ['an object', { name: 'gap_id' }],
    ['an entry without a name', [{}]],
    ['an empty name', [{ name: '' }]],
    ['a non-string name', [{ name: 7 }]],
    ['a non-object entry', ['gap_id']],
  ] as Array<[string, unknown]>) {
    test(`malformed variables (${label}) are refused 400 and nothing is written`, async () => {
      withNullVarsRow();
      const { status, body } = await update({ variables, tasks });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      // the shape check names the problem (not the field-level refusal that preceded it)
      expect(String(body.error)).toContain('Invalid update field: variables');
      expect(updateCall()).toBeUndefined();
    });
  }

  test('CONTROL — without a variables update, a NULL-variables row still has its placeholders refused', async () => {
    withNullVarsRow();
    const { status, body } = await update({ tasks });
    expect(status).toBe(400);
    expect(body.error).toContain('{{gap_id}}');
    expect(updateCall()).toBeUndefined();
  });

  test('CONTROL — a global row still needs evidence for a variables update (no new write path)', async () => {
    const globalRow = { ...row, scope: 'global', org_id: 'org-other' };
    queryHandler = (sql: string) => {
      if (sql.includes('SELECT variables FROM activity ') || sql.includes('SELECT * FROM activity')) return [globalRow];
      return [];
    };
    const { status, body } = await update({ variables: [{ name: 'gap_id' }, { name: 'base_ref' }], tasks });
    expect(status).toBe(422);
    expect(body.error).toContain('insufficient_evidence');
    expect(updateCall()).toBeUndefined();
  });
});
