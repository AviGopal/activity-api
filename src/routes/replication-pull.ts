/**
 * replication-pull — the read side of intra-identity-group trace replication.
 *
 * Returns FULL `execution` rows since a watermark so a peer activity-api in the
 * same identity group can pull-replicate them losslessly (idempotent UPSERT by
 * record id on the receiver). Unlike executionTraceWithSignatures (a read-
 * optimized projection), this returns rows verbatim — every learning-critical
 * field (variant_id, signature, cost, tokens, metadata, tags) AND the
 * provenance fields (origin_substrate_id, origin_instance) — so replication
 * does not degrade the peer's learning signal.
 *
 * `exclude_origin` lets the caller skip rows that ALREADY originated at its own
 * substrate (echo suppression): with idempotent UPSERT a re-pull is harmless,
 * but excluding own-origin rows avoids the wasted transfer and keeps the
 * single-hop-fanout invariant (an instance never re-imports what it authored).
 *
 * Read-only. Root DB path: this is substrate-internal replication plumbing, not
 * tenant data (see CLAUDE.md SurrealDB constraint #2 — same rationale as
 * trace-store-counters).
 */

import { surrealDB } from '../db/surreal';

export interface ReplicationPullInput {
  since?: string;
  limit?: number;
  exclude_origin?: string;
}

export interface ReplicationPullResult {
  shape: 'executionReplicationPull';
  generated_at: string;
  since: string;
  count: number;
  rows: Record<string, unknown>[];
}

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 500;

export async function runReplicationPull(
  pointer: unknown,
): Promise<ReplicationPullResult> {
  const p = (pointer ?? {}) as Record<string, unknown>;

  const since =
    typeof p.since === 'string' && p.since.length > 0
      ? p.since
      : new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();

  let limit =
    typeof p.limit === 'number' && Number.isFinite(p.limit)
      ? Math.floor(p.limit)
      : DEFAULT_LIMIT;
  limit = Math.max(1, Math.min(MAX_LIMIT, limit));

  const excludeOrigin =
    typeof p.exclude_origin === 'string' && p.exclude_origin.length > 0
      ? p.exclude_origin
      : null;

  const where: string[] = ['executed_at >= type::datetime($since)'];
  const params: Record<string, unknown> = { since, lim: limit };
  if (excludeOrigin) {
    // NONE-safe: keep rows with no origin OR a different origin.
    where.push('(origin_substrate_id IS NONE OR origin_substrate_id != $excl)');
    params.excl = excludeOrigin;
  }

  const sql = `SELECT * FROM execution WHERE ${where.join(
    ' AND ',
  )} ORDER BY executed_at ASC LIMIT $lim;`;

  const res = await surrealDB.query<Record<string, unknown>>(sql, params);
  const rows: Record<string, unknown>[] = Array.isArray(res)
    ? Array.isArray((res as unknown[])[0])
      ? ((res as unknown[])[0] as Record<string, unknown>[])
      : (res as Record<string, unknown>[])
    : [];

  return {
    shape: 'executionReplicationPull',
    generated_at: new Date().toISOString(),
    since,
    count: rows.length,
    rows,
  };
}
