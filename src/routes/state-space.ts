/**
 * State Space Learning API Routes
 *
 * Tracks impulse state transitions and learns patterns:
 * - Record before/after impulse states for each execution
 * - Learn which activities work with which impulse configurations
 * - Recommend activities based on current impulse state
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/surrealdb'
import { logger } from '../utils/logger'

const app = new Hono()

// =============================================================================
// Schemas
// =============================================================================

const ImpulseStateSummarySchema = z.object({
  id: z.string(),
  shape: z.string(),
  metadata: z.record(z.any()).optional()
})

const ImpulseStateSchema = z.object({
  impulses: z.array(ImpulseStateSummarySchema),
  state_vector: z.array(z.number()).optional() // For future: embeddings
})

const StateTransitionSchema = z.object({
  execution_id: z.string(),
  before_state: ImpulseStateSchema,
  after_state: ImpulseStateSchema,
  activity_id: z.string(),
  resolvers_used: z.array(z.string()),
  success: z.boolean(),
  duration_ms: z.number(),
  org_id: z.string().optional()
})

const ImpulseStatePatternSchema = z.object({
  pattern_type: z.enum(['shape_combination', 'state_vector_cluster', 'metadata_condition']),
  pattern: z.record(z.any()),
  recommended_activity_id: z.string(),
  confidence: z.number().min(0).max(1).default(0.5),
  support_count: z.number().int().default(1),
  success_rate: z.number().min(0).max(1),
  org_id: z.string().optional(),
  scope: z.enum(['global', 'org', 'project']).default('org')
})

// =============================================================================
// Routes: State Transitions
// =============================================================================

/**
 * POST /v2/state-space/transitions
 *
 * Record a state transition (called after each execution)
 */
