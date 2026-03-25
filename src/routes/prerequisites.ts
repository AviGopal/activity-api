/**
 * Prerequisites Routes
 *
 * Data Flow Learning: Tracks activity prerequisites and composition patterns.
 * Enables automatic composition through prerequisite satisfaction.
 */

import { Hono } from 'hono';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';

const app = new Hono();

// ============================================================================
// Types
// ============================================================================

interface ActivityPrerequisite {
  id: string;
  template_id: string;
  variant_id: string;
  required_impulses: Array<{
    type: string;
    optional: boolean;
    description?: string;
  }>;
  state_requirements?: Record<string, unknown>;
  produces_impulses: Array<{
    type: string;
    reliability: number;
    description?: string;
  }>;
  state_changes?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface PrerequisitePattern {
  id: string;
  required_impulse_type: string;
  required_state?: Record<string, unknown>;
  satisfying_activity_id: string;
  satisfying_variant_id?: string;
  execution_count: number;
  success_count: number;
  success_rate: number;
  avg_duration_ms: number;
  thompson_alpha: number;
  thompson_beta: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// POST /prerequisites/activity - Record activity prerequisites
// ============================================================================

app.post('/activity', async (c) => {
  try {
    const body = await c.req.json();

    if (!body.template_id || !body.variant_id) {
      return c.json({
        success: false,
        error: 'Missing required fields: template_id, variant_id'
      }, 400);
    }

    const prereqId = `prereq:${body.template_id}:${body.variant_id}`;

    // Check if already exists
    const existing = await surrealDB.query<ActivityPrerequisite[]>(
      `SELECT * FROM activity_prerequisites WHERE template_id = $template_id AND variant_id = $variant_id`,
      { template_id: body.template_id, variant_id: body.variant_id }
    );

    if (existing && existing.length > 0) {
      // Update existing
      const updated = await surrealDB.query<ActivityPrerequisite[]>(
        `UPDATE activity_prerequisites SET
          required_impulses = $required_impulses,
          state_requirements = $state_requirements,
          produces_impulses = $produces_impulses,
          state_changes = $state_changes,
          updated_at = time::now()
        WHERE template_id = $template_id AND variant_id = $variant_id
        RETURN AFTER`,
        {
          template_id: body.template_id,
          variant_id: body.variant_id,
          required_impulses: body.required_impulses || [],
          state_requirements: body.state_requirements,
          produces_impulses: body.produces_impulses || [],
          state_changes: body.state_changes
        }
      );

      return c.json({
        success: true,
        prerequisite: updated && updated.length > 0 ? updated[0] : existing[0],
        updated: true
      });
    }

    // Create new
    const created = await surrealDB.query<ActivityPrerequisite[]>(
      `CREATE activity_prerequisites CONTENT {
        id: $id,
        template_id: $template_id,
        variant_id: $variant_id,
        required_impulses: $required_impulses,
        state_requirements: $state_requirements,
        produces_impulses: $produces_impulses,
        state_changes: $state_changes,
        created_at: time::now(),
        updated_at: time::now()
      }`,
      {
        id: prereqId,
        template_id: body.template_id,
        variant_id: body.variant_id,
        required_impulses: body.required_impulses || [],
        state_requirements: body.state_requirements,
        produces_impulses: body.produces_impulses || [],
        state_changes: body.state_changes
      }
    );

    logger.info('Created activity prerequisites', {
      template_id: body.template_id,
      required: body.required_impulses?.length || 0,
      produces: body.produces_impulses?.length || 0
    });

    return c.json({
      success: true,
      prerequisite: created && created.length > 0 ? created[0] : { id: prereqId },
      created: true
    });
  } catch (error: any) {
    logger.error('Failed to record activity prerequisites', {
      error: error.message
    });
    return c.json({
      success: false,
      error: error.message
    }, 500);
  }
});

// ============================================================================
// POST /prerequisites/pattern - Record prerequisite satisfaction pattern
// ============================================================================

app.post('/pattern', async (c) => {
  try {
    const body = await c.req.json();

    if (!body.required_impulse_type || !body.satisfying_activity_id) {
      return c.json({
        success: false,
        error: 'Missing required fields: required_impulse_type, satisfying_activity_id'
      }, 400);
    }

    const patternId = `pattern:${body.required_impulse_type}:${body.satisfying_activity_id}`;

    // Check if pattern exists
    const existing = await surrealDB.query<PrerequisitePattern[]>(
      `SELECT * FROM prerequisite_patterns WHERE required_impulse_type = $type AND satisfying_activity_id = $activity`,
      { type: body.required_impulse_type, activity: body.satisfying_activity_id }
    );

    if (existing && existing.length > 0) {
      // Update with new execution result
      const pattern = existing[0];
      const newExecutionCount = pattern.execution_count + 1;
      const newSuccessCount = pattern.success_count + (body.success ? 1 : 0);
      const newSuccessRate = newSuccessCount / newExecutionCount;
      const newAvgDuration = ((pattern.avg_duration_ms * pattern.execution_count) + (body.duration_ms || 0)) / newExecutionCount;

      const updated = await surrealDB.query<PrerequisitePattern[]>(
        `UPDATE prerequisite_patterns SET
          execution_count = $execution_count,
          success_count = $success_count,
          success_rate = $success_rate,
          avg_duration_ms = $avg_duration_ms,
          thompson_alpha = thompson_alpha + (${body.success ? 1 : 0}),
          thompson_beta = thompson_beta + (${body.success ? 0 : 1}),
          updated_at = time::now()
        WHERE required_impulse_type = $type AND satisfying_activity_id = $activity
        RETURN AFTER`,
        {
          type: body.required_impulse_type,
          activity: body.satisfying_activity_id,
          execution_count: newExecutionCount,
          success_count: newSuccessCount,
          success_rate: newSuccessRate,
          avg_duration_ms: newAvgDuration
        }
      );

      logger.info('Updated prerequisite pattern', {
        impulse_type: body.required_impulse_type,
        activity: body.satisfying_activity_id,
        success_rate: newSuccessRate
      });

      return c.json({
        success: true,
        pattern: updated && updated.length > 0 ? updated[0] : existing[0],
        updated: true
      });
    }

    // Create new pattern
    const created = await surrealDB.query<PrerequisitePattern[]>(
      `CREATE prerequisite_patterns CONTENT {
        id: $id,
        required_impulse_type: $required_impulse_type,
        required_state: $required_state,
        satisfying_activity_id: $satisfying_activity_id,
        satisfying_variant_id: $satisfying_variant_id,
        execution_count: 1,
        success_count: ${body.success ? 1 : 0},
        success_rate: ${body.success ? 1.0 : 0.0},
        avg_duration_ms: $avg_duration_ms,
        thompson_alpha: ${body.success ? 2.0 : 1.0},
        thompson_beta: ${body.success ? 1.0 : 2.0},
        created_at: time::now(),
        updated_at: time::now()
      }`,
      {
        id: patternId,
        required_impulse_type: body.required_impulse_type,
        required_state: body.required_state,
        satisfying_activity_id: body.satisfying_activity_id,
        satisfying_variant_id: body.satisfying_variant_id,
        avg_duration_ms: body.duration_ms || 0
      }
    );

    logger.info('Created prerequisite pattern', {
      impulse_type: body.required_impulse_type,
      activity: body.satisfying_activity_id,
      success: body.success
    });

    return c.json({
      success: true,
      pattern: created && created.length > 0 ? created[0] : { id: patternId },
      created: true
    });
  } catch (error: any) {
    logger.error('Failed to record prerequisite pattern', {
      error: error.message
    });
    return c.json({
      success: false,
      error: error.message
    }, 500);
  }
});

// ============================================================================
// GET /prerequisites/find-satisfier - Find activity that produces impulse
// ============================================================================

app.get('/find-satisfier', async (c) => {
  const impulseType = c.req.query('impulse_type');

  if (!impulseType) {
    return c.json({
      success: false,
      error: 'Missing required parameter: impulse_type'
    }, 400);
  }

  try {
    // Find patterns that produce this impulse type (Thompson Sampling)
    const patterns = await surrealDB.query<PrerequisitePattern[]>(
      `SELECT * FROM prerequisite_patterns
       WHERE required_impulse_type = $type
       ORDER BY success_rate DESC, execution_count DESC
       LIMIT 5`,
      { type: impulseType }
    );

    if (!patterns || patterns.length === 0) {
      // Fallback: check activity prerequisites for what produces this impulse
      const prerequisites = await surrealDB.query<ActivityPrerequisite[]>(
        `SELECT * FROM activity_prerequisites
         WHERE produces_impulses[*].type CONTAINS $type`,
        { type: impulseType }
      );

      if (!prerequisites || prerequisites.length === 0) {
        return c.json({
          success: true,
          candidates: [],
          message: 'No activities found that produce this impulse type'
        });
      }

      return c.json({
        success: true,
        candidates: prerequisites.map(p => ({
          activity_id: p.template_id,
          variant_id: p.variant_id,
          confidence: 0.5,  // Neutral confidence (unproven)
          source: 'declaration'
        }))
      });
    }

    // Thompson Sampling: calculate confidence scores
    const candidates = patterns.map(p => {
      const thompsonScore = p.thompson_alpha / (p.thompson_alpha + p.thompson_beta);
      return {
        activity_id: p.satisfying_activity_id,
        variant_id: p.satisfying_variant_id,
        confidence: thompsonScore,
        success_rate: p.success_rate,
        execution_count: p.execution_count,
        avg_duration_ms: p.avg_duration_ms,
        source: 'proven'
      };
    });

    logger.info('Found satisfiers for impulse', {
      impulse_type: impulseType,
      count: candidates.length
    });

    return c.json({
      success: true,
      candidates: candidates.sort((a, b) => b.confidence - a.confidence)
    });
  } catch (error: any) {
    logger.error('Failed to find satisfier', {
      error: error.message
    });
    return c.json({
      success: false,
      error: error.message
    }, 500);
  }
});

// ============================================================================
// GET /prerequisites/activity/:template_id - Get activity prerequisites
// ============================================================================

app.get('/activity/:template_id', async (c) => {
  const templateId = c.req.param('template_id');
  const variantId = c.req.query('variant_id');

  try {
    let query = `SELECT * FROM activity_prerequisites WHERE template_id = $template_id`;
    const params: Record<string, string> = { template_id: templateId };

    if (variantId) {
      query += ` AND variant_id = $variant_id`;
      params.variant_id = variantId;
    }

    const prerequisites = await surrealDB.query<ActivityPrerequisite[]>(query, params);

    if (!prerequisites || prerequisites.length === 0) {
      return c.json({
        success: true,
        prerequisites: [],
        message: 'No prerequisites defined for this activity'
      });
    }

    return c.json({
      success: true,
      prerequisites: variantId ? prerequisites[0] : prerequisites
    });
  } catch (error: any) {
    logger.error('Failed to get activity prerequisites', {
      error: error.message
    });
    return c.json({
      success: false,
      error: error.message
    }, 500);
  }
});

// ============================================================================
// GET /prerequisites/patterns - List prerequisite patterns
// ============================================================================

app.get('/patterns', async (c) => {
  const impulseType = c.req.query('impulse_type');
  const activityId = c.req.query('activity_id');
  const limit = parseInt(c.req.query('limit') || '50');

  try {
    let query = `SELECT * FROM prerequisite_patterns`;
    const params: Record<string, unknown> = { limit };

    if (impulseType) {
      query += ` WHERE required_impulse_type = $impulse_type`;
      params.impulse_type = impulseType;
    } else if (activityId) {
      query += ` WHERE satisfying_activity_id = $activity_id`;
      params.activity_id = activityId;
    }

    query += ` ORDER BY success_rate DESC, execution_count DESC LIMIT $limit`;

    const patterns = await surrealDB.query<PrerequisitePattern[]>(query, params);

    return c.json({
      success: true,
      patterns: patterns || [],
      count: patterns?.length || 0
    });
  } catch (error: any) {
    logger.error('Failed to list prerequisite patterns', {
      error: error.message
    });
    return c.json({
      success: false,
      error: error.message
    }, 500);
  }
});

export default app;
