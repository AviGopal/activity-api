/**
 * Tuning-params route — the WRITE seam for runtime-consumable learning-policy
 * hyperparameters (seam 2a write-back).
 *
 * `src/lib/tuning-params.ts` `getTuningParam` READS the `substrate_tuning_param`
 * table (migration 152) with a short TTL cache; nothing wrote it until this seam.
 * This route lets a caller author a tuning row so a learning-policy
 * recommendation actually ACTUATES on the learner — closing the "reflect
 * adjusts the learner" loop.
 *
 *   POST /v2/tuning-params
 *   { "name": "TD_LAMBDA", "value": 0.72, "evidence": "..." }
 *
 * Validation: `name` non-empty string, `value` finite number. On success it
 * UPSERTs via `writeTuningParam` (which also drops the getTuningParam cache
 * entry for `name`) and echoes the stored row summary.
 *
 * WHO MAY WRITE WHICH ROW. Some rows are gate inputs: a gate, judge or verdict
 * reads them (the auto-revert guard thresholds, the retirement thresholds, the
 * pull-sync landing pacing, ...). Behind only the global /v2/* auth, any
 * authenticated key — a vessel's or a goal walk's service key included — could
 * loosen the gates that judge its own work. The closed set of those rows is
 * GATE_INPUT_ROWS in src/policy/gate-input-rows.ts (a closed file, built from
 * the rows closed readers read). Writing one needs isPolicyWritePrincipal(ctx),
 * read from the JwtAuthContext the auth middleware set from the server-side
 * validation of the credential, never from the body:
 *   - scopes include POLICY_WRITE_SCOPE, or ADMIN_SCOPE as the interim fallback
 *     until policy-scoped keys are issued;
 *   - keyId present;
 *   - not obo: a federated on-behalf-of caller is a peer node's grant, not a
 *     policy author at this node.
 * Role and userId are not read: the operator's key and the node keys share one
 * principal and differ only in issued scopes (same measurement as the label
 * write, goal-verification-label-write.ts). No allow-list, no env gate (law 1):
 * who holds policy:write is decided where keys are issued. Unknown, missing or
 * malformed means refused (fail closed).
 *
 * Every other row (the learning knobs, e.g. TD_LAMBDA / YIELD_FLOOR that the
 * development-vessel learningPolicyWriteback tick authors) stays writable by
 * any authenticated key, so the system keeps tuning its own learner, but a
 * LEARNING_ROWS value must fall inside LEARNING_ROW_BOUNDS (closed file):
 * outside it is refused 422, naming the bound, for EVERY caller, policy:write
 * and admin included. Moving the envelope is a code change, not a write.
 *
 * No write from an on-behalf-of (federated) caller, on any row: a peer node's
 * grant does not author this node's learning policy.
 *
 * Attribution, for every row: `updated_by` is the SERVER-DERIVED key id; a
 * credential without one is refused (nothing to attribute the write to). A
 * body `updated_by` is not attribution: it is only logged, as
 * `claimed_updated_by`. Body `scopes` are never read.
 *
 * In-process writers (jobs/accelerator-flag-tick.ts) call writeTuningParam
 * directly and are unaffected. Reads (GET /:name) stay open to any
 * authenticated caller.
 */

import { Hono } from 'hono';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { writeTuningParam } from '../lib/tuning-params';
import { getJwtAuthFromContext, type JwtAuthContext } from '../middleware/jwtAuth';
import { isGateInputRow, learningRowBoundViolation } from '../policy/gate-input-rows';

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

export const POLICY_WRITE_SCOPE = 'policy:write';
export const ADMIN_SCOPE = 'admin';

export function isPolicyWritePrincipal(ctx: JwtAuthContext | null | undefined): boolean {
  if (!ctx) return false;
  if (ctx.obo) return false;
  if (typeof ctx.keyId !== 'string' || ctx.keyId.trim().length === 0) return false;
  const scopes = Array.isArray(ctx.scopes) ? ctx.scopes : [];
  return scopes.includes(POLICY_WRITE_SCOPE) || scopes.includes(ADMIN_SCOPE);
}

interface TuningParamWriteBody {
  name?: unknown;
  value?: unknown;
  /** Logged only (claimed_updated_by); never attribution. */
  updated_by?: unknown;
  evidence?: unknown;
}

app.post('/', async (c) => {
  // Nothing is written before every check below has passed.
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'authentication required' }, 401);
  }
  if (auth.obo) {
    logger.warn('tuning param write REFUSED: on-behalf-of caller', {
      event: 'tuning_param_write_refused',
      key_id: auth.keyId ?? null,
      obo_node: auth.obo.node ?? null,
    });
    return c.json({ error: 'an on-behalf-of (federated) caller cannot write tuning params at this node' }, 403);
  }

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

  const gateInput = isGateInputRow(name);
  if (gateInput && !isPolicyWritePrincipal(auth)) {
    logger.warn('tuning param write REFUSED: gate-input row from a credential without the policy-write scope', {
      event: 'tuning_param_write_refused',
      name,
      key_id: auth.keyId ?? null,
      auth_type: auth.authType ?? null,
      obo: auth.obo ? true : false,
    });
    return c.json({
      error: `"${name}" is a gate-input row: writing it requires a credential issued with the "${POLICY_WRITE_SCOPE}" scope (or "${ADMIN_SCOPE}"), attributable by key id and not on-behalf-of a peer node`,
    }, 403);
  }
  if (typeof auth.keyId !== 'string' || auth.keyId.trim().length === 0) {
    return c.json({ error: 'writing a tuning param requires a credential with a server-derived key id (the write is attributed to it)' }, 403);
  }
  const keyId = auth.keyId;

  // The learning-row envelope applies to every caller (policy:write and admin included).
  const bound = learningRowBoundViolation(name, value);
  if (bound) {
    logger.warn('tuning param write REFUSED: value outside the learning-row envelope', {
      event: 'tuning_param_write_out_of_bounds',
      name,
      value,
      min: bound.min,
      max: bound.max,
      key_id: keyId,
    });
    return c.json({
      error: `${name} = ${value} is outside its envelope [${bound.min}, ${bound.max}] (LEARNING_ROW_BOUNDS, src/policy/gate-input-rows.ts); the envelope applies to every caller and changes only by a code change`,
    }, 422);
  }

  const claimed_updated_by = typeof body.updated_by === 'string' ? body.updated_by : null;
  const updated_by = keyId;
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
    updated_by,
    gate_input: gateInput,
    auth_type: auth.authType ?? null,
    claimed_updated_by,
  });

  return c.json({ ok: true, name, value, updated_by }, 200);
});

export default app;