app.post('/transitions', async (c) => {
  try {
    const body = await c.req.json()
    const transition = StateTransitionSchema.parse(body)

    // Generate ID
    const id = `transition-${transition.execution_id}`

    // Store transition
    const result = await db.query(`
      CREATE state_transition:${id} SET
        execution_id = $execution_id,
        before_state = $before_state,
        after_state = $after_state,
        activity_id = $activity_id,
        resolvers_used = $resolvers_used,
        success = $success,
        duration_ms = $duration_ms,
        org_id = $org_id
    `, transition)

    // Trigger pattern learning (async)
    learnPatternsFromTransition(transition).catch(err =>
      logger.error('Pattern learning failed:', err)
    )

    return c.json({ recorded: true, transition: result[0] })
  } catch (error) {
    logger.error('State transition recording failed:', { error: error instanceof Error ? error.message : String(error) })
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

/**
 * GET /v2/state-space/transitions/:execution_id
 *
 * Get state transition for specific execution
 */
app.get('/transitions/:execution_id', async (c) => {
  const executionId = c.req.param('execution_id')

  try {
    const result = await db.query(`
      SELECT * FROM state_transition
      WHERE execution_id = $execution_id
    `, { execution_id: executionId })

    if (!result || result.length === 0) {
      return c.json({ error: 'Transition not found' }, 404)
    }

    return c.json({ transition: result[0] })
  } catch (error) {
    logger.error('Transition fetch failed:', { error: error instanceof Error ? error.message : String(error) })
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

// =============================================================================
// Routes: Pattern Learning
// =============================================================================

/**
 * POST /v2/state-space/patterns/learn
 *
 * Trigger pattern learning from recent transitions
 */
app.post('/patterns/learn', async (c) => {
  const { lookback_hours = 24 } = await c.req.json()

  try {
    // Find common shape combinations that lead to success
    const shapePatterns = await db.query(`
      SELECT
        before_state.impulses[*].shape AS input_shapes,
        activity_id,
        COUNT(*) AS support_count,
        SUM(CASE WHEN success THEN 1 ELSE 0 END) / COUNT(*) AS success_rate
      FROM state_transition
      WHERE created_at > time::now() - duration('${lookback_hours}h')
      GROUP BY input_shapes, activity_id
      HAVING support_count >= 3
      ORDER BY success_rate DESC, support_count DESC
    `)

    // Create or update patterns
    const patterns = []
    for (const pattern of shapePatterns) {
      const patternId = `pattern-${hashPattern(pattern)}`

      const result = await db.query(`
        UPSERT impulse_state_pattern:${patternId} SET
          pattern_type = 'shape_combination',
          pattern = $pattern,
          recommended_activity_id = $activity_id,
          confidence = $success_rate,
          support_count = $support_count,
          success_rate = $success_rate,
          learned_at = time::now()
      `, {
        pattern: { input_shapes: pattern.input_shapes },
        activity_id: pattern.activity_id,
        success_rate: pattern.success_rate,
        support_count: pattern.support_count
      })

      patterns.push(result[0])
    }

    return c.json({
      learned: true,
      patterns_count: patterns.length,
      patterns
    })
  } catch (error) {
    logger.error('Pattern learning failed:', { error: error instanceof Error ? error.message : String(error) })
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

/**
 * GET /v2/state-space/patterns/list
 *
 * List learned patterns
 */
app.get('/patterns/list', async (c) => {
  const minConfidence = parseFloat(c.req.query('min_confidence') || '0.3')

  try {
    const patterns = await db.query(`
      SELECT * FROM impulse_state_pattern
      WHERE confidence >= $min_confidence
      ORDER BY confidence DESC, support_count DESC
      LIMIT 100
    `, { min_confidence: minConfidence })

    return c.json({ patterns, count: patterns.length })
  } catch (error) {
    logger.error('Pattern list failed:', { error: error instanceof Error ? error.message : String(error) })
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

// =============================================================================
// Routes: Activity Recommendations (State-Space Based)
// =============================================================================

/**
 * POST /v2/state-space/recommend
 *
 * Recommend activities based on current impulse state
 *
 * Body: { impulses: [{id, shape, metadata}] }
 * Returns: Activities ranked by pattern match confidence
 */
app.post('/recommend', async (c) => {
  try {
    const { impulses } = await c.req.json()
    const inputShapes = impulses.map(i => i.shape).sort()

    // Find patterns that match current impulse state
    const matchingPatterns = await db.query(`
      SELECT
        *,
        recommended_activity_id,
        confidence,
        support_count
      FROM impulse_state_pattern
      WHERE
        pattern_type = 'shape_combination'
        AND pattern.input_shapes ALLINSIDE $input_shapes
      ORDER BY confidence DESC, support_count DESC
      LIMIT 10
    `, { input_shapes: inputShapes })

    // Fetch activity details
    const recommendations = []
    for (const pattern of matchingPatterns) {
      const activity = await db.query(`
        SELECT * FROM activity WHERE id = $activity_id
      `, { activity_id: pattern.recommended_activity_id })

      if (activity && activity.length > 0) {
        recommendations.push({
          activity: activity[0],
          confidence: pattern.confidence,
          support_count: pattern.support_count,
          pattern_match: 'shape_combination',
          input_shapes: inputShapes
        })
      }
    }

    return c.json({
      recommendations,
      count: recommendations.length,
      input_state: { impulses, shapes: inputShapes }
    })
  } catch (error) {
    logger.error('State-space recommendation failed:', { error: error instanceof Error ? error.message : String(error) })
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

/**
 * GET /v2/state-space/analyze
 *
 * Analyze impulse state space coverage
 */
app.get('/analyze', async (c) => {
  try {
    const analysis = await db.query(`
      SELECT
        pattern.input_shapes AS shape_combination,
        COUNT(DISTINCT recommended_activity_id) AS activities_count,
        AVG(confidence) AS avg_confidence,
        SUM(support_count) AS total_support
      FROM impulse_state_pattern
      WHERE pattern_type = 'shape_combination'
      GROUP BY shape_combination
      ORDER BY total_support DESC
    `)

    const coverage = {
      unique_shape_combinations: analysis.length,
      total_patterns: await db.query(`SELECT COUNT(*) FROM impulse_state_pattern`),
      analysis
    }

    return c.json(coverage)
  } catch (error) {
    logger.error('State space analysis failed:', { error: error instanceof Error ? error.message : String(error) })
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Learn patterns from a single state transition
 */
async function learnPatternsFromTransition(transition: z.infer<typeof StateTransitionSchema>) {
  const inputShapes = transition.before_state.impulses.map(i => i.shape).sort()
  const patternId = `pattern-${hashPattern({ input_shapes: inputShapes, activity_id: transition.activity_id })}`

  // Upsert pattern with incremental learning
  await db.query(`
    LET $existing = SELECT * FROM impulse_state_pattern:${patternId};
    LET $prev_count = $existing.support_count OR 0;
    LET $prev_rate = $existing.success_rate OR 0.5;
    LET $new_count = $prev_count + 1;
    LET $new_rate = (($prev_rate * $prev_count) + ($success ? 1 : 0)) / $new_count;

    UPSERT impulse_state_pattern:${patternId} SET
      pattern_type = 'shape_combination',
      pattern = $pattern,
      recommended_activity_id = $activity_id,
      confidence = $new_rate,
      support_count = $new_count,
      success_rate = $new_rate,
      last_matched_at = time::now()
  `, {
    pattern: { input_shapes: inputShapes },
    activity_id: transition.activity_id,
    success: transition.success
  })
}

/**
 * Hash pattern for consistent ID generation
 */
function hashPattern(pattern: any): string {
  return Bun.hash(JSON.stringify(pattern)).toString(36).slice(0, 12)
}

export default app
