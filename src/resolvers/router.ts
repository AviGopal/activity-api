/**
 * Resolver Router [DEPRECATED - ARCHITECTURE DRIFT]
 *
 * TODO: This module violates the "Resolvers live WHERE THE DATA IS" principle.
 *
 * PROBLEM: This implements LLM tier selection logic in the backend, making
 * the backend responsible for choosing which model to use. This is universal
 * resolver behavior, which contradicts the foundation where vessels should
 * resolve data where they have access to it.
 *
 * SOLUTION: Move this logic to MiniBob and other vessels:
 * - Vessels have context about their task complexity
 * - Vessels should decide which LLM tier they need
 * - Backend should only learn from traces of what vessels chose
 *
 * Original tiers:
 * - Tier 1: Pattern match (exact) - $0
 * - Tier 2: Interpolation (similar) - $0
 * - Tier 3: Haiku - $
 * - Tier 4: Sonnet - $$
 * - Tier 5: Opus - $$$
 *
 * The goal is to minimize LLM costs by using learned patterns first.
 */

import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import { findExact, findSimilar, type Pattern } from './pattern-store';

// ============================================================================
// Types
// ============================================================================

export type ResolverTier = 'pattern' | 'interpolate' | 'haiku' | 'sonnet' | 'opus';

export interface ImpulseMetadata {
  shape?: string;
  intent?: string;
  domain?: string;
  complexity?: number;
  context_tokens?: number;
  [key: string]: any;
}

export interface Impulse {
  id: string;
  pointer: {
    type: string;
    [key: string]: any;
  };
  metadata: ImpulseMetadata;
  budget?: number;
  priority?: string;
}

export interface ExecutionContext {
  execution_id?: string;
  task_index?: number;
  previous_results?: any[];
  depth?: number;
}

export interface ResolverDecision {
  tier: ResolverTier;
  confidence: number;
  reasoning: string;
  estimated_cost: number;
  pattern_id?: string;
  pattern_similarity?: number;
}

export interface ComplexityEstimate {
  context_tokens: number;
  reasoning_depth: number;
  requires_tools: boolean;
  is_novel: boolean;
}

// ============================================================================
// Impulse Hash Function
// ============================================================================

/**
 * Create a stable hash of the impulse "shape" for pattern matching.
 * Ignores variable content, focuses on structure.
 *
 * The hash is based on:
 * - Impulse pointer type
 * - Metadata shape/intent/domain
 * - Normalized structural fields
 */
