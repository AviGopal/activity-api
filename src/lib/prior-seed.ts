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

export interface SeededPrior {
  alpha0: number;
  beta0: number;
  source: 'concepts' | 'fallback';
  neighbor_count?: number;
}

const FALLBACK: SeededPrior = { alpha0: 1, beta0: 1, source: 'fallback' };

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
): Promise<SeededPrior> {
  if (process.env.PRIOR_SEED_ENABLED === 'false') return FALLBACK;

  const url = process.env.CONCEPT_DB_URL;
  if (!url) return FALLBACK;

  const K = parseInt(process.env.PRIOR_SEED_K ?? '5', 10);
  const kappa = parseFloat(process.env.PRIOR_SEED_KAPPA ?? '10');
  const timeoutMs = parseInt(process.env.PRIOR_SEED_TIMEOUT_MS ?? '500', 10);

  const query = signature ? `${templateId} ${signature}` : templateId;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${url}/concepts/search?query=${encodeURIComponent(query)}&limit=${K}`,
      {
        signal: ctrl.signal,
        headers: { 'X-Org-Id': orgId },
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
