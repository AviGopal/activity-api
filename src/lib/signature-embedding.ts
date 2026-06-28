/**
 * signature-embedding — dense (MiniLM, 384-dim) embedding of state-space
 * signatures, via concept-db's embedder.
 *
 * Spec: openspec/changes/2026-06-04-learning-rate-8-hierarchical-signature-clustering/
 *       (task D2.1).
 *
 * IMPORTANT — what gets embedded:
 *   A state-space "signature" (the `context_bucket` in `context_thompson_scores`)
 *   is a HASH (e.g. "c13d16a3"), produced by computeStateSpaceSignature() from a
 *   sorted set of impulse shapes. Embedding the hash string itself is useless —
 *   hashes carry no semantic similarity. The callers of this module (the backfill
 *   job + the posterior-update hook) resolve each signature back to its SEMANTIC
 *   content — the sorted, comma-joined impulse-shape set — and pass THAT text
 *   here. This module is shape-agnostic: it embeds whatever text it is given.
 *
 * Transport: concept-db exposes its MiniLM embedder through the impulse contract
 * (NOT a bespoke /v1/embed route — that returns 404). Contract, verified live:
 *   POST {CONCEPT_DB_EMBED_ENDPOINT}
 *   body:  {"impulse":{"type":"embed","pointer":{"type":"embed","texts":[...]}}}
 *   resp:  {"content":[{"text":"...","embedding":[<384 floats>]}, ...],
 *           "metadata":{"shape":"embed","count":N,"dim":384}}
 *
 * ADVISORY semantics: 500ms timeout, and on ANY error/timeout/shape-mismatch the
 * function returns an array of nulls (one per input). It never throws — clustering
 * is a best-effort enhancement and must never block trace ingestion.
 */

import { logger } from '../utils/logger';

const CONCEPT_DB_EMBED_ENDPOINT =
  process.env.CONCEPT_DB_EMBED_ENDPOINT || 'http://localhost:8260/v2/impulses/resolve';

// Both call sites (backfill batch + posterior-update fire-and-forget hook) are
// background/non-blocking — nothing latency-sensitive waits on embedding — so a
// generous default is correct. A batch of 50 signatures through concept-db's
// MiniLM ONNX measures ~1.6s; 500ms (the original per-request assumption) can
// never succeed for batches. 5s gives ~3x margin plus cold-model warmup.
const EMBED_TIMEOUT_MS = parseInt(process.env.CONCEPT_DB_EMBED_TIMEOUT_MS ?? '5000', 10);

const EMBEDDING_DIM = 384;

interface EmbedResponseEntry {
  text?: string;
  embedding?: number[];
}

interface EmbedResponse {
  content?: EmbedResponseEntry[];
  metadata?: { shape?: string; count?: number; dim?: number };
}

/**
 * Embed a batch of texts via concept-db's MiniLM embedder.
 *
 * Returns one entry per input text, positionally aligned. Each entry is either a
 * 384-dim number[] or `null` (on failure for that text, or for the whole batch
 * on transport/timeout error). Never throws.
 */
export async function embedSignatures(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];

  try {
    const response = await fetch(CONCEPT_DB_EMBED_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impulse: { type: 'embed', pointer: { type: 'embed', texts } },
      }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn('signature-embedding: concept-db embed call non-2xx (advisory, returning nulls)', {
        status: response.status,
        endpoint: CONCEPT_DB_EMBED_ENDPOINT,
        count: texts.length,
      });
      return texts.map(() => null);
    }

    const body = (await response.json()) as EmbedResponse;
    const entries = body?.content;

    if (!Array.isArray(entries) || entries.length !== texts.length) {
      logger.warn('signature-embedding: concept-db embed response shape mismatch (advisory, returning nulls)', {
        endpoint: CONCEPT_DB_EMBED_ENDPOINT,
        expected: texts.length,
        received: Array.isArray(entries) ? entries.length : 'non-array',
      });
      return texts.map(() => null);
    }

    return entries.map((entry) => {
      const emb = entry?.embedding;
      if (Array.isArray(emb) && emb.length === EMBEDDING_DIM && emb.every((v) => typeof v === 'number')) {
        return emb;
      }
      return null;
    });
  } catch (err) {
    // Timeout (AbortError) or transport failure — advisory, never throw.
    logger.warn('signature-embedding: concept-db embed call failed (advisory, returning nulls)', {
      endpoint: CONCEPT_DB_EMBED_ENDPOINT,
      count: texts.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return texts.map(() => null);
  }
}

/**
 * Convenience single-text variant. Returns the 384-dim vector or null.
 */
export async function embedSignature(text: string): Promise<number[] | null> {
  const [result] = await embedSignatures([text]);
  return result ?? null;
}
