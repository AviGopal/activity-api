/**
 * The context_thompson_scores writes a set of recorded db calls made (CHANGE DB2). Before DB2 each cts write was its
 * own call with `activity_id` / `sig` / `sig_version` / `alpha_delta` / `beta_delta` parameters; through the
 * posterior aggregator's cts lane, one transaction carries every key as `k<i>_tpl` / `k<i>_bucket` / `k<i>_ver` /
 * `k<i>_da` / `k<i>_db` / `k<i>_org`. Tests that assert which rows were written read both forms through this.
 */
export interface CtsWrite { activity_id?: unknown; org_id?: unknown; sig?: unknown; sig_version?: unknown; alpha_delta?: unknown; beta_delta?: unknown }
export function ctsWrites(calls: Array<{ sql: string; params?: Record<string, unknown> }>): CtsWrite[] {
  const out: CtsWrite[] = [];
  for (const c of calls) {
    if (!/(CREATE|UPSERT) context_thompson_scores/.test(c.sql)) continue;
    const p = c.params ?? {};
    const keys = Object.keys(p).filter((k) => /^k\d+_tpl$/.test(k)).map((k) => k.slice(0, -'_tpl'.length));
    if (keys.length === 0) { out.push({ activity_id: p.activity_id, org_id: p.org_id, sig: p.sig, sig_version: p.sig_version, alpha_delta: p.alpha_delta, beta_delta: p.beta_delta }); continue; }
    for (const k of keys) out.push({ activity_id: p[`${k}_tpl`], org_id: p[`${k}_org`], sig: p[`${k}_bucket`], sig_version: p[`${k}_ver`], alpha_delta: p[`${k}_da`], beta_delta: p[`${k}_db`] });
  }
  return out;
}
