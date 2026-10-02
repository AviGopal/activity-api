// THE ONE RULE FOR A DETERMINISTIC VERDICT TOKEN.
//
// ONE COPY, VENDORED. packages/verdict-token/verdict-token.ts is canonical;
// activity-api/src/lib/verdict-token.ts and development-vessel/src/lib/verdict-token.ts
// are byte-identical copies (validation/scripts/verdict-token-copies.test.ts asserts it).
// Vessels cannot import packages/ at runtime. Zero dependencies.
//
// Why one rule: activity-api STAMPS a failure class `deterministic:<token>` on a trace,
// and development-vessel FILES one gap per class as `verdict-class-<token>`. If the two
// accepted different tokens, a stamped class could be one the filer refuses forever (or
// one the gap store's volatile-token stripping collapses onto another class's row).
// A token is accepted only when it is canonical AND carries nothing the gap store's
// gapClassKey would rewrite (a uuid, a date, an ISO timestamp, a 10+ digit epoch), so
// `verdict-class-<token>` is a stable, unique row id by construction.
//
// FAIL CLOSED: anything else is not a token. A reason whose head is
// `deterministic:` followed by a non-canonical run is NOT cut to a canonical prefix
// (`deterministic:foo.bar` is not `foo`): it is refused whole. The token alphabet is
// lowercase alphanumerics, `_` and `-` (see CANONICAL).

export const VERDICT_CLASS_PREFIX = "deterministic:";

/**
 * 2..64 chars: lowercase alphanumerics, underscores and single hyphens, alphanumeric at both
 * ends. Underscores are canonical because goal-host emits them on not-reached verdicts
 * (hollow_walklog_capped, grep_files-mismatch, avg_lines-mismatch, total_lines-mismatch), and
 * gapClassKey leaves `_` alone.
 */
const CANONICAL = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])$/;

/** What the gap store's gapClassKey strips as volatile, plus any 8+ digit run. */
const VOLATILE: readonly RegExp[] = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  /\d{4}-\d{2}-\d{2}/,
  /\d{8}/,
];

/** A token both repos accept: canonical, no double hyphen, nothing volatile. */
export function isVerdictToken(token: unknown): token is string {
  if (typeof token !== "string" || !CANONICAL.test(token) || token.includes("--")) return false;
  return !VOLATILE.some((re) => re.test(token));
}

/** The token of an exact class string `deterministic:<token>`, else null. */
export function verdictTokenOfClass(cls: unknown): string | null {
  if (typeof cls !== "string" || !cls.startsWith(VERDICT_CLASS_PREFIX)) return null;
  const token = cls.slice(VERDICT_CLASS_PREFIX.length);
  return isVerdictToken(token) ? token : null;
}

/**
 * The token at the head of a verdict reason: `deterministic:` then a run that ends at
 * whitespace, an em/en dash, an opening parenthesis, or the end of the reason. The WHOLE
 * run must be a token; a run carrying anything else (a dot, a colon, a slash, a capital)
 * is refused, never truncated to its canonical prefix.
 */
export function verdictTokenOfReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const r = reason.trim();
  if (!r.startsWith(VERDICT_CLASS_PREFIX)) return null;
  const rest = r.slice(VERDICT_CLASS_PREFIX.length);
  const end = rest.search(/[\s—–(]/);
  const run = end < 0 ? rest : rest.slice(0, end);
  return isVerdictToken(run) ? run : null;
}
