import { ParadigmActivity, queryActivitiesByDense, queryActivitiesByFTS, queryActivitiesByShapes } from "../db/paradigm";
import { logger } from "../utils/logger";
import { mergeByRRF } from "../utils/rrf";

export /**
 * Tiered fallback result type
 */
type TieredFallbackResult = {
  activities: ParadigmActivity[];
  tier: 'exact' | 'compatible' | 'fts' | 'fts_hybrid';
};

export /**
 * F25 — Filter activities whose declared input_shapes can be satisfied by the
 * caller's providedShapes pool. An activity matches if either:
 *   - it has no declared input_shapes (backwards-compatible default), OR
 *   - every element of input_shapes is present in providedShapes
 *
 * This mirrors the satisfiability check at lines 278-303 (discover-by-shapes)
 * which is used internally by slot-binding. The two recommendation paths now
 * apply the same discipline, closing the architectural asymmetry where
 * /recommend would route to templates the engine then rejected at pre-flight.
 *
 * Conservative semantics: callers fall through to the next tier when the
 * satisfiable-only filter would yield too few results, rather than failing
 * the request outright. This preserves operator-class goal coverage via FTS
 * fallback while still preferring dispatchable templates when available.
 */
function filterBySatisfiableInputShapes(
  activities: ParadigmActivity[],
  providedShapes: string[],
): ParadigmActivity[] {
  if (!activities || activities.length === 0) return activities;
  const providedSet = new Set(providedShapes);
  return activities.filter((a) => {
    const inputs =
      ((a as { input_shapes?: string[] }).input_shapes) ??
      ((a as { inputShapes?: string[] }).inputShapes) ??
      [];
    if (!inputs || inputs.length === 0) return true;
    return inputs.every((s: string) => providedSet.has(s));
  });
}

export /**
 * Tiered fallback for activity recommendations
 * Each tier progressively relaxes constraints to ensure results
 *
 * Tier 1: Exact match - shapes + category + tags
 * Tier 2: Compatible - shapes optional, category soft match
 *         (F25: now also applies input_shapes satisfiability filter)
 * Tier 3: FTS fallback - search by goal description
 *         (F25: also applies satisfiability filter to merged results)
 *
 * @param shapes - Available impulse shapes for filtering
 * @param category - Optional category filter
 * @param goalDescription - Goal description for FTS search fallback
 * @param orgId - Organization ID for multi-tenant filtering
 * @param executionType - Optional execution_type filter
 * @param limit - Maximum number of results to return
 * @param jwtToken - Optional JWT token for RBAC
 * @returns Activities with tier indicator
 */
