/**
 * SurrealDB Type Utilities Tests
 *
 * Tests for RecordId normalization and related utilities.
 */

import { describe, test, expect } from 'bun:test';
import {
  normalizeRecordId,
  isRecordIdObject,
  normalizeRecordIds,
  extractIdFromRecordId,
  extractTableFromRecordId,
  type RecordIdLike,
} from './surrealdb-types';

describe('normalizeRecordId', () => {
  test('returns string input unchanged', () => {
    expect(normalizeRecordId('activity:abc123')).toBe('activity:abc123');
    expect(normalizeRecordId('simple-id')).toBe('simple-id');
    expect(normalizeRecordId('')).toBe('');
  });

  test('returns empty string for null/undefined', () => {
    expect(normalizeRecordId(null)).toBe('');
    expect(normalizeRecordId(undefined)).toBe('');
  });

  test('converts RecordId-like object via toString()', () => {
    const mockRecordId: RecordIdLike = {
      tb: 'activity',
      id: 'abc123',
      toString: () => 'activity:abc123',
    };
    expect(normalizeRecordId(mockRecordId)).toBe('activity:abc123');
  });

  test('handles object with toString method', () => {
    const customObj = {
      value: 42,
      toString: () => 'custom:42',
    };
    expect(normalizeRecordId(customObj)).toBe('custom:42');
  });

  test('converts numbers via String()', () => {
    expect(normalizeRecordId(123)).toBe('123');
    expect(normalizeRecordId(0)).toBe('0');
  });

  test('converts booleans via String()', () => {
    expect(normalizeRecordId(true)).toBe('true');
    expect(normalizeRecordId(false)).toBe('false');
  });

  test('handles plain objects without custom toString', () => {
    const plainObj = { foo: 'bar' };
    // Plain objects use Object.prototype.toString which returns [object Object]
    expect(normalizeRecordId(plainObj)).toBe('[object Object]');
  });
});

describe('isRecordIdObject', () => {
  test('returns true for RecordId-like objects', () => {
    const mockRecordId: RecordIdLike = {
      tb: 'activity',
      id: 'abc123',
      toString: () => 'activity:abc123',
    };
    expect(isRecordIdObject(mockRecordId)).toBe(true);
  });

  test('returns false for plain strings', () => {
    expect(isRecordIdObject('activity:abc123')).toBe(false);
  });

  test('returns false for null/undefined', () => {
    expect(isRecordIdObject(null)).toBe(false);
    expect(isRecordIdObject(undefined)).toBe(false);
  });

  test('returns false for objects missing tb/id', () => {
    expect(isRecordIdObject({ toString: () => 'test' })).toBe(false);
    expect(isRecordIdObject({ tb: 'activity' })).toBe(false);
    expect(isRecordIdObject({ id: 'abc' })).toBe(false);
  });

  test('returns false for objects without toString function', () => {
    const obj = { tb: 'activity', id: 'abc123', toString: 'not a function' };
    expect(isRecordIdObject(obj)).toBe(false);
  });
});

describe('normalizeRecordIds', () => {
  test('normalizes id field by default', () => {
    const mockRecordId = {
      tb: 'activity',
      id: 'abc123',
      toString: () => 'activity:abc123',
    };
    const obj = {
      id: mockRecordId,
      name: 'Test Activity',
      count: 42,
    };

    const result = normalizeRecordIds(obj as Record<string, unknown>);

    expect(result.id).toBe('activity:abc123');
    expect(result.name).toBe('Test Activity');
    expect(result.count).toBe(42);
  });

  test('normalizes custom fields when specified', () => {
    const mockTemplateId = {
      tb: 'template',
      id: 'tmpl1',
      toString: () => 'template:tmpl1',
    };
    const mockVariantId = {
      tb: 'variant',
      id: 'var1',
      toString: () => 'variant:var1',
    };
    const obj = {
      template_id: mockTemplateId,
      variant_id: mockVariantId,
      name: 'Test',
    };

    const result = normalizeRecordIds(obj as Record<string, unknown>, ['template_id', 'variant_id']);

    expect(result.template_id).toBe('template:tmpl1');
    expect(result.variant_id).toBe('variant:var1');
    expect(result.name).toBe('Test');
  });

  test('returns copy of object, does not mutate original', () => {
    const mockRecordId = {
      tb: 'activity',
      id: 'abc123',
      toString: () => 'activity:abc123',
    };
    const original: Record<string, unknown> = { id: mockRecordId, name: 'Test' };

    const result = normalizeRecordIds(original);

    expect(result).not.toBe(original);
    expect(original.id).toBe(mockRecordId); // Original unchanged
    expect(result.id).toBe('activity:abc123'); // Result normalized
  });

  test('handles already-string fields', () => {
    const obj = { id: 'activity:abc123', name: 'Test' };
    const result = normalizeRecordIds(obj);

    expect(result.id).toBe('activity:abc123');
  });

  test('handles missing fields gracefully', () => {
    const obj = { name: 'Test' };
    const result = normalizeRecordIds(obj, ['id', 'missing_field']);

    expect(result).toEqual({ name: 'Test' });
  });
});

