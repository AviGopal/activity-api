/**
 * Thompson Sampling Service
 *
 * Implements Thompson Sampling for activity template selection with shape match scoring.
 *
 * Key concepts:
 * - Thompson Sampling: Bayesian approach to multi-armed bandit problem
 * - Shape Match Score: Jaccard similarity between expected and actual output shapes
 * - Weighted Success: Combines execution success with shape match quality
 *
 * Score formula:
 * - If execution succeeded: score = 0.7 * shapeMatchScore + 0.3 (base success)
 * - If execution failed: score = 0 (no partial credit)
 *
 * The shape match score is computed as:
 * shapeMatchScore = |intersection| / |union| (Jaccard similarity)
 *
 * This enables the learning system to:
 * 1. Favor activities that produce the expected output shapes
 * 2. Detect shape drift (execution succeeds but wrong shapes)
 * 3. Learn which activities reliably produce specific shapes
 */

import { logger } from '../utils/logger';

/**
 * Compute Jaccard similarity between expected and actual output shapes
 *
 * Formula: |intersection| / |union|
 *
 * @param expectedShapes - Declared output shapes from activity template
 * @param actualShapes - Actual shapes produced during execution
 * @returns Score between 0 (no overlap) and 1 (perfect match)
 */
export function computeShapeMatchScore(
  expectedShapes: string[],
  actualShapes: string[]
): number {
  // Handle edge cases
  if (expectedShapes.length === 0 && actualShapes.length === 0) {
    return 1.0; // Both empty = perfect match
  }
  if (expectedShapes.length === 0 || actualShapes.length === 0) {
    return 0.0; // One empty = no match
  }

  // Compute intersection: shapes present in both sets
  const expectedSet = new Set(expectedShapes);
  const actualSet = new Set(actualShapes);

  const intersection = Array.from(expectedSet).filter(shape => actualSet.has(shape));

  // Compute union: all unique shapes from both sets
  const union = new Set(Array.from(expectedSet).concat(Array.from(actualSet)));

  // Jaccard similarity = |intersection| / |union|
  const score = intersection.length / union.size;

  logger.debug('[Shape Match] Computed Jaccard similarity', {
    expectedShapes,
    actualShapes,
    intersection: intersection.length,
    union: union.size,
    score,
  });

  return score;
}

/**
 * Compute weighted success score for Thompson Sampling update
 *
 * Combines execution success with shape match quality:
 * - Success + perfect shapes = 1.0 (0.7 * 1.0 + 0.3)
 * - Success + partial shapes = 0.4-0.9 (0.7 * score + 0.3)
 * - Success + no shapes = 0.3 (0.7 * 0 + 0.3)
 * - Failure (any shapes) = 0.0 (no partial credit)
 *
 * @param executionSuccess - Whether the execution completed successfully
 * @param shapeMatchScore - Jaccard similarity between expected and actual shapes (0-1)
 * @returns Weighted success score for Thompson Sampling (0-1)
 */
export function computeWeightedSuccessScore(
  executionSuccess: boolean,
  shapeMatchScore: number
): number {
  if (!executionSuccess) {
    // Failed execution gets no credit, regardless of shapes
    return 0.0;
  }

  // Successful execution gets base credit (0.3) + shape quality bonus (0.7 * match)
  // This ensures:
  // - Even successful executions with wrong shapes get some credit (0.3)
  // - Perfect shape matches get full credit (1.0)
  // - Partial matches get proportional credit (0.3 to 1.0)
  const weightedScore = 0.7 * shapeMatchScore + 0.3;

  logger.debug('[Thompson Sampling] Computed weighted success score', {
    executionSuccess,
    shapeMatchScore,
    weightedScore,
  });

  return weightedScore;
}

/**
 * Compute Thompson Sampling parameter updates
 *
 * Updates alpha (successes) and beta (failures) based on weighted success score.
 * Uses fractional increments to support partial success credit.
 *
 * @param executionSuccess - Whether the execution completed successfully
 * @param shapeMatchScore - Jaccard similarity between expected and actual shapes (0-1)
 * @returns Delta updates for Thompson Sampling parameters
 */
export function computeThompsonSamplingUpdates(
  executionSuccess: boolean,
  shapeMatchScore: number
): {
  alphaDelta: number;
  betaDelta: number;
  weightedScore: number;
} {
  const weightedScore = computeWeightedSuccessScore(executionSuccess, shapeMatchScore);

  // Split the weighted score between alpha and beta
  // Full success (1.0) = +1 alpha, +0 beta
  // Partial success (0.5) = +0.5 alpha, +0.5 beta
  // Full failure (0.0) = +0 alpha, +1 beta
  const alphaDelta = weightedScore;
  const betaDelta = 1.0 - weightedScore;

  logger.info('[Thompson Sampling] Computed parameter updates', {
    executionSuccess,
    shapeMatchScore,
    weightedScore,
    alphaDelta,
    betaDelta,
  });

  return {
    alphaDelta,
    betaDelta,
    weightedScore,
  };
}

/**
 * Extract output shapes from execution trace
 *
 * Handles multiple formats:
 * - output_impulses array of objects with shape field
 * - output_impulses array of shape strings
 * - output_impulse_shapes array of strings
 *
 * @param executionTrace - Execution trace data from MiniBob
 * @returns Array of shape strings
 */
