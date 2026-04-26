/**
 * Provider-agnostic embedding service
 * Supports multiple embedding providers via configuration.
 *
 * Also exports LocalEmbeddingService: loads all-MiniLM-L6-v2 via onnxruntime-node
 * for local, zero-cost 384-dim dense embeddings used in hybrid BM25+dense search.
 */

import { logger } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

// Embedding provider interface
export interface EmbeddingProvider {
  name: string;
  generateEmbedding(text: string): Promise<number[]>;
  generateEmbeddings(texts: string[]): Promise<number[][]>;
  readonly dimension: number;
}

// Provider configuration
export interface EmbeddingConfig {
  provider: 'openai' | 'anthropic' | 'voyage' | 'cohere' | 'local';
  apiKey: string;
  model: string;
  dimension: number;
  baseUrl?: string;
}

// Get config from environment
export function getEmbeddingConfig(): EmbeddingConfig | null {
  const provider = process.env.EMBEDDING_PROVIDER;
  if (!provider) return null;

  const apiKey =
    process.env.EMBEDDING_API_KEY ||
    process.env[`${provider.toUpperCase()}_API_KEY`];

  if (!apiKey) {
    logger.warn('Embedding API key not configured', { provider });
    return null;
  }

  return {
    provider: provider as EmbeddingConfig['provider'],
    apiKey,
    model: process.env.EMBEDDING_MODEL || getDefaultModel(provider),
    dimension: parseInt(process.env.EMBEDDING_DIMENSION || '1536', 10),
    baseUrl: process.env.EMBEDDING_BASE_URL,
  };
}

function getDefaultModel(provider: string): string {
  switch (provider) {
    case 'openai':
      return 'text-embedding-3-small';
    case 'voyage':
      return 'voyage-code-2';
    case 'cohere':
      return 'embed-english-v3.0';
    default:
      return 'text-embedding-3-small';
  }
}

// OpenAI provider implementation
class OpenAIEmbeddingProvider implements EmbeddingProvider {
  name = 'openai';
  private apiKey: string;
  private model: string;
  readonly dimension: number;
  private baseUrl: string;

  constructor(config: EmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.dimension = config.dimension;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const embeddings = await this.generateEmbeddings([text]);
    return embeddings[0];
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        dimensions: this.dimension,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embedding error: ${error}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return data.data.map((item) => item.embedding);
  }
}

// Voyage provider implementation
class VoyageEmbeddingProvider implements EmbeddingProvider {
  name = 'voyage';
  private apiKey: string;
  private model: string;
  readonly dimension: number;

  constructor(config: EmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.dimension = config.dimension;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const embeddings = await this.generateEmbeddings([text]);
    return embeddings[0];
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Voyage embedding error: ${error}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return data.data.map((item) => item.embedding);
  }
}

// Cohere provider implementation
class CohereEmbeddingProvider implements EmbeddingProvider {
  name = 'cohere';
  private apiKey: string;
  private model: string;
  readonly dimension: number;

