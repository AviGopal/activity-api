/**
 * THE context_thompson_scores LANE OF THE POSTERIOR AGGREGATOR (CHANGE DB2; gap
 * context-posterior-upsert-is-read-then-create-so-hot-rows-contend-and-duplicate).
 *
 * Every ingested trace wrote up to six cts rows, each its own query and none in a transaction: repair-v2, the v1
 * leaf (with a per-trace count() GROUP ALL for the cardinality cap), the v1 cluster row, and up to four ancestors
 * and their cluster rows. The leaf, repair and ancestor writes were `LET $existing = SELECT …; IF … UPDATE ELSE
 * CREATE`, and a multi-statement script runs each top-level statement as its own implicit transaction, so the
 * SELECT -> CREATE was never atomic: hot rows contended (absorbed by the 4x conflict retry) and new keys could
 * duplicate. Measured on node1 (2 h to 2026-10-16T07:54Z): 3.7 cts conflicts per run-goal start.
 *
 * Now each write is a DELTA enqueued here, keyed by (org, template, signature_version, bucket) or, for a cluster row,
 * by its deterministic slug id; deltas to one key are summed in the aggregator's existing buffer, and every flush
 * applies ALL pending keys in ONE BEGIN … COMMIT, each key as ONE `UPSERT … WHERE` (verified on 2.3.10 with the real
 * schema, 2026-10-16: a pre-existing random-id row is updated in place, siblings sharing an index prefix untouched,
 * 20 concurrent upserts on one key leave one row with the exact sum). Decay rides inside the expression. The
 * cardinality cap is evaluated once per distinct capped template per flush, inside the same transaction.
 *
 * A LEARNING EDGE IS NEVER FIRE-AND-FORGET: a failed flush is logged and counted and its deltas are merged back and
 * retried on the next flush; the aggregator's shutdown hook flushes this lane too; counters expose pending, flushed,
 * failed and capped. With coalescing off (POSTERIOR_COALESCE), the same one-key statement is applied directly.
 */
import { logger } from '../utils/logger';

export type ContextLaneKind = 'leaf' | 'repair' | 'ancestor' | 'cluster';
export interface ContextDelta {
  kind: ContextLaneKind;
  orgId: string;
  templateId: string;
  signatureVersion: number;
  bucket: string;
  alpha: number;
  beta: number;
  /** Decay the stored alpha/beta toward (1,1) with this half-life before adding (the v1 leaf); absent: no decay. */
  halfLifeSecs?: number;
  /** A new bucket is created only while the template has fewer than this many buckets at this version (the v1 leaf). */
  cap?: number;
  /** The prior a NEW row starts from (seedPriorFromConcepts); default (1,1). */
  alpha0?: number;
  beta0?: number;
  /** Cluster rows: their deterministic record id (clusterRowSlug) and cluster id; written by id, not WHERE. */
  slug?: string;
  clusterId?: string;
}
interface Pending extends ContextDelta { n: number }

export interface Queryable { query: (sql: string, params?: Record<string, unknown>) => Promise<unknown> }

const pending = new Map<string, Pending>();
const stats = { enqueued: 0, keys_flushed: 0, flushes: 0, failed_flushes: 0, direct_writes: 0, direct_failed: 0 };
export function contextLaneStats(): Readonly<typeof stats & { pending_keys: number }> { return { ...stats, pending_keys: pending.size }; }
export function contextLanePendingCount(): number { return pending.size; }
export function __resetContextLaneForTests(): void { pending.clear(); for (const k of Object.keys(stats) as Array<keyof typeof stats>) stats[k] = 0; }

const keyOf = (d: ContextDelta): string => (d.slug ? `slug|${d.slug}` : `${d.kind}|${d.orgId}|${d.templateId}|${d.signatureVersion}|${d.bucket}`);

/** Sum a delta into the pending buffer. */
export function enqueueContextDelta(d: ContextDelta): void {
  if (d.alpha === 0 && d.beta === 0) return;
  stats.enqueued += 1;
  const k = keyOf(d);
  const cur = pending.get(k);
  if (cur) { cur.alpha += d.alpha; cur.beta += d.beta; cur.n += 1; return; }
  pending.set(k, { ...d, n: 1 });
}

