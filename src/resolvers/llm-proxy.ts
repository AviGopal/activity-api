/**
 * LLM Proxy Client [DEPRECATED - ARCHITECTURE DRIFT]
 *
 * TODO: This module violates the "Resolvers live WHERE THE DATA IS" principle.
 *
 * PROBLEM: The backend is making LLM calls on behalf of vessels, acting as
 * a proxy. This makes the backend a universal resolver instead of a trace
 * store and pattern learner.
 *
 * SOLUTION: Vessels should call LLMs directly:
 * - MiniBob already has LLM client code (src/llm.ts)
 * - Other vessels can include their own LLM clients
 * - Backend receives traces of what happened, doesn't orchestrate calls
 *
 * This module is retained for reference but should not be used going forward.
 *
 * Original functionality:
 * - Model-specific methods (Haiku, Sonnet, Opus)
 * - Full request/response tracing
 * - Rate limiting and retries
 * - Token usage tracking
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger';
import { calculateActualCost } from './router';

// ============================================================================
// Types
// ============================================================================

export interface LLMOptions {
  system?: string;
  max_tokens?: number;
  temperature?: number;
  tools?: Anthropic.Tool[];
  tool_choice?: Anthropic.ToolChoiceAuto | Anthropic.ToolChoiceAny | Anthropic.ToolChoiceTool;
  stop_sequences?: string[];
  stream?: boolean;
}

export interface LLMResponse {
  content: string;
  thinking?: string;
  stop_reason: string;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read?: number;
  tokens_cache_write?: number;
  latency_ms: number;
  cost_usd: number;
  model: string;
  raw_response?: Anthropic.Message;
}

export interface LLMRequest {
  messages: Anthropic.MessageParam[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
  tools?: Anthropic.Tool[];
}

// ============================================================================
// Configuration
// ============================================================================

// Model IDs
const MODELS = {
  haiku: 'claude-3-haiku-20240307',
  sonnet: 'claude-sonnet-4-20250514',
  opus: 'claude-opus-4-5-20251101'
};

// Default max tokens by model
const DEFAULT_MAX_TOKENS = {
  haiku: 4096,
  sonnet: 8192,
  opus: 8192
};

// Rate limiting configuration
const RATE_LIMIT = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000
};

// ============================================================================
// Client Singleton
// ============================================================================

let anthropicClient: Anthropic | null = null;

/**
 * Get or create the Anthropic client
 */
function getClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is not set');
    }

    anthropicClient = new Anthropic({
      apiKey
    });
  }

  return anthropicClient;
}

// ============================================================================
// Core LLM Call Function
// ============================================================================

/**
 * Make an LLM call with the specified model
 */
