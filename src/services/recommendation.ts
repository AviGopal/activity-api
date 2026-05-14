/**
 * State-Space-Aware Recommendation Helpers (Phase 11)
 *
 * Pure functions for compatibility filtering and pointer/blocking-shape output.
 * buildPointerStateSpace is a stub pending G2 (vessel-session-handshake).
 */

import { logger } from '../utils/logger';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImpulseStateEntry {
  shape: string;
  summary?: string;
  pointer?: { type: string; [key: string]: unknown };
  loaded_at?: string;
}

export interface PointerStateEntry {
  shape: string;
  vessel_id: string;
  resolve_tier: 'deterministic' | 'pattern' | 'llm';
}

export interface PointerRecommendation {
  shape: string;
  pointer_hint?: { type: string; [key: string]: unknown };
  rationale: string;
  unlocks_template_ids: string[];
  expected_utility: number;
  resolve_via: { vessel_id: string; resolve_tier: 'deterministic' | 'pattern' | 'llm' };
}

export interface BlockingShape {
  shape: string;
  required_by_template_ids: string[];
  gap_type: 'resolvable' | 'escalatable' | 'scope_upgradeable' | 'budget_blocked' | 'capability_blocked';
  resolve_via?: { vessel_id: string; resolve_tier: 'deterministic' | 'pattern' | 'llm' };
  gap_severity: 'blocking' | 'optional';
}

// ---------------------------------------------------------------------------
// Environment-variable discount factors (configurable per deploy)
// ---------------------------------------------------------------------------

function getDiscount(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw !== undefined) {
    const parsed = parseFloat(raw);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  }
  return fallback;
}

const PARTIAL_COVERAGE_DISCOUNT  = () => getDiscount('RECOMMEND_PARTIAL_COVERAGE_DISCOUNT', 0.7);
const ESCALATABLE_DISCOUNT       = () => getDiscount('RECOMMEND_ESCALATABLE_DISCOUNT',       0.5);
const NO_COVERAGE_DISCOUNT       = () => getDiscount('RECOMMEND_NO_COVERAGE_DISCOUNT',       0.3);

// ---------------------------------------------------------------------------
// applyCompatibilityFilter
// ---------------------------------------------------------------------------

/**
 * Re-rank templates by multiplying their Thompson score by a compatibility
 * discount that reflects how many of their required input shapes are already
 * in the caller's impulse pool.
 *
 * - Does NOT mutate alpha/beta — only adds `_compatibility_score` for sorting.
 * - Returns templates unchanged when impulse_state_space is absent/empty.
 */
export function applyCompatibilityFilter<
  T extends { id?: string; input_shapes?: string[]; alpha?: number; beta?: number; [key: string]: unknown },
>(
  templates: T[],
  impulse_state_space: ImpulseStateEntry[] | undefined,
  pointer_state_space: PointerStateEntry[],
): (T & { _compatibility_score: number })[] {
  if (!impulse_state_space || impulse_state_space.length === 0) {
    return templates.map((t) => ({
      ...t,
      _compatibility_score: thompsonScore(t.alpha, t.beta),
    }));
  }

  const availableShapes = new Set(impulse_state_space.map((e) => e.shape));
  const resolvableShapes = new Set(pointer_state_space.map((e) => e.shape));

  const partialDiscount  = PARTIAL_COVERAGE_DISCOUNT();
  const escalatableDisc  = ESCALATABLE_DISCOUNT();
  const noCoverageDisc   = NO_COVERAGE_DISCOUNT();

  return templates
    .map((t) => {
      const base = thompsonScore(t.alpha, t.beta);
      const inputShapes: string[] = Array.isArray(t.input_shapes) ? t.input_shapes : [];

      if (inputShapes.length === 0) {
        // No declared inputs — fully covered
        return { ...t, _compatibility_score: base };
      }

      const missingShapes = inputShapes.filter((s) => !availableShapes.has(s));

      if (missingShapes.length === 0) {
        // All present — no discount
        return { ...t, _compatibility_score: base };
      }

      const allResolvable = missingShapes.every((s) => resolvableShapes.has(s));
      if (allResolvable) {
        return { ...t, _compatibility_score: base * partialDiscount };
      }

      // Some missing shapes are not in pointer_state_space.
      // G2-blocked: no shape-gap index to distinguish scope_upgradeable /
      // budget_blocked / capability_blocked — treat all as escalatable
      // (conservative default per spec).
      const someResolvable = missingShapes.some((s) => resolvableShapes.has(s));
      if (someResolvable) {
        // Mixed: partly resolvable, partly escalatable — use escalatable tier
        return { ...t, _compatibility_score: base * escalatableDisc };
      }

      // None in pointer_state_space — escalatable
      return { ...t, _compatibility_score: base * escalatableDisc };
    })
    .sort((a, b) => b._compatibility_score - a._compatibility_score);
}