/** One key's statement, with its parameters prefixed `${p}_`. The UPSERT is the whole write: no read-then-create. */
export function contextUpsertSql(d: Pending, p: string, capVar?: string): { sql: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {
    [`${p}_org`]: d.orgId, [`${p}_tpl`]: d.templateId, [`${p}_ver`]: d.signatureVersion, [`${p}_bucket`]: d.bucket,
    [`${p}_da`]: d.alpha, [`${p}_db`]: d.beta, [`${p}_n`]: d.n, [`${p}_a0`]: d.alpha0 ?? 1, [`${p}_b0`]: d.beta0 ?? 1,
  };
  const decayed = (f: 'alpha' | 'beta', prior: string): string => d.halfLifeSecs && d.halfLifeSecs > 0
    ? `IF ${f} IS NONE THEN ${prior} ELSE 1 + (${f} - 1) * math::pow(0.5, math::max([0, time::unix(time::now()) - time::unix(last_updated_at ?? time::now())]) / $${p}_hl) END`
    : `(${f} ?? ${prior})`;
  if (d.halfLifeSecs && d.halfLifeSecs > 0) params[`${p}_hl`] = d.halfLifeSecs;
  const set = `org_id = $${p}_org, template_id = $${p}_tpl, signature_version = $${p}_ver, context_bucket = $${p}_bucket,
      alpha = ${decayed('alpha', `$${p}_a0`)} + $${p}_da,
      beta = ${decayed('beta', `$${p}_b0`)} + $${p}_db,
      n_observations = (n_observations ?? 0) + $${p}_n,
      last_updated_at = time::now(), created_at = created_at ?? time::now()`;
  if (d.slug) {
    params[`${p}_slug`] = d.slug; params[`${p}_cluster`] = d.clusterId ?? null;
    return { sql: `UPSERT type::thing('context_thompson_scores', $${p}_slug) SET ${set}, cluster_id = $${p}_cluster;`, params };
  }
  const where = `WHERE org_id = $${p}_org AND template_id = $${p}_tpl AND signature_version = $${p}_ver AND context_bucket = $${p}_bucket`;
  const upsert = `UPSERT context_thompson_scores SET ${set} ${where}`;
  if (capVar === undefined) return { sql: `${upsert};`, params };
  // A NEW bucket only while under the cap; an existing one is always updated.
  return { sql: `IF array::len((SELECT id FROM context_thompson_scores ${where} LIMIT 1)) > 0 OR ${capVar} < $${p}_cap THEN (${upsert}) END;`, params: { ...params, [`${p}_cap`]: d.cap } };
}

/** ONE transaction over every given key, the cap counted once per distinct capped (org, template, version). */
export function contextFlushSql(batch: Pending[]): { sql: string; params: Record<string, unknown> } {
  const parts: string[] = ['BEGIN TRANSACTION;'];
  let params: Record<string, unknown> = {};
  const capVars = new Map<string, string>();
  batch.forEach((d, i) => {
    let capVar: string | undefined;
    if (!d.slug && typeof d.cap === 'number') {
      const ck = `${d.orgId}|${d.templateId}|${d.signatureVersion}`;
      capVar = capVars.get(ck);
      if (!capVar) {
        capVar = `$card${capVars.size}`;
        capVars.set(ck, capVar);
        const c = `c${capVars.size - 1}`;
        params = { ...params, [`${c}_org`]: d.orgId, [`${c}_tpl`]: d.templateId, [`${c}_ver`]: d.signatureVersion };
        parts.push(`LET ${capVar} = (SELECT count() FROM context_thompson_scores WHERE org_id = $${c}_org AND template_id = $${c}_tpl AND signature_version = $${c}_ver GROUP ALL)[0].count ?? 0;`);
      }
    }
    const s = contextUpsertSql(d, `k${i}`, capVar);
    parts.push(s.sql);
    params = { ...params, ...s.params };
  });
  parts.push('COMMIT TRANSACTION;');
  return { sql: parts.join('\n'), params };
}

/** Apply every pending key in one transaction. On failure: logged, counted, and the deltas merged back for the next flush. */
export async function flushContextLane(db: Queryable): Promise<void> {
  if (pending.size === 0) return;
  const batch = [...pending.values()];
  pending.clear();
  const { sql, params } = contextFlushSql(batch);
  try {
    await db.query(sql, params);
    stats.flushes += 1;
    stats.keys_flushed += batch.length;
  } catch (err) {
    stats.failed_flushes += 1;
    for (const d of batch) {
      const k = keyOf(d);
      const cur = pending.get(k);
      if (cur) { cur.alpha += d.alpha; cur.beta += d.beta; cur.n += d.n; } else pending.set(k, d);
    }
    logger.warn('[posterior-aggregator] context lane flush FAILED: deltas kept for the next flush', {
      keys: batch.length, failed_flushes: stats.failed_flushes, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Coalescing off: the same one-key statement, applied now (a single UPSERT is itself atomic). Never throws. */
export async function applyContextDeltaNow(db: Queryable, d: ContextDelta): Promise<boolean> {
  if (d.alpha === 0 && d.beta === 0) return true;
  const { sql, params } = contextFlushSql([{ ...d, n: 1 }]);
  try { await db.query(sql, params); stats.direct_writes += 1; return true; }
  catch (err) {
    stats.direct_failed += 1;
    logger.warn('[posterior-aggregator] context posterior write failed', { kind: d.kind, template_id: d.templateId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
