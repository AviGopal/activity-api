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

  const params: Record<string, unknown> = { since, lim: limit };
  let idSql: string;

  // OOM-safe two-step (migration-162): `SELECT *` carries the full trace blob,
  // so ORDER BY executed_at over the watermark window makes SurrealDB's
  // MemoryOrderedLimit collect every matched blob row into RAM before LIMIT.
  // Step 1 sorts ONLY the narrow (id, executed_at) keys under LIMIT; step 2
  // hydrates the full rows verbatim for the chosen ids (replication needs every
  // field), preserving executed_at ASC order.
  if (excludeOrigin) {
    params.excl = excludeOrigin;
    // Planner trap (SurrealDB 2.3.3): the disjunction (`IS NONE OR !=`) on
    // `origin_substrate_id` prevents the planner from using the `executed_at`
    // index, forcing a full table scan. This subquery forces the index-
    // friendly range scan first, then filters the smaller result set by origin.
    idSql = `
      SELECT id, executed_at FROM (
        SELECT id, executed_at, origin_substrate_id FROM execution WHERE executed_at >= type::datetime($since)
      ) WHERE origin_substrate_id IS NONE OR origin_substrate_id != $excl
      ORDER BY executed_at ASC LIMIT $lim TIMEOUT 30s;
    `;
  } else {
    idSql = `
      SELECT id, executed_at FROM execution
      WHERE executed_at >= type::datetime($since)
      ORDER BY executed_at ASC LIMIT $lim TIMEOUT 30s;
    `;
  }

  const idRes = await surrealDB.query<Record<string, unknown>>(idSql, params);
  const idRows: Record<string, unknown>[] = Array.isArray(idRes)
    ? Array.isArray((idRes as unknown[])[0])
      ? ((idRes as unknown[])[0] as Record<string, unknown>[])
      : (idRes as Record<string, unknown>[])
    : [];
  const ids = idRows.map((r) => r.id).filter((x) => x != null);

  let rows: Record<string, unknown>[] = [];
  if (ids.length > 0) {
    const sql = `SELECT * FROM execution WHERE id IN $ids ORDER BY executed_at ASC;`;
    const res = await surrealDB.query<Record<string, unknown>>(sql, { ...params, ids });
    rows = Array.isArray(res)
      ? Array.isArray((res as unknown[])[0])
        ? ((res as unknown[])[0] as Record<string, unknown>[])
        : (res as Record<string, unknown>[])
      : [];
  }

  return {
    shape: 'executionReplicationPull',
    generated_at: new Date().toISOString(),
    since,
    count: rows.length,
    rows,
  };
}