// ---------------------------------------------------------------------------
// generatePointerRecommendations
// ---------------------------------------------------------------------------

/**
 * Identify which shapes from pointer_state_space are worth fetching next,
 * ranked by how many top-20 templates they would unlock.
 *
 * Returns at most 5 entries sorted by expected_utility DESC.
 * Returns [] when pointer_state_space is empty.
 */
export function generatePointerRecommendations(
  pointer_state_space: PointerStateEntry[],
  impulse_state_space: ImpulseStateEntry[],
  top20Templates: Array<{ id?: string; template_id?: string; input_shapes?: string[]; alpha?: number; beta?: number; template_name?: string; name?: string }>,
): PointerRecommendation[] {
  if (pointer_state_space.length === 0) return [];

  const alreadyLoaded = new Set((impulse_state_space || []).map((e) => e.shape));

  // Collapse duplicate shapes in pointer_state_space: prefer deterministic > pattern > llm
  const tierRank: Record<string, number> = { deterministic: 0, pattern: 1, llm: 2 };
  const bestByShape = new Map<string, PointerStateEntry>();
  for (const entry of pointer_state_space) {
    const existing = bestByShape.get(entry.shape);
    if (!existing || tierRank[entry.resolve_tier] < tierRank[existing.resolve_tier]) {
      bestByShape.set(entry.shape, entry);
    }
  }

  const candidates: PointerRecommendation[] = [];

  for (const [shape, pse] of bestByShape.entries()) {
    if (alreadyLoaded.has(shape)) continue;

    // Find templates unlocked by this shape
    const unlocking = top20Templates.filter((t) =>
      Array.isArray(t.input_shapes) && t.input_shapes.includes(shape)
    );

    if (unlocking.length === 0) continue;

    const templateIds = unlocking.map((t) =>
      (t.template_id ?? t.id ?? '') as string
    ).filter(Boolean);

    const rawUtility = unlocking.reduce(
      (sum, t) => sum + thompsonScore(t.alpha, t.beta),
      0
    );

    // Best by Thompson score
    const best = unlocking.slice().sort(
      (a, b) => thompsonScore(b.alpha, b.beta) - thompsonScore(a.alpha, a.beta)
    )[0];
    const bestName = (best?.template_name ?? best?.name ?? best?.template_id ?? best?.id ?? 'unknown') as string;

    candidates.push({
      shape,
      rationale: `unlocks ${unlocking.length} template(s) in top-20; highest-ranked: ${bestName}`,
      unlocks_template_ids: templateIds,
      expected_utility: rawUtility, // normalised below
      resolve_via: { vessel_id: pse.vessel_id, resolve_tier: pse.resolve_tier },
    });
  }

  // Normalise expected_utility to 0-1 range
  if (candidates.length > 0) {
    const maxUtility = Math.max(...candidates.map((c) => c.expected_utility));
    if (maxUtility > 0) {
      for (const c of candidates) {
        c.expected_utility = c.expected_utility / maxUtility;
      }
    }
  }

  // Sort DESC, return top 5
  candidates.sort((a, b) => b.expected_utility - a.expected_utility);
  return candidates.slice(0, 5);
}

// ---------------------------------------------------------------------------
// identifyBlockingShapes
// ---------------------------------------------------------------------------

/**
 * For each of the top-5 templates, find input shapes not yet in the
 * caller's impulse pool. Returns deduplicated blocking-shape entries.
 */
