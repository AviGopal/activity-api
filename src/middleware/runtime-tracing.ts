/**
 * Runtime Activity Tracing Middleware
 *
 * Instruments HTTP requests and internal resolvers to track:
 * - Hot paths (most frequent activities)
 * - Performance bottlenecks (slow resolvers)
 * - Error patterns (which impulses cause failures)
 * - Reuse opportunities (which functions are called from many activities)
 *
 * Uses the same execution trace schema as development activities.
 */

import type { Context, Next } from 'hono';

/**
 * Minimal local type definitions for runtime tracing.
 *
 * These mirror the fields MiniBob publishes for impulses and resolver
 * invocations, but this file is the only consumer in this backend so
 * we keep the shape local rather than coupling to a shared model.
 */
interface Impulse {
  id: string;
  pointer: { type: string; content?: string; [key: string]: unknown };
  budget: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
  loaded: boolean;
  metadata?: Record<string, unknown>;
}

interface ImpulseResolution {
  impulse_id: string;
  resolver_id: string;
  resolver_tier: 'deterministic' | 'pattern' | 'llm';
  vessel_id: string;
  latency_ms: number;
  cost_usd: number;
  success?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for runtime tracing
 */
export interface RuntimeTracingConfig {
  enabled: boolean;
  level: 'request' | 'function' | 'full';
  sampleRate: number; // 0.0 to 1.0
  storeEndpoint: string;
  vesselId: string;
}

/**
 * Activity context for tracking resolutions within a single request
 */
export class RuntimeActivityContext {
  private resolutions: ImpulseResolution[] = [];
  private startTime: number;
  private inputImpulse?: Impulse;
  private outputImpulse?: Impulse;

  constructor(
    public activityId: string,
    public activityTemplateId: string,
    public vesselId: string
  ) {
    this.startTime = Date.now();
  }

  setInputImpulse(impulse: Impulse) {
    this.inputImpulse = impulse;
  }

  setOutputImpulse(impulse: Impulse) {
    this.outputImpulse = impulse;
  }

  recordResolution(resolution: Omit<ImpulseResolution, 'vessel_id'>) {
    this.resolutions.push({
      ...resolution,
      vessel_id: this.vesselId
    });
  }

