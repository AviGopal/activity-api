/**
 * Thompson Sampling Service Tests
 *
 * Tests shape match scoring and weighted success computation
 */

import { describe, test, expect } from 'bun:test';
import {
  computeShapeMatchScore,
  computeWeightedSuccessScore,
  computeThompsonSamplingUpdates,
  extractOutputShapes,
  validateOutputShapes,
} from './thompson-sampling';

describe('computeShapeMatchScore', () => {
  test('perfect match returns 1.0', () => {
    const expected = ['source_code', 'test_result'];
    const actual = ['source_code', 'test_result'];
    const score = computeShapeMatchScore(expected, actual);
    expect(score).toBe(1.0);
  });

  test('no overlap returns 0.0', () => {
    const expected = ['source_code', 'test_result'];
    const actual = ['config_file', 'documentation'];
    const score = computeShapeMatchScore(expected, actual);
    expect(score).toBe(0.0);
  });

  test('partial overlap computes Jaccard similarity', () => {
    const expected = ['source_code', 'test_result', 'documentation'];
    const actual = ['source_code', 'config_file'];
    // Intersection: ['source_code'] = 1
    // Union: ['source_code', 'test_result', 'documentation', 'config_file'] = 4
    // Score: 1/4 = 0.25
    const score = computeShapeMatchScore(expected, actual);
    expect(score).toBe(0.25);
  });

  test('empty sets return 1.0', () => {
    const score = computeShapeMatchScore([], []);
    expect(score).toBe(1.0);
  });

  test('one empty set returns 0.0', () => {
    const score1 = computeShapeMatchScore(['source_code'], []);
    const score2 = computeShapeMatchScore([], ['source_code']);
    expect(score1).toBe(0.0);
    expect(score2).toBe(0.0);
  });

  test('duplicate shapes are deduplicated', () => {
    const expected = ['source_code', 'source_code', 'test_result'];
    const actual = ['source_code', 'test_result'];
    // After deduplication: expected = {source_code, test_result}, actual = {source_code, test_result}
    const score = computeShapeMatchScore(expected, actual);
    expect(score).toBe(1.0);
  });
});

describe('computeWeightedSuccessScore', () => {
  test('successful execution with perfect shapes = 1.0', () => {
    const score = computeWeightedSuccessScore(true, 1.0);
    expect(score).toBe(1.0); // 0.7 * 1.0 + 0.3 = 1.0
  });

  test('successful execution with no shapes = 0.3', () => {
    const score = computeWeightedSuccessScore(true, 0.0);
    expect(score).toBe(0.3); // 0.7 * 0.0 + 0.3 = 0.3
  });

  test('successful execution with partial shapes = weighted', () => {
    const score = computeWeightedSuccessScore(true, 0.5);
    expect(score).toBeCloseTo(0.65); // 0.7 * 0.5 + 0.3 = 0.65
  });

  test('failed execution always returns 0.0', () => {
    expect(computeWeightedSuccessScore(false, 1.0)).toBe(0.0);
    expect(computeWeightedSuccessScore(false, 0.5)).toBe(0.0);
    expect(computeWeightedSuccessScore(false, 0.0)).toBe(0.0);
  });
});

describe('computeThompsonSamplingUpdates', () => {
  test('perfect success updates alpha fully', () => {
    const updates = computeThompsonSamplingUpdates(true, 1.0);
    expect(updates.alphaDelta).toBe(1.0);
    expect(updates.betaDelta).toBe(0.0);
    expect(updates.weightedScore).toBe(1.0);
  });

  test('partial success splits update', () => {
    const updates = computeThompsonSamplingUpdates(true, 0.5);
    expect(updates.alphaDelta).toBeCloseTo(0.65);
    expect(updates.betaDelta).toBeCloseTo(0.35);
    expect(updates.weightedScore).toBeCloseTo(0.65);
  });

  test('failure updates beta fully', () => {
    const updates = computeThompsonSamplingUpdates(false, 1.0);
    expect(updates.alphaDelta).toBe(0.0);
    expect(updates.betaDelta).toBe(1.0);
    expect(updates.weightedScore).toBe(0.0);
  });

  test('successful with no shapes gives base credit', () => {
    const updates = computeThompsonSamplingUpdates(true, 0.0);
    expect(updates.alphaDelta).toBe(0.3);
    expect(updates.betaDelta).toBe(0.7);
    expect(updates.weightedScore).toBe(0.3);
  });
});

