/**
 * Blame must not be assigned for an infrastructure failure the arm did not cause.
 *
 * THE REGRESSION THIS PINS. `execution_error` — what the engine emits for an unhandled
 * resolver throw — was absent from computeDeltas' switch, so it fell to `default:` and
 * took a FULL beta=1 penalty while warning "unknown failure_mode.type". Measured on the
 * live substrate 2026-08-22:
 *
 *   execution_error   1,761      <- 98% of all recorded failures
 *   cascading            36
 *   verifier_negative      4
 *
 * So the overwhelming majority of all blame in this system was assigned by a branch that
 * did not know what it was looking at. When the trace store is unreachable or a vessel is
 * mid-restart, every arm that happens to run is condemned for a failure it did not cause.
 *
 * That is also the upstream cause of the posterior-decay conflict recorded in
 * posterior-decay-halflife.test.ts: decay had to be aggressive enough to heal
 * outage-poisoned posteriors (alpha=1, beta=81), and that same aggression erased genuinely
 * earned evidence — 95.4% of arms retaining under 5%. Fixing attribution is what makes a
 * longer half-life safe, because there is far less poison to heal.
 *
 * THE ASYMMETRY IS DELIBERATE. Matching is narrow — transport and availability signatures
 * only — and anything unrecognised keeps the strict penalty. A false abstention costs one
 * lost blame signal; a false blame condemns a working arm, and that is the failure this
 * codebase keeps paying for.
 */

import { describe, expect, test } from 'bun:test';

// config.ts throws at import without these and posterior-update imports it transitively.
// Set unconditionally: a sibling test restores them to undefined.
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

const { isEnvironmentalFailureReason } = await import('./posterior-update');

describe('environmental failure detection', () => {
  test('THE REGRESSION: transport failures are recognised as environmental', () => {
    // Each of these is the infrastructure being unavailable, not the arm being wrong.
    const environmental = [
      'connect ECONNREFUSED 127.0.0.1:8080',
      'read ECONNRESET',
      'connect ETIMEDOUT 10.0.0.5:8080',
      'getaddrinfo EAI_AGAIN activity-api',
      'getaddrinfo ENOTFOUND discovery-vessel',
      'connect EHOSTUNREACH',
      'connect ENETUNREACH',
      'write EPIPE',
      'connection refused',
      'socket hang up',
      'socket hangup',
      'network is unreachable',
      'fetch failed',
      'Failed to fetch',
      'request timed out after 30000ms',
      'request timeout',
      'upstream connect error or disconnect/reset before headers',
      'HTTP 503: Service Unavailable',
      'HTTP 502 bad gateway',
      '504 gateway timeout',
    ];
    for (const reason of environmental) {
      expect(isEnvironmentalFailureReason(reason)).toBe(true);
    }
  });

  test('NEGATIVE CONTROL: resolver-logic failures are NOT environmental', () => {
    // These are the arm's own fault and must keep the full penalty. If any of these
    // matched, the fix would silently stop penalising genuinely broken activities —
    // strictly worse than the defect it replaces.
    const armFault = [
      'oldString not found in repos/activity-api/src/index.ts',
      'paths[0] is undefined',
      'invalid URL: undefined',
      'Cannot read properties of undefined (reading "map")',
      'template validation failed: missing required field "tasks"',
      'json_path_extract: no value at $.result.items',
      'oldString matches 3 times — use a more specific string',
      'file not found: repos/x/y.ts',
      'SyntaxError: Unexpected token < in JSON at position 0',
      'assertion failed: expected 2 got 3',
      'unauthorized: invalid api key',
      'permission denied',
    ];
    for (const reason of armFault) {
      expect(isEnvironmentalFailureReason(reason)).toBe(false);
    }
  });

  test('an absent or empty reason is NOT treated as environmental', () => {
    // Historical rows carry no reason because the sink stripped it. Abstaining blind on
    // those would silently forgive every unlabelled failure in the store — a far larger
    // behaviour change than this fix intends.
    expect(isEnvironmentalFailureReason(undefined)).toBe(false);
    expect(isEnvironmentalFailureReason(null)).toBe(false);
    expect(isEnvironmentalFailureReason('')).toBe(false);
    expect(isEnvironmentalFailureReason(42)).toBe(false);
    expect(isEnvironmentalFailureReason({ reason: 'ECONNREFUSED' })).toBe(false);
  });

  test('matching is on a token, not a loose substring', () => {
    // Guards against the patterns being so broad they swallow arm-fault text. A message
    // that merely mentions a status-like number is not a gateway error.
    expect(isEnvironmentalFailureReason('returned 5031 rows, expected 502')).toBe(false);
    expect(isEnvironmentalFailureReason('expected status 200, got 404')).toBe(false);
    // and a real one still matches
    expect(isEnvironmentalFailureReason('HTTP 502: upstream failed')).toBe(true);
  });

  test('detection is case-insensitive where the wire is inconsistent', () => {
    expect(isEnvironmentalFailureReason('Connection Refused')).toBe(true);
    expect(isEnvironmentalFailureReason('SOCKET HANG UP')).toBe(true);
    expect(isEnvironmentalFailureReason('Fetch Failed')).toBe(true);
  });
});

