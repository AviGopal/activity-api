/**
 * Learning-loop failure-track tests.
 *
 * Locks in two recently-fixed paths in the trace-storage / variant-family
 * pipeline that the end-to-end validation surfaced (Bugs B and C):
 *
 *   B) Variant families always surface at least the base template
 *      (singleton fallback). Previously `getVariantFamily` matched the base
 *      via `WHERE id = $base_id` — comparing a SurrealDB record id to a
 *      plain string — and silently returned []. Every template's
 *      `/variant-scores` was therefore empty, leaving Thompson Sampling at
 *      the variant axis with nothing to sample.
 *
 *   C) Failed (`success: false`) traces increment thompson_beta of the
 *      dispatched template even when the trace itself is a meta-trace
 *      (`_goal_resolve`, `_activity_execute`) carrying the real template id
 *      in `metadata.template_id`. Without this, a goal-level abort on a
 *      recommended template never penalises it — the system learns from
 *      successes only.
 *
 * Tests are pure (no SurrealDB) — they target the helpers that drive the
 * write path so a regression in either is caught without infra.
 */

import { describe, test, expect } from 'bun:test';
import { resolveTemplateIdsForUpdate } from '../src/routes/execution-traces';
import { normalizeActivityId } from '../src/db/paradigm';

describe('resolveTemplateIdsForUpdate (Bug C: failure track)', () => {
  test('beta increments on failure: variant_id alone when no metadata.template_id', () => {
    // Direct execution: the trace's variant_id IS the dispatched template.
    // Single-bucket update, no fan-out.
    const ids = resolveTemplateIdsForUpdate({
      variantId: 'execute-shell-command',
      metadata: { activity_status: 'failed' },
    });
    expect(ids).toEqual(['execute-shell-command']);
  });

  test('alpha-track companion: success traces collapse to the same single id', () => {
    // Sanity check that the helper has no opinion about success/failure
    // (alpha vs beta delta is decided at the call site). A successful direct
    // execution still produces a single-id update — locks in the existing
    // behaviour so the failure-track fan-out doesn't accidentally split
    // success updates across two rows.
    const ids = resolveTemplateIdsForUpdate({
      variantId: 'execute-shell-command',
      metadata: { activity_status: 'success' },
    });
    expect(ids).toEqual(['execute-shell-command']);
  });

  test('meta-trace failure: variant_id is synthetic, metadata.template_id names dispatched template', () => {
    // The exact shape minibob's emitMetaTrace sends for an L1 goal_resolve
    // failure that dispatched a real activity. Both buckets must be updated:
    // the synthetic _goal_resolve row (so meta-trace stats stay coherent)
    // AND goal-processing-activity-driven (so its beta moves).
    const ids = resolveTemplateIdsForUpdate({
      variantId: '_goal_resolve',
      metadata: {
        level: 'goal_resolve',
        activity_status: 'failed',
        template_id: 'goal-processing-activity-driven',
      },
    });
    expect(ids).toEqual(['_goal_resolve', 'goal-processing-activity-driven']);
  });

  test('de-duplicates when metadata.template_id matches variant_id', () => {
    // L2 activity_execute trace where minibob filled metadata.template_id
    // with the same id as variant_id. Don't double-count the failure.
    const ids = resolveTemplateIdsForUpdate({
      variantId: 'goal-processing-activity-driven',
      metadata: { template_id: 'goal-processing-activity-driven' },
    });
    expect(ids).toEqual(['goal-processing-activity-driven']);
  });

  test('ignores non-string metadata.template_id (defensive)', () => {
    // Old/buggy emitters might put non-strings here. The helper should fall
    // back to variant_id alone rather than crash or emit garbage.
    const ids = resolveTemplateIdsForUpdate({
      variantId: 'execute-shell-command',
      metadata: { template_id: 123 as unknown as string },
    });
    expect(ids).toEqual(['execute-shell-command']);
  });

  test('handles missing/null metadata', () => {
    expect(resolveTemplateIdsForUpdate({ variantId: 'x', metadata: null })).toEqual(['x']);
    expect(resolveTemplateIdsForUpdate({ variantId: 'x', metadata: undefined })).toEqual(['x']);
    expect(resolveTemplateIdsForUpdate({ variantId: 'x', metadata: {} })).toEqual(['x']);
  });

  test('drops empty string ids so we never UPDATE on an empty match', () => {
    const ids = resolveTemplateIdsForUpdate({
      variantId: 'real-template',
      metadata: { template_id: '' },
    });
    expect(ids).toEqual(['real-template']);
  });
});

describe('normalizeActivityId (Bug B: variant family lookup)', () => {
  test('strips activity: prefix and angle brackets from string record ids', () => {
    // SurrealDB returns record ids like `activity:⟨execute-shell-command⟩`
    // when the id contains non-identifier characters. The variant-scores
    // endpoint then keys on the plain string — without normalisation, the
    // metrics lookup misses every time.
    expect(normalizeActivityId('activity:⟨execute-shell-command⟩')).toBe('execute-shell-command');
    expect(normalizeActivityId('activity:execute-shell-command')).toBe('execute-shell-command');
  });

  test('handles SurrealDB Thing object form', () => {
    // Some driver paths surface the record id as { tb, id }. Normalise it
    // identically.
    expect(normalizeActivityId({ tb: 'activity', id: 'hello-world' })).toBe('hello-world');
    expect(normalizeActivityId({ tb: 'activity', id: '⟨quoted-id⟩' })).toBe('quoted-id');
  });

  test('passes through plain strings', () => {
    expect(normalizeActivityId('execute-shell-command')).toBe('execute-shell-command');
  });

  test('handles null/undefined defensively', () => {
    expect(normalizeActivityId(null)).toBe('');
    expect(normalizeActivityId(undefined)).toBe('');
  });
});
