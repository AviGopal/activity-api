/**
 * Concept-conditioned Thompson prior (learning-rate mechanism 2).
 *
 * When a new (signature, template) cell is created, query concept-db for
 * dense-search neighbors of the (template_id, signature) key and compute a
 * weighted-mean Beta prior from neighbor relevance + loaded/succeeded counts.
 *
 * The new cell starts with effective κ "virtual trials" at the neighbor mean
 * rate, instead of Beta(1, 1). Empirical Bayes; cheapest of the 8 mechanisms.
 *
 * Citations: concept_uTVZPoaxMmo2 (mechanism), concept_TbN0eSf7U_hM (parent),
 * concept_W9CzngXfixvh (cold-start dominance evidence),
 * concept_YdzaAAQGx4xC (picker bug this mitigates).
 *
 * Fallback discipline: any error / timeout / empty response / disabled flag
 * returns Beta(1, 1) — the substrate never blocks on prior seeding.
 */

import { logger } from '../utils/logger';
import { computeEmbeddingConditionedPrior } from '../services/embedding-prior';

export interface SeededPrior {
  alpha0: number;
  beta0: number;
  source: 'concepts' | 'fallback' | 'embedding_model';
  neighbor_count?: number;
  model_version?: string;
}

const FALLBACK: SeededPrior = { alpha0: 1, beta0: 1, source: 'fallback' };

// Concept-db endpoint resolution (discovery-first; env override wins).
// Env-var endpoint gating is a defect class: vessel dependencies resolve via
// the discovery registry. An explicit env override wins when set; else
// resolve the vessel advertising shape "concept" via discovery (cached 60s);
// only when BOTH are unavailable return null — and warn, never silently.
let conceptDbUrlCache: { url: string | null; expiresAt: number } | null = null;
const CONCEPT_DB_URL_TTL_MS = 60_000;

export async function resolveConceptDbUrl(): Promise<string | null> {
  const override = process.env['CONCEPT_DB_URL'];
  if (override) return override;
  const now = Date.now();
  if (conceptDbUrlCache && conceptDbUrlCache.expiresAt > now) {
    return conceptDbUrlCache.url;
  }
  const { discoveryClient } = await import('../services/discovery-client');
  const { found, vessels } = await discoveryClient.discoverVesselsForShape('concept');
  const endpoint =
    found && vessels[0]?.endpoint ? vessels[0].endpoint.replace(/\/+$/, '') : null;
  if (!endpoint) {
    logger.warn('concept_db_unresolved', {
      event: 'concept_db_unresolved',
      reason: 'concept-db endpoint override unset and discovery returned no vessel for shape concept; prior seeding disabled until one resolves',
    });
  }
  conceptDbUrlCache = { url: endpoint, expiresAt: now + CONCEPT_DB_URL_TTL_MS };
  return endpoint;
}

interface ConceptHit {
  id?: string;
  relevance?: number;
  loaded_count?: number;
  succeeded_count?: number;
}

export async function seedPriorFromConcepts(
  templateId: string,
  signature: string | null,
  orgId: string,
  embedding?: number[],
): Promise<SeededPrior> {
  if (process.env.PRIOR_SEED_ENABLED === 'false') return FALLBACK;

  // M1 integration hook (concept_vugylIHzIMvk): when EMBEDDING_PRIOR_ENABLED
  // is true and a per-cell embedding is provided, route through the
  // embedding-conditioned θ-scored prior INSTEAD OF the concept-db neighbor
  // query. Falls through to the concept-db path on fallback so callers
  // never lose prior seeding.
  if (process.env.EMBEDDING_PRIOR_ENABLED === 'true' && Array.isArray(embedding) && embedding.length > 0) {
    const m1 = await computeEmbeddingConditionedPrior(embedding, orgId);
    if (m1.source === 'embedding_model') {
      return { alpha0: m1.α0, beta0: m1.β0, source: 'embedding_model', model_version: m1.model_version };
    }
    // else: fall through to concept-db path
  }

  const url = await resolveConceptDbUrl();
  if (!url) return FALLBACK;

  const K = parseInt(process.env.PRIOR_SEED_K ?? '5', 10);
  const kappa = parseFloat(process.env.PRIOR_SEED_KAPPA ?? '10');
  const timeoutMs = parseInt(process.env.PRIOR_SEED_TIMEOUT_MS ?? '2500', 10);

  const query = signature ? `${templateId} ${signature}` : templateId;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${url}/concepts/search?query=${encodeURIComponent(query)}&limit=${K}`,
      {
        signal: ctrl.signal,
        headers: {
          'X-Org-Id': orgId,
          ...(process.env.METABOB_API_KEY ? { Authorization: `ApiKey ${process.env.METABOB_API_KEY}` } : {}),
        },
      },
    );
    clearTimeout(t);
    if (!res.ok) return FALLBACK;
    const body = (await res.json()) as { concepts?: ConceptHit[] };
    const concepts = Array.isArray(body?.concepts) ? body.concepts : [];
    if (concepts.length === 0) return FALLBACK;

    let weightedAlpha = 0;
    let weightedBeta = 0;
    let totalWeight = 0;
    for (const c of concepts) {
      const r = typeof c.relevance === 'number' ? c.relevance : 0;
      if (r <= 0) continue;
      const loaded = typeof c.loaded_count === 'number' ? c.loaded_count : 0;
      const succeeded = typeof c.succeeded_count === 'number' ? c.succeeded_count : 0;
      // Treat the concept's accumulated empirical evidence as a Beta(a_i, b_i).
      // a_i = succeeded; b_i = max(0, loaded - succeeded). Use relevance as the
      // similarity weight; degenerate concepts (loaded=0) fall back to r itself.
      const a_i = loaded > 0 ? succeeded : r;
      const b_i = loaded > 0 ? Math.max(0, loaded - succeeded) : (1 - r);
      weightedAlpha += r * a_i;
      weightedBeta += r * b_i;
      totalWeight += r;
    }
    if (totalWeight <= 0) return FALLBACK;

    const meanAlpha = weightedAlpha / totalWeight;
    const meanBeta = weightedBeta / totalWeight;
    const sum = meanAlpha + meanBeta;
    if (sum <= 0 || !Number.isFinite(sum)) return FALLBACK;

    // Scale to κ virtual trials at the neighbor mean rate.
    const alpha0 = kappa * (meanAlpha / sum);
    const beta0 = kappa * (meanBeta / sum);
    if (!Number.isFinite(alpha0) || !Number.isFinite(beta0)) return FALLBACK;

    const result: SeededPrior = {
      alpha0,
      beta0,
      source: 'concepts',
      neighbor_count: concepts.length,
    };
    logger.debug('prior_seed_applied', {
      event: 'prior_seed_applied',
      template_id: templateId,
      signature,
      org_id: orgId,
      ...result,
    });
    return result;
  } catch (err) {
    clearTimeout(t);
    logger.debug('prior_seed_applied', {
      event: 'prior_seed_applied',
      template_id: templateId,
      signature,
      org_id: orgId,
      source: 'fallback',
      reason: err instanceof Error ? err.message : String(err),
    });
    return FALLBACK;
  }
}
