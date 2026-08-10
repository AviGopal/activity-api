/**
 * Goal Execution Paths Routes
 *
 * Implements goal-based path tracking and Thompson Sampling recommendations:
 * - POST /goal-paths - Record path execution
 * - GET /goal-paths - Query paths for a goal
 * - POST /goal-paths/recommend - Thompson Sampling recommendation
 * - GET /goal-paths/stats - Global statistics
 */

import { Hono } from 'hono';
import crypto from 'crypto';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import {
  PathRecordRequestSchema,
  PathQuerySchema,
  PathRecommendationRequestSchema,
  PathStatsResponseSchema,
  PathsResponseSchema,
  PathRecommendationResponseSchema,
  type GoalExecutionPath,
  type PathRecordRequest,
  type PathQuery,
  type PathRecommendationRequest,
  type RecommendedPath,
} from '../models/schemas';
import { applyOutcomeToPosteriors } from '../lib/posterior-update';

const app = new Hono();

/**
 * Accumulate (and deduplicate) the terminal output shapes produced by
 * executing the activities in `pathActivities`, in path order.
 *
 * Joins `activity` records via the supplied ids and unions their
 * `output_shapes` arrays. Used at write-time on `goal_execution_paths` to
 * populate the denormalised `endpoint_output_shapes` field (migration 092),
 * and at read-time as the fallback when the field is missing.
 *
 * Behaviour mirrors the previous in-line accumulation that lived inside
 * `predictEndpointState` — empty input returns `[]`, missing rows are
 * skipped, and duplicates are collapsed via Set.
 */
export async function accumulateEndpointShapes(
  pathActivities: string[]
): Promise<string[]> {
  if (pathActivities.length === 0) {
    return [];
  }

  try {
    const activitiesQuery = `
      SELECT id, output_shapes FROM activity
      WHERE id INSIDE $activity_ids
    `;

    const activitiesResult = await surrealDB.query(
      activitiesQuery,
      { activity_ids: pathActivities }
    );

    if (!activitiesResult || activitiesResult.length === 0) {
      return [];
    }

    // Flatten the result (SurrealDB returns nested arrays).
    const rawActivities = activitiesResult[0];
    const activities: Array<{ id: string; output_shapes: string[] }> = Array.isArray(rawActivities)
      ? rawActivities
      : [];

    const shapeSet = new Set<string>();
    const activityMap = new Map<string, { id: string; output_shapes: string[] }>(
      activities.map(a => [a.id, a])
    );

    for (const activityId of pathActivities) {
      const activity = activityMap.get(activityId);
      if (activity?.output_shapes) {
        activity.output_shapes.forEach((shape: string) => shapeSet.add(shape));
      }
    }

    return Array.from(shapeSet);
  } catch (error) {
    logger.warn('Failed to accumulate endpoint shapes', { error });
    return [];
  }
}

/**
 * Normalize goal text for consistent hashing
 */
function normalizeGoal(goal: string): string {
  return goal
    .toLowerCase()
    .trim()
    // CLASS HASH, NOT INSTANCE HASH. goal_hash keys goal_execution_paths — the surface Thompson
    // learns pathway reuse over — so this function decides what counts as "the same goal", and
    // therefore what the system is able to learn anything about at all.
    //
    // Gap-closing goals embed a unique gap id ("close substrate gap route-edit-5994fcfb:21"),
    // and the punctuation strip below leaves the hex intact because it is \w. So every instance
    // hashed to its own row. Measured 2026-08-06 over the live corpus:
    //
    //   78.6% of ALL paths executed exactly once (3,690 of 4,693)
    //   close-substrate-gap alone: 2,145 DISTINCT paths for 3,102 executions — 1.4 each
    //
    // A Beta posterior over a single observation IS its prior. So those paths carry no learning,
    // and the next instance of the same work arrives under a new hash and starts from scratch.
    // The machinery around it is fine: 47.3% of paths already compose 2-6 activities, and
    // excluding the two degenerate families, paths executed >=3 times reach 27.2% against 24.7%
    // for single-shot paths — reuse DOES pay. It is simply almost never possible, because the
    // key shatters the surface before the learner can see it.
    //
    // Eliding volatile identifiers collapses those instances onto one learnable class. That is
    // what makes first/last-mile pathway adaptation possible: reuse the body, walk the
    // difference. Deliberately conservative — a hex run must be >= 8 chars AND contain a digit,
    // so ordinary all-letter hex words ("deadbeef", "facade") are untouched. The ":21" suffix is
    // part of the identifier: eliding the hex alone still left route-edit-5994fcfb:21 and
    // route-edit-477438a2:16 in separate classes, which a test caught.
    //
    // Safe against replaying a known-bad pathway because /recommend already withholds paths with
    // >=3 executions and zero successes. Runs BEFORE the punctuation strip, which would otherwise
    // weld the id to its neighbours and destroy the \b boundaries this relies on.
    .replace(/\b[0-9a-f]{8,}(?::\d+)?\b/g, (m) => (/\d/.test(m) ? 'id' : m))
    .replace(/\b\d{10,}\b/g, 'n')
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, '_');   // Replace spaces with underscores
}

/**
 * Hash goal text to create goal_hash
 */
function hashGoal(goal: string): string {
  const normalized = normalizeGoal(goal);
  return crypto.createHash('md5').update(normalized).digest('hex').substring(0, 16);
}

/**
 * Hash path activities to create path_signature
 */
function hashPath(activities: string[]): string {
  const signature = activities.join('->');
  return crypto.createHash('md5').update(signature).digest('hex').substring(0, 16);
}

