import { describe, test, expect } from 'bun:test';
import {
  applyCompatibilityFilter,
  generatePointerRecommendations,
  identifyBlockingShapes,
  type ImpulseStateEntry,
  type PointerStateEntry,
} from '../src/services/recommendation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTemplate(
  id: string,
  input_shapes: string[],
  alpha = 3,
  beta = 1,
) {
  return { id, input_shapes, alpha, beta, name: `Template ${id}` };
}

function makeImpulse(shape: string): ImpulseStateEntry {
  return { shape };
}

function makePointer(shape: string, vessel_id = 'v1', resolve_tier: PointerStateEntry['resolve_tier'] = 'deterministic'): PointerStateEntry {
  return { shape, vessel_id, resolve_tier };
}

// ---------------------------------------------------------------------------
// applyCompatibilityFilter
// ---------------------------------------------------------------------------

describe('applyCompatibilityFilter', () => {
  test('returns templates unchanged when impulse_state_space is absent', () => {
    const templates = [makeTemplate('t1', ['codeFile']), makeTemplate('t2', [])];
    const result = applyCompatibilityFilter(templates, undefined, []);
    expect(result).toHaveLength(2);
    // _compatibility_score is added but original fields are preserved
    for (const r of result) {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('_compatibility_score');
    }
  });

  test('returns templates unchanged when impulse_state_space is empty array', () => {
    const templates = [makeTemplate('t1', ['codeFile'])];
    const result = applyCompatibilityFilter(templates, [], []);
    expect(result).toHaveLength(1);
    // Score = thompson(3,1) = 3/4 = 0.75
    expect(result[0]._compatibility_score).toBeCloseTo(0.75);
  });

  test('fully covered template gets no discount', () => {
    const templates = [makeTemplate('t1', ['codeFile'], 3, 1)];
    const pool = [makeImpulse('codeFile')];
    const result = applyCompatibilityFilter(templates, pool, []);
    // alpha/(alpha+beta) = 3/4
    expect(result[0]._compatibility_score).toBeCloseTo(0.75);
  });

  test('template with no input_shapes gets no discount', () => {
    const templates = [makeTemplate('t1', [], 3, 1)];
    const pool = [makeImpulse('something')];
    const result = applyCompatibilityFilter(templates, pool, []);
    expect(result[0]._compatibility_score).toBeCloseTo(0.75);
  });

  test('partially covered — gap resolvable via pointer_state_space — gets 0.7 discount', () => {
    const templates = [makeTemplate('t1', ['codeFile', 'trace'], 3, 1)];
    // 'codeFile' in pool, 'trace' missing but in pointer_state_space
    const pool = [makeImpulse('codeFile')];
    const ptrs = [makePointer('trace')];
    const result = applyCompatibilityFilter(templates, pool, ptrs);
    // score = 0.75 * 0.7 = 0.525
    expect(result[0]._compatibility_score).toBeCloseTo(0.75 * 0.7, 3);
  });

  test('gap not in pointer_state_space — gets 0.5 (escalatable) discount', () => {
    const templates = [makeTemplate('t1', ['missingShape'], 3, 1)];
    const pool = [makeImpulse('otherShape')];
    // pointer_state_space doesn't have 'missingShape'
    const result = applyCompatibilityFilter(templates, pool, []);
    expect(result[0]._compatibility_score).toBeCloseTo(0.75 * 0.5, 3);
  });

  test('sorts by _compatibility_score DESC', () => {
    // t1: fully covered → higher score
    // t2: gap not resolvable → lower score
    const templates = [
      makeTemplate('t2', ['missing'], 3, 1),
      makeTemplate('t1', ['present'], 3, 1),
    ];
    const pool = [makeImpulse('present')];
    const result = applyCompatibilityFilter(templates, pool, []);
    expect(result[0].id).toBe('t1');
    expect(result[1].id).toBe('t2');
  });

  test('does not mutate original alpha/beta', () => {
    const templates = [makeTemplate('t1', ['missing'], 5, 2)];
    const pool = [makeImpulse('other')];
    const result = applyCompatibilityFilter(templates, pool, []);
    // Original alpha/beta must be preserved
    expect(result[0].alpha).toBe(5);
    expect(result[0].beta).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// generatePointerRecommendations
// ---------------------------------------------------------------------------

describe('generatePointerRecommendations', () => {
  test('returns empty array when pointer_state_space is empty', () => {
    const result = generatePointerRecommendations([], [], []);
    expect(result).toEqual([]);
  });

  test('excludes shapes already in impulse_state_space', () => {
    const ptrs = [makePointer('alreadyLoaded')];
    const pool = [makeImpulse('alreadyLoaded')];
    const result = generatePointerRecommendations(ptrs, pool, []);
    expect(result).toEqual([]);
  });

  test('orders by expected_utility DESC', () => {
    const ptrs = [makePointer('shapeA'), makePointer('shapeB')];
    // shapeA unlocks 2 templates, shapeB unlocks 1
    const templates = [
      { template_id: 't1', input_shapes: ['shapeA'], alpha: 5, beta: 1, template_name: 'T1' },
      { template_id: 't2', input_shapes: ['shapeA'], alpha: 3, beta: 1, template_name: 'T2' },
      { template_id: 't3', input_shapes: ['shapeB'], alpha: 2, beta: 1, template_name: 'T3' },
    ];
    const result = generatePointerRecommendations(ptrs, [], templates);
    // shapeA has higher total utility → should be first
    expect(result[0].shape).toBe('shapeA');
    expect(result[1].shape).toBe('shapeB');
  });

  test('normalises expected_utility to 0-1 range', () => {
    const ptrs = [makePointer('shapeA')];
    const templates = [
      { template_id: 't1', input_shapes: ['shapeA'], alpha: 5, beta: 1, template_name: 'T1' },
    ];
    const result = generatePointerRecommendations(ptrs, [], templates);
    expect(result[0].expected_utility).toBeCloseTo(1.0);
  });

  test('caps at 5 results', () => {
    const ptrs = Array.from({ length: 10 }, (_, i) => makePointer(`shape${i}`));
    const templates = ptrs.map((p, i) => ({
      template_id: `t${i}`,
      input_shapes: [p.shape],
      alpha: 2,
      beta: 1,
      template_name: `T${i}`,
    }));
    const result = generatePointerRecommendations(ptrs, [], templates);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  test('unlocks_template_ids contains template ids', () => {
    const ptrs = [makePointer('codeFile', 'vessel-analysis', 'deterministic')];
    const templates = [
      { template_id: 'tA', input_shapes: ['codeFile'], alpha: 3, beta: 1, template_name: 'TA' },
    ];
    const result = generatePointerRecommendations(ptrs, [], templates);
    expect(result[0].unlocks_template_ids).toContain('tA');
    expect(result[0].resolve_via.vessel_id).toBe('vessel-analysis');
    expect(result[0].resolve_via.resolve_tier).toBe('deterministic');
  });
});

// ---------------------------------------------------------------------------
// identifyBlockingShapes
// ---------------------------------------------------------------------------

describe('identifyBlockingShapes', () => {
  test('no blocking shapes when all inputs are present', () => {
    const templates = [{ template_id: 't1', input_shapes: ['codeFile'] }];
    const pool = [makeImpulse('codeFile')];
    const result = identifyBlockingShapes(templates, pool, []);
    expect(result).toEqual([]);
  });

  test('identifies missing input shapes as blocking', () => {
    const templates = [{ template_id: 't1', input_shapes: ['missing'] }];
    const result = identifyBlockingShapes(templates, [], []);
    expect(result).toHaveLength(1);
    expect(result[0].shape).toBe('missing');
    expect(result[0].gap_severity).toBe('blocking');
  });

  test('gap_type is resolvable when shape in pointer_state_space', () => {
    const templates = [{ template_id: 't1', input_shapes: ['trace'] }];
    const ptrs = [makePointer('trace', 'vessel-api', 'pattern')];
    const result = identifyBlockingShapes(templates, [], ptrs);
    expect(result[0].gap_type).toBe('resolvable');
    expect(result[0].resolve_via).toBeDefined();
    expect(result[0].resolve_via!.vessel_id).toBe('vessel-api');
  });

  test('gap_type is escalatable when shape not in pointer_state_space', () => {
    const templates = [{ template_id: 't1', input_shapes: ['unknown'] }];
    const result = identifyBlockingShapes(templates, [], []);
    expect(result[0].gap_type).toBe('escalatable');
    expect(result[0].resolve_via).toBeUndefined();
  });

  test('deduplicates across multiple templates', () => {
    const templates = [
      { template_id: 't1', input_shapes: ['shared'] },
      { template_id: 't2', input_shapes: ['shared'] },
    ];
    const result = identifyBlockingShapes(templates, [], []);
    expect(result).toHaveLength(1);
    expect(result[0].shape).toBe('shared');
    expect(result[0].required_by_template_ids).toContain('t1');
    expect(result[0].required_by_template_ids).toContain('t2');
  });

  test('template with no input_shapes produces no blocking shapes', () => {
    const templates = [{ template_id: 't1', input_shapes: [] }];
    const result = identifyBlockingShapes(templates, [], []);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Backward-compat: undefined impulse_state_space → no new fields + unchanged order
// ---------------------------------------------------------------------------

describe('backward-compat with undefined impulse_state_space', () => {
  test('applyCompatibilityFilter with undefined returns all templates', () => {
    const templates = [makeTemplate('t1', ['a']), makeTemplate('t2', ['b'])];
    const result = applyCompatibilityFilter(templates, undefined, []);
    expect(result).toHaveLength(2);
    // Both present — scores are unadjusted Thompson values
    expect(result.every(r => r._compatibility_score > 0)).toBe(true);
  });

  test('identifyBlockingShapes with empty state → still identifies missing shapes', () => {
    const result = identifyBlockingShapes(
      [{ template_id: 't1', input_shapes: ['x'] }],
      [],
      [],
    );
    expect(result).toHaveLength(1);
  });
});
