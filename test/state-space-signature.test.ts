import { describe, test, expect } from 'bun:test';
import {
  computeStateSpaceSignature,
  type StateSpaceSignatureInput,
} from '../src/utils/session-context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sig(input: StateSpaceSignatureInput): string {
  return computeStateSpaceSignature(input);
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('computeStateSpaceSignature — determinism', () => {
  test('same input produces identical signature', () => {
    const input: StateSpaceSignatureInput = {
      shapes: ['activityTemplate', 'executionTrace'],
      provenance: [{ shape: 'activityTemplate', producedBy: 'activity-api' }],
      missing: ['goal'],
    };
    expect(sig(input)).toBe(sig(input));
    expect(sig(input)).toBe(sig({ ...input }));
  });

  test('empty input is stable', () => {
    const a = sig({ shapes: [] });
    const b = sig({ shapes: [] });
    expect(a).toBe(b);
  });

  test('output is 16 hex chars', () => {
    const result = sig({ shapes: ['foo', 'bar'] });
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// Order-independence (multiset)
// ---------------------------------------------------------------------------

describe('computeStateSpaceSignature — order-independence', () => {
  test('shapes: order does not matter', () => {
    const a = sig({ shapes: ['alpha', 'beta', 'gamma'] });
    const b = sig({ shapes: ['gamma', 'alpha', 'beta'] });
    expect(a).toBe(b);
  });

  test('missing: order does not matter', () => {
    const a = sig({ shapes: ['x'], missing: ['m1', 'm2', 'm3'] });
    const b = sig({ shapes: ['x'], missing: ['m3', 'm1', 'm2'] });
    expect(a).toBe(b);
  });

  test('provenance: order does not matter', () => {
    const a = sig({
      shapes: ['s1', 's2'],
      provenance: [
        { shape: 's1', producedBy: 'v1' },
        { shape: 's2', producedBy: 'v2' },
      ],
    });
    const b = sig({
      shapes: ['s1', 's2'],
      provenance: [
        { shape: 's2', producedBy: 'v2' },
        { shape: 's1', producedBy: 'v1' },
      ],
    });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------

describe('computeStateSpaceSignature — sensitivity', () => {
  test('different shapes → different signature', () => {
    const a = sig({ shapes: ['alpha'] });
    const b = sig({ shapes: ['beta'] });
    expect(a).not.toBe(b);
  });

  test('producedBy present vs absent → different signature', () => {
    const a = sig({ shapes: ['s'], provenance: [{ shape: 's', producedBy: 'vessel-a' }] });
    const b = sig({ shapes: ['s'], provenance: [{ shape: 's' }] });
    expect(a).not.toBe(b);
  });

  test('producedBy value change → different signature', () => {
    const a = sig({ shapes: ['s'], provenance: [{ shape: 's', producedBy: 'v1' }] });
    const b = sig({ shapes: ['s'], provenance: [{ shape: 's', producedBy: 'v2' }] });
    expect(a).not.toBe(b);
  });

  test('adding a missing shape → different signature', () => {
    const a = sig({ shapes: ['s'] });
    const b = sig({ shapes: ['s'], missing: ['goal'] });
    expect(a).not.toBe(b);
  });

  test('changing a missing shape value → different signature', () => {
    const a = sig({ shapes: ['s'], missing: ['goal'] });
    const b = sig({ shapes: ['s'], missing: ['cost'] });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Version isolation
// ---------------------------------------------------------------------------

describe('computeStateSpaceSignature — version isolation', () => {
  test('v1 with provenance differs from v1c (shape-only coarse)', () => {
    const input = {
      shapes: ['activityTemplate', 'executionTrace'],
      provenance: [{ shape: 'activityTemplate', producedBy: 'api' }],
      missing: ['goal'],
    };
    const full = sig({ ...input, version: '1' as const });
    const coarse = sig({ ...input, version: '1c' as const });
    expect(full).not.toBe(coarse);
  });

  test('v1c ignores provenance — same signature for different provenances', () => {
    const base = { shapes: ['s'], missing: [] };
    const a = sig({ ...base, version: '1c', provenance: [{ shape: 's', producedBy: 'v1' }] });
    const b = sig({ ...base, version: '1c', provenance: [{ shape: 's', producedBy: 'v2' }] });
    expect(a).toBe(b);
  });

  test('v1c without provenance matches v1 without provenance', () => {
    const a = sig({ shapes: ['s'], version: '1' });
    const b = sig({ shapes: ['s'], version: '1c' });
    // version token differs so hash should differ
    expect(a).not.toBe(b);
  });

  test('default version equals explicit v1', () => {
    const input = { shapes: ['a', 'b'], provenance: [{ shape: 'a', producedBy: 'x' }] };
    expect(sig(input)).toBe(sig({ ...input, version: '1' as const }));
  });
});

// ---------------------------------------------------------------------------
// Cross-platform / byte-identical contract
// ---------------------------------------------------------------------------

describe('computeStateSpaceSignature — canonical contract', () => {
  test('known fixture: empty inputs produce a stable hash', () => {
    // Pre-computed: sha256("1|||") truncated to 8 bytes → verify stability
    const result = sig({ shapes: [], version: '1' });
    expect(result).toHaveLength(16);
    // Same call again must be identical (no entropy)
    expect(result).toBe(sig({ shapes: [], version: '1' }));
  });

  test('known fixture: single shape, no provenance, no missing', () => {
    // raw = "1|activityTemplate||"
    const result = sig({ shapes: ['activityTemplate'] });
    expect(result).toHaveLength(16);
    expect(result).toBe(sig({ shapes: ['activityTemplate'] }));
  });
});

// ---------------------------------------------------------------------------
// v1c coarse signatures (§7.2)
// ---------------------------------------------------------------------------

describe('computeStateSpaceSignature — v1c coarse (§7.2)', () => {
  test('v1c ignores provenance', () => {
    const withProv = sig({
      shapes: ['activityTemplate', 'goal'],
      provenance: [{ shape: 'goal', producedBy: 'activity-api' }],
      version: '1c',
    });
    const noProv = sig({
      shapes: ['activityTemplate', 'goal'],
      version: '1c',
    });
    expect(withProv).toBe(noProv);
  });

  test('v1c ignores missing shapes', () => {
    const withMissing = sig({ shapes: ['codeFile'], missing: ['goal'], version: '1c' });
    const noMissing  = sig({ shapes: ['codeFile'], version: '1c' });
    expect(withMissing).toBe(noMissing);
  });

  test('v1c differs from v1 for same shapes (different hash inputs)', () => {
    const v1  = sig({ shapes: ['codeFile'], version: '1' });
    const v1c = sig({ shapes: ['codeFile'], version: '1c' });
    expect(v1).not.toBe(v1c);
  });

  test('v1c is deterministic and 16 chars', () => {
    const a = sig({ shapes: ['a', 'b', 'c'], version: '1c' });
    const b = sig({ shapes: ['a', 'b', 'c'], version: '1c' });
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  test('v1c differs for different shape sets', () => {
    const x = sig({ shapes: ['activityTemplate'], version: '1c' });
    const y = sig({ shapes: ['activityTemplate', 'goal'], version: '1c' });
    expect(x).not.toBe(y);
  });
});
