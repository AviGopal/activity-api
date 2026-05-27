/**
 * Substrate event bus publish endpoint.
 *
 * Per openspec change 2026-05-27-neutral-emitter-lifecycle-bus. Receives
 * `<source>.<noun>.<verb>` typed events from any authenticated vessel and
 * forwards them to the existing WebSocket broadcaster. Fire-and-forget on
 * the producer side — broadcaster failures are logged but never surface
 * as 5xx, because lifecycle events are best-effort observability signals
 * (durable state lives in the trace store).
 *
 * Accepts:
 *   POST /v2/events/publish
 *   {
 *     type:             string,            // must match EVENT_TYPE_REGEX
 *     source_vessel_id: string,            // emitter identity for tracing
 *     scope?:           "broadcast" | "org" | "session", // default "broadcast"
 *     target?:          string,            // sessionId or orgId when scope != broadcast
 *     data:             object             // type-specific payload, fanned out as data
 *   }
 *
 * Returns: 200 { accepted: true, ts: number } on success, 400 on malformed type.
 */

import { Hono } from 'hono';
import { broadcaster } from '../websocket/broadcaster';
import { logger } from '../utils/logger';
import { getJwtAuthFromContext } from '../middleware/jwtAuth';

const eventsRouter = new Hono();

// Dotted namespace form. All lowercase snake_case segments, 2-4 parts:
//   <domain>.<event>            (e.g. vessel.registered)
//   <domain>.<noun>.<verb>      (e.g. lifecycle.task.pre_binding)
//   <domain>.<subdomain>.<noun>.<verb>  (room for finer taxonomies)
const EVENT_TYPE_REGEX = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;

interface PublishBody {
  type?: unknown;
  source_vessel_id?: unknown;
  scope?: unknown;
  target?: unknown;
  data?: unknown;
}

eventsRouter.post('/publish', async (c) => {
  let body: PublishBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ accepted: false, error: 'invalid JSON body' }, 400);
  }

  const type = body.type;
  if (typeof type !== 'string' || !EVENT_TYPE_REGEX.test(type)) {
    return c.json({
      accepted: false,
      error: 'type must match <source>.<noun>.<verb> snake_case form',
    }, 400);
  }

  const sourceVesselId = typeof body.source_vessel_id === 'string' ? body.source_vessel_id : 'unknown';
  const scope = body.scope === 'org' || body.scope === 'session' ? body.scope : 'broadcast';
  const target = typeof body.target === 'string' ? body.target : undefined;
  const data = (body.data && typeof body.data === 'object') ? body.data as Record<string, unknown> : {};

  const ts = Date.now();
  const message = {
    type,
    timestamp: new Date(ts).toISOString(),
    data: {
      ...data,
      source_vessel_id: sourceVesselId,
    },
  };

  try {
    if (scope === 'org') {
      // Require orgId — explicit target overrides JWT scope, else fall back to JWT.
      const jwtAuth = getJwtAuthFromContext(c);
      const orgId = target ?? jwtAuth?.orgId;
      if (!orgId) {
        return c.json({ accepted: false, error: 'scope=org requires target or JWT orgId' }, 400);
      }
      broadcaster.emitToOrg(message, orgId);
    } else if (scope === 'session') {
      if (!target) {
        return c.json({ accepted: false, error: 'scope=session requires target sessionId' }, 400);
      }
      broadcaster.emitToSession(message, target);
    } else {
      broadcaster.emit(message);
    }
  } catch (err) {
    // Broadcaster failures must not propagate — bus is best-effort. Logged for
    // observability; producer sees a 200 because the event was accepted, even
    // if fan-out had a transient hiccup.
    logger.warn('Event publish: broadcaster.emit threw', {
      type,
      error: (err as Error).message,
    });
  }

  return c.json({ accepted: true, ts });
});

export default eventsRouter;
