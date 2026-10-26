/**
 * NAMED SCOPES FOR THE DATABASE- AND TEMPLATE-ADMINISTRATION SURFACES.
 *
 * db_admin (DDL, apply_migration, REMOVE TABLE via reconcile), the FTS rebuild, and the template lifecycle routes
 * (retire-malformed, auto-promote, /templates/:id/promote) used to require only that the caller was authenticated:
 * any key of any org, or a person's on-behalf-of token, could alter the schema or promote and retire templates every
 * org selects from. Each now requires a named scope, checked in its handler, the way policy:write (tuning-params) and
 * verdict:human (label writes) already are:
 *   - db:admin        db_admin and /internal/fts-rebuild
 *   - templates:admin /templates/retire-malformed, /templates/auto-promote, /templates/:templateId/promote
 * The `admin` scope satisfies both, as it does policy:write.
 *
 * The scopes are identity's server-validated answer for an API key (JwtAuthContext.scopes, set by the auth middleware,
 * never read from a request body). The principal must be a key: an on-behalf-of token (a person through a federated
 * surface) is refused even when it carries the scope, and so is a context with no key id. Missing or malformed scopes
 * are refused (fail closed).
 */
import type { JwtAuthContext } from '../middleware/jwtAuth';

export const DB_ADMIN_SCOPE = 'db:admin';
export const TEMPLATES_ADMIN_SCOPE = 'templates:admin';
export const ADMIN_SCOPE = 'admin';

export type AdminScope = typeof DB_ADMIN_SCOPE | typeof TEMPLATES_ADMIN_SCOPE;

export function holdsAdminScope(ctx: JwtAuthContext | null | undefined, scope: AdminScope): boolean {
  if (!ctx) return false;
  if (ctx.obo) return false;
  if (typeof ctx.keyId !== 'string' || ctx.keyId.trim().length === 0) return false;
  const scopes = Array.isArray(ctx.scopes) ? ctx.scopes : [];
  return scopes.includes(scope) || scopes.includes(ADMIN_SCOPE);
}

/** The refusal body every gated route answers with (403). */
export function scopeRefusal(scope: AdminScope): { error: { code: 'SCOPE_REQUIRED'; message: string; required_scope: AdminScope } } {
  return { error: { code: 'SCOPE_REQUIRED', message: `this operation requires the "${scope}" scope (or "admin") on an API key`, required_scope: scope } };
}