async function getActivitiesWithTieredFallback(
  shapes: string[],
  category: string | null,
  goalDescription: string | null,
  orgId: string | null,
  executionType: 'template' | 'tool' | 'composition' | 'vessel_function' | null,
  limit: number,
  jwtToken: string | null
): Promise<TieredFallbackResult> {
  const minResults = Math.ceil(limit / 2);

  // Tier 1: Exact match - use shapes for strict filtering
  if (shapes && shapes.length > 0) {
    logger.debug('[tiered-fallback] Trying Tier 1: exact shape match', {
      shapes,
      category,
      executionType,
      limit,
      minResults,
    });

    const tier1Result = await queryActivitiesByShapes(
      shapes,
      orgId,
      category,
      executionType,
      limit * 3, // Fetch more to allow for filtering
      jwtToken
    );

    if (tier1Result.data && tier1Result.data.length >= minResults) {
      // 2026-05-01 relevance fix follow-up: Tier 1 exact-shape match
      // returns all shape-compatible templates, but its ordering is
      // ev DESC (10.10) which is query-independent. When goalDescription
      // is provided, blend FTS+dense hits to bring query-relevant
      // templates into the candidate pool. Without this, the implied-
      // shapes path from analyzeTaskSemantics always satisfies Tier 1,
      // FTS never fires, and Thompson Sampling on global α/β picks the
      // same global winner across all queries.
      if (goalDescription && goalDescription.trim().length > 0) {
        try {
          const [ftsBlend, denseBlend] = await Promise.all([
            queryActivitiesByFTS(goalDescription, orgId, executionType, limit * 3, jwtToken),
            queryActivitiesByDense(goalDescription, orgId, executionType, limit * 3, jwtToken),
          ]);
          const ftsRows = ftsBlend.data ?? [];
          const blended: ParadigmActivity[] = denseBlend.length > 0
            ? mergeByRRF(ftsRows as ParadigmActivity[], denseBlend as ParadigmActivity[])
            : (ftsRows as ParadigmActivity[]);
          if (blended.length > 0) {
            const seen = new Set<string>();
            const ordered: ParadigmActivity[] = [];
            for (const r of blended) {
              const id = String((r as any).id);
              if (!seen.has(id)) { seen.add(id); ordered.push(r); }
            }
            for (const r of tier1Result.data as ParadigmActivity[]) {
              const id = String((r as any).id);
              if (!seen.has(id)) { seen.add(id); ordered.push(r); }
            }
            // 2026-06-23 shape-feasibility fix: the blended FTS/dense hits
            // are prepended without passing through the satisfiability
            // filter, so text-relevant-but-shape-infeasible activities
            // dominate the top even when real shapes are provided. Apply
            // the same filter Tier 1 used against the same `shapes`. Only
            // adopt the filtered list if it still meets minResults; else
            // fall back to the unfiltered `ordered` (never underfill —
            // matches the file's existing tier-fallthrough philosophy).
            const feasible = filterBySatisfiableInputShapes(ordered, shapes);
            const chosen = feasible.length >= minResults ? feasible : ordered;
            logger.info('[tiered-fallback] Tier 1 (exact) + Tier 3 (FTS+dense) blended', {
              tier1Count: tier1Result.data.length,
              ftsCount: ftsRows.length,
              denseCount: denseBlend.length,
              blendedTotal: ordered.length,
              feasibleCount: feasible.length,
              chosenCount: chosen.length,
            });
            // Tier 1 exact-shape supplied the base set; label the path
            // 'exact' rather than 'fts_hybrid'/'fts' so observers/learners
            // see the true selection path.
            return { activities: chosen, tier: 'exact' };
          }
        } catch (blendErr) {
          logger.warn('[tiered-fallback] Tier 3 blend failed; falling through to Tier 1 only', {
            error: blendErr instanceof Error ? blendErr.message : String(blendErr),
          });
        }
      }

      logger.info('[tiered-fallback] Tier 1 (exact) succeeded', {
        resultCount: tier1Result.data.length,
        path: tier1Result.path,
        latency_ms: tier1Result.latency_ms,
      });

      return {
        activities: tier1Result.data,
        tier: 'exact',
      };
    }

    logger.debug('[tiered-fallback] Tier 1 insufficient results, trying Tier 2', {
      tier1Count: tier1Result.data?.length || 0,
      minResults,
    });
  }

  // 2026-05-01 relevance fix: when no shape filter is available AND a
  // non-trivial goalDescription is present, promote Tier 3 FTS+dense ahead
  // of Tier 2. Otherwise Tier 2 returns the entire catalog (ev DESC
  // ordered, but query-independent) and Tier 3 never fires, so every
  // query collapses to whichever template Thompson Sampling happens to
  // favour globally. The ev DESC prefilter from 10.10 helps but doesn't
  // fix relevance — the query content has to feed candidate selection,
  // not just ranking.
  // 2026-05-01 expansion: try Tier 3 ahead of Tier 2 whenever a query
  // is present, regardless of whether shapes were provided. Tier 1
  // (when shapes given) blends FTS in earlier; this branch handles the
  // Tier-1-underfill-and-fall-through case where shapes are non-empty
  // but didn't yield minResults — Tier 2 would then drown query relevance.
  const hasQuery = !!goalDescription && goalDescription.trim().length > 0;
  if (hasQuery) {
    logger.debug('[tiered-fallback] No shape filter + query present; trying Tier 3 (FTS+dense) before Tier 2', {
      goalDescription: goalDescription!.substring(0, 50),
      limit,
      minResults,
    });
    const [ftsFirst, denseFirst] = await Promise.all([
      queryActivitiesByFTS(goalDescription!, orgId, executionType, limit * 3, jwtToken),
      queryActivitiesByDense(goalDescription!, orgId, executionType, limit * 3, jwtToken),
    ]);
    const ftsRows = ftsFirst.data ?? [];
    if (denseFirst.length > 0) {
      const merged = mergeByRRF(ftsRows as ParadigmActivity[], denseFirst as ParadigmActivity[]);
      if (merged.length >= minResults) {
        logger.info('[tiered-fallback] Tier 3 (FTS+dense, query-first) succeeded', {
          ftsCount: ftsRows.length,
          denseCount: denseFirst.length,
          mergedCount: merged.length,
        });
        return { activities: merged, tier: 'fts_hybrid' };
      }
    }
    if (ftsRows.length >= minResults) {
      logger.info('[tiered-fallback] Tier 3 (FTS, query-first) succeeded', {
        resultCount: ftsRows.length,
        topScore: (ftsRows[0] as any)?.fts_score,
      });
      return { activities: ftsRows, tier: 'fts' };
    }
    logger.debug('[tiered-fallback] Tier 3 query-first insufficient; falling through to Tier 2', {
      ftsCount: ftsRows.length,
      denseCount: denseFirst.length,
      minResults,
    });
  }

  // Tier 2: Compatible - query without shape filter (relax constraints)
  logger.debug('[tiered-fallback] Trying Tier 2: compatible (no shape filter)', {
    category,
    executionType,
    limit,
    minResults,
  });

  const tier2Result = await queryActivitiesByShapes(
    [], // No shape filter - accept all activities
    orgId,
    category,
    executionType,
    limit * 3,
    jwtToken
  );

  // F25: prefer satisfiable templates so the recommender doesn't return
  // candidates the engine will reject at pre-flight. If filtering yields
  // enough candidates, return only those; otherwise fall through to FTS.
  const tier2Satisfiable = filterBySatisfiableInputShapes(
    tier2Result.data ?? [],
    shapes ?? [],
  );

  if (tier2Satisfiable && tier2Satisfiable.length >= minResults) {
    logger.info('[tiered-fallback] Tier 2 (compatible, F25 satisfiable-input filter) succeeded', {
      originalCount: tier2Result.data?.length ?? 0,
      satisfiableCount: tier2Satisfiable.length,
      providedShapes: shapes ?? [],
      path: tier2Result.path,
      latency_ms: tier2Result.latency_ms,
    });

    return {
      activities: tier2Satisfiable,
      tier: 'compatible',
    };
  }

  // F25 follow-up: if satisfiable filtering produced too few but raw Tier 2
  // produced enough AND the caller provided no shapes (operator goal with no
  // pre-seeded impulses), accept the broader result rather than failing — the
  // engine pre-flight will still reject unsatisfiable templates, but at least
  // the recommender returns candidates whose semantic match was strongest.
  // This preserves backwards-compatible behavior while logging that the
  // operator-facing dispatch may still hit F25 manifestations.
  if (tier2Result.data && tier2Result.data.length >= minResults && (!shapes || shapes.length === 0)) {
    logger.warn('[tiered-fallback] Tier 2 (compatible) returning unsatisfiable-eligible result — caller provided no shapes; engine may pre-flight reject', {
      resultCount: tier2Result.data.length,
      satisfiableCount: tier2Satisfiable?.length ?? 0,
      path: tier2Result.path,
      latency_ms: tier2Result.latency_ms,
    });

    return {
      activities: tier2Result.data,
      tier: 'compatible',
    };
  }

  logger.debug('[tiered-fallback] Tier 2 insufficient results, trying Tier 3 FTS', {
    tier2Count: tier2Result.data?.length || 0,
    minResults,
    goalDescription: goalDescription?.substring(0, 50),
  });

  // Tier 3: Hybrid FTS + dense fallback — search by goal description
  if (goalDescription && goalDescription.trim()) {
    const [tier3Result, denseResults] = await Promise.all([
      queryActivitiesByFTS(goalDescription, orgId, executionType, limit * 3, jwtToken),
      queryActivitiesByDense(goalDescription, orgId, executionType, limit * 3, jwtToken),
    ]);

    const ftsData = tier3Result.data ?? [];

    if (denseResults.length > 0) {
      const merged = mergeByRRF(ftsData as ParadigmActivity[], denseResults as ParadigmActivity[]);
      // F25: prefer satisfiable templates in merged FTS+dense candidates.
      // When caller provided shapes, keep only templates whose inputs can be
      // satisfied; otherwise return the merged list with a logged caveat.
      const mergedSatisfiable = filterBySatisfiableInputShapes(merged, shapes ?? []);
      const chosen =
        shapes && shapes.length > 0 && mergedSatisfiable.length > 0
          ? mergedSatisfiable
          : merged;
      logger.info('[tiered-fallback] Tier 3 (FTS+dense hybrid, F25 satisfiable-input filter) succeeded', {
        ftsCount: ftsData.length,
        denseCount: denseResults.length,
        mergedCount: merged.length,
        satisfiableCount: mergedSatisfiable.length,
        appliedFilter: shapes && shapes.length > 0 && mergedSatisfiable.length > 0,
        searchQuery: goalDescription.substring(0, 50),
      });
      return {
        activities: chosen,
        tier: 'fts_hybrid',
      };
    }

    if (ftsData.length > 0) {
      // F25: same satisfiability preference at FTS-only path.
      const ftsSatisfiable = filterBySatisfiableInputShapes(
        ftsData as ParadigmActivity[],
        shapes ?? [],
      );
      const chosen =
        shapes && shapes.length > 0 && ftsSatisfiable.length > 0
          ? ftsSatisfiable
          : (ftsData as ParadigmActivity[]);
      logger.info('[tiered-fallback] Tier 3 (FTS, F25 satisfiable-input filter) succeeded', {
        resultCount: ftsData.length,
        satisfiableCount: ftsSatisfiable.length,
        appliedFilter: shapes && shapes.length > 0 && ftsSatisfiable.length > 0,
        searchQuery: goalDescription.substring(0, 50),
        topScore: ftsData[0]?.fts_score,
        latency_ms: tier3Result.latency_ms,
      });
      return {
        activities: chosen,
        tier: 'fts',
      };
    }
  }

  // If FTS returned nothing or no goalDescription, return whatever we got from Tier 2
  // This ensures we always return something if Tier 2 found any results
  if (tier2Result.data && tier2Result.data.length > 0) {
    logger.info('[tiered-fallback] Returning Tier 2 results after FTS miss', {
      resultCount: tier2Result.data.length,
    });

    return {
      activities: tier2Result.data,
      tier: 'compatible',
    };
  }

  // Last resort: return empty array with FTS tier indicator
  logger.warn('[tiered-fallback] All tiers exhausted, returning empty', {
    shapes,
    category,
    goalDescription: goalDescription?.substring(0, 50),
  });

  return {
    activities: [],
    tier: 'fts',
  };
}