/**
 * Deterministic 32-bit PRNG (mulberry32). Given the same seed it yields the
 * same [0,1) stream, so a recommendation can be reproduced on a held-out
 * re-run. Only used when a per-request seed is supplied; otherwise the
 * handler passes Math.random and behaviour is byte-identical to before.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fold a per-request seed together with the goal_hash into a single 32-bit
 * PRNG seed (FNV-1a over the goal_hash, mixed with the seed) so identical
 * (seed, goal) pairs reproduce and different goals decorrelate.
 */
function seedForGoal(seed: number, goalHash: string): number {
  let h = (seed >>> 0) ^ 0x811c9dc5;
  for (let i = 0; i < goalHash.length; i++) {
    h = Math.imul(h ^ goalHash.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

/**
 * Sample from Beta distribution (Thompson Sampling)
 * Uses Wilson score interval approximation for speed
 */
function sampleBeta(alpha: number, beta: number, rng: () => number = Math.random): number {
  // For small sample sizes, use Wilson score
  if (alpha + beta < 10) {
    const n = alpha + beta - 2;
    const p = (alpha - 1) / n;
    const z = 1.96; // 95% confidence

    if (n === 0) return 0.5; // No data

    const wilson = (p + z*z/(2*n) - z * Math.sqrt((p*(1-p) + z*z/(4*n))/n)) / (1 + z*z/n);
    return Math.max(0, Math.min(1, wilson));
  }

  // For larger samples, use simple mean with small noise
  const mean = (alpha - 1) / (alpha + beta - 2);
  const noise = (rng() - 0.5) * 0.1; // +/- 5%
  return Math.max(0, Math.min(1, mean + noise));
}

/**
 * Calculate Wilson score confidence interval for success rate
 * Provides more accurate bounds than normal approximation for small samples
 */
function calculateConfidenceInterval(
  successCount: number,
  totalCount: number,
  confidenceLevel: number = 0.95
): { lower: number; upper: number; confidence_level: number } {
  if (totalCount === 0) {
    return { lower: 0, upper: 1, confidence_level: confidenceLevel };
  }

  const p = successCount / totalCount;
  // z-score for confidence level (1.96 for 95%, 2.576 for 99%)
  const z = confidenceLevel === 0.99 ? 2.576 : 1.96;

  const denominator = 1 + (z * z) / totalCount;
  const centerAdjustment = p + (z * z) / (2 * totalCount);
  const interval = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * totalCount)) / totalCount);

  const lower = Math.max(0, (centerAdjustment - interval) / denominator);
  const upper = Math.min(1, (centerAdjustment + interval) / denominator);

  return { lower, upper, confidence_level: confidenceLevel };
}

/**
 * Predict endpoint state after executing a path.
 *
 * Reads the denormalised `endpoint_output_shapes` (when supplied via
 * `precomputedShapes` — i.e. the path row already has it) and falls back to
 * on-the-fly accumulation via {@link accumulateEndpointShapes} for legacy
 * rows whose field was never backfilled.
 */
async function predictEndpointState(
  pathActivities: string[],
  goalText?: string,
  precomputedShapes?: string[] | null
): Promise<{
  expected_shapes: string[];
  missing_shapes?: string[];
  goal_completion?: number;
}> {
  try {
    if (pathActivities.length === 0 && (!precomputedShapes || precomputedShapes.length === 0)) {
      return { expected_shapes: [] };
    }

    // Prefer the denormalised field when present; otherwise accumulate live.
    const expected_shapes = precomputedShapes && precomputedShapes.length > 0
      ? Array.from(new Set(precomputedShapes))
      : await accumulateEndpointShapes(pathActivities);

    const shapeSet = new Set<string>(expected_shapes);

    // If goal text provided, infer expected shapes and compute completion
    if (goalText) {
      const inferredGoalShapes = inferShapesFromGoal(goalText);
      const missing_shapes = inferredGoalShapes.filter(s => !shapeSet.has(s));
      const goal_completion = inferredGoalShapes.length > 0
        ? (inferredGoalShapes.length - missing_shapes.length) / inferredGoalShapes.length
        : 1.0;

      return {
        expected_shapes,
        missing_shapes: missing_shapes.length > 0 ? missing_shapes : undefined,
        goal_completion,
      };
    }

    return { expected_shapes };
  } catch (error) {
    logger.warn('Failed to predict endpoint state', { error });
    return { expected_shapes: [] };
  }
}

/**
 * Infer expected shapes from goal text using keyword matching
 * Simple heuristic-based inference for common patterns
 */
function inferShapesFromGoal(goalText: string): string[] {
  const lower = goalText.toLowerCase();
  const shapes: string[] = [];

  // Common patterns
  if (lower.includes('test') || lower.includes('coverage')) {
    shapes.push('testResults', 'coverageReport');
  }
  if (lower.includes('commit') || lower.includes('git')) {
    shapes.push('gitCommit', 'gitDiff');
  }
  if (lower.includes('deploy') || lower.includes('production')) {
    shapes.push('deploymentStatus', 'healthCheck');
  }
  if (lower.includes('bug') || lower.includes('fix')) {
    shapes.push('patch', 'testResults');
  }
  if (lower.includes('feature') || lower.includes('implement')) {
    shapes.push('sourceCode', 'testResults');
  }
  if (lower.includes('refactor')) {
    shapes.push('sourceCode', 'gitDiff');
  }
  if (lower.includes('document') || lower.includes('readme')) {
    shapes.push('documentation', 'markdown');
  }
  if (lower.includes('analyze') || lower.includes('report')) {
    shapes.push('analysisReport', 'metrics');
  }

  return shapes.length > 0 ? shapes : ['sourceCode']; // Default fallback
}

/**
 * POST /goal-paths
 * Record execution of a goal-based path
 */
