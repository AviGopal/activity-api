/**
 * A TASK'S ATTEMPTS AND BUDGET SURVIVE THE WRITE BOUNDARY (light-dispatch abort-budget fix).
 *
 * light-dispatch now records, per task, the abort budget it ran under and every request it sent
 * (attempts[]), so a retried model call is visible as three requests, not one. normalizePersistedTask
 * whitelists the stored task fields, the same boundary that once dropped resolved_config and the
 * per-task shapes, so without this both fields would be dropped on write. light-dispatch also names
 * its tasks `id`, which the boundary never read: every light-dispatch task was stored with no task_id.
 */
import { describe, expect, it } from 'bun:test';
import { normalizePersistedTask } from './execution-traces';

const ldTask = (extra: Record<string, unknown> = {}) => ({
  id: 'summarize', resolver_id: 'development-vessel:llm_completion_dispatch', resolver_tier: 'deterministic',
  success: false, duration_ms: 61000, input_impulse_ids: [], output_impulse_ids: [], ...extra,
});

describe('normalizePersistedTask keeps light-dispatch task fields', () => {
  it('[MUST-FAIL] attempts and budget_ms are kept, each attempt reduced to its scalar fields', () => {
    const out = normalizePersistedTask(ldTask({ budget_ms: 180000, attempts: [
      { n: 1, started_at: '2026-10-17T00:10:00.000Z', duration_ms: 3, ok: false, error: 'Unable to connect', code: 'ConnectionRefused', extra: 'x'.repeat(10) },
      { n: 2, started_at: 'not a time', duration_ms: 60500, ok: true },
    ] }));
    expect(out.budget_ms).toBe(180000);
    expect(out.attempts).toEqual([
      { n: 1, duration_ms: 3, ok: false, started_at: '2026-10-17T00:10:00.000Z', error: 'Unable to connect', code: 'ConnectionRefused' },
      { n: 2, duration_ms: 60500, ok: true }, // an unparseable start time is dropped, not stored
    ]);
  });
  it('[MUST-FAIL] a task named `id` is stored under task_id', () => {
    expect(normalizePersistedTask(ldTask()).task_id).toBe('summarize');
  });
  it('[CONTROL] taskId / task_id still win over id; no attempts field means none stored', () => {
    const out = normalizePersistedTask({ taskId: 'a', task_id: 'b', id: 'c' });
    expect(out.task_id).toBe('a');
    expect(out.attempts).toBeUndefined();
    expect(out.budget_ms).toBeUndefined();
  });
  it('[HELD-OUT] the boundary bounds what it stores: at most 10 attempts, malformed entries dropped, long strings cut', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ n: i + 1, duration_ms: 1, ok: false, error: 'e'.repeat(500), code: 'C'.repeat(100) }));
    const out = normalizePersistedTask(ldTask({ attempts: [{ n: 'one' }, ...many] }));
    expect(out.attempts!.length).toBe(9); // the first of the ten is malformed and dropped
    expect(out.attempts![0]!.error!.length).toBe(200);
    expect(out.attempts![0]!.code!.length).toBe(64);
    expect(normalizePersistedTask(ldTask({ budget_ms: 'soon' })).budget_ms).toBeUndefined();
  });
});
