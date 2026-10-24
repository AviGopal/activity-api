/**
 * Access log with caller attribution.
 *
 * Same two lines as hono/logger (`<-- METHOD path`, `--> METHOD path STATUS elapsed`), so anything
 * that counts calls or request-seconds from them keeps working, with ` caller=<label>` appended to
 * the outgoing line. Without it a query storm on a hot route (GET /v2/activities/templates) could
 * be counted but not traced to the vessel or node sending it.
 *
 * The label is read from the authenticated context the auth middleware set during `next()`: the
 * key id identity's validation returned (`key:<id>`), the on-behalf-of node when there is one
 * (`node:<id>`), else the user or instance id. Never the credential itself. A request with no
 * authenticated principal logs `caller=anon`.
 */

import type { Context, Next } from 'hono';
import type { JwtAuthContext } from './jwtAuth';

// Ids come from identity or from token claims: keep them to one log token of plain characters.
const clean = (v: string): string => v.replace(/[^\w.:@\-]/g, '_').slice(0, 80);

export function callerLabel(auth: JwtAuthContext | null | undefined): string {
  if (!auth) return 'anon';
  const parts: string[] = [];
  if (auth.keyId) parts.push(`key:${clean(String(auth.keyId))}`);
  else if (auth.userId) parts.push(`user:${clean(String(auth.userId))}`);
  else if (auth.instanceId) parts.push(`instance:${clean(String(auth.instanceId))}`);
  if (auth.obo?.node) parts.push(`node:${clean(String(auth.obo.node))}`);
  return parts.length > 0 ? parts.join(',') : `unidentified:${clean(String(auth.authType ?? 'unknown'))}`;
}

function elapsed(start: number): string {
  const delta = Date.now() - start;
  const s = delta < 1000 ? `${delta}ms` : `${Math.round(delta / 1000)}s`;
  return s.replace(/(\d)(?=(\d\d\d)+(?!\d))/g, '$1,');
}

export function accessLog(print: (line: string) => void = console.log) {
  return async function accessLogMiddleware(c: Context, next: Next) {
    const { method, url } = c.req;
    const path = url.slice(url.indexOf('/', 8));
    print(`<-- ${method} ${path}`);
    const start = Date.now();
    await next();
    let auth: JwtAuthContext | null | undefined;
    try { auth = (c.get as (k: string) => unknown)('jwtAuth') as JwtAuthContext | null | undefined; } catch { auth = null; }
    print(`--> ${method} ${path} ${c.res.status} ${elapsed(start)} caller=${callerLabel(auth)}`);
  };
}