const { computeDeltas } = await import('./posterior-update');

describe('computeDeltas: execution_error blame', () => {
  const w = (): string[] => [];

  test('THE REGRESSION: an environmental execution_error costs NO blame', () => {
    // Before: fell to `default:` -> beta=1, condemning every arm that ran during an
    // outage. Now abstains, matching how `cascading` already treats a victim.
    const d = computeDeltas(
      false,
      { type: 'execution_error', reason: 'connect ECONNREFUSED 127.0.0.1:8080' } as never,
      w(),
    );
    expect(d).toEqual({ alphaDelta: 0, betaDelta: 0 });
  });

  test('a resolver-logic execution_error STILL takes the full penalty', () => {
    // The fix must not become a blanket amnesty — a genuinely broken arm is still blamed.
    const d = computeDeltas(
      false,
      { type: 'execution_error', reason: 'oldString not found in repos/x/y.ts' } as never,
      w(),
    );
    expect(d).toEqual({ alphaDelta: 0, betaDelta: 1 });
  });

  test('an execution_error with NO reason keeps the strict penalty and warns', () => {
    // Historical rows have no reason (the sink stripped it). Abstaining blind on those
    // would forgive every unlabelled failure in the store.
    const warnings: string[] = [];
    const d = computeDeltas(false, { type: 'execution_error' } as never, warnings);
    expect(d).toEqual({ alphaDelta: 0, betaDelta: 1 });
    expect(warnings.join(' ')).toMatch(/cannot distinguish environmental/i);
  });

  test('it no longer warns "unknown failure_mode.type" for the 98% case', () => {
    // The old path announced that it did not know what it was looking at, on almost
    // every failure the system records.
    const warnings: string[] = [];
    computeDeltas(false, { type: 'execution_error', reason: 'socket hang up' } as never, warnings);
    expect(warnings.join(' ')).not.toMatch(/unknown failure_mode\.type/i);
  });

  test('NEGATIVE CONTROL: other failure modes are untouched by this change', () => {
    expect(computeDeltas(false, { type: 'verifier_negative' } as never, w()))
      .toEqual({ alphaDelta: 0, betaDelta: 1 });
    expect(computeDeltas(false, { type: 'cascading' } as never, w()))
      .toEqual({ alphaDelta: 0, betaDelta: 0 });
    expect(computeDeltas(false, { type: 'budget_exhausted' } as never, w()))
      .toEqual({ alphaDelta: 0, betaDelta: 0.5 });
    // and a genuinely unknown type still hits the strict default
    const warnings: string[] = [];
    expect(computeDeltas(false, { type: 'some_future_mode' } as never, warnings))
      .toEqual({ alphaDelta: 0, betaDelta: 1 });
    expect(warnings.join(' ')).toMatch(/unknown failure_mode\.type/i);
  });

  test('NEGATIVE CONTROL: success is unaffected', () => {
    const d = computeDeltas(true, null, w());
    expect(d.alphaDelta).toBeGreaterThan(0);
  });
});
