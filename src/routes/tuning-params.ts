/**
 * Tuning-params route — the WRITE seam for runtime-consumable learning-policy
 * hyperparameters (seam 2a write-back).
 *
 * `src/lib/tuning-params.ts` `getTuningParam` READS the `substrate_tuning_param`
 * table (migration 152) with a short TTL cache; nothing wrote it until this seam.
 * This route lets an authorised caller (the development-vessel reflect tick)
 * author a tuning row so a learning-policy recommendation actually ACTUATES on
 * the learner — closing the "reflect adjusts the learner" loop.
 *
 *   POST /v2/tuning-params
 *   { "name": "TD_LAMBDA", "value": 0.72, "updated_by": "learning-policy-writeback", "evidence": "..." }
 *
 * Validation: `name` non-empty string, `value` finite number. On success it
 * UPSERTs via `writeTuningParam` (which also drops the getTuningParam cache
 * entry for `name`) and echoes the stored row summary.
 */

import { Hono } from 'hono';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { writeTuningParam } from '../lib/tuning-params';

const app = new Hono();

/**
 * GET /v2/tuning-params/:name — read the currently-authored value for one
 * parameter (or null when no row exists). Lets a write-back tick compare the
 * recommended value against the stored one and skip a no-op UPSERT. `value` is
 * backtick-quoted (reserved word) and aliased.
 */
app.get('/:name', async (c) => {
  const name = c.req.param('name');
  try {
    const rows = await surrealDB.query<{ param_value: number | null }>(
      'SELECT `value` AS param_value FROM substrate_tuning_param WHERE name = $name LIMIT 1',
      { name },
    );
    const value =
      rows && rows.length > 0 && typeof rows[0].param_value === 'number'
        ? rows[0].param_value
        : null;
    return c.json({ name, value }, 200);
  } catch (err) {
    logger.error('tuning param read failed', {
      event: 'tuning_param_read_failed',
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ name, value: null }, 200);
  }
});

interface TuningParamWriteBody {
  name?: unknown;
  value?: unknown;
  updated_by?: unknown;
  evidence?: unknown;
}

app.post('/', async (c) => {
  let body: TuningParamWriteBody;
  try {
    body = (await c.req.json()) as TuningParamWriteBody;
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const name = body.name;
  const value = body.value;
  if (typeof name !== 'string' || name.length === 0) {
    return c.json({ error: 'name must be a non-empty string' }, 400);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return c.json({ error: 'value must be a finite number' }, 400);
  }

  const updated_by = typeof body.updated_by === 'string' ? body.updated_by : undefined;
  const evidence = typeof body.evidence === 'string' ? body.evidence : undefined;

  try {
    await writeTuningParam(name, value, { updated_by, evidence });
  } catch (err) {
    logger.error('writeTuningParam failed', {
      event: 'tuning_param_write_failed',
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: 'failed to write tuning param' }, 500);
  }

  logger.info('tuning param authored', {
    event: 'tuning_param_written',
    name,
    value,
    updated_by: updated_by ?? null,
  });

  return c.json({ ok: true, name, value, updated_by: updated_by ?? null }, 200);
});

export default app;
