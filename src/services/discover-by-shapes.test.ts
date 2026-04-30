/**
 * Unit tests for the discover-by-shapes shared helper (services/discover-by-shapes.ts).
 *
 * These tests focus on the input-validation surface — the SQL-execution path is
 * exercised end-to-end by `routes/discover-by-shapes.test.ts` (REST) and
 * `routes/impulses-discover-by-shapes-shape.test.ts` (shape).
 *
 * The helper is the single source of truth for both
 * the REST route and the `discoverByShapesQuery` impulse-resolve shape, so that
 * adding a new caller does not require duplicating SQL or composition-score
 * augmentation.
 */

import { describe, test, expect } from 'bun:test';
import { validateDiscoverByShapesInput } from './discover-by-shapes';

describe('validateDiscoverByShapesInput', () => {
  test('rejects missing required_shapes', () => {
    const err = validateDiscoverByShapesInput({} as any);
    expect(err).not.toBeNull();
    expect(err?.error).toBe('Validation failed');
    expect(err?.message).toContain('required_shapes');
  });

  test('rejects empty required_shapes array', () => {
    const err = validateDiscoverByShapesInput({ required_shapes: [] });
    expect(err).not.toBeNull();
    expect(err?.error).toBe('Validation failed');
  });

  test('rejects non-array required_shapes', () => {
    const err = validateDiscoverByShapesInput({
      required_shapes: 'not an array' as any,
    });
    expect(err).not.toBeNull();
    expect(err?.error).toBe('Validation failed');
  });

  test('rejects unknown mode', () => {
    const err = validateDiscoverByShapesInput({
      required_shapes: ['x'],
      mode: 'lateral' as any,
    });
    expect(err).not.toBeNull();
    expect(err?.message).toContain('mode must be one of');
  });

  test('accepts forward mode (default)', () => {
    expect(validateDiscoverByShapesInput({ required_shapes: ['x'] })).toBeNull();
    expect(validateDiscoverByShapesInput({
      required_shapes: ['x'],
      mode: 'forward',
    })).toBeNull();
  });

  test('accepts backward mode', () => {
    expect(validateDiscoverByShapesInput({
      required_shapes: ['validation_result'],
      mode: 'backward',
    })).toBeNull();
  });

  test('accepts candidates_with_scores mode', () => {
    expect(validateDiscoverByShapesInput({
      required_shapes: ['validation_result'],
      mode: 'candidates_with_scores',
    })).toBeNull();
  });

  test('accepts optional fields without coercion', () => {
    expect(validateDiscoverByShapesInput({
      required_shapes: ['validation_result'],
      mode: 'backward',
      output_shapes: ['validation_result'],
      current_shapes: ['file'],
      limit: 5,
      predecessor_activity_id: 'activity:fix_bug',
    })).toBeNull();
  });
});
