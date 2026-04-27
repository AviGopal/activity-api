/**
 * F-NN-D regression coverage (2026-04-27): the
 * `activityTemplatesByMetrics` resolver renders markdown for the top-N
 * templates by execution metrics. The merge between
 * `variant_performance_metrics` (where `variant_id` is a plain `string`)
 * and the `activity_template` view (where `variant_id` is aliased from
 * the `activity` table's record id, so the JS driver returns a
 * `RecordId` object) used a strict-equality `.find` that always missed,
 * leaving every template field undefined in the rendered output.
 *
 * Symptom on canary (https://activity.metabob.com):
 *
 *   curl -X POST .../v2/impulses/resolve -d '{"pointer":{"type":"activityTemplatesByMetrics","limit":3}}'
 *
 *   # | undefined | 100.0% | 619 | 506084ms | N/A |
 *   # **ID**: `undefined`
 *   # **Category**: undefined
 *
 * This test stubs the SurrealDB driver to return a `RecordId`-shaped
 * object on the view-aliased `variant_id` column (matching what canary
 * does today) and asserts the markdown carries real values.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// RecordId-shaped stub mimicking what the SurrealDB driver returns for the
// view-aliased `id AS variant_id` column. The default JS-driver toString
// renders as `activity:⟨name⟩`.
function recordId(name: string): { tb: string; id: string; toString: () => string } {
  return {
    tb: 'activity',
    id: name,
    toString: () => `activity:⟨${name}⟩`,
  };
}

// Sequenced query stub: handler issues two queries in order — first
// metrics from `variant_performance_metrics`, then template details from
// the `activity_template` view. We hand back the metrics with plain
// `string` ids and the view with RecordId-shaped ids to reproduce the
// canary mismatch.
const metricsRows = [
  {
    variant_id: 'hello-world-minimal',
    total_executions: 619,
    success_rate: 1.0,
    avg_duration_ms: 506084,
    avg_cost_usd: null,
  },
  {
    variant_id: 'execute-shell-command',
    total_executions: 7,
    success_rate: 1.0,
    avg_duration_ms: 52826,
    avg_cost_usd: 0.2149,
  },
];

const templateRows = [
  {
    variant_id: recordId('hello-world-minimal'),
    variant_name: 'Hello World Minimal',
    description: 'A minimal hello-world template',
    category: 'infrastructure',
    task_steps: [],
  },
  {
    variant_id: recordId('execute-shell-command'),
    variant_name: 'Execute Shell Command',
    description: 'Run a shell command',
    category: 'tool',
    task_steps: [],
  },
];

let queryCallIndex = 0;

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: mock(async (sql: string) => {
      // First query is the metrics fetch (variant_performance_metrics);
      // second is the template detail fetch (activity_template view).
      // Match by SQL substring so test ordering matches handler ordering.
      if (sql.includes('variant_performance_metrics')) {
        return metricsRows;
      }
      if (sql.includes('activity_template')) {
        return templateRows;
      }
      // Defensive fallback for any other queries the resolver issues
      // (e.g. the executeAsAuth org_id check).
      queryCallIndex += 1;
      return [];
    }),
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
}));

const impulsesRoutes = (await import('./impulses')).default;

function appWithAuth(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('jwtAuth', {
      orgId: 'test-org',
      authType: 'apikey',
      jwtToken: 'stub-jwt',
      keyId: 'test-key',
      scopes: ['read'],
    });
    await next();
  });
  app.route('/v2/impulses', impulsesRoutes);
  return app;
}

async function resolve(app: Hono, pointer: Record<string, unknown>) {
  const res = await app.request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointer, budget: 2000, priority: 'medium' }),
  });
  return { status: res.status, body: await res.json() };
}

describe('F-NN-D: activityTemplatesByMetrics merges RecordId variant_id correctly', () => {
  beforeEach(() => {
    queryCallIndex = 0;
  });

  test('returns markdown with real template names (not "undefined")', async () => {
    const app = appWithAuth();
    const { status, body } = await resolve(app, {
      type: 'activityTemplatesByMetrics',
      limit: 2,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const md: string = body.content;
    expect(typeof md).toBe('string');

    // Regression: previously every cell was "undefined".
    expect(md).not.toMatch(/\| undefined \|/);
    // The detail blocks should not have undefined headers / categories.
    expect(md).not.toContain('## undefined');
    expect(md).not.toContain('**ID**: `undefined`');
    expect(md).not.toContain('**Category**: undefined');
  });

  test('includes both template names from the merged data', async () => {
    const app = appWithAuth();
    const { body } = await resolve(app, {
      type: 'activityTemplatesByMetrics',
      limit: 2,
    });
    const md: string = body.content;

    // Merge succeeded → variant_name surfaces in the summary table and
    // the detail headers.
    expect(md).toContain('Hello World Minimal');
    expect(md).toContain('Execute Shell Command');
  });

  test('renders canonical (un-prefixed) ID strings, not RecordId objects', async () => {
    const app = appWithAuth();
    const { body } = await resolve(app, {
      type: 'activityTemplatesByMetrics',
      limit: 2,
    });
    const md: string = body.content;

    // The "ID" line should carry the bare name, not the RecordId
    // toString form (`activity:⟨...⟩`) and not the literal `[object
    // Object]` that strict template-string coercion would produce.
    expect(md).toContain('**ID**: `hello-world-minimal`');
    expect(md).toContain('**ID**: `execute-shell-command`');
    expect(md).not.toContain('[object Object]');
    expect(md).not.toContain('activity:⟨');
  });

  test('preserves metrics data (success rate, executions) on the merged row', async () => {
    const app = appWithAuth();
    const { body } = await resolve(app, {
      type: 'activityTemplatesByMetrics',
      limit: 2,
    });
    const md: string = body.content;

    // From metricsRows: 619 executions for hello-world-minimal, 7 for
    // execute-shell-command. Both should appear in the summary table.
    expect(md).toContain('| 619 |');
    expect(md).toContain('| 7 |');
  });
});
