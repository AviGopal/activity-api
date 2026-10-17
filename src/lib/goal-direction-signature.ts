/**
 * THE GOAL-DIRECTION PARTITION (user ruling 2026-10-17T08:34:28Z on (c1): "Build the key now, read post-run").
 *
 * A satisfier's context posterior was keyed by the trace's input-pool signature, and a satisfier trace has no inputs and
 * outputs [X], so every satisfier had ONE constant bucket (sha256("1|X||")[:16]; shellResult 1c90f3d8ce96f334,
 * llm_completion_dispatch d60d86aefd3aa8a9): the context grain WAS the global row. The goal direction (the walk's target
 * shape set) now gets its OWN partition under its own signature_version, NOT inside the pool-signature partition (v1 is
 * the input pool, v2 the failure-conditioned repair key; mixing a situational hash into either would merge incompatible
 * partitions, as activities.ts warns). One derivation, the existing computeStateSpaceSignature over the sorted target
 * set, is used by the writer (trace ingest and chain credit) and the reader (thompson_posterior goal_target_shapes) alike,
 * so the two can never key differently.
 */
import { computeStateSpaceSignature } from '../utils/session-context';

/** The goal-direction partition's signature_version (0 legacy, 1 input pool, 2 failure-conditioned repair). */
export const GOAL_DIRECTION_SIGNATURE_VERSION = 3;

/** The sorted, de-duplicated target shape set, or null when there is none (no partition is written for it). */
export function goalDirectionShapes(targets: unknown): string[] | null {
  if (!Array.isArray(targets)) return null;
  const set = [...new Set(targets.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()))].sort();
  return set.length > 0 ? set : null;
}

/** The goal-direction bucket for a target shape set (null when there is none). */
export function goalDirectionSignature(targets: unknown): string | null {
  const shapes = goalDirectionShapes(targets);
  return shapes ? computeStateSpaceSignature({ shapes, provenance: [], missing: [] }) : null;
}
