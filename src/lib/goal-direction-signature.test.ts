// (c1) THE GOAL-DIRECTION PARTITION (user ruling 2026-10-17T08:34:28Z). A satisfier's outcome is keyed by the walk's
// target shape set at its own signature_version (3), beside the input-pool row. Before, every satisfier had ONE constant
// pool bucket (a satisfier trace has no inputs and outputs [X]), so an F1-class goal and an H3-class goal using the same
// satisfier shared one verdict. MUST-FAIL on the parent (e11b6cb): goal-direction-signature.ts does not exist and nothing
// writes or reads signature_version 3.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GOAL_DIRECTION_SIGNATURE_VERSION, goalDirectionShapes, goalDirectionSignature } from './goal-direction-signature';
import { computeStateSpaceSignature } from '../utils/session-context';

const SRC = (p: string) => readFileSync(join(import.meta.dir, '..', p), 'utf8');
// Two classes of goal that both run satisfier:shellResult: a registry count (F1) and a current-events digest (H3).
const F1 = ['registryCount'];
const H3 = ['currentEventsDigest', 'webSearchResult'];

describe('the goal direction is its own key', () => {
  test('[MUST-FAIL] F1-class and H3-class goals get DIFFERENT goal-direction buckets for the same satisfier', () => {
    const f1 = goalDirectionSignature(F1), h3 = goalDirectionSignature(H3);
    expect(f1).toMatch(/^[0-9a-f]{16}$/);
    expect(h3).toMatch(/^[0-9a-f]{16}$/);
    expect(f1).not.toBe(h3);
  });
  test('[CONTROL] the pool signature the parent writes is ONE constant for both (the defect this partition fixes)', () => {
    // deriveSignatureShapes of a satisfier trace (no inputs, outputs [shellResult]) is [shellResult] whatever the goal.
    const pool = computeStateSpaceSignature({ shapes: ['shellResult'], provenance: [], missing: [] });
    expect(pool).toBe('1c90f3d8ce96f334');
  });
  test('[CONTROL] one key per target SET: order and duplicates do not matter; no targets is no key', () => {
    expect(goalDirectionSignature(['b', 'a', 'a'])).toBe(goalDirectionSignature(['a', 'b']));
    expect(goalDirectionShapes([' a ', '', 7, 'a'])).toEqual(['a']);
    expect(goalDirectionSignature([])).toBeNull();
    expect(goalDirectionSignature(undefined)).toBeNull();
    expect(GOAL_DIRECTION_SIGNATURE_VERSION).toBe(3);
  });
});

describe('[WIRING] one derivation, used by the writer and the reader', () => {
  test('the trace ingest derives it from metadata.goal_target_shapes and grades into it', () => {
    const r = SRC('routes/execution-traces.ts');
    expect(r).toContain("...(goalDirectionSignature((body as any).metadata?.goal_target_shapes) ? { goal_direction_signature: goalDirectionSignature((body as any).metadata?.goal_target_shapes)! } : {}),");
    const u = SRC('lib/posterior-update.ts');
    expect(u).toContain("kind: 'leaf', orgId, templateId: activityId, signatureVersion: GOAL_DIRECTION_SIGNATURE_VERSION,");
    expect(u).toContain("bucket: trace.goal_direction_signature, alpha: alphaDelta, beta: betaDelta,");
  });
  test('chain credit re-derives an ancestor satisfier\'s goal direction from its stored target set', () => {
    const u = SRC('lib/posterior-update.ts');
    expect(u).toContain('metadata.goal_target_shapes AS goal_target_shapes');
    expect(u).toContain('goal_direction_signature: goalDirectionSignature(row.goal_target_shapes) ?? undefined,');
    expect(u).toContain("kind: 'ancestor', orgId: meta.org_id, templateId: ancestorId, signatureVersion: GOAL_DIRECTION_SIGNATURE_VERSION,");
  });
  test('thompson_posterior derives the same bucket from goal_target_shapes and FILTERS on the version', () => {
    const i = SRC('routes/impulses.ts');
    expect(i).toContain('const goalDirectionBucket = goalDirectionSignature((pointer as any).goal_target_shapes);');
    expect(i).toContain("WHERE template_id = $variant_id AND context_bucket = $context_bucket${explicitSignatureVersion ? ' AND signature_version = $signature_version' : ''}");
  });
});
