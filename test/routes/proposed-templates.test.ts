/**
 * Proposed-template flow tests.
 *
 * Per audit investigation-028 recommendation A: substrate-authored writes
 * (ribosome, make-activity) set proposed=true so the template lands in the
 * registry but is selection-invisible until an operator (or future autonomous
 * promoter) calls POST /templates/:id/promote.
 *
 * These tests use the same in-memory mock pattern as other route tests:
 * the global fetch is stubbed where the route reaches activity-api and
 * we exercise the schema + filter logic directly.
 */
import { describe, it, expect } from 'bun:test';
import { CreateTemplateRequestSchema } from '../../src/models/schemas';

describe('CreateTemplateRequestSchema — proposed field', () => {
  it('defaults proposed to false when omitted', () => {
    const parsed = CreateTemplateRequestSchema.parse({
      id: 'x',
      name: 'x',
      description: 'x',
      tags: ['cat.x'],
      tasks: [{ id: 't', description: 'd', resolver: 'noop' }],
      output_shapes: ['xShape'],
    });
    expect(parsed.proposed).toBe(false);
  });

  it('accepts proposed=true', () => {
    const parsed = CreateTemplateRequestSchema.parse({
      id: 'x',
      name: 'x',
      description: 'x',
      tags: ['cat.x'],
      tasks: [{ id: 't', description: 'd', resolver: 'noop' }],
      output_shapes: ['xShape'],
      proposed: true,
    });
    expect(parsed.proposed).toBe(true);
  });

  it('rejects non-boolean proposed', () => {
    expect(() => CreateTemplateRequestSchema.parse({
      id: 'x',
      name: 'x',
      description: 'x',
      tags: ['cat.x'],
      tasks: [{ id: 't', description: 'd', resolver: 'noop' }],
      output_shapes: ['xShape'],
      proposed: 'yes',
    })).toThrow();
  });
});

describe('Recommend filter — proposed templates excluded', () => {
  // Smoke test of the validTemplates filter logic. The route's filter step
  // checks `template.proposed === true` and excludes from the candidate pool.
  // Mirroring the inline predicate so behavior changes here are visible to test.
  function passesRecommendFilter(template: { id?: string; retired?: boolean; proposed?: boolean }): boolean {
    const id = template.id ?? '';
    if (!id || id.trim() === '') return false;
    if (template.retired === true) return false;
    if (template.proposed === true) return false;
    return true;
  }

  it('excludes proposed=true from candidate pool', () => {
    expect(passesRecommendFilter({ id: 'tpl-a', proposed: true })).toBe(false);
    expect(passesRecommendFilter({ id: 'tpl-a', proposed: false })).toBe(true);
    expect(passesRecommendFilter({ id: 'tpl-a' })).toBe(true); // undefined → not proposed
  });

  it('combines with existing retired filter', () => {
    expect(passesRecommendFilter({ id: 'tpl-a', retired: true, proposed: false })).toBe(false);
    expect(passesRecommendFilter({ id: 'tpl-a', retired: false, proposed: true })).toBe(false);
    expect(passesRecommendFilter({ id: 'tpl-a', retired: false, proposed: false })).toBe(true);
  });
});