export function extractOutputShapes(executionTrace: {
  output_impulses?: Array<{ shape: string } | string>;
  output_impulse_shapes?: string[];
}): string[] {
  // Try output_impulse_shapes first (explicit shape array)
  if (executionTrace.output_impulse_shapes && executionTrace.output_impulse_shapes.length > 0) {
    return executionTrace.output_impulse_shapes;
  }

  // Try output_impulses (may be objects with shape field or plain strings)
  if (executionTrace.output_impulses && executionTrace.output_impulses.length > 0) {
    return executionTrace.output_impulses.map((imp: any) =>
      typeof imp === 'string' ? imp : (imp?.shape || 'unknown')
    );
  }

  return [];
}

/**
 * Shape match metadata for execution trace storage
 */
export interface ShapeMatchMetadata {
  passed: boolean;
  expectedShapes: string[];
  actualShapes: string[];
  shapeMatchScore: number;
  weightedSuccessScore: number;
  missing: string[];
  unexpected: string[];
  validatedAt: string;
}

/**
 * Validate output shapes and compute match metadata
 *
 * Compares actual output shapes against declared output shapes from template.
 * Computes Jaccard similarity and identifies missing/unexpected shapes.
 *
 * @param declaredShapes - Output shapes declared in activity template
 * @param actualShapes - Actual shapes produced during execution
 * @param executionSuccess - Whether the execution completed successfully
 * @returns Shape match metadata for storage
 */
export function validateOutputShapes(
  declaredShapes: string[],
  actualShapes: string[],
  executionSuccess: boolean
): ShapeMatchMetadata {
  const shapeMatchScore = computeShapeMatchScore(declaredShapes, actualShapes);
  const weightedSuccessScore = computeWeightedSuccessScore(executionSuccess, shapeMatchScore);

  // Identify missing and unexpected shapes
  const declaredSet = new Set(declaredShapes);
  const actualSet = new Set(actualShapes);

  const missing = declaredShapes.filter(s => !actualSet.has(s));
  const unexpected = actualShapes.filter(s => !declaredSet.has(s));

  // Consider validation "passed" if score is above 0.8 (80% shape overlap)
  const passed = shapeMatchScore >= 0.8;

  const metadata: ShapeMatchMetadata = {
    passed,
    expectedShapes: declaredShapes,
    actualShapes,
    shapeMatchScore,
    weightedSuccessScore,
    missing,
    unexpected,
    validatedAt: new Date().toISOString(),
  };

  if (!passed) {
    logger.warn('[Shape Validation] Low shape match score', {
      shapeMatchScore,
      missing,
      unexpected,
    });
  } else {
    logger.info('[Shape Validation] Shapes validated successfully', {
      shapeMatchScore,
      actualShapes,
    });
  }

  return metadata;
}

/**
 * Cross-signature reputation penalty (2026-06-25 composition-gap lever 3).
 *
 * Re-injects a template's signature-agnostic GLOBAL reputation proportional to
 * how much the context blend discounted it, damping the "gamed-signature
 * escape" (a template with strong LOCAL alpha on one signature it games escapes
 * its bad GLOBAL reputation because the blend downweights global). Computes a
 * factor in [0,1] that scales the drawn Thompson sample:
 *
 *   mu_g            = alphaGlobal / (alphaGlobal + betaGlobal)
 *   reputationFactor = 1 - blendWeight * (1 - mu_g)
 *   sample'          = sample * reputationFactor
 *
 * Deliberately NOT a flat `sample *= mu_g`: that double-damps the fresh-signature
 * regime (blendWeight=0), where global is already the Beta param. Here
 * blendWeight=0 => factor=1.0 (no-op), and worse global / more local override =>
 * stronger damping. factor <= 1, so it can only damp, never amplify.
 *
 * Guards (all preserve novelty / exploration):
 * - disabled flag                          => 1.0 (current behavior, no-op)
 * - blendWeight <= 0                        => 1.0 (no double-damp)
 * - missing global posterior               => 1.0 (no bad reputation to damp)
 * - global observations below minObs floor => 1.0 (one unlucky failure ≠ bad rep)
 *
 * `minObs` is measured as `alphaGlobal + betaGlobal - 2` (observations above the
 * Beta(1,1) prior), matching `nContext` upstream.
 *
 * @returns reputationFactor in [0,1]; multiply the drawn sample by this.
 */
export function applyReputationFactor(
  blendWeight: number,
  alphaGlobal: number | null | undefined,
  betaGlobal: number | null | undefined,
  opts: { enabled: boolean; minObs?: number }
): number {
  if (!opts.enabled) return 1.0;
  if (!(blendWeight > 0)) return 1.0;
  if (alphaGlobal == null || betaGlobal == null) return 1.0;

  const minObs = opts.minObs ?? 5;
  const globalObs = alphaGlobal + betaGlobal - 2;
  if (globalObs < minObs) return 1.0;

  const denom = alphaGlobal + betaGlobal;
  if (!(denom > 0)) return 1.0;
  const muG = alphaGlobal / denom;

  const factor = 1 - blendWeight * (1 - muG);
  // Defensive clamp to [0,1].
  return Math.max(0, Math.min(1, factor));
}
