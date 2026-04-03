/**
 * Provider-agnostic embedding service
 * Supports multiple embedding providers via configuration
 */

import { logger } from '../utils/logger';

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
