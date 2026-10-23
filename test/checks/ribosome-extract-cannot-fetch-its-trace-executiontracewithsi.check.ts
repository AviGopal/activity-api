/**
 * CHECK for gap ribosome-extract-cannot-fetch-its-trace-executionTraceWithSignatures-times-out-at-8s-so-no-reached-execution-becomes-a-template.
 *
 * ribosome-extract resolves executionTraceWithSignatures {execution_id} under an 8 s deadline. The live-table point
 * lookup finds the row at once, but the reader then also queried the legacy v_paradigm_execution_traces view (a
 * DEFINE TABLE AS projection of that same table, seconds on a large store), so every extraction timed out.
 *   [MUST-FAIL] an execution_id the point lookup finds (bare and execution:-prefixed) issues NO
 *               v_paradigm_execution_traces statement, and the found row is returned.
 *   [CONTROL]   an id only the legacy view holds still resolves through the view.
 * Same rule as the fix's own test (test/signature-point-lookup-skips-legacy-view.test.ts), with the database as a
 * statement recorder instead of a spawned server, so the check starts no process.
 */
import { describe, expect, test } from 'bun:test';
import * as mod from '../../src/routes/execution-trace-with-signatures';

const ORG = 'organizations:o1';
const TARGET = 'e4242';
const LEGACY = 'legacy_only_1';
const APIKEY = { orgId: ORG, accountId: null, authType: 'apikey' as const };

function recorder() {
  const seen: string[] = [];
  const row = (id: string) => ({
    id, activity_id: 'a6', success: true, duration_ms: 10, executed_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
    input_impulses: [], output_impulses: [], org_id: ORG,
    trace: { tasks: [{ id: 't1', status: 'success' }, { id: 't2', status: 'success' }] },
  });
  const db = {
    async query(sql: string, vars?: Record<string, any>) {
      const q = String(sql);
      seen.push(q);
      if (q.includes('FROM type::thing("execution"')) {
        return vars?.executionPointId === TARGET ? [[{ id: `execution:${TARGET}`, executed_at: '2026-01-01T00:00:00Z' }]] : [[]];
      }
      if (/FROM execution\s+WHERE id IN \$ids/.test(q)) return [[row(`execution:${TARGET}`)]];
      if (q.includes('v_paradigm_execution_traces')) {
        if (vars?.executionId !== LEGACY && !(Array.isArray(vars?.legacyIds) && vars.legacyIds.includes(LEGACY))) return [[]];
        if (/execution_id IN \$legacyIds/.test(q)) return [[{ ...row(LEGACY), activity_id: 'legacy-act' }]];
        return [[{ execution_id: LEGACY, executed_at: '2025-06-01T00:00:00Z' }]];
      }
      return [[]];
    },
  };
  return { db: db as any, seen, viewReads: () => seen.filter((q) => q.includes('v_paradigm_execution_traces')) };
}

describe('executionTraceWithSignatures execution_id point read', () => {
  test('[MUST-FAIL] a found execution_id is read without the legacy view', async () => {
    const r = recorder();
    const rep = await mod.runExecutionTraceWithSignatures(r.db, { execution_id: TARGET, limit: 1 }, APIKEY);
    expect(rep.traces.map((t) => String(t.execution_id).replace(/^execution:/, ""))).toEqual([TARGET]);
    expect(r.viewReads()).toEqual([]);
  });

  test('[MUST-FAIL] the execution:<id> form is read without the legacy view', async () => {
    const r = recorder();
    const rep = await mod.runExecutionTraceWithSignatures(r.db, { execution_id: `execution:${TARGET}`, limit: 1 }, APIKEY);
    expect(rep.traces.map((t) => String(t.execution_id).replace(/^execution:/, ""))).toEqual([TARGET]);
    expect(r.viewReads()).toEqual([]);
  });

  test('[CONTROL] an id only the legacy view holds still resolves through the view', async () => {
    const r = recorder();
    const rep = await mod.runExecutionTraceWithSignatures(r.db, { execution_id: LEGACY, limit: 1 }, APIKEY);
    expect(rep.traces.map((t) => t.execution_id)).toEqual([LEGACY]);
    expect(r.viewReads().length).toBeGreaterThan(0);
  });
});