  constructor(config: EmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.dimension = config.dimension;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const embeddings = await this.generateEmbeddings([text]);
    return embeddings[0];
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.cohere.ai/v1/embed', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        texts,
        model: this.model,
        input_type: 'search_document',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Cohere embedding error: ${error}`);
    }

    const data = (await response.json()) as {
      embeddings: number[][];
    };
    return data.embeddings;
  }
}

// Factory function
export function createEmbeddingProvider(
  config: EmbeddingConfig
): EmbeddingProvider {
  switch (config.provider) {
    case 'openai':
      return new OpenAIEmbeddingProvider(config);
    case 'voyage':
      return new VoyageEmbeddingProvider(config);
    case 'cohere':
      return new CohereEmbeddingProvider(config);
    default:
      throw new Error(`Unsupported embedding provider: ${config.provider}`);
  }
}

// Singleton instance
let embeddingProvider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider | null {
  if (embeddingProvider) return embeddingProvider;

  const config = getEmbeddingConfig();
  if (!config) return null;

  embeddingProvider = createEmbeddingProvider(config);
  logger.info('Embedding provider initialized', {
    provider: config.provider,
    model: config.model,
    dimension: config.dimension,
  });

  return embeddingProvider;
}

// Helper to embed activity
export async function embedActivity(
  name: string,
  description?: string
): Promise<number[] | null> {
  const provider = getEmbeddingProvider();
  if (!provider) return null;

  const text = description ? `${name}: ${description}` : name;

  try {
    return await provider.generateEmbedding(text);
  } catch (error) {
    logger.error('Failed to generate embedding', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// Helper to embed multiple activities in batch
export async function embedActivities(
  activities: Array<{ name: string; description?: string }>
): Promise<(number[] | null)[]> {
  const provider = getEmbeddingProvider();
  if (!provider) return activities.map(() => null);

  const texts = activities.map((a) =>
    a.description ? `${a.name}: ${a.description}` : a.name
  );

  try {
    const embeddings = await provider.generateEmbeddings(texts);
    return embeddings;
  } catch (error) {
    logger.error('Failed to generate batch embeddings', {
      error: error instanceof Error ? error.message : String(error),
      count: activities.length,
    });
    return activities.map(() => null);
  }
}

// =============================================================================
// LocalEmbeddingService — all-MiniLM-L6-v2 via onnxruntime-node
// =============================================================================
// Loads the ONNX model from disk (MODEL_DIR env var or /app/models/all-MiniLM-L6-v2).
// Init is async and non-blocking; callers should check isReady() before using.
// Produces L2-normalised 384-dim Float32Arrays. Cosine similarity reduces to dot
// product on normalised vectors.
// =============================================================================

const LOCAL_MODEL_DIR =
  process.env.EMBEDDING_MODEL_DIR ?? '/app/models/all-MiniLM-L6-v2';
const LOCAL_DIM = 384;
const MAX_SEQ_LEN = 128;

/**
 * Minimal WordPiece tokeniser for all-MiniLM-L6-v2.
 * Loads vocab.txt from MODEL_DIR, returns input_ids / attention_mask tensors.
 */
class WordPieceTokenizer {
  private vocab = new Map<string, number>();
  private unkId = 100;
  private clsId = 101;
  private sepId = 102;
  private padId = 0;

  load(vocabPath: string): void {
    const lines = fs.readFileSync(vocabPath, 'utf-8').split('\n');
    lines.forEach((token, idx) => {
      const t = token.trim();
      if (t) this.vocab.set(t, idx);
    });
    this.unkId = this.vocab.get('[UNK]') ?? 100;
    this.clsId = this.vocab.get('[CLS]') ?? 101;
    this.sepId = this.vocab.get('[SEP]') ?? 102;
    this.padId = this.vocab.get('[PAD]') ?? 0;
  }

  /**
   * Encode text to {input_ids, attention_mask, token_type_ids}.
   * Each array is Float32Array of length MAX_SEQ_LEN.
   */
  encode(text: string): {
    input_ids: BigInt64Array;
    attention_mask: BigInt64Array;
    token_type_ids: BigInt64Array;
  } {
    const tokens = this.tokenize(text);
    // [CLS] + tokens + [SEP], capped at MAX_SEQ_LEN
    const ids: number[] = [this.clsId];
    for (const tok of tokens) {
      if (ids.length >= MAX_SEQ_LEN - 1) break;
      ids.push(this.vocab.get(tok) ?? this.unkId);
    }
    ids.push(this.sepId);

    const seqLen = ids.length;
    const input_ids = new BigInt64Array(MAX_SEQ_LEN).fill(BigInt(this.padId));
    const attention_mask = new BigInt64Array(MAX_SEQ_LEN).fill(BigInt(0));
    const token_type_ids = new BigInt64Array(MAX_SEQ_LEN).fill(BigInt(0));

    for (let i = 0; i < seqLen; i++) {
      input_ids[i] = BigInt(ids[i]);
      attention_mask[i] = BigInt(1);
    }

    return { input_ids, attention_mask, token_type_ids };
  }

  private tokenize(text: string): string[] {
    // Basic whitespace + punctuation split → lowercase → WordPiece per word
    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' $& ')
      .split(/\s+/)
      .filter(Boolean);
    const result: string[] = [];
    for (const word of words) {
      result.push(...this.wordPiece(word));
    }
    return result;
  }

  private wordPiece(word: string): string[] {
    if (this.vocab.has(word)) return [word];
    // Try to split into subwords
    const chars = [...word];
    if (chars.length === 1) return [word];

    const tokens: string[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found = '';
      while (end > start) {
        const substr = chars.slice(start, end).join('');
        const candidate = start === 0 ? substr : `##${substr}`;
        if (this.vocab.has(candidate)) {
          found = candidate;
          break;
        }
        end--;
      }
      if (!found) {
        // Unknown character — emit [UNK] and advance
        tokens.push('[UNK]');
        start++;
      } else {
        tokens.push(found);
        start = end;
      }
    }
    return tokens;
  }
}

