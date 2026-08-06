import { describe, expect, it } from 'bun:test';

import { PathRecommendationResponseSchema, RecommendedPathSchema } from './schemas';

/**
 * PATHWAY REUSE DIED IN A ZOD STRIP, AND NOTHING NOTICED FOR DAYS.
 *
 * goal-host's `recommendReachingPath` accepts a recorded pathway on the RAW
 * COUNTERS — `successful_executions >= minSuccessful && total_executions >=
 * minTotal` — deliberately not on `success_rate`, because the rate is derived
 * and has been observed truncated while the counters are written atomically.
 *
 * `successful_executions` was missing from RecommendedPathSchema. `z.object()`
 * strips unknown keys by default, so the route computed the value, put it on the
 * response object, and Zod silently removed it on the way out. The consumer read
 * `undefined`, scored it 0, and rejected every candidate. Measured on the live
 * spoke over 48h: 5 requests, 15 paths recommended, **0 accepted**, last genuine
 * reuse 2026-08-05T20:42Z. The failure reported itself as the honest-looking
 * "no reusable pathway", which is why it survived so long.
 *
 * Both ends typechecked throughout. A field can only be load-bearing if it
 * survives serialization, and nothing in the type system says a consumer three
 * repos away reads this key. These tests are that statement.
 */
describe('RecommendedPathSchema — fields the reuse gate reads must survive parse', () => {
  const base = {
    path_activities: ['satisfier:shellResult', 'satisfier:memoryNote_write'],
    confidence: 0.8,
    success_rate: 0.75,
    avg_duration_ms: 1200,
    avg_cost_usd: 0.01,
    total_executions: 8,
    successful_executions: 6,
  };

  it('preserves successful_executions — the field the acceptance gate gates on', () => {
    const parsed = RecommendedPathSchema.parse(base);
    expect(parsed.successful_executions).toBe(6);
  });

  it('preserves path identity so a caller can tell which composition it reused', () => {
    const parsed = RecommendedPathSchema.parse({
      ...base,
      goal_hash: 'a1b2c3d4e5f60718',
      path_signature: '38d119315cefd32d',
    });
    expect(parsed.goal_hash).toBe('a1b2c3d4e5f60718');
    expect(parsed.path_signature).toBe('38d119315cefd32d');
  });

  it('preserves match_mode and shape_cover so a nearby match is distinguishable from an exact one', () => {
    const parsed = RecommendedPathSchema.parse({
      ...base,
      match_mode: 'shape_signature',
      shape_cover: 0.5,
    });
    expect(parsed.match_mode).toBe('shape_signature');
    expect(parsed.shape_cover).toBe(0.5);
  });

  it('defaults match_mode to absent rather than inventing an exact match', () => {
    const parsed = RecommendedPathSchema.parse(base);
    expect(parsed.match_mode).toBeUndefined();
  });

  it('rejects a match_mode outside the two candidate arms', () => {
    expect(() => RecommendedPathSchema.parse({ ...base, match_mode: 'vibes' })).toThrow();
  });

  it('carries the counters through the full response envelope, not just the leaf', () => {
    // The route returns PathRecommendationResponseSchema.parse(...), so a leaf
    // field that survives on its own can still be stripped by the envelope.
    const parsed = PathRecommendationResponseSchema.parse({
      goal_hash: 'deadbeefdeadbeef',
      recommended_paths: [{ ...base, match_mode: 'shape_signature', shape_cover: 1 }],
    });
    expect(parsed.recommended_paths[0]?.successful_executions).toBe(6);
    expect(parsed.recommended_paths[0]?.match_mode).toBe('shape_signature');
  });

  it("a path with zero successes still round-trips as 0, never as undefined", () => {
    // The consumer treats a MISSING counter and an observed zero identically
    // (both score 0), which is exactly what hid this bug. Keep them distinct on
    // the wire so a future consumer can tell "never reached" from "not reported".
    const parsed = RecommendedPathSchema.parse({ ...base, successful_executions: 0 });
    expect(parsed.successful_executions).toBe(0);
    expect(parsed.successful_executions).not.toBeUndefined();
  });
});