describe('extractOutputShapes', () => {
  test('extracts from output_impulse_shapes', () => {
    const trace = {
      output_impulse_shapes: ['source_code', 'test_result'],
    };
    const shapes = extractOutputShapes(trace);
    expect(shapes).toEqual(['source_code', 'test_result']);
  });

  test('extracts from output_impulses objects', () => {
    const trace = {
      output_impulses: [
        { shape: 'source_code', pointer: {} },
        { shape: 'test_result', pointer: {} },
      ],
    };
    const shapes = extractOutputShapes(trace);
    expect(shapes).toEqual(['source_code', 'test_result']);
  });

  test('extracts from output_impulses strings', () => {
    const trace = {
      output_impulses: ['source_code', 'test_result'],
    };
    const shapes = extractOutputShapes(trace);
    expect(shapes).toEqual(['source_code', 'test_result']);
  });

  test('prefers output_impulse_shapes over output_impulses', () => {
    const trace = {
      output_impulse_shapes: ['preferred'],
      output_impulses: ['ignored'],
    };
    const shapes = extractOutputShapes(trace);
    expect(shapes).toEqual(['preferred']);
  });

  test('returns empty array when no shapes', () => {
    const shapes = extractOutputShapes({});
    expect(shapes).toEqual([]);
  });

  test('handles unknown shape in output_impulses', () => {
    const trace = {
      output_impulses: [
        { pointer: {} }, // Missing shape field
        { shape: 'test_result', pointer: {} },
      ],
    };
    const shapes = extractOutputShapes(trace);
    expect(shapes).toEqual(['unknown', 'test_result']);
  });
});

describe('validateOutputShapes', () => {
  test('perfect match passes validation', () => {
    const metadata = validateOutputShapes(
      ['source_code', 'test_result'],
      ['source_code', 'test_result'],
      true
    );
    expect(metadata.passed).toBe(true);
    expect(metadata.shapeMatchScore).toBe(1.0);
    expect(metadata.weightedSuccessScore).toBe(1.0);
    expect(metadata.missing).toEqual([]);
    expect(metadata.unexpected).toEqual([]);
  });

  test('partial match below threshold fails validation', () => {
    const metadata = validateOutputShapes(
      ['source_code', 'test_result'],
      ['source_code'],
      true
    );
    // Intersection: ['source_code'] = 1
    // Union: ['source_code', 'test_result'] = 2
    // Jaccard: 1/2 = 0.5 < 0.8 threshold
    expect(metadata.passed).toBe(false);
    expect(metadata.shapeMatchScore).toBe(0.5);
    expect(metadata.missing).toEqual(['test_result']);
    expect(metadata.unexpected).toEqual([]);
  });

  test('identifies unexpected shapes', () => {
    const metadata = validateOutputShapes(
      ['source_code'],
      ['source_code', 'config_file'],
      true
    );
    expect(metadata.passed).toBe(false); // 0.5 < 0.8 threshold
    expect(metadata.shapeMatchScore).toBe(0.5);
    expect(metadata.missing).toEqual([]);
    expect(metadata.unexpected).toEqual(['config_file']);
  });

  test('failed execution still computes shapes', () => {
    const metadata = validateOutputShapes(
      ['source_code', 'test_result'],
      ['source_code', 'test_result'],
      false
    );
    expect(metadata.passed).toBe(true); // Shape match is good
    expect(metadata.shapeMatchScore).toBe(1.0);
    expect(metadata.weightedSuccessScore).toBe(0.0); // But execution failed
  });

  test('validation at 80% threshold passes', () => {
    const metadata = validateOutputShapes(
      ['a', 'b', 'c', 'd', 'e'],
      ['a', 'b', 'c', 'd'], // 4/5 = 0.8
      true
    );
    expect(metadata.passed).toBe(true);
    expect(metadata.shapeMatchScore).toBe(0.8);
  });

  test('validation just below 80% threshold fails', () => {
    const metadata = validateOutputShapes(
      ['a', 'b', 'c', 'd', 'e', 'f'],
      ['a', 'b', 'c', 'd'], // Intersection: 4, Union: 6, Jaccard: 4/6 ≈ 0.67
      true
    );
    expect(metadata.passed).toBe(false); // 0.67 < 0.8 threshold
    expect(metadata.shapeMatchScore).toBeCloseTo(0.67, 2);
  });

  test('includes timestamp in metadata', () => {
    const metadata = validateOutputShapes(['source_code'], ['source_code'], true);
    expect(metadata.validatedAt).toBeDefined();
    expect(new Date(metadata.validatedAt).getTime()).toBeGreaterThan(0);
  });
});