export function identifyBlockingShapes(
  top5Templates: Array<{ id?: string; template_id?: string; input_shapes?: string[] }>,
  impulse_state_space: ImpulseStateEntry[],
  pointer_state_space: PointerStateEntry[],
): BlockingShape[] {
  const availableShapes = new Set((impulse_state_space || []).map((e) => e.shape));
  const resolvableShapes = new Set(pointer_state_space.map((e) => e.shape));

  // shape → merged BlockingShape
  const byShape = new Map<string, BlockingShape>();

  for (const template of top5Templates) {
    const tid = (template.template_id ?? template.id ?? '') as string;
    const inputShapes: string[] = Array.isArray(template.input_shapes)
      ? template.input_shapes
      : [];

    for (const shape of inputShapes) {
      if (availableShapes.has(shape)) continue; // already present

      const gap_type: BlockingShape['gap_type'] = resolvableShapes.has(shape)
        ? 'resolvable'
        : 'escalatable'; // G2-blocked: conservative default

      if (byShape.has(shape)) {
        const existing = byShape.get(shape)!;
        if (tid && !existing.required_by_template_ids.includes(tid)) {
          existing.required_by_template_ids.push(tid);
        }
      } else {
        const entry: BlockingShape = {
          shape,
          required_by_template_ids: tid ? [tid] : [],
          gap_type,
          gap_severity: 'blocking',
        };
        // Attach resolution hint when resolvable
        if (gap_type === 'resolvable') {
          const pse = pointer_state_space.find((p) => p.shape === shape);
          if (pse) {
            entry.resolve_via = { vessel_id: pse.vessel_id, resolve_tier: pse.resolve_tier };
          }
        }
        byShape.set(shape, entry);
      }
    }
  }

  return Array.from(byShape.values());
}

// ---------------------------------------------------------------------------
// buildPointerStateSpace — discovery-vessel integration
// ---------------------------------------------------------------------------

/**
 * Queries discovery-vessel's /registry/shapes endpoint to enumerate all
 * registered shapes accessible to the given account IDs and wraps each as a
 * PointerStateEntry.
 *
 * When `accessible_account_ids` is non-empty, the org_ids query param is sent
 * to discovery-vessel so only org-scoped or system vessel shapes are returned.
 * System vessels (e.g., discovery-vessel itself) are always included.
 *
 * Degrades gracefully: on any network error or non-200 response, logs a
 * warning and returns [] so the recommendation call continues with the
 * "escalatable" discount for all missing shapes.
 */
export async function buildPointerStateSpace(
  accessible_account_ids: string[],
): Promise<PointerStateEntry[]> {
  const discoveryEndpoint = config.discovery.endpoint;
  const orgIdsParam = accessible_account_ids.length
    ? `?org_ids=${accessible_account_ids.map(encodeURIComponent).join(',')}`
    : '';
  const url = `${discoveryEndpoint}/registry/shapes${orgIdsParam}`;
  const start = Date.now();

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      logger.warn('buildPointerStateSpace: discovery-vessel returned non-200', {
        status: res.status,
        url,
        latency_ms: Date.now() - start,
      });
      return [];
    }

    const body = (await res.json()) as { shapes?: string[] };
    const shapes = Array.isArray(body?.shapes) ? body.shapes : [];

    logger.debug('buildPointerStateSpace: registry shapes fetched', {
      shape_count: shapes.length,
      latency_ms: Date.now() - start,
    });

    // Map shape names to PointerStateEntries. vessel_id is "discovered"
    // until discovery-vessel exposes per-shape vessel attribution.
    return shapes.map((shape) => ({
      shape,
      vessel_id: 'discovered',
      resolve_tier: 'deterministic' as const,
    }));
  } catch (err) {
    logger.warn('buildPointerStateSpace: discovery-vessel unreachable, degrading to []', {
      url,
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function thompsonScore(alpha?: number, beta?: number): number {
  const a = alpha ?? 1;
  const b = beta ?? 1;
  if (a === 0 && b === 0) return 0.5;
  return a / (a + b);
}
