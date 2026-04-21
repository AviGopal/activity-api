/**
 * State-Aware Activity Recommendations
 *
 * Enhanced Thompson Sampling that considers impulse state, recent activities,
 * git changes, and goal context to provide contextually appropriate recommendations.
 */

import { Hono } from 'hono';
import { Database } from '../db.js';
import { StatePatternLearner, StateSnapshot } from '../services/state-pattern-learner.js';
import { sampleBeta } from '../services/thompson-sampling.js';

const app = new Hono();

interface StateAwareRecommendationRequest {
  goal: string;
  state: {
    impulse_state: StateSnapshot['impulse_state'];
    activity_history: StateSnapshot['activity_history'];
    git_state: StateSnapshot['git_state'];
    goal_context: StateSnapshot['goal_context'];
  };
  n_recommendations?: number;
}

interface ActivityRecommendation {
  activity_id: string;
  activity_name: string;
  thompson_score: number;
  state_bonus: number;
  final_score: number;
  matched_patterns: Array<{
    pattern_id: string;
    match_score: number;
    observations: number;
    success_rate: number;
  }>;
  reasoning: string;
  confidence: number;
}

/**
 * POST /v2/activities/recommend-with-state
 *
 * Get activity recommendations enhanced with state awareness
 */
app.post('/recommend-with-state', async (c) => {
  const db: Database = c.get('db');
  const auth = c.get('auth');

  if (!auth || !auth.org_id) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const body = await c.req.json<StateAwareRecommendationRequest>();
  const { goal, state, n_recommendations = 3 } = body;

  try {
    const learner = new StatePatternLearner(db);

    // 1. Get all activities for this org
    const activities = await db.query<any[]>(
      `SELECT * FROM activity_template WHERE org_id = $org_id OR public = true`,
      { org_id: auth.org_id }
    );

    if (!activities || activities.length === 0) {
      return c.json({ recommendations: [] });
    }

    // 2. Match patterns to current state
    const currentStateSnapshot = {
      ...state,
      timestamp: new Date(),
      org_id: auth.org_id
    };

    const matchedPatterns = await learner.matchPatterns(
      currentStateSnapshot,
      auth.org_id
    );

    console.log(`[State-Aware] Matched ${matchedPatterns.length} patterns for org ${auth.org_id}`);

    // 3. Calculate base Thompson Sampling scores
    const recommendations: ActivityRecommendation[] = [];

    for (const activity of activities) {
      // Base Thompson Sampling score
      const alpha = activity.success_count + 1;
      const beta = activity.failure_count + 1;
      const thompsonScore = sampleBeta(alpha, beta);

      // Calculate state bonus from matched patterns
      let stateBonus = 0;
      const activityPatterns: ActivityRecommendation['matched_patterns'] = [];

      for (const pattern of matchedPatterns) {
        if (pattern.best_activity_id === activity.id) {
          // Boost score based on:
          // - Pattern match strength (0-1)
          // - Pattern success rate (0-1)
          // - Pattern confidence (0-1)
          const patternBoost =
            pattern.match_score *
            pattern.success_rate *
            pattern.confidence *
            0.3; // Max 30% boost per pattern

          stateBonus += patternBoost;

          activityPatterns.push({
            pattern_id: pattern.pattern_id,
            match_score: pattern.match_score,
            observations: pattern.observations,
            success_rate: pattern.success_rate
          });
        }
      }

      const finalScore = thompsonScore + stateBonus;

      // Generate reasoning
      const reasoning = generateReasoning(
        activity,
        activityPatterns,
        thompsonScore,
        stateBonus,
        state
      );

      // Calculate overall confidence
      const confidence = calculateConfidence(
        activity,
        activityPatterns,
        matchedPatterns.length
      );

      recommendations.push({
        activity_id: activity.id,
        activity_name: activity.name,
        thompson_score: thompsonScore,
        state_bonus: stateBonus,
        final_score: finalScore,
        matched_patterns: activityPatterns,
        reasoning,
        confidence
      });
    }

    // 4. Sort by final score and return top N
    const topRecommendations = recommendations
      .sort((a, b) => b.final_score - a.final_score)
      .slice(0, n_recommendations);

    return c.json({
      recommendations: topRecommendations,
      total_patterns_matched: matchedPatterns.length,
      state_aware: matchedPatterns.length > 0
    });
  } catch (error) {
    console.error('[State-Aware] Error:', error);
    return c.json(
      { error: 'Failed to get state-aware recommendations', details: (error as Error).message },
      500
    );
  }
});

/**
 * POST /v2/activities/state-snapshot
 *
 * Store a state snapshot before activity execution
 */
app.post('/state-snapshot', async (c) => {
  const db: Database = c.get('db');
  const auth = c.get('auth');

  if (!auth || !auth.org_id) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const snapshot = await c.req.json<StateSnapshot>();

  try {
    const result = await db.query(
      `CREATE execution_state_snapshot CONTENT $snapshot`,
      { snapshot: { ...snapshot, org_id: auth.org_id } }
    );

    return c.json({
      execution_id: snapshot.execution_id,
      stored: true
    });
  } catch (error) {
    console.error('[State-Snapshot] Error storing snapshot:', error);
    return c.json(
      { error: 'Failed to store state snapshot', details: (error as Error).message },
      500
    );
  }
});

