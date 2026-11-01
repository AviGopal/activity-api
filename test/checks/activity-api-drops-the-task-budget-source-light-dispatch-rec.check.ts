import { describe, test, expect } from 'bun:test';
import * as mod from '../../src/routes/execution-traces';

describe('normalizePersistedTask — light-dispatch budget_source persistence', () => {
  test('repro: drops task budget_source from light-dispatch record (should be preserved)', () => {
    const input = {
      id: 't',
      resolver_id: 'llm_completion_dispatch',
      success: true,
      duration_ms: 1,
      budget_ms: 600000,
      budget_source: 'policy:resolver:llm_completion_dispatch',
    };
    const out = mod.normalizePersistedTask(input);

    // Control sanity: field that is currently whitelisted stays.
    expect(out.budget_ms).toBe(600000);

    // Failing assertion (red until fix): budget_source should be carried through.
    expect((out as any).budget_source).toBe('policy:resolver:llm_completion_dispatch');
  });

  test('control: invalid/oversized budget_source is absent; other fields unchanged', () => {
    const input = {
      id: 't2',
      resolver_id: 'xyz',
      resolver_tier: 'gold',
      duration_ms: 7,
      budget_ms: 12345,
      budget_source: 42, // invalid type should be dropped
      attempts: [
        { n: 1, duration_ms: 10, ok: true, started_at: '2026-01-01T00:00:00Z' },
      ],
    };
    const out = mod.normalizePersistedTask(input);

    // Fields unaffected by the bug remain exactly as today.
    expect(out.resolver_id).toBe('xyz');
    expect(out.resolver_tier).toBe('gold');
    expect(out.budget_ms).toBe(12345);
    expect(out.attempts).toBeDefined();

    // Control: non-string budget_source is filtered out by normalizer.
    expect((out as any).budget_source).toBeUndefined();
  });
});
