/**
 * LLM-router learning route — the read + write seam for the goal-host per-task-type
 * LLM router's Thompson state (`llm_router_decisions`, migration 155).
 *
 * The router in goal-host picks WHICH llm-resolver vessel (== which model) serves
 * each internal reasoning call, keyed on TASK TYPE. It:
 *   - GET /v2/llm-router/candidates?task_type=X  → the per-vessel Beta(α,β) + cost
 *     arms it samples over at selection time (empty ⇒ uniform Beta(1,1) prior).
 *   - POST /v2/llm-router/feedback               → records one outcome at dispatch
 *     end: α+1 if the goal reached, β+1 if hollow, plus cumulative latency/cost.
 *
 * Cumulative SUMS (not means) are stored so concurrent += UPSERTs never
 * read-modify-write an average; the GET derives avg = sum / sample_count.
 * PERMISSIONS FULL table (substrate learning state) — reads/writes go through the
 * root surreal client like the other single-purpose learning routes.
 */

import { Hono } from 'hono';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';

const app = new Hono();

interface RouterArmRow {
  vessel_id: string;
  alpha: number;
  beta: number;
  sample_count: number;
  sum_latency_ms: number;
  sum_cost_usd: number;
}

/**
 * GET /v2/llm-router/candidates?task_type=X
 * Returns every learned arm for the task type. Arms with no row simply don't
 * appear — the caller treats a missing arm as the uniform Beta(1,1) prior, so a
 * brand-new vessel is explored on equal footing.
 */
app.get('/candidates', async (c) => {
  const taskType = c.req.query('task_type');
  if (!taskType || taskType.length === 0) {
    return c.json({ error: 'task_type query param is required' }, 400);
  }
  try {
    const rows = await surrealDB.query<RouterArmRow>(
      `SELECT vessel_id, alpha, beta, sample_count, sum_latency_ms, sum_cost_usd
       FROM llm_router_decisions WHERE task_type = $taskType`,
      { taskType },
    );
    const candidates = (Array.isArray(rows) ? rows : []).map((r) => ({
      vessel_id: r.vessel_id,
      alpha: typeof r.alpha === 'number' ? r.alpha : 1,
      beta: typeof r.beta === 'number' ? r.beta : 1,
      sample_count: typeof r.sample_count === 'number' ? r.sample_count : 0,
      avg_latency_ms:
        r.sample_count && r.sample_count > 0 ? r.sum_latency_ms / r.sample_count : 0,
      avg_cost_usd:
        r.sample_count && r.sample_count > 0 ? r.sum_cost_usd / r.sample_count : 0,
    }));
    return c.json({ task_type: taskType, candidates }, 200);
  } catch (err) {
    logger.error('llm-router candidates read failed', {
      event: 'llm_router_candidates_failed',
      task_type: taskType,
      error: err instanceof Error ? err.message : String(err),
    });
    // Fail soft: an empty candidate set makes the router fall back to a uniform
    // pick rather than erroring the dispatch.
    return c.json({ task_type: taskType, candidates: [] }, 200);
  }
});

interface RouterFeedbackBody {
  task_type?: unknown;
  vessel_id?: unknown;
  reached?: unknown;
  latency_ms?: unknown;
  cost_usd?: unknown;
}

/**
 * POST /v2/llm-router/feedback
 * { task_type, vessel_id, reached: bool, latency_ms?: number, cost_usd?: number }
 * One Beta update for the (task_type, vessel_id) arm. reached ⇒ α+1, else β+1.
 */
app.post('/feedback', async (c) => {
  let body: RouterFeedbackBody;
  try {
    body = (await c.req.json()) as RouterFeedbackBody;
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const taskType = body.task_type;
  const vesselId = body.vessel_id;
  if (typeof taskType !== 'string' || taskType.length === 0) {
    return c.json({ error: 'task_type must be a non-empty string' }, 400);
  }
  if (typeof vesselId !== 'string' || vesselId.length === 0) {
    return c.json({ error: 'vessel_id must be a non-empty string' }, 400);
  }
  if (typeof body.reached !== 'boolean') {
    return c.json({ error: 'reached must be a boolean' }, 400);
  }

  const succ = body.reached ? 1 : 0;
  const fail = body.reached ? 0 : 1;
  const lat =
    typeof body.latency_ms === 'number' && Number.isFinite(body.latency_ms)
      ? Math.max(0, body.latency_ms)
      : 0;
  const cost =
    typeof body.cost_usd === 'number' && Number.isFinite(body.cost_usd)
      ? Math.max(0, body.cost_usd)
      : 0;

  try {
    // Null-coalescing accumulation is correct for both the create path (fields
    // unset ⇒ prior) and the update path. UNIQUE (task_type, vessel_id) index +
    // WHERE makes this a keyed UPSERT; surrealDB.query retries on write-conflict.
    await surrealDB.query(
      `UPSERT llm_router_decisions SET
         task_type = $taskType,
         vessel_id = $vesselId,
         alpha = (alpha ?? 1.0) + $succ,
         beta = (beta ?? 1.0) + $fail,
         sample_count = (sample_count ?? 0) + 1,
         sum_latency_ms = (sum_latency_ms ?? 0.0) + $lat,
         sum_cost_usd = (sum_cost_usd ?? 0.0) + $cost,
         updated_at = time::now()
       WHERE task_type = $taskType AND vessel_id = $vesselId`,
      { taskType, vesselId, succ, fail, lat, cost },
    );
    return c.json({ ok: true, task_type: taskType, vessel_id: vesselId, reached: body.reached }, 200);
  } catch (err) {
    logger.error('llm-router feedback write failed', {
      event: 'llm_router_feedback_failed',
      task_type: taskType,
      vessel_id: vesselId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Learning writes are advisory — never fail the caller's dispatch over one.
    return c.json({ ok: false, error: 'write failed' }, 200);
  }
});

export default app;