app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const validated = PathRecordRequestSchema.parse(body);

    const goalHash = hashGoal(validated.goal_text);
    const pathSignature = hashPath(validated.path_activities);

    // Denormalise terminal output shapes so shape-keyed lookup
    // (`WHERE endpoint_output_shapes CONTAINS $shape`) doesn't need the
    // join at read-time. Failure to accumulate is non-fatal: the helper
    // returns [] on error, the field is nullable, and the read-time
    // fallback in predictEndpointState recomputes for legacy rows.
    const endpointOutputShapes = validated.endpoint_output_shapes !== undefined
      ? validated.endpoint_output_shapes
      : await accumulateEndpointShapes(validated.path_activities);

    // Phase G2 — CC1 scope-narrowing validator (2026-04-28).
    // When the caller declares a parent path (sub-goal lineage), enforce
    // that this child's terminal output shapes are a SUBSET of the
    // parent's. Prevents sub-goal chains from producing shapes outside
    // their original scope. Documented in
    // sql/migrations/100-cc1-scope-narrowing-assert.surql §G2.
    //
    // Bypass conditions (preserve backward compat):
    //   - parent_path_signature absent (legacy caller path)
    //   - parent row not found (e.g. cross-org isolation; surface as 404
    //     so callers learn the parent ref is invalid)
    //   - parent has no endpoint_output_shapes (legacy row predating mig 092)
    //   - new path has no endpoint_output_shapes (nothing to constrain)
    if (validated.parent_path_signature) {
      const parentGoalHash: string = validated.parent_goal_hash ?? goalHash;
      try {
        const parentRows = await surrealDB.query<GoalExecutionPath[]>(
          `SELECT endpoint_output_shapes FROM goal_execution_paths
            WHERE goal_hash = $parent_goal_hash
              AND path_signature = $parent_path_signature
            LIMIT 1`,
          {
            parent_goal_hash: parentGoalHash,
            parent_path_signature: validated.parent_path_signature,
          }
        );
        const parentRow = Array.isArray(parentRows) && parentRows.length > 0 ? parentRows[0] : null;
        if (!parentRow) {
          return c.json({
            error: 'Parent path not found',
            message: `No goal_execution_paths row matches parent_goal_hash=${parentGoalHash}, parent_path_signature=${validated.parent_path_signature}`,
          }, 404);
        }
        const parentShapes = (parentRow as any).endpoint_output_shapes;
        // Only enforce the constraint when the parent has a declared scope.
        // IS NONE / empty array is treated as "unbounded" (legacy rows).
        if (Array.isArray(parentShapes) && parentShapes.length > 0 && endpointOutputShapes.length > 0) {
          const parentSet = new Set<string>(parentShapes);
          const violations = endpointOutputShapes.filter((s) => !parentSet.has(s));
          if (violations.length > 0) {
            logger.warn('CC1 scope-narrowing violation', {
              parent_path_signature: validated.parent_path_signature,
              parent_goal_hash: parentGoalHash,
              parent_shapes: parentShapes,
              child_shapes: endpointOutputShapes,
              violations,
            });
            return c.json({
              error: 'Scope-narrowing violation (CC1)',
              message: `Child path produces shapes [${violations.join(', ')}] not in parent's endpoint_output_shapes [${parentShapes.join(', ')}]. Sub-goals MUST narrow scope, never expand it.` as const,
              parent_path_signature: validated.parent_path_signature,
              parent_endpoint_output_shapes: parentShapes,
              child_endpoint_output_shapes: endpointOutputShapes,
              violations,
            }, 400);
          }
        }
      } catch (cc1Error) {
        // Surface query errors as 500 — silent skip would defeat the
        // hardening guarantee. Distinguish from "parent not found" 404.
        logger.error('CC1 scope-narrowing check failed', {
          error: cc1Error instanceof Error ? cc1Error.message : String(cc1Error),
          parent_path_signature: validated.parent_path_signature,
          parent_goal_hash: parentGoalHash,
        });
        return c.json({
          error: 'Scope-narrowing check failed',
          message: cc1Error instanceof Error ? cc1Error.message : String(cc1Error),
        }, 500);
      }
    }

    logger.info('Recording goal path', {
      goal: validated.goal_text,
      goal_hash: goalHash,
      path: validated.path_activities,
      success: validated.success,
      endpoint_output_shapes: endpointOutputShapes,
    });

    // Check if this goal+path combination exists
    const checkQuery = `
      SELECT * FROM goal_execution_paths
      WHERE goal_hash = $goal_hash
        AND path_signature = $path_signature
      LIMIT 1
    `;
    
    const existing = await surrealDB.query<GoalExecutionPath[]>(checkQuery, {
      goal_hash: goalHash,
      path_signature: pathSignature,
    });
    
    let path: GoalExecutionPath;
    
    if (existing && existing.length > 0 && existing[0]) {
      // Update existing path
      const current = existing[0];

      // Phase 10 P1: atomic increments. Earlier path read `current` and
      // computed newTotal/newSuccessful/newFailed/thompson_alpha/beta/
      // success_rate/avg_* in JS, then wrote them back — classic lost-
      // update race when two goal executions for the same (goal_hash,
      // path_signature) land concurrently. All counter and rolling-mean
      // expressions now compute against the row's pre-update state in a
      // single SQL statement, so the second UPDATE sees the first's
      // increments rather than overwriting them.
      const successDelta = validated.success ? 1 : 0;
      const failureDelta = validated.success ? 0 : 1;
      const tokenUsage = validated.token_usage !== undefined ? validated.token_usage : null;
      // success_rate below divides in FLOAT deliberately (the `* 1.0`). Both counters are
      // TYPE int (sql/003-goal-execution-paths.surql:40,44) and SurrealDB 2.3.3 divides
      // int/int as INTEGER division, so every partially-successful path stored
      // success_rate = 0. Verified on that engine version:
      //   RETURN (244 + 0) / (489 + 1)          => 0
      //   RETURN ((244 + 0) * 1.0) / (489 + 1)  => 0.49795918367346936
      // Measured before this fix across all 4632 rows: success_rate held only two distinct
      // values, 0 and 1. All 130 paths with 0 < successful_executions < total_executions
      // read 0, and those carried 544 of the store's 1370 successes (39.7%).
      // goal-host's reuse hook (index.ts:3381) tests this field for truthiness and the
      // ?? operator does not fall through on 0, so all 130 were unselectable: the MIDDLE
      // tier of the execution contract was switched off by an integer division. It is also
      // the ORDER BY key of the operator-facing list endpoints below, which therefore
      // ranked the best pathways in the store last.
      // Written as `* 1.0` rather than a cast so it stays correct however the operands
      // happen to be typed at runtime. NOTE: no SQL-level comment here on purpose — this
      // file's queries contain no `--` comments and that parse was not worth risking.
      // De-sequenced rate arithmetic. SurrealDB applies the SET clauses of one
      // UPDATE SEQUENTIALLY, so when the success_rate clause below was evaluated the
      // two counters it referenced had ALREADY been incremented by the clauses above
      // it: it stored ((S + delta) + delta) / ((T + 1) + 1) instead of the intended
      // (S + delta) / (T + 1) — numerator double-counted, denominator post-increment.
      // The counters, posteriors and rolling means stay atomic server-side; only the
      // DERIVED rate moves here, computed from the pre-update snapshot already read
      // into `current`, because no SET-clause form can reference pre-update state
      // once an earlier clause in the same statement has overwritten it.
      // `current` is `existing[0]` and `existing` is typed GoalExecutionPath[][] by
      // the query generic (surrealDB.query<T> returns T[]), so `current` is statically
      // an ARRAY even though at runtime it is the row — the same mismatch the
      // `@ts-ignore` further down already papers over.
      const currentRow = current as unknown as {
        successful_executions?: number;
        total_executions?: number;
      };
      const priorSuccessful = currentRow.successful_executions ?? 0;
      const priorTotal = currentRow.total_executions ?? 0;
      const nextSuccessRate = ((priorSuccessful + successDelta) * 1.0) / (priorTotal + 1);

      const updateQuery = `
        UPDATE goal_execution_paths
        SET
          total_executions = (total_executions ?? 0) + 1,
          execution_count = (execution_count ?? 0) + 1,
          successful_executions = (successful_executions ?? 0) + $success_delta,
          failed_executions = (failed_executions ?? 0) + $failure_delta,
          thompson_alpha = (thompson_alpha ?? 1) + $success_delta,
          thompson_beta = (thompson_beta ?? 1) + $failure_delta,
          last_inference_confidence = $inference_confidence ?? last_inference_confidence,
          success_rate = $success_rate,
          avg_duration_ms = (((avg_duration_ms ?? 0) * (total_executions ?? 0)) + $duration_ms) / ((total_executions ?? 0) + 1),
          avg_cost_usd = (((avg_cost_usd ?? 0) * (total_executions ?? 0)) + $cost_usd) / ((total_executions ?? 0) + 1),
          avg_token_usage = IF $token_usage IS NULL
            THEN (avg_token_usage ?? 0)
            ELSE math::floor((((avg_token_usage ?? 0) * (total_executions ?? 0)) + $token_usage) / ((total_executions ?? 0) + 1))
            END,
          endpoint_output_shapes = $endpoint_output_shapes,
          last_executed_at = time::now(),
          walk_tier = $walk_tier ?? walk_tier,
          expected_output_shapes = $expected_output_shapes ?? expected_output_shapes,
          updated_at = time::now()
        WHERE goal_hash = $goal_hash
          AND path_signature = $path_signature
        RETURN AFTER
      `;

      const updated = await surrealDB.query<GoalExecutionPath[]>(updateQuery, {
        goal_hash: goalHash,
        path_signature: pathSignature,
        success_delta: successDelta,
        failure_delta: failureDelta,
        success_rate: nextSuccessRate,
        duration_ms: validated.duration_ms,
        cost_usd: validated.cost_usd,
        token_usage: tokenUsage,
        inference_confidence: validated.inference_confidence ?? null,
        endpoint_output_shapes: endpointOutputShapes,
        expected_output_shapes: validated.expected_output_shapes ?? null,
        walk_tier: validated.walk_tier ?? 'fresh_derivation',
      });
      
      // @ts-ignore - SurrealDB query typing
      path = updated && updated.length > 0 ? updated[0] : current;

      logger.info('Updated goal path', {
        goal_hash: goalHash,
        // Counters/posteriors are now computed server-side; report what the
        // UPDATE returned so the log reflects the post-atomic state rather
        // than the JS-projected pre-state.
        total: (path as any)?.total_executions,
        success_rate: (path as any)?.success_rate,
        thompson_alpha: (path as any)?.thompson_alpha,
        thompson_beta: (path as any)?.thompson_beta,
      });
    } else {
      // Create new path
      const thompsonAlpha = validated.success ? 2.0 : 1.0;
      const thompsonBeta = validated.success ? 1.0 : 2.0;
      const successRate = validated.success ? 1.0 : 0.0;
      
      const createQuery = `
        CREATE goal_execution_paths CONTENT {
          goal_hash: $goal_hash,
          org_id: $org_id,
          goal_text: $goal_text,
          goal_category: $goal_category,
          path_activities: $path_activities,
          path_signature: $path_signature,
          endpoint_output_shapes: $endpoint_output_shapes,
          expected_output_shapes: $expected_output_shapes,
          total_executions: 1,
          execution_count: 1,
          success_count: $successful_executions,
          successful_executions: $successful_executions,
          failed_executions: $failed_executions,
          thompson_alpha: $thompson_alpha,
          thompson_beta: $thompson_beta,
          success_rate: $success_rate,
          avg_duration_ms: $avg_duration_ms,
          avg_cost_usd: $avg_cost_usd,
          avg_token_usage: $avg_token_usage,
          last_inference_confidence: $inference_confidence,
          typical_files_modified: $typical_files_modified,
          typical_tools_used: $typical_tools_used,
          last_executed_at: time::now(),
          walk_tier: $walk_tier,
          created_at: time::now(),
          updated_at: time::now()
        }
      `;

      const created = await surrealDB.query<GoalExecutionPath[]>(createQuery, {
        goal_hash: goalHash,
        org_id: (body as any).org_id ?? 'public',
        expected_output_shapes: validated.expected_output_shapes ?? null,
        goal_text: validated.goal_text,
        goal_category: validated.goal_category,
        path_activities: validated.path_activities,
        path_signature: pathSignature,
        endpoint_output_shapes: endpointOutputShapes,
        successful_executions: validated.success ? 1 : 0,
        failed_executions: validated.success ? 0 : 1,
        thompson_alpha: thompsonAlpha,
        thompson_beta: thompsonBeta,
        success_rate: successRate,
        avg_duration_ms: validated.duration_ms,
        avg_cost_usd: validated.cost_usd,
        avg_token_usage: validated.token_usage || 0,
        // last_inference_confidence is option<number> in the schema: passing
        // NULL fails the whole CREATE silently, so confidence-less senders
        // (goal-walk pathway records) were never recorded. Default to 0.
        inference_confidence: validated.inference_confidence ?? 0,
        typical_files_modified: validated.files_modified ?? undefined,
        typical_tools_used: validated.tools_used ?? undefined,
        walk_tier: validated.walk_tier ?? 'fresh_derivation',
      });
      
      // @ts-ignore - SurrealDB query typing
      path = created && created.length > 0 ? created[0] : {
        goal_hash: goalHash,
        goal_text: validated.goal_text,
        goal_category: validated.goal_category,
        path_activities: validated.path_activities,
        endpoint_output_shapes: endpointOutputShapes,
        path_signature: pathSignature,
        total_executions: 1,
        successful_executions: validated.success ? 1 : 0,
        failed_executions: validated.success ? 0 : 1,
        thompson_alpha: thompsonAlpha,
        thompson_beta: thompsonBeta,
        success_rate: successRate,
        avg_duration_ms: validated.duration_ms,
        avg_cost_usd: validated.cost_usd,
        avg_token_usage: validated.token_usage || 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      
      logger.info('Created new goal path', {
        goal_hash: goalHash,
        success_rate: successRate,
      });
    }

    // Credit the terminal activity in the path's variant_performance_metrics.
    applyOutcomeToPosteriors(
      {
        activity_id: validated.path_activities[validated.path_activities.length - 1],
        success: validated.success,
        failure_mode: null,
        cost_usd: validated.cost_usd,
        // Honest-reach floor: goal-host does not (yet) emit a reach verdict on this
        // body, so an exit-status completion is UNGRADED, not credit. Synthetic
        // goal-host tag => classifyReach => 'ungraded' => SKIP (learn nothing, never
        // mis-credit). Remove once goal-host emits reach tags on this path.
        tags: ['dispatcher_used:goal-host'],
      },
      surrealDB,
      (body as any).org_id ?? 'public',
    ).catch((err) => {
      logger.warn('[18.3.3] applyOutcomeToPosteriors failed (non-blocking, goal-paths)', {
        goal_hash: goalHash,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.json({
      success: true,
      path,
    });
    
  } catch (error: any) {
    logger.error('Failed to record goal path', {
      error: error.message,
      stack: error.stack,
    });
    
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }
    
    return c.json({
      error: 'Failed to record goal path',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /goal-paths
 * Query paths for a specific goal
 */
app.get('/', async (c) => {
  try {
    const query = c.req.query();
    const validated = PathQuerySchema.parse({
      goal_text: query.goal_text,
      goal_hash: query.goal_hash,
      goal_category: query.goal_category,
      min_executions: query.min_executions ? parseInt(query.min_executions) : undefined,
      limit: query.limit ? parseInt(query.limit) : undefined,
      offset: query.offset ? parseInt(query.offset) : undefined,
    });

    // Optional shape filter — parsed alongside the schema-validated fields so
    // we don't have to extend PathQuerySchema in models/schemas.ts. A single
    // shape only for now; multi-shape filtering can come later.
    const endpointOutputShape: string | undefined =
      typeof query.endpoint_output_shape === 'string' && query.endpoint_output_shape.length > 0
        ? query.endpoint_output_shape
        : undefined;

    let whereClause = '';
    const params: Record<string, any> = {
      limit: validated.limit,
      offset: validated.offset,
    };

    if (validated.goal_hash) {
      whereClause = 'WHERE goal_hash = $goal_hash';
      params.goal_hash = validated.goal_hash;
    } else if (validated.goal_text) {
      const goalHash = hashGoal(validated.goal_text);
      whereClause = 'WHERE goal_hash = $goal_hash';
      params.goal_hash = goalHash;
    } else if (validated.goal_category) {
      whereClause = 'WHERE goal_category = $goal_category';
      params.goal_category = validated.goal_category;
    }

    if (validated.min_executions > 1) {
      whereClause += whereClause ? ' AND ' : 'WHERE ';
      whereClause += 'total_executions >= $min_executions';
      params.min_executions = validated.min_executions;
    }

    if (endpointOutputShape) {
      whereClause += whereClause ? ' AND ' : 'WHERE ';
      whereClause += 'endpoint_output_shapes CONTAINS $endpoint_output_shape';
      params.endpoint_output_shape = endpointOutputShape;
    }
    
    const selectQuery = `
      SELECT * FROM goal_execution_paths
      ${whereClause}
      ORDER BY success_rate DESC, total_executions DESC
      LIMIT $limit
      START $offset
    `;
    
    const paths = await surrealDB.query<GoalExecutionPath[]>(selectQuery, params);
    
    const countQuery = `
      SELECT count() AS total FROM goal_execution_paths
      ${whereClause}
      GROUP ALL
    `;
    
    const countResult = await surrealDB.query<{ total: number }>(countQuery, params);
    const total = countResult && countResult.length > 0 ? countResult[0].total : 0;
    
    const response = PathsResponseSchema.parse({
      paths: paths || [],
      total,
    });
    
    return c.json(response);
    
  } catch (error: any) {
    logger.error('Failed to query goal paths', {
      error: error.message,
    });
    
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }
    
    return c.json({
      error: 'Failed to query goal paths',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /goal-paths/recommend
 * Thompson Sampling recommendation for a goal
 */
app.post('/recommend', async (c) => {
  try {
    const body = await c.req.json();
    const validated = PathRecommendationRequestSchema.parse(body);

    // Optional shape filter — applied as a hard constraint on the candidate
    // set BEFORE Thompson Sampling so we never recommend a path whose
    // terminal state can't produce the requested shape. Parsed alongside the
    // schema-validated body so we don't have to extend
    // PathRecommendationRequestSchema in models/schemas.ts.
    const endpointOutputShape: string | undefined =
      typeof body?.endpoint_output_shape === 'string' && body.endpoint_output_shape.length > 0
        ? body.endpoint_output_shape
        : undefined;

    // The walk's inferred target shapes, used ONLY as a fallback candidate arm
    // when exact goal-hash retrieval finds nothing reusable (see below).
    const targetShapes: string[] = Array.isArray(body?.target_shapes)
      ? (body.target_shapes as unknown[])
          .map((s) => String(s))
          .filter((s) => s.length > 0)
      : [];

    const goalHash = hashGoal(validated.goal_text);

    // Optional per-request seed for reproducible recommendations. When
    // provided, both the explore coin and the exploit Beta draws are taken
    // from a deterministic PRNG seeded from (seed, goal_hash), so an
    // identical goal + posteriors + seed reproduces the same selection on a
    // held-out re-run. When absent, we pass Math.random and behaviour is
    // byte-identical to before. Parsed off the raw body to avoid extending
    // PathRecommendationRequestSchema.
    const requestSeed: number | undefined =
      typeof body?.seed === 'number' && Number.isFinite(body.seed)
        ? body.seed
        : undefined;
    const rng: () => number =
      requestSeed !== undefined ? mulberry32(seedForGoal(requestSeed, goalHash)) : Math.random;

    logger.info('Recommending path for goal', {
      goal: validated.goal_text,
      goal_hash: goalHash,
      exploration_rate: validated.exploration_rate,
      endpoint_output_shape: endpointOutputShape,
    });

    // Get all paths for this goal
    let whereClause = 'WHERE goal_hash = $goal_hash';
    const params: Record<string, any> = { goal_hash: goalHash };

    if (validated.goal_category) {
      whereClause += ' AND goal_category = $goal_category';
      params.goal_category = validated.goal_category;
    }

    if (endpointOutputShape) {
      whereClause += ' AND endpoint_output_shapes CONTAINS $endpoint_output_shape';
      params.endpoint_output_shape = endpointOutputShape;
    }

    const selectQuery = `
      SELECT * FROM goal_execution_paths
      ${whereClause}
      ORDER BY total_executions DESC
    `;
    
    const allPaths = await surrealDB.query<GoalExecutionPath[]>(selectQuery, params);

    // PROVEN-FAILING PATHS ARE NOT REUSABLE PATHWAYS.
    //
    // Recommendation was per-goal_hash with no ABSOLUTE bar: Thompson picks the best of the
    // paths recorded for this goal, and when the only recorded path has never reached, Beta
    // sampling over a single arm returns it anyway. The walk then labels the replay
    // `learned_pathway` and re-runs a path that is known not to work.
    //
    // Measured 2026-08-05 over 4,494 recorded paths / 9,704 executions:
    //   learned_pathway  765 executions,  14 successes  —  1%
    //   fresh_derivation 1,194 executions, 417 successes — 34%
    // The tier that is supposed to be the CEILING was the floor by a factor of thirty, and
    // 3,727 executions (38% of all execution) went to 352 paths that have never once reached.
    // 630 of 2,265 distinct goals have no reaching path at all, so for those goals every
    // recommendation was a replay of failure.
    //
    // Deriving fresh is strictly better than replaying something proven not to reach, so a path
    // with enough observations to have reached and none is withheld. Returning NO recommendation
    // is the useful answer here — it sends the walk down the fresh-derivation path rather than
    // handing it a known-bad plan. "Reuse before mint" does not mean reuse what never worked.
    //
    // The bar is deliberately observation-gated, not a rate threshold: a path with one or two
    // failures may simply be new or unlucky, and is kept so exploration can still find it. Only
    // an explicit, repeated, zero-success record disqualifies.
    const PROVEN_FAILING_MIN_EXECUTIONS = 3;
    const isProvenFailing = (p: any): boolean => {
      const execs = (p as any).total_executions ?? 0;
      const succ = (p as any).successful_executions ?? null;
      // A MISSING success counter must never disqualify a path — only an observed zero does.
      return succ !== null && succ === 0 && execs >= PROVEN_FAILING_MIN_EXECUTIONS;
    };
    const paths = ((allPaths ?? []) as any[]).filter((p) => !isProvenFailing(p));
    for (const p of paths) p.__match_mode = 'goal_hash';
    const withheld = (allPaths?.length ?? 0) - paths.length;
    if (withheld > 0) {
      logger.info('Withheld proven-failing paths from recommendation', {
        goal_hash: goalHash,
        withheld,
        remaining: paths.length,
        min_executions: PROVEN_FAILING_MIN_EXECUTIONS,
      });
    }

    // NEARBY MATCH ON THE SHAPE SIGNATURE — the second candidate arm.
    //
    // Retrieval above is keyed on an exact hash of the goal text, so a reworded
    // or merely similar goal retrieves nothing and the walk re-derives a
    // composition the system already knows. Measured over the fully-paginated
    // 4,768-row corpus (2026-08-06): 1,017 of 1,304 fresh goal hashes (78%)
    // landed on a path_signature that ALREADY EXISTED under a different goal
    // hash. That is not learning compounding; it is the same composition being
    // rediscovered from scratch, and it is invisible as waste because each
    // re-derivation looks like a healthy fresh walk.
    //
    // So when the exact arm yields nothing reusable, fall back to candidates
    // whose recorded ENDPOINT OUTPUT SHAPES overlap the shapes this walk is
    // trying to produce, ranked by cover fraction |candidate ∩ target| / |target|.
    // Shapes are the routing key the whole system is built on, so two goals that
    // terminate in the same shapes are asking for the same thing in different
    // words — exactly the case the goal-hash key cannot see.
    //
    // This is deliberately a FALLBACK, not a merge: an exact goal-hash match is
    // stronger evidence than a shape overlap, so it is never displaced. And the
    // same proven-failing bar applies, because a nearby path that never reached
    // is no more reusable than an exact one that never reached.
    let shapeMatched = 0;
    if (paths.length === 0 && targetShapes.length > 0) {
      const shapeQuery = `
        SELECT * FROM goal_execution_paths
        WHERE endpoint_output_shapes CONTAINSANY $target_shapes
          AND goal_hash != $goal_hash
        ORDER BY total_executions DESC
        LIMIT 200
      `;
      const shapeRows = await surrealDB.query<GoalExecutionPath[]>(shapeQuery, {
        target_shapes: targetShapes,
        goal_hash: goalHash,
      });
      const targetSet = new Set(targetShapes);
      const scored = ((shapeRows ?? []) as any[])
        .filter((p) => !isProvenFailing(p))
        .map((p) => {
          const have: string[] = Array.isArray(p.endpoint_output_shapes) ? p.endpoint_output_shapes.map(String) : [];
          const covered = have.filter((s) => targetSet.has(s)).length;
          p.__shape_cover = targetSet.size > 0 ? covered / targetSet.size : 0;
          p.__match_mode = 'shape_signature';
          return p;
        })
        // A single incidental shape in common is not a nearby match. Require the
        // candidate to cover at least half of what the walk is trying to produce,
        // so first/last-mile adaptation has a real body to adapt rather than a
        // coincidence to chase.
        .filter((p) => p.__shape_cover >= 0.5)
        .sort((a, b) => (b.__shape_cover - a.__shape_cover)
          || ((b.successful_executions ?? 0) - (a.successful_executions ?? 0))
          || ((b.total_executions ?? 0) - (a.total_executions ?? 0)));
      if (scored.length > 0) {
        paths.push(...scored);
        shapeMatched = scored.length;
        logger.info('Shape-signature fallback matched candidate paths', {
          goal_hash: goalHash,
          target_shapes: targetShapes,
          candidates: shapeMatched,
          best_cover: scored[0].__shape_cover,
        });
      }
    }

    if (paths.length === 0) {
      // Either nothing was recorded, or everything recorded is proven-failing. Both mean the
      // same thing to the caller: there is no pathway worth reusing, derive one.
      return c.json(PathRecommendationResponseSchema.parse({
        goal_hash: goalHash,
        recommended_paths: [],
      }));
    }

    // Decide: exploration vs exploitation
    const shouldExplore = rng() < validated.exploration_rate;
    
    let recommendedPaths: RecommendedPath[];
    
    if (shouldExplore) {
      // Exploration: prefer paths with fewer executions (UCB-style)
      logger.info('Thompson Sampling: EXPLORE mode');

      const sorted = paths
        .sort((a, b) => {
          // @ts-ignore
          const aExec = a.total_executions || 0;
          // @ts-ignore
          const bExec = b.total_executions || 0;
          return aExec - bExec; // Ascending (fewer executions first)
        })
        .slice(0, validated.top_k);

      // Build recommendations with enhanced metadata
      recommendedPaths = await Promise.all(
        sorted.map(async (p) => {
          // @ts-ignore
          const totalExec = p.total_executions || 0;
          // @ts-ignore
          const successExec = p.successful_executions || 0;
          // @ts-ignore
          const alpha = p.thompson_alpha || 1;
          // @ts-ignore
          const beta = p.thompson_beta || 1;

          const confidenceInterval = calculateConfidenceInterval(successExec, totalExec, 0.95);
          const endpointPrediction = await predictEndpointState(
            // @ts-ignore
            p.path_activities,
            validated.goal_text,
            // @ts-ignore - prefer denormalised shapes when present (post-backfill)
            p.endpoint_output_shapes,
          );

          return {
            // @ts-ignore
            path_activities: p.path_activities,
            confidence: 0.5, // Neutral confidence for exploration
            confidence_interval: confidenceInterval,
            endpoint_prediction: endpointPrediction,
            // @ts-ignore
            success_rate: p.success_rate || 0,
            // @ts-ignore
            avg_duration_ms: p.avg_duration_ms || 0,
            // @ts-ignore
            avg_cost_usd: p.avg_cost_usd || 0,
            total_executions: totalExec,
            successful_executions: successExec,
            // @ts-ignore
            goal_hash: typeof p.goal_hash === 'string' ? p.goal_hash : undefined,
            // @ts-ignore
            path_signature: typeof p.path_signature === 'string' ? p.path_signature : undefined,
            // @ts-ignore
            match_mode: p.__match_mode ?? 'goal_hash',
            // @ts-ignore
            shape_cover: typeof p.__shape_cover === 'number' ? p.__shape_cover : undefined,
            exploration_bonus: 1.0 / (totalExec + 1),
            thompson_params: { alpha, beta },
          };
        })
      );
    } else {
      // Exploitation: sample from Beta distributions
      logger.info('Thompson Sampling: EXPLOIT mode');

      const samples = paths.map(p => ({
        path: p,
        // @ts-ignore
        sample: sampleBeta(p.thompson_alpha || 1, p.thompson_beta || 1, rng),
      }));

      samples.sort((a, b) => b.sample - a.sample); // Descending

      // Build recommendations with enhanced metadata
      recommendedPaths = await Promise.all(
        samples.slice(0, validated.top_k).map(async (s) => {
          // @ts-ignore
          const totalExec = s.path.total_executions || 0;
          // @ts-ignore
          const successExec = s.path.successful_executions || 0;
          // @ts-ignore
          const alpha = s.path.thompson_alpha || 1;
          // @ts-ignore
          const beta = s.path.thompson_beta || 1;

          const confidenceInterval = calculateConfidenceInterval(successExec, totalExec, 0.95);
          const endpointPrediction = await predictEndpointState(
            // @ts-ignore
            s.path.path_activities,
            validated.goal_text,
            // @ts-ignore - prefer denormalised shapes when present (post-backfill)
            s.path.endpoint_output_shapes,
          );

          return {
            // @ts-ignore
            path_activities: s.path.path_activities,
            confidence: s.sample,
            confidence_interval: confidenceInterval,
            endpoint_prediction: endpointPrediction,
            // @ts-ignore
            success_rate: s.path.success_rate || 0,
            // @ts-ignore
            avg_duration_ms: s.path.avg_duration_ms || 0,
            // @ts-ignore
            avg_cost_usd: s.path.avg_cost_usd || 0,
            total_executions: totalExec,
            successful_executions: successExec,
            // @ts-ignore
            goal_hash: typeof s.path.goal_hash === 'string' ? s.path.goal_hash : undefined,
            // @ts-ignore
            path_signature: typeof s.path.path_signature === 'string' ? s.path.path_signature : undefined,
            // @ts-ignore
            match_mode: s.path.__match_mode ?? 'goal_hash',
            // @ts-ignore
            shape_cover: typeof s.path.__shape_cover === 'number' ? s.path.__shape_cover : undefined,
            thompson_params: { alpha, beta },
          };
        })
      );
    }
    
    const response = PathRecommendationResponseSchema.parse({
      goal_hash: goalHash,
      recommended_paths: recommendedPaths,
    });
    
    logger.info('Recommended paths', {
      goal_hash: goalHash,
      count: recommendedPaths.length,
      mode: shouldExplore ? 'explore' : 'exploit',
      shape_matched_candidates: shapeMatched,
      returned_shape_matches: recommendedPaths.filter((p: any) => p.match_mode === 'shape_signature').length,
    });
    
    return c.json(response);
    
  } catch (error: any) {
    logger.error('Failed to recommend path', {
      error: error.message,
      stack: error.stack,
    });
    
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }
    
    return c.json({
      error: 'Failed to recommend path',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /goal-paths/stats
 * Global statistics on goal paths
 */
app.get('/stats', async (c) => {
  try {
    // Total unique goals (SurrealDB doesn't support count(DISTINCT), use subquery)
    const goalsQuery = `
      SELECT count() AS total FROM (
        SELECT goal_hash FROM goal_execution_paths GROUP BY goal_hash
      ) GROUP ALL
    `;
    const goalsResult = await surrealDB.query<{ total: number }>(goalsQuery);
    const totalGoals = goalsResult && goalsResult.length > 0 ? goalsResult[0].total : 0;

    // Total paths
    const pathsQuery = `
      SELECT count() AS total FROM goal_execution_paths
      GROUP ALL
    `;
    const pathsResult = await surrealDB.query<{ total: number }>(pathsQuery);
    const totalPaths = pathsResult && pathsResult.length > 0 ? pathsResult[0].total : 0;
    
    // Avg paths per goal
    const avgPathsPerGoal = totalGoals > 0 ? totalPaths / totalGoals : 0;
    
    // Most common goals (by path count)
    const commonGoalsQuery = `
      SELECT 
        goal_hash,
        goal_text,
        count() AS path_count
      FROM goal_execution_paths
      GROUP BY goal_hash, goal_text
      ORDER BY path_count DESC
      LIMIT 10
    `;
    const mostCommonGoals = await surrealDB.query<{
      goal_hash: string;
      goal_text: string;
      path_count: number;
    }[]>(commonGoalsQuery);
    
    // Best performing paths
    const bestPathsQuery = `
      SELECT 
        goal_text,
        path_activities,
        success_rate,
        total_executions
      FROM goal_execution_paths
      WHERE total_executions >= 3
      ORDER BY success_rate DESC, total_executions DESC
      LIMIT 10
    `;
    const bestPerformingPaths = await surrealDB.query<{
      goal_text: string;
      path_activities: string[];
      success_rate: number;
      total_executions: number;
    }[]>(bestPathsQuery);
    
    const response = PathStatsResponseSchema.parse({
      total_goals: totalGoals,
      total_paths: totalPaths,
      avg_paths_per_goal: avgPathsPerGoal,
      most_common_goals: mostCommonGoals || [],
      best_performing_paths: bestPerformingPaths || [],
    });
    
    return c.json(response);
    
  } catch (error: any) {
    logger.error('Failed to get path stats', {
      error: error.message,
    });
    
    return c.json({
      error: 'Failed to get path stats',
      message: error.message,
    }, 500);
  }
});

export default app;
