import { describe, test, expect } from 'bun:test';
import {
  normalizeShape,
  levenshtein,
  findAliasClusters,
  type ObservedShapeUsage,
} from './observed-shapes';

function usage(shape: string, total = 1): ObservedShapeUsage {
  return {
    shape,
    sources: {
      templateInputShapes: total,
      templateOutputShapes: 0,
      taskInputShapes: 0,
      taskOutputShapes: 0,
      taskOutputImpulses: 0,
    },
    total,
  };
}

describe('observed-shapes', () => {
  describe('normalizeShape', () => {
    test('lowercases', () => {
      expect(normalizeShape('ExecutionTrace')).toBe('executiontrace');
    });

    test('strips underscores', () => {
      expect(normalizeShape('execution_trace')).toBe('executiontrace');
    });

    test('strips hyphens', () => {
      expect(normalizeShape('execution-trace')).toBe('executiontrace');
    });

    test('strips colons', () => {
      expect(normalizeShape('execution:trace')).toBe('executiontrace');
    });

    test('collapses all three variants to equal', () => {
      expect(normalizeShape('execution_trace')).toBe(normalizeShape('executionTrace'));
      expect(normalizeShape('execution-trace')).toBe(normalizeShape('executionTrace'));
      expect(normalizeShape('Execution:Trace')).toBe(normalizeShape('executionTrace'));
    });

    test('preserves distinct shapes', () => {
      expect(normalizeShape('goal')).not.toBe(normalizeShape('error'));
    });
  });

  describe('levenshtein', () => {
    test('identical strings return 0', () => {
      expect(levenshtein('abc', 'abc')).toBe(0);
    });

    test('empty string handling', () => {
      expect(levenshtein('', 'abc')).toBe(3);
      expect(levenshtein('abc', '')).toBe(3);
      expect(levenshtein('', '')).toBe(0);
    });

    test('single substitution', () => {
      expect(levenshtein('cat', 'bat')).toBe(1);
    });

    test('single insertion', () => {
      expect(levenshtein('cat', 'cats')).toBe(1);
    });

    test('single deletion', () => {
      expect(levenshtein('cats', 'cat')).toBe(1);
    });

    test('canonical kitten/sitting example', () => {
      expect(levenshtein('kitten', 'sitting')).toBe(3);
    });

    test('is symmetric', () => {
      expect(levenshtein('abc', 'xyz')).toBe(levenshtein('xyz', 'abc'));
      expect(levenshtein('executiontrace', 'executiontree')).toBe(
        levenshtein('executiontree', 'executiontrace'),
      );
    });
  });

  describe('findAliasClusters', () => {
    test('returns empty for a corpus with no lookalikes', () => {
      const observed = [usage('goal'), usage('error'), usage('patch')];
      expect(findAliasClusters(observed)).toEqual([]);
    });

    test('flags normalized-equal casing variants', () => {
      const observed = [usage('execution_trace'), usage('executionTrace')];
      const clusters = findAliasClusters(observed);
      expect(clusters).toHaveLength(2);
      const first = clusters.find((c) => c.shape === 'execution_trace');
      expect(first).toBeDefined();
      expect(first!.candidates[0].other).toBe('executionTrace');
      expect(first!.candidates[0].reason).toBe('normalized-equal');
      expect(first!.candidates[0].similarity).toBe(1);
    });

    test('flags normalized-equal hyphen vs underscore', () => {
      const observed = [usage('source-code'), usage('source_code')];
      const clusters = findAliasClusters(observed);
      expect(clusters).toHaveLength(2);
      for (const c of clusters) {
        expect(c.candidates[0].reason).toBe('normalized-equal');
      }
    });

    test('flags close-but-not-equal via levenshtein', () => {
      // 'activitytemplate' vs 'activitytemplates' -> distance 1
      const observed = [usage('activity_template'), usage('activity_templates')];
      const clusters = findAliasClusters(observed);
      expect(clusters.length).toBeGreaterThan(0);
      const reasons = clusters.flatMap((c) => c.candidates.map((x) => x.reason));
      expect(reasons).toContain('levenshtein');
    });

    test('does NOT flag short strings with small edit distance', () => {
      // Avoid false positives: 'log' vs 'bug' would have distance 2 but
      // normalized minLen (3) is below the threshold of 4.
      const observed = [usage('log'), usage('bug')];
      expect(findAliasClusters(observed)).toEqual([]);
    });

    test('flags substring containment for longer strings', () => {
      // 'trace' is a substring of 'executiontrace' under normalization.
      const observed = [usage('trace'), usage('executionTrace')];
      const clusters = findAliasClusters(observed);
      const trace = clusters.find((c) => c.shape === 'trace');
      expect(trace).toBeDefined();
      expect(trace!.candidates.some((c) => c.reason === 'substring')).toBe(true);
    });

    test('does NOT flag short substring overlap', () => {
      // Normalized minLen (3) below the substring threshold of 5 - we don't
      // want every short shape to get flagged against every longer shape.
      const observed = [usage('log'), usage('superlogger')];
      expect(findAliasClusters(observed)).toEqual([]);
    });

    test('preserves the original shape string (not the normalized form)', () => {
      const observed = [usage('ExecutionTrace'), usage('execution_trace')];
      const clusters = findAliasClusters(observed);
      const first = clusters.find((c) => c.shape === 'ExecutionTrace');
      expect(first).toBeDefined();
      expect(first!.candidates[0].other).toBe('execution_trace');
    });

    test('sorts candidates highest-similarity first', () => {
      // 'sourcecode' should match both 'source_code' (normalized-equal, 1.0)
      // and 'sourcecodes' (levenshtein distance 1 on normalized).
      const observed = [
        usage('sourcecode'),
        usage('source_code'),
        usage('sourcecodes'),
      ];
      const clusters = findAliasClusters(observed);
      const self = clusters.find((c) => c.shape === 'sourcecode');
      expect(self).toBeDefined();
      expect(self!.candidates[0].similarity).toBeGreaterThanOrEqual(
        self!.candidates[self!.candidates.length - 1].similarity,
      );
      expect(self!.candidates[0].reason).toBe('normalized-equal');
    });
  });
});