/**
 * POST /v2/activities/state-snapshot/:execution_id/outcome
 *
 * Update state snapshot with execution outcome (triggers pattern learning)
 */
app.post('/state-snapshot/:execution_id/outcome', async (c) => {
  const db: Database = c.get('db');
  const auth = c.get('auth');

  if (!auth || !auth.org_id) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const executionId = c.req.param('execution_id');
  const outcome = await c.req.json<{
    success: boolean;
    duration_ms: number;
    cost_usd: number;
    summary: string;
  }>();

  try {
    const learner = new StatePatternLearner(db);

    // This updates patterns, activity-state affinity, and feature importance
    await learner.updatePatternsFromSnapshot(executionId, outcome);

    return c.json({
      execution_id: executionId,
      patterns_updated: true,
      learning_complete: true
    });
  } catch (error) {
    console.error('[State-Outcome] Error updating patterns:', error);
    return c.json(
      { error: 'Failed to update patterns', details: (error as Error).message },
      500
    );
  }
});

/**
 * GET /v2/activities/state-patterns
 *
 * Get discovered patterns for observability
 */
app.get('/state-patterns', async (c) => {
  const db: Database = c.get('db');
  const auth = c.get('auth');

  if (!auth || !auth.org_id) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const limit = Number(c.req.query('limit') || '20');
  const minConfidence = Number(c.req.query('min_confidence') || '0.3');

  try {
    const patterns = await db.query<any[]>(
      `SELECT * FROM discovered_state_pattern
       WHERE org_id = $org_id AND enabled = true AND confidence >= $min_confidence
       ORDER BY observations DESC, success_rate DESC
       LIMIT $limit`,
      { org_id: auth.org_id, min_confidence: minConfidence, limit }
    );

    return c.json({
      patterns: patterns || [],
      total: patterns?.length || 0
    });
  } catch (error) {
    console.error('[State-Patterns] Error:', error);
    return c.json(
      { error: 'Failed to get patterns', details: (error as Error).message },
      500
    );
  }
});

/**
 * GET /v2/activities/feature-importance
 *
 * Get state feature importance for observability
 */
app.get('/feature-importance', async (c) => {
  const db: Database = c.get('db');
  const auth = c.get('auth');

  if (!auth || !auth.org_id) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const limit = Number(c.req.query('limit') || '50');

  try {
    const features = await db.query<any[]>(
      `SELECT * FROM state_feature_importance
       WHERE org_id = $org_id
       ORDER BY correlation_score DESC, observations DESC
       LIMIT $limit`,
      { org_id: auth.org_id, limit }
    );

    return c.json({
      features: features || [],
      total: features?.length || 0
    });
  } catch (error) {
    console.error('[Feature-Importance] Error:', error);
    return c.json(
      { error: 'Failed to get feature importance', details: (error as Error).message },
      500
    );
  }
});

// ============================================================================
// Helper Functions
// ============================================================================

function generateReasoning(
  activity: any,
  matchedPatterns: ActivityRecommendation['matched_patterns'],
  thompsonScore: number,
  stateBonus: number,
  state: StateAwareRecommendationRequest['state']
): string {
  if (matchedPatterns.length === 0) {
    return `Standard Thompson Sampling selection (score: ${thompsonScore.toFixed(3)})`;
  }

  const topPattern = matchedPatterns[0];
  const reasons: string[] = [];

  // Pattern-based reasoning
  reasons.push(
    `Matched ${matchedPatterns.length} learned pattern(s) (best match: ${(topPattern.match_score * 100).toFixed(0)}%)`
  );

  if (state.activity_history.last_activity_id) {
    reasons.push(`Following ${state.activity_history.last_activity_name || 'previous activity'}`);
  }

  if (state.git_state.total_changes > 0) {
    reasons.push(`Detected ${state.git_state.total_changes} uncommitted changes`);
  }

  const impulseTypes = Object.keys(state.impulse_state.impulse_types);
  if (impulseTypes.length > 0) {
    reasons.push(`Available impulse types: ${impulseTypes.join(', ')}`);
  }

  if (stateBonus > 0.1) {
    reasons.push(`State bonus: +${(stateBonus * 100).toFixed(1)}%`);
  }

  return reasons.join('. ');
}

function calculateConfidence(
  activity: any,
  matchedPatterns: ActivityRecommendation['matched_patterns'],
  totalPatternsMatched: number
): number {
  // Base confidence from activity execution count
  const executionCount = (activity.success_count || 0) + (activity.failure_count || 0);
  const executionConfidence = Math.min(1.0, Math.log10(executionCount + 1) / 2);

  // Pattern-based confidence
  let patternConfidence = 0;
  if (matchedPatterns.length > 0) {
    const avgMatchScore =
      matchedPatterns.reduce((sum, p) => sum + p.match_score, 0) / matchedPatterns.length;
    const avgSuccessRate =
      matchedPatterns.reduce((sum, p) => sum + p.success_rate, 0) / matchedPatterns.length;

    patternConfidence = avgMatchScore * avgSuccessRate;
  }

  // Combined confidence (weighted average)
  return executionConfidence * 0.4 + patternConfidence * 0.6;
}

export default app;
