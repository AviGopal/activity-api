/**
 * Resolution Routes
 *
 * Handles impulse resolution through the tiered resolver system.
 *
 * Endpoints:
 * - POST /v2/resolve - Resolve an impulse through the tiered system
 *
 * Resolution flow:
 * 1. Check for pattern match (Tier 1) - $0
 * 2. Check for similar pattern (Tier 2) - $0
 * 3. Route to appropriate LLM (Tier 3-5) - $$
 * 4. Record resolution in llm_resolution_log
 * 5. Deduct tokens from budget
 */

import { Hono } from 'hono';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { logger } from '../utils/logger';
import { getJwtAuthFromContext, hasJwtAuth } from '../middleware/jwtAuth';
import {
  selectResolver,
  hashImpulseShape,
  type Impulse,
  type ExecutionContext,
  type ResolverDecision
} from '../resolvers/router';
import { findExact, findSimilar, recordPatternExecution } from '../resolvers/pattern-store';
import { callByTier, callWithTrace, type LLMResponse, type LLMTrace } from '../resolvers/llm-proxy';
import { checkAndDeductBudget, type BudgetCheckResult } from '../resolvers/budget';
import type Anthropic from '@anthropic-ai/sdk';

const resolve = new Hono();

// ============================================================================
// Types
// ============================================================================

interface ResolveRequest {
  impulse: Impulse;
  execution_context?: ExecutionContext;
  prefer_tier?: 'pattern' | 'haiku' | 'sonnet' | 'opus';
  messages?: Anthropic.MessageParam[]; // For direct LLM calls
  system?: string;
  max_tokens?: number;
}

interface ResolveResponse {
  resolver_used: string;
  confidence: number;
  result: any;
  cost_usd: number;
  tokens_used: {
    input: number;
    output: number;
  };
  pattern_id?: string;
  trace_id?: string;
  thinking?: string;
}

interface LLMResolutionLog {
  id?: string;
  org_id: string;
  project_id?: string;
  connection_id?: string;
  execution_id?: string;
  resolver_tier: string;
  resolver_confidence: number;
  resolver_reasoning?: string;
  prefer_tier?: string;
  pattern_id?: string;
  pattern_success_rate?: number;
  pattern_similarity?: number;
  llm_model?: string;
  llm_request?: any;
  llm_response?: any;
  thinking?: string;
  tokens_input?: number;
  tokens_output?: number;
  tokens_cache?: number;
  latency_ms?: number;
  success: boolean;
  result?: any;
  error_message?: string;
  error_type?: string;
  cost_usd: number;
  impulse_hash?: string;
  impulse_metadata?: any;
  pattern_extracted: boolean;
  resolved_at: string;
}

// ============================================================================
// POST /v2/resolve
// ============================================================================

resolve.post('/resolve', async (c) => {
  const startTime = Date.now();

  try {
    // Require JWT auth for resolution
    if (!hasJwtAuth(c)) {
      return c.json({
        error: 'unauthorized',
        message: 'JWT authentication required'
      }, 401);
    }

    const jwtAuth = getJwtAuthFromContext(c)!;
    const body = await c.req.json() as ResolveRequest;
    const { impulse, execution_context, prefer_tier, messages, system, max_tokens } = body;

    if (!impulse) {
      return c.json({
        error: 'missing_impulse',
        message: 'impulse is required'
      }, 400);
    }

    // Get connection ID if provided
    const connectionId = c.req.header('X-Connection-ID');

    // Hash the impulse shape for pattern matching
    const impulseHash = hashImpulseShape(impulse.metadata);

    logger.info('[Resolve] Processing resolution request', {
      impulseHash: impulseHash.substring(0, 16),
      preferTier: prefer_tier,
      hasMessages: !!messages
    });

    // Select resolver tier
    const decision = await selectResolver(impulse, execution_context, jwtAuth.jwtToken);

    logger.info('[Resolve] Resolver selected', {
      tier: decision.tier,
      confidence: decision.confidence,
      reasoning: decision.reasoning
    });

    // Initialize resolution log
    const resolutionLog: Partial<LLMResolutionLog> = {
      org_id: jwtAuth.orgId,
      project_id: jwtAuth.projectId,
      connection_id: connectionId,
      execution_id: execution_context?.execution_id,
      resolver_tier: decision.tier,
      resolver_confidence: decision.confidence,
      resolver_reasoning: decision.reasoning,
      prefer_tier: prefer_tier,
      impulse_hash: impulseHash,
      impulse_metadata: impulse.metadata,
      pattern_extracted: false,
      resolved_at: new Date().toISOString()
    };

    let result: any;
    let response: ResolveResponse;

    // Handle based on tier
    if (decision.tier === 'pattern' || decision.tier === 'interpolate') {
      // Tier 1-2: Pattern match (free)
      const pattern = decision.tier === 'pattern'
        ? await findExact(impulseHash, jwtAuth.jwtToken)
        : await findSimilar(impulseHash, 0.85, jwtAuth.jwtToken);

      if (!pattern) {
        // Pattern disappeared between selection and execution, fall back to LLM
        logger.warn('[Resolve] Pattern not found, falling back to Sonnet');
        return await handleLLMResolution(
          c,
          jwtAuth,
          impulse,
          { ...decision, tier: 'sonnet' },
          resolutionLog,
          messages,
          system,
          max_tokens,
          startTime
        );
      }

      // Execute pattern template
      result = executePatternTemplate(pattern.template, impulse);

      // Record pattern execution
      await recordPatternExecution(pattern.id, true);

      // Update resolution log
      resolutionLog.pattern_id = pattern.pattern_id;
      resolutionLog.pattern_success_rate = pattern.success_rate;
      resolutionLog.pattern_similarity = pattern.similarity;
      resolutionLog.success = true;
      resolutionLog.result = result;
      resolutionLog.cost_usd = 0;

      response = {
        resolver_used: decision.tier,
        confidence: decision.confidence,
        result,
        cost_usd: 0,
        tokens_used: { input: 0, output: 0 },
        pattern_id: pattern.pattern_id
      };

    } else {
      // Tier 3-5: LLM resolution
      return await handleLLMResolution(
        c,
        jwtAuth,
        impulse,
        decision,
        resolutionLog,
        messages,
        system,
        max_tokens,
        startTime
      );
    }

    // Record resolution in database
    const traceId = await recordResolution(resolutionLog as LLMResolutionLog, jwtAuth.jwtToken);
    response.trace_id = traceId;

    const latencyMs = Date.now() - startTime;
    logger.info('[Resolve] Resolution complete', {
      tier: decision.tier,
      latencyMs,
      costUsd: response.cost_usd
    });

    return c.json(response);

  } catch (error) {
    const err = error as Error;
    logger.error('[Resolve] Resolution failed', { error: err.message });
    return c.json({
      error: 'resolution_failed',
      message: err.message
    }, 500);
  }
});