  async finish(success: boolean, statusCode?: number): Promise<RuntimeExecutionTrace> {
    return {
      id: this.activityId,
      activity_template_id: this.activityTemplateId,
      vessel_id: this.vesselId,
      impulse_resolutions: this.resolutions,
      duration_ms: Date.now() - this.startTime,
      total_cost_usd: this.resolutions.reduce((sum, r) => sum + (r.cost_usd || 0), 0),
      success,
      metadata: {
        runtime_trace: true,
        status_code: statusCode,
        input_impulse_id: this.inputImpulse?.id,
        output_impulse_id: this.outputImpulse?.id,
        resolver_count: this.resolutions.length
      }
    };
  }
}

/**
 * Execution trace format (same as development activities)
 */
export interface RuntimeExecutionTrace {
  id: string;
  activity_template_id: string;
  vessel_id: string;
  impulse_resolutions: ImpulseResolution[];
  duration_ms: number;
  total_cost_usd: number;
  success: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Middleware: Request-level tracing
 *
 * Traces entire HTTP requests as activities.
 * Low overhead (~1ms per request).
 */
export function runtimeTracingMiddleware(config: RuntimeTracingConfig) {
  return async (c: Context, next: Next) => {
    if (!config.enabled) {
      return next();
    }

    // Sample requests based on configured rate
    if (Math.random() > config.sampleRate) {
      return next();
    }

    const activityId = `runtime_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const activityTemplateId = `http_${c.req.method.toLowerCase()}_${c.req.path.replace(/\//g, '_')}`;

    const context = new RuntimeActivityContext(activityId, activityTemplateId, config.vesselId);

    // Create input impulse from request
    const inputImpulse: Impulse = {
      id: `${activityId}_input`,
      pointer: {
        type: 'memo',
        content: JSON.stringify({
          method: c.req.method,
          path: c.req.path,
          headers: Object.fromEntries(c.req.raw.headers.entries()),
          query: c.req.query()
        })
      },
      budget: 10000,
      priority: 'medium',
      loaded: true,
      metadata: {
        shape: 'http_request',
        method: c.req.method,
        path: c.req.path
      }
    };

    context.setInputImpulse(inputImpulse);

    // Store context for downstream resolvers
    c.set('runtimeContext', context);

    let success = true;
    let statusCode = 200;

    try {
      await next();

      statusCode = c.res.status;
      success = statusCode < 400;

      // Create output impulse from response
      const outputImpulse: Impulse = {
        id: `${activityId}_output`,
        pointer: {
          type: 'memo',
          content: JSON.stringify({
            status: c.res.status,
            headers: Object.fromEntries(c.res.headers.entries())
            // Note: Don't include body (could be large)
          })
        },
        budget: 10000,
        priority: 'medium',
        loaded: true,
        metadata: {
          shape: 'http_response',
          status: c.res.status
        }
      };

      context.setOutputImpulse(outputImpulse);

    } catch (error) {
      success = false;
      statusCode = 500;
      throw error;
    } finally {
      // Store trace asynchronously (non-blocking)
      const trace = await context.finish(success, statusCode);
      storeTraceAsync(trace, config.storeEndpoint).catch(err => {
        console.error('[RuntimeTracing] Failed to store trace:', err);
      });
    }
  };
}

/**
 * Wrapper: Function-level tracing
 *
 * Wraps individual functions to track as resolvers.
 * Medium overhead (~0.5ms per call).
 *
 * Usage:
 * ```ts
 * const tracedQuery = withResolver('surrealdb_query', 'deterministic', queryDatabase);
 * const result = await tracedQuery(sql, params, c);
 * ```
 */
export function withResolver<TArgs extends any[], TReturn>(
  resolverId: string,
  tier: 'deterministic' | 'pattern' | 'llm',
  fn: (...args: [...TArgs, Context]) => Promise<TReturn>
) {
  return async (...args: [...TArgs, Context]): Promise<TReturn> => {
    const c = args[args.length - 1] as Context;
    const context = c.get('runtimeContext') as RuntimeActivityContext | undefined;

    // If no runtime context, execute without tracing
    if (!context) {
      return fn(...args);
    }

    const startTime = Date.now();
    const impulseId = `${resolverId}_${Date.now()}`;

    try {
      const result = await fn(...args);

      context.recordResolution({
        impulse_id: impulseId,
        resolver_id: resolverId,
        resolver_tier: tier,
        latency_ms: Date.now() - startTime,
        cost_usd: tier === 'llm' ? estimateLLMCost(result) : 0
      });

      return result;
    } catch (error) {
      context.recordResolution({
        impulse_id: impulseId,
        resolver_id: resolverId,
        resolver_tier: tier,
        latency_ms: Date.now() - startTime,
        cost_usd: 0,
        metadata: {
          error: String(error),
          success: false
        }
      });
      throw error;
    }
  };
}

/**
 * Store trace asynchronously to avoid blocking request
 */
async function storeTraceAsync(trace: RuntimeExecutionTrace, endpoint: string): Promise<void> {
  try {
    const response = await fetch(`${endpoint}/v2/activities/execution-traces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `ApiKey ${process.env.METABOB_API_KEY}`
      },
      body: JSON.stringify({
        ...trace,
        created_at: new Date().toISOString()
      })
    });

    if (!response.ok) {
      console.error('[RuntimeTracing] Failed to store trace:', response.statusText);
    }
  } catch (error) {
    console.error('[RuntimeTracing] Store trace error:', error);
  }
}

/**
 * Estimate LLM cost from response (placeholder)
 */
function estimateLLMCost(result: unknown): number {
  // Would need actual token counting logic
  return 0.001;
}

/**
 * Example: Instrumenting Activity-API routes
 */

/*
// In src/index.ts:

import { runtimeTracingMiddleware } from './middleware/runtime-tracing';

const config: RuntimeTracingConfig = {
  enabled: process.env.RUNTIME_TRACING_ENABLED === 'true',
  level: 'function',
  sampleRate: process.env.NODE_ENV === 'production' ? 0.01 : 0.1, // 1% prod, 10% canary
  storeEndpoint: process.env.METABOB_ENDPOINT || 'https://activity.metabob.com',
  vesselId: process.env.HOSTNAME || 'activity-api-unknown'
};

app.use('*', runtimeTracingMiddleware(config));

// In src/routes/activities.ts:

import { withResolver } from '../middleware/runtime-tracing';

// Original
async function fetchTemplates(db: SurrealDB) {
  return await db.query('SELECT * FROM activity_template');
}

// Traced
const fetchTemplatesTraced = withResolver(
  'surrealdb_fetch_templates',
  'deterministic',
  async (db: SurrealDB, c: Context) => {
    return await db.query('SELECT * FROM activity_template');
  }
);

// In route handler
app.get('/v2/activities/templates', async (c) => {
  const db = await createAuthenticatedClient(c);
  const templates = await fetchTemplatesTraced(db, c);
  return c.json(templates);
});
*/

/**
 * Dashboard Queries for Runtime Traces
 */

export const RUNTIME_QUERIES = {
  // Most frequently executed activities (hot paths)
  hotPaths: `
    SELECT
      activity_template_id,
      COUNT() as execution_count,
      AVG(duration_ms) as avg_duration_ms,
      math::percentile(duration_ms, 0.95) as p95_duration_ms,
      SUM(success = false) as failure_count
    FROM execution
    WHERE metadata.runtime_trace = true
      AND created_at > time::now() - 7d
    GROUP BY activity_template_id
    ORDER BY execution_count DESC
    LIMIT 20;
  `,

  // Resolver performance (bottlenecks)
  resolverPerformance: `
    SELECT
      resolution.resolver_id as resolver_id,
      resolution.resolver_tier as tier,
      COUNT() as call_count,
      AVG(resolution.latency_ms) as avg_latency_ms,
      math::percentile(resolution.latency_ms, 0.95) as p95_latency_ms,
      SUM(resolution.cost_usd) as total_cost_usd,
      call_count * avg_latency_ms as total_time_ms
    FROM execution,
         execution.impulse_resolutions as resolution
    WHERE execution.metadata.runtime_trace = true
      AND execution.created_at > time::now() - 7d
    GROUP BY resolver_id, tier
    ORDER BY total_time_ms DESC
    LIMIT 20;
  `,

  // Error patterns by endpoint
  errorPatterns: `
    SELECT
      activity_template_id,
      metadata.status_code as status_code,
      COUNT() as error_count,
      array::unique(
        SELECT resolver_id
        FROM impulse_resolutions
        WHERE metadata.error IS NOT EMPTY
      ) as failing_resolvers
    FROM execution
    WHERE metadata.runtime_trace = true
      AND success = false
      AND created_at > time::now() - 7d
    GROUP BY activity_template_id, status_code
    ORDER BY error_count DESC;
  `,

  // Reuse opportunities
  reuseOpportunities: `
    SELECT
      resolution.resolver_id as resolver_id,
      COUNT(DISTINCT execution.activity_template_id) as used_in_activities,
      COUNT() as total_calls,
      total_calls / used_in_activities as reuse_factor
    FROM execution,
         execution.impulse_resolutions as resolution
    WHERE execution.metadata.runtime_trace = true
      AND execution.created_at > time::now() - 7d
    GROUP BY resolver_id
    HAVING used_in_activities > 3
    ORDER BY reuse_factor DESC
    LIMIT 20;
  `
};