describe('extractIdFromRecordId', () => {
  test('extracts id portion from table:id format', () => {
    expect(extractIdFromRecordId('activity:abc123')).toBe('abc123');
    expect(extractIdFromRecordId('user:12345')).toBe('12345');
    expect(extractIdFromRecordId('template:my-template-id')).toBe('my-template-id');
  });

  test('returns input unchanged if no colon', () => {
    expect(extractIdFromRecordId('abc123')).toBe('abc123');
    expect(extractIdFromRecordId('simple-id')).toBe('simple-id');
  });

  test('handles empty string', () => {
    expect(extractIdFromRecordId('')).toBe('');
  });

  test('handles multiple colons (uses first colon)', () => {
    // Edge case: id contains colons
    expect(extractIdFromRecordId('activity:id:with:colons')).toBe('id:with:colons');
  });
});

describe('extractTableFromRecordId', () => {
  test('extracts table portion from table:id format', () => {
    expect(extractTableFromRecordId('activity:abc123')).toBe('activity');
    expect(extractTableFromRecordId('user:12345')).toBe('user');
    expect(extractTableFromRecordId('template:my-template-id')).toBe('template');
  });

  test('returns empty string if no colon', () => {
    expect(extractTableFromRecordId('abc123')).toBe('');
    expect(extractTableFromRecordId('simple-id')).toBe('');
  });

  test('handles empty string', () => {
    expect(extractTableFromRecordId('')).toBe('');
  });

  test('handles multiple colons (uses first colon)', () => {
    expect(extractTableFromRecordId('activity:id:with:colons')).toBe('activity');
  });
});

describe('real-world scenarios', () => {
  test('Map key lookups work with normalized IDs', () => {
    // This was the original bug: Map keys didn't match because one was a RecordId object
    const scores = new Map<string, { alpha: number; beta: number }>();
    scores.set('activity:abc123', { alpha: 10, beta: 2 });

    const mockRecordId = {
      tb: 'activity',
      id: 'abc123',
      toString: () => 'activity:abc123',
    };

    // Without normalization, this would fail
    const normalizedId = normalizeRecordId(mockRecordId);
    const score = scores.get(normalizedId);

    expect(score).toBeDefined();
    expect(score?.alpha).toBe(10);
  });

  test('filter operations work with normalized IDs', () => {
    const mockRecordId1 = { tb: 'activity', id: 'a1', toString: () => 'activity:a1' };
    const mockRecordId2 = { tb: 'activity', id: 'a2', toString: () => 'activity:a2' };

    const templates = [
      { id: mockRecordId1, name: 'Template 1' },
      { id: mockRecordId2, name: 'Template 2' },
    ];

    // Filter by normalized IDs
    const filtered = templates.filter((t) => {
      const id = normalizeRecordId(t.id);
      return id === 'activity:a1';
    });

    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe('Template 1');
  });

  test('typeof checks work after normalization', () => {
    const mockRecordId = {
      tb: 'activity',
      id: 'abc123',
      toString: () => 'activity:abc123',
    };

    // Before normalization
    expect(typeof mockRecordId).toBe('object'); // Not 'string'!

    // After normalization
    const normalized = normalizeRecordId(mockRecordId);
    expect(typeof normalized).toBe('string');
    expect(normalized).toBe('activity:abc123');
  });
});