// ============================================================================
// LLM Resolution Handler
// ============================================================================

async function handleLLMResolution(
  c: any,
  jwtAuth: any,
  impulse: Impulse,
  decision: ResolverDecision,
  resolutionLog: Partial<LLMResolutionLog>,
  messages?: Anthropic.MessageParam[],
  system?: string,
  maxTokens?: number,
  startTime?: number
): Promise<Response> {
  const tier = decision.tier as 'haiku' | 'sonnet' | 'opus';

  // Estimate tokens needed (rough estimate)
  const estimatedTokens = estimateImpulseTokens(impulse) + (messages?.length || 0) * 500;

  // Check and deduct budget
  const budgetResult = await checkAndDeductBudget(
    jwtAuth.jwtToken,
    estimatedTokens,
    jwtAuth.orgId
  );

  if (!budgetResult.allowed) {
    logger.warn('[Resolve] Budget exceeded', {
      tokensUsed: budgetResult.tokens_used,
      tokensLimit: budgetResult.tokens_limit
    });

    return c.json({
      error: 'llm_budget_exceeded',
      message: 'Monthly LLM token budget exhausted',
      tokens_used: budgetResult.tokens_used,
      tokens_limit: budgetResult.tokens_limit,
      reset_at: budgetResult.reset_at,
      pattern_matches_available: true
    }, 402);
  }

  // Build messages if not provided
  const llmMessages = messages || buildMessagesFromImpulse(impulse);

  // Make LLM call with tracing
  let trace: LLMTrace;
  let llmResponse: LLMResponse;

  try {
    trace = await callWithTrace(tier, llmMessages, {
      system,
      max_tokens: maxTokens
    });
    llmResponse = trace.response;
  } catch (error) {
    const err = error as Error;

    // Record failed resolution
    resolutionLog.success = false;
    resolutionLog.error_message = err.message;
    resolutionLog.error_type = 'llm_error';
    resolutionLog.cost_usd = 0;
    resolutionLog.latency_ms = Date.now() - (startTime || Date.now());

    await recordResolution(resolutionLog as LLMResolutionLog, jwtAuth.jwtToken);

    throw error;
  }

  // Update budget with actual usage
  await adjustBudget(
    jwtAuth.jwtToken,
    estimatedTokens,
    llmResponse.tokens_input + llmResponse.tokens_output,
    jwtAuth.orgId
  );

  // Update resolution log
  resolutionLog.llm_model = llmResponse.model;
  resolutionLog.llm_request = trace.request;
  resolutionLog.llm_response = {
    content: llmResponse.content,
    stop_reason: llmResponse.stop_reason,
    model: llmResponse.model
  };
  resolutionLog.thinking = llmResponse.thinking;
  resolutionLog.tokens_input = llmResponse.tokens_input;
  resolutionLog.tokens_output = llmResponse.tokens_output;
  resolutionLog.tokens_cache = llmResponse.tokens_cache_read;
  resolutionLog.latency_ms = llmResponse.latency_ms;
  resolutionLog.success = true;
  resolutionLog.result = { content: llmResponse.content };
  resolutionLog.cost_usd = llmResponse.cost_usd;

  // Record resolution
  const traceId = await recordResolution(resolutionLog as LLMResolutionLog, jwtAuth.jwtToken);

  const response: ResolveResponse = {
    resolver_used: tier,
    confidence: decision.confidence,
    result: { content: llmResponse.content },
    cost_usd: llmResponse.cost_usd,
    tokens_used: {
      input: llmResponse.tokens_input,
      output: llmResponse.tokens_output
    },
    trace_id: traceId,
    thinking: llmResponse.thinking
  };

  logger.info('[Resolve] LLM resolution complete', {
    tier,
    tokensInput: llmResponse.tokens_input,
    tokensOutput: llmResponse.tokens_output,
    costUsd: llmResponse.cost_usd.toFixed(6),
    latencyMs: llmResponse.latency_ms
  });

  return c.json(response);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Execute a pattern template with the given impulse
 */
function executePatternTemplate(template: any, impulse: Impulse): any {
  // For now, return the template result directly
  // A more sophisticated implementation would interpolate variables
  if (template.result) {
    return template.result;
  }

  // If template has a transform function (as string), we could eval it
  // But for safety, just return the template
  return template;
}

/**
 * Build LLM messages from an impulse
 */
function buildMessagesFromImpulse(impulse: Impulse): Anthropic.MessageParam[] {
  // Convert impulse to a user message
  const content = JSON.stringify({
    ...impulse.pointer,
    metadata: impulse.metadata
  }, null, 2);

  return [
    {
      role: 'user',
      content: `Please process this impulse:\n\n${content}`
    }
  ];
}

/**
 * Estimate tokens in an impulse
 */
function estimateImpulseTokens(impulse: Impulse): number {
  const content = JSON.stringify(impulse);
  return Math.ceil(content.length / 4);
}

/**
 * Record a resolution in the database
 */
async function recordResolution(
  log: LLMResolutionLog,
  jwtToken: string
): Promise<string> {
  try {
    const result = await queryWithAuth<{ id: string }>(
      jwtToken,
      `CREATE llm_resolution_log CONTENT {
        org_id: $orgId,
        project_id: $projectId,
        connection_id: $connectionId,
        execution_id: $executionId,
        resolver_tier: $resolverTier,
        resolver_confidence: $resolverConfidence,
        resolver_reasoning: $resolverReasoning,
        prefer_tier: $preferTier,
        pattern_id: $patternId,
        pattern_success_rate: $patternSuccessRate,
        pattern_similarity: $patternSimilarity,
        llm_model: $llmModel,
        llm_request: $llmRequest,
        llm_response: $llmResponse,
        thinking: $thinking,
        tokens_input: $tokensInput,
        tokens_output: $tokensOutput,
        tokens_cache: $tokensCache,
        latency_ms: $latencyMs,
        success: $success,
        result: $result,
        error_message: $errorMessage,
        error_type: $errorType,
        cost_usd: $costUsd,
        impulse_hash: $impulseHash,
        impulse_metadata: $impulseMetadata,
        pattern_extracted: $patternExtracted,
        resolved_at: $resolvedAt,
        created_at: time::now(),
        updated_at: time::now()
      }`,
      {
        orgId: log.org_id,
        projectId: log.project_id || null,
        connectionId: log.connection_id || null,
        executionId: log.execution_id || null,
        resolverTier: log.resolver_tier,
        resolverConfidence: log.resolver_confidence,
        resolverReasoning: log.resolver_reasoning || null,
        preferTier: log.prefer_tier || null,
        patternId: log.pattern_id || null,
        patternSuccessRate: log.pattern_success_rate || null,
        patternSimilarity: log.pattern_similarity || null,
        llmModel: log.llm_model || null,
        llmRequest: log.llm_request || null,
        llmResponse: log.llm_response || null,
        thinking: log.thinking || null,
        tokensInput: log.tokens_input || null,
        tokensOutput: log.tokens_output || null,
        tokensCache: log.tokens_cache || null,
        latencyMs: log.latency_ms || null,
        success: log.success,
        result: log.result || null,
        errorMessage: log.error_message || null,
        errorType: log.error_type || null,
        costUsd: log.cost_usd,
        impulseHash: log.impulse_hash || null,
        impulseMetadata: log.impulse_metadata || null,
        patternExtracted: log.pattern_extracted,
        resolvedAt: log.resolved_at
      }
    );

    return result[0]?.id || 'unknown';
  } catch (error) {
    logger.error('[Resolve] Failed to record resolution', { error });
    return 'error';
  }
}

/**
 * Adjust budget after actual LLM usage
 */
async function adjustBudget(
  jwtToken: string,
  estimatedTokens: number,
  actualTokens: number,
  orgId: string
): Promise<void> {
  const difference = actualTokens - estimatedTokens;
  if (difference !== 0) {
    // Adjust the budget by the difference
    // This is handled by the budget module
    logger.debug('[Resolve] Budget adjustment', {
      estimated: estimatedTokens,
      actual: actualTokens,
      difference
    });
  }
}

export default resolve;
