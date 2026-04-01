/**
 * Resolver Registry API Routes
 *
 * Manages resolver discovery and selection.
 * Resolvers advertise what impulse types they can consume/produce.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/surrealdb'

const app = new Hono()

// =============================================================================
// Schemas
// =============================================================================

const ResolverSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  resolver_type: z.enum(['built-in', 'vessel', 'remote_service', 'mcp_server']),
  can_consume: z.array(z.string()).default([]),
  can_produce: z.array(z.string()).default([]),
  endpoint: z.string().url().optional(),
  vessel_id: z.string().optional(),
  avg_latency_ms: z.number().optional(),
  avg_cost_usd: z.number().optional(),
  success_rate: z.number().min(0).max(1).optional(),
  org_id: z.string().optional(),
  scope: z.enum(['global', 'org', 'project']).default('global'),
  is_active: z.boolean().default(true)
})

type Resolver = z.infer<typeof ResolverSchema>

// =============================================================================
// Routes
// =============================================================================

/**
 * POST /v2/resolvers/register
 *
 * Register or update a resolver
 */
app.post('/register', async (c) => {
  try {
    const body = await c.req.json()
    const resolver = ResolverSchema.parse(body)

    // Upsert resolver
    const result = await db.query(`
      UPDATE resolver:${resolver.id} SET
        name = $name,
        description = $description,
        resolver_type = $resolver_type,
        can_consume = $can_consume,
        can_produce = $can_produce,
        endpoint = $endpoint,
        vessel_id = $vessel_id,
        org_id = $org_id,
        scope = $scope,
        is_active = $is_active,
        last_used_at = time::now()
    `, {
      ...resolver
    })

    return c.json({ registered: true, resolver: result[0] })
  } catch (error) {
    console.error('Resolver registration failed:', error)
    return c.json({ error: error.message }, 400)
  }
})

/**
 * GET /v2/resolvers/discover
 *
 * Find resolvers that can handle a given impulse type
 *
 * Query params:
 * - input_shape: Impulse shape to consume
 * - output_shape: Desired output shape
 * - scope: Filter by scope (global, org, project)
 */
app.get('/discover', async (c) => {
  const inputShape = c.req.query('input_shape')
  const outputShape = c.req.query('output_shape')
  const scope = c.req.query('scope') || 'global'

  try {
    let query = `SELECT * FROM resolver WHERE is_active = true`
    const params: Record<string, any> = {}

    if (inputShape) {
      query += ` AND $input_shape IN can_consume`
      params.input_shape = inputShape
    }

    if (outputShape) {
      query += ` AND $output_shape IN can_produce`
      params.output_shape = outputShape
    }

    query += ` ORDER BY success_rate DESC, avg_latency_ms ASC`

    const resolvers = await db.query(query, params)

    return c.json({
      resolvers,
      count: resolvers.length,
      query: { inputShape, outputShape, scope }
    })
  } catch (error) {
    console.error('Resolver discovery failed:', error)
    return c.json({ error: error.message }, 500)
  }
})

/**
 * GET /v2/resolvers/list
 *
 * List all registered resolvers
 */
app.get('/list', async (c) => {
  try {
    const resolvers = await db.query(`
      SELECT * FROM resolver
      WHERE is_active = true
      ORDER BY resolver_type, name
    `)

    return c.json({ resolvers, count: resolvers.length })
  } catch (error) {
    console.error('Resolver list failed:', error)
    return c.json({ error: error.message }, 500)
  }
})

/**
 * GET /v2/resolvers/:id
 *
 * Get details for specific resolver
 */
app.get('/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const result = await db.query(`SELECT * FROM resolver:${id}`)

    if (!result || result.length === 0) {
      return c.json({ error: 'Resolver not found' }, 404)
    }

    return c.json({ resolver: result[0] })
  } catch (error) {
    console.error('Resolver fetch failed:', error)
    return c.json({ error: error.message }, 500)
  }
})

/**
 * POST /v2/resolvers/:id/metrics
 *
 * Update resolver performance metrics (called after each execution)
 */
app.post('/:id/metrics', async (c) => {
  const id = c.req.param('id')
  const { latency_ms, cost_usd, success } = await c.req.json()

  try {
    // Update running averages using exponential moving average
    const result = await db.query(`
      LET $resolver = SELECT * FROM resolver:${id};
      LET $prev_latency = $resolver.avg_latency_ms OR 0;
      LET $prev_cost = $resolver.avg_cost_usd OR 0;
      LET $prev_rate = $resolver.success_rate OR 0.5;

      UPDATE resolver:${id} SET
        avg_latency_ms = ($prev_latency * 0.9) + ($latency_ms * 0.1),
        avg_cost_usd = ($prev_cost * 0.9) + ($cost_usd * 0.1),
        success_rate = ($prev_rate * 0.95) + (($success ? 1 : 0) * 0.05),
        last_used_at = time::now()
    `, { latency_ms, cost_usd, success })

    return c.json({ updated: true, resolver: result[0] })
  } catch (error) {
    console.error('Resolver metrics update failed:', error)
    return c.json({ error: error.message }, 500)
  }
})

/**
 * DELETE /v2/resolvers/:id
 *
 * Deactivate a resolver
 */
app.delete('/:id', async (c) => {
  const id = c.req.param('id')

  try {
    await db.query(`UPDATE resolver:${id} SET is_active = false`)
    return c.json({ deactivated: true })
  } catch (error) {
    console.error('Resolver deactivation failed:', error)
    return c.json({ error: error.message }, 500)
  }
})

export default app