class LocalEmbeddingServiceImpl {
  private session: any | null = null; // ort.InferenceSession
  private tokenizer = new WordPieceTokenizer();
  private ready = false;
  private initError: string | null = null;

  isReady(): boolean {
    return this.ready;
  }

  getStatus(): { status: 'healthy' | 'loading' | 'disabled'; model: string; dim: number } {
    return {
      status: this.ready ? 'healthy' : (this.initError ? 'disabled' : 'loading'),
      model: 'all-MiniLM-L6-v2',
      dim: LOCAL_DIM,
    };
  }

  async init(): Promise<void> {
    const modelPath = path.join(LOCAL_MODEL_DIR, 'model.onnx');
    const vocabPath = path.join(LOCAL_MODEL_DIR, 'vocab.txt');

    if (!fs.existsSync(modelPath) || !fs.existsSync(vocabPath)) {
      this.initError = `Model files not found at ${LOCAL_MODEL_DIR}`;
      logger.warn('[LocalEmbedding] Model files missing — dense search disabled', {
        modelPath,
        vocabPath,
      });
      return;
    }

    try {
      // Dynamic import to avoid hard failure when onnxruntime-node is not installed
      const ort = await import('onnxruntime-node');
      this.session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      this.tokenizer.load(vocabPath);
      this.ready = true;
      logger.info('[LocalEmbedding] all-MiniLM-L6-v2 loaded', { dim: LOCAL_DIM, modelPath });
    } catch (err) {
      this.initError = err instanceof Error ? err.message : String(err);
      logger.error('[LocalEmbedding] Failed to load ONNX model', { error: this.initError });
    }
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.ready || !this.session) {
      throw new Error('LocalEmbeddingService not ready');
    }

    const ort = await import('onnxruntime-node');
    const { input_ids, attention_mask, token_type_ids } = this.tokenizer.encode(text);
    const shape = [1, MAX_SEQ_LEN];

    const feeds: Record<string, any> = {
      input_ids: new ort.Tensor('int64', input_ids, shape),
      attention_mask: new ort.Tensor('int64', attention_mask, shape),
      token_type_ids: new ort.Tensor('int64', token_type_ids, shape),
    };

    const output = await this.session.run(feeds);
    // last_hidden_state shape: [1, seq_len, 384]
    const hiddenState: Float32Array = output['last_hidden_state']?.data as Float32Array;
    if (!hiddenState) {
      throw new Error('Unexpected ONNX output — missing last_hidden_state');
    }

    // Mean-pool over token positions (ignoring padding via attention_mask)
    const vec = new Float32Array(LOCAL_DIM);
    let tokenCount = 0;
    for (let t = 0; t < MAX_SEQ_LEN; t++) {
      if (attention_mask[t] === BigInt(0)) continue;
      tokenCount++;
      for (let d = 0; d < LOCAL_DIM; d++) {
        vec[d] += hiddenState[t * LOCAL_DIM + d];
      }
    }
    if (tokenCount > 0) {
      for (let d = 0; d < LOCAL_DIM; d++) vec[d] /= tokenCount;
    }

    // L2 normalise
    let norm = 0;
    for (let d = 0; d < LOCAL_DIM; d++) norm += vec[d] * vec[d];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let d = 0; d < LOCAL_DIM; d++) vec[d] /= norm;
    }

    return vec;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

/** Singleton local embedding service (all-MiniLM-L6-v2 via ONNX Runtime) */
export const localEmbeddingService = new LocalEmbeddingServiceImpl();