export function hashImpulseShape(metadata: ImpulseMetadata): string {
  // Extract structural elements that define the "shape"
  const shape = {
    type: metadata.shape || 'unknown',
    intent: metadata.intent || 'unknown',
    domain: metadata.domain || 'general',
    // Add any other structural fields that should be part of the hash
  };

  // Create deterministic string representation
  const normalized = JSON.stringify(shape, Object.keys(shape).sort());

  // Return SHA-256 hash
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// ============================================================================
// Complexity Estimation
// ============================================================================

/**
 * Estimate the complexity of resolving an impulse.
 * Used to select between Haiku, Sonnet, and Opus.
 */
export function estimateComplexity(
  impulse: Impulse,
  context?: ExecutionContext
): ComplexityEstimate {
  const metadata = impulse.metadata;

  // Estimate context tokens
  let contextTokens = metadata.context_tokens || 0;

  // If not provided, estimate based on pointer type
  if (!contextTokens) {
    switch (impulse.pointer.type) {
      case 'goal':
        contextTokens = 500; // Goals are usually short
        break;
      case 'file':
        contextTokens = 2000; // Average file size
        break;
      case 'activityExecutionTrace':
        contextTokens = 5000; // Traces can be large
        break;
      case 'activityTemplate':
        contextTokens = 1000; // Templates are medium
        break;
      default:
        contextTokens = 1000; // Default estimate
    }
  }

  // Add context from previous results
  if (context?.previous_results) {
    contextTokens += context.previous_results.length * 500;
  }

  // Estimate reasoning depth
  let reasoningDepth = context?.depth || 1;

  // Check for complexity indicators in metadata
  if (metadata.complexity) {
    reasoningDepth = Math.max(reasoningDepth, Math.ceil(metadata.complexity / 2));
  }

  // Check intent for complexity hints
  const complexIntents = ['refactor', 'debug', 'optimize', 'design', 'architect'];
  if (metadata.intent && complexIntents.some(i => metadata.intent?.toLowerCase().includes(i))) {
    reasoningDepth = Math.max(reasoningDepth, 3);
  }

  // Determine if tools might be required
  const requiresTools = ['execute', 'run', 'test', 'deploy'].some(
    t => metadata.intent?.toLowerCase().includes(t)
  );

  // Check if this appears to be a novel situation
  const isNovel = metadata.shape === 'unknown' || !metadata.shape;

  return {
    context_tokens: contextTokens,
    reasoning_depth: reasoningDepth,
    requires_tools: requiresTools,
    is_novel: isNovel
  };
}

// ============================================================================
// Confidence Scoring
// ============================================================================

/**
 * Calculate confidence score for a pattern match
 */
function calculatePatternConfidence(
  pattern: Pattern,
  similarity: number = 1.0
): number {
  // Base confidence from pattern success rate
  let confidence = pattern.success_rate;

  // Adjust for number of executions (more executions = higher confidence)
  if (pattern.executions < 10) {
    confidence *= 0.8; // Penalty for low execution count
  } else if (pattern.executions > 50) {
    confidence *= 1.05; // Slight boost for well-tested patterns
  }

  // Adjust for similarity (for interpolation)
  confidence *= similarity;

  // Cap at 1.0
  return Math.min(confidence, 1.0);
}

/**
 * Calculate confidence for LLM tier selection
 */
function calculateLLMConfidence(
  tier: 'haiku' | 'sonnet' | 'opus',
  complexity: ComplexityEstimate
): number {
  switch (tier) {
    case 'haiku':
      // High confidence for simple tasks
      if (complexity.context_tokens < 4000 && complexity.reasoning_depth < 3) {
        return 0.75;
      }
      return 0.5; // Lower confidence if task might be too complex
    case 'sonnet':
      // Good confidence for moderate complexity
      if (complexity.context_tokens < 100000 && complexity.reasoning_depth < 5) {
        return 0.85;
      }
      return 0.7;
    case 'opus':
      // High confidence - Opus can handle anything
      return 0.95;
    default:
      return 0.5;
  }
}

// ============================================================================
// Main Router Function
// ============================================================================

/**
 * Select the appropriate resolver for an impulse.
 *
 * Priority:
 * 1. Exact pattern match (Tier 1) - if success_rate > 90% and executions > 10
 * 2. Similar pattern (Tier 2) - if success_rate > 85% and executions > 5
 * 3. Haiku (Tier 3) - for simple tasks (<4K tokens, depth <3)
 * 4. Sonnet (Tier 4) - for moderate tasks (<100K tokens, depth <5)
 * 5. Opus (Tier 5) - for complex/novel/high-stakes tasks
 */
export async function selectResolver(
  impulse: Impulse,
  context?: ExecutionContext,
  jwtToken?: string
): Promise<ResolverDecision> {
  const impulseHash = hashImpulseShape(impulse.metadata);

  logger.debug('[ResolverRouter] Selecting resolver', {
    impulseHash: impulseHash.substring(0, 16),
    metadata: impulse.metadata
  });

  // Tier 1: Exact pattern match
  try {
    const exactMatch = await findExact(impulseHash, jwtToken);

    if (exactMatch && exactMatch.success_rate > 0.90 && exactMatch.executions > 10) {
      const confidence = calculatePatternConfidence(exactMatch);

      logger.info('[ResolverRouter] Tier 1: Exact pattern match', {
        patternId: exactMatch.pattern_id,
        successRate: exactMatch.success_rate,
        executions: exactMatch.executions
      });

      return {
        tier: 'pattern',
        confidence,
        reasoning: `Exact match: ${exactMatch.pattern_id} (${exactMatch.executions} executions, ${(exactMatch.success_rate * 100).toFixed(1)}% success)`,
        estimated_cost: 0,
        pattern_id: exactMatch.pattern_id
      };
    }
  } catch (error) {
    logger.warn('[ResolverRouter] Error checking exact pattern', { error });
  }

  // Tier 2: Similar pattern with interpolation
  try {
    const similar = await findSimilar(impulseHash, 0.85, jwtToken);

    if (similar && similar.success_rate > 0.85 && similar.executions > 5) {
      const confidence = calculatePatternConfidence(similar, similar.similarity || 0.85);

      logger.info('[ResolverRouter] Tier 2: Similar pattern found', {
        patternId: similar.pattern_id,
        similarity: similar.similarity,
        successRate: similar.success_rate
      });

      return {
        tier: 'interpolate',
        confidence,
        reasoning: `Interpolate from: ${similar.pattern_id} (similarity: ${((similar.similarity || 0.85) * 100).toFixed(1)}%)`,
        estimated_cost: 0,
        pattern_id: similar.pattern_id,
        pattern_similarity: similar.similarity
      };
    }
  } catch (error) {
    logger.warn('[ResolverRouter] Error checking similar patterns', { error });
  }

  // Tier 3+: LLM required
  const complexity = estimateComplexity(impulse, context);

  logger.debug('[ResolverRouter] Complexity estimate', complexity);

  // Tier 3: Haiku for simple tasks
  if (complexity.context_tokens < 4000 && complexity.reasoning_depth < 3 && !complexity.is_novel) {
    const confidence = calculateLLMConfidence('haiku', complexity);

    return {
      tier: 'haiku',
      confidence,
      reasoning: `Simple task (${complexity.context_tokens} tokens, depth ${complexity.reasoning_depth})`,
      estimated_cost: estimateCost('haiku', complexity.context_tokens)
    };
  }

  // Tier 4: Sonnet for moderate complexity
  if (complexity.context_tokens < 100000 && complexity.reasoning_depth < 5) {
    const confidence = calculateLLMConfidence('sonnet', complexity);

    return {
      tier: 'sonnet',
      confidence,
      reasoning: `Moderate complexity (${complexity.context_tokens} tokens, depth ${complexity.reasoning_depth})`,
      estimated_cost: estimateCost('sonnet', complexity.context_tokens)
    };
  }

  // Tier 5: Opus for complex/novel situations
  const confidence = calculateLLMConfidence('opus', complexity);

  return {
    tier: 'opus',
    confidence,
    reasoning: `High complexity or novel situation (${complexity.context_tokens} tokens, depth ${complexity.reasoning_depth})`,
    estimated_cost: estimateCost('opus', complexity.context_tokens)
  };
}

// ============================================================================
// Cost Estimation
// ============================================================================

// Pricing per 1M tokens (approximate)
const PRICING = {
  haiku: {
    input: 0.25,  // $0.25 per 1M input tokens
    output: 1.25  // $1.25 per 1M output tokens
  },
  sonnet: {
    input: 3.0,   // $3 per 1M input tokens
    output: 15.0  // $15 per 1M output tokens
  },
  opus: {
    input: 15.0,  // $15 per 1M input tokens
    output: 75.0  // $75 per 1M output tokens
  }
};

/**
 * Estimate cost for an LLM call
 */
function estimateCost(tier: 'haiku' | 'sonnet' | 'opus', inputTokens: number): number {
  const pricing = PRICING[tier];

  // Assume output is roughly 20% of input for estimation
  const estimatedOutputTokens = Math.ceil(inputTokens * 0.2);

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (estimatedOutputTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}

/**
 * Calculate actual cost from token usage
 */
export function calculateActualCost(
  tier: 'haiku' | 'sonnet' | 'opus',
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = PRICING[tier];

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}