async function callLLM(
  model: keyof typeof MODELS,
  messages: Anthropic.MessageParam[],
  options: LLMOptions = {}
): Promise<LLMResponse> {
  const client = getClient();
  const modelId = MODELS[model];
  const maxTokens = options.max_tokens || DEFAULT_MAX_TOKENS[model];

  const startTime = Date.now();
  let lastError: Error | null = null;

  // Build request
  const request: Anthropic.MessageCreateParams = {
    model: modelId,
    max_tokens: maxTokens,
    messages
  };

  if (options.system) {
    request.system = options.system;
  }

  if (options.temperature !== undefined) {
    request.temperature = options.temperature;
  }

  if (options.tools && options.tools.length > 0) {
    request.tools = options.tools;
    if (options.tool_choice) {
      request.tool_choice = options.tool_choice;
    }
  }

  if (options.stop_sequences) {
    request.stop_sequences = options.stop_sequences;
  }

  // Retry loop with exponential backoff
  for (let attempt = 0; attempt < RATE_LIMIT.maxRetries; attempt++) {
    try {
      logger.debug('[LLMProxy] Making API call', {
        model: modelId,
        attempt: attempt + 1,
        messageCount: messages.length
      });

      const response = await client.messages.create(request);

      const latencyMs = Date.now() - startTime;

      // Extract content
      let content = '';
      let thinking = '';

      for (const block of response.content) {
        if (block.type === 'text') {
          content += block.text;
        } else if ((block as any).type === 'thinking') {
          thinking += (block as any).thinking || '';
        }
      }

      // Calculate cost
      const tokensInput = response.usage.input_tokens;
      const tokensOutput = response.usage.output_tokens;
      const costUsd = calculateActualCost(model, tokensInput, tokensOutput);

      logger.info('[LLMProxy] API call successful', {
        model: modelId,
        tokensInput,
        tokensOutput,
        costUsd: costUsd.toFixed(6),
        latencyMs,
        stopReason: response.stop_reason
      });

      return {
        content,
        thinking: thinking || undefined,
        stop_reason: response.stop_reason || 'end_turn',
        tokens_input: tokensInput,
        tokens_output: tokensOutput,
        tokens_cache_read: (response.usage as any).cache_read_input_tokens,
        tokens_cache_write: (response.usage as any).cache_creation_input_tokens,
        latency_ms: latencyMs,
        cost_usd: costUsd,
        model: modelId,
        raw_response: response
      };

    } catch (error: any) {
      lastError = error;

      // Check if it's a rate limit error
      if (error.status === 429 || error.error?.type === 'rate_limit_error') {
        const delay = Math.min(
          RATE_LIMIT.baseDelayMs * Math.pow(2, attempt),
          RATE_LIMIT.maxDelayMs
        );

        logger.warn('[LLMProxy] Rate limited, retrying', {
          attempt: attempt + 1,
          delayMs: delay,
          error: error.message
        });

        await sleep(delay);
        continue;
      }

      // Check if it's a retriable error
      if (error.status >= 500 || error.status === 408) {
        const delay = Math.min(
          RATE_LIMIT.baseDelayMs * Math.pow(2, attempt),
          RATE_LIMIT.maxDelayMs
        );

        logger.warn('[LLMProxy] Server error, retrying', {
          attempt: attempt + 1,
          delayMs: delay,
          status: error.status,
          error: error.message
        });

        await sleep(delay);
        continue;
      }

      // Non-retriable error, throw immediately
      throw error;
    }
  }

  // All retries exhausted
  throw lastError || new Error('LLM call failed after max retries');
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Model-Specific Methods
// ============================================================================

/**
 * Call Claude 3 Haiku (Tier 3)
 * Best for: Simple tasks, <4K context
 */
export async function callHaiku(
  messages: Anthropic.MessageParam[],
  options: LLMOptions = {}
): Promise<LLMResponse> {
  return callLLM('haiku', messages, {
    ...options,
    max_tokens: options.max_tokens || 4096
  });
}

/**
 * Call Claude Sonnet 4 (Tier 4)
 * Best for: Moderate complexity, <100K context
 */
export async function callSonnet(
  messages: Anthropic.MessageParam[],
  options: LLMOptions = {}
): Promise<LLMResponse> {
  return callLLM('sonnet', messages, {
    ...options,
    max_tokens: options.max_tokens || 8192
  });
}

/**
 * Call Claude Opus 4.5 (Tier 5)
 * Best for: Complex/novel/high-stakes tasks
 */
export async function callOpus(
  messages: Anthropic.MessageParam[],
  options: LLMOptions = {}
): Promise<LLMResponse> {
  return callLLM('opus', messages, {
    ...options,
    max_tokens: options.max_tokens || 8192
  });
}

// ============================================================================
// Unified Call Method
// ============================================================================

/**
 * Call the appropriate model based on tier
 */
export async function callByTier(
  tier: 'haiku' | 'sonnet' | 'opus',
  messages: Anthropic.MessageParam[],
  options: LLMOptions = {}
): Promise<LLMResponse> {
  switch (tier) {
    case 'haiku':
      return callHaiku(messages, options);
    case 'sonnet':
      return callSonnet(messages, options);
    case 'opus':
      return callOpus(messages, options);
    default:
      throw new Error(`Unknown LLM tier: ${tier}`);
  }
}

// ============================================================================
// Request/Response Capture for Tracing
// ============================================================================

export interface LLMTrace {
  request: LLMRequest;
  response: LLMResponse;
  tier: 'haiku' | 'sonnet' | 'opus';
  timestamp: string;
}

/**
 * Make an LLM call and capture full trace for logging
 */
export async function callWithTrace(
  tier: 'haiku' | 'sonnet' | 'opus',
  messages: Anthropic.MessageParam[],
  options: LLMOptions = {}
): Promise<LLMTrace> {
  const request: LLMRequest = {
    messages,
    system: options.system,
    max_tokens: options.max_tokens,
    temperature: options.temperature,
    tools: options.tools
  };

  const response = await callByTier(tier, messages, options);

  return {
    request,
    response,
    tier,
    timestamp: new Date().toISOString()
  };
}

// ============================================================================
// Token Counting (Estimation)
// ============================================================================

/**
 * Estimate token count for a message
 * Uses a simple heuristic: ~4 characters per token
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total tokens for messages
 */
export function estimateMessageTokens(messages: Anthropic.MessageParam[]): number {
  let total = 0;

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          total += estimateTokens(block.text);
        }
      }
    }
  }

  return total;
}
