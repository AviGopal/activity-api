#!/usr/bin/env bun
/**
 * Collapse stale v1 signature rows (§7.1 + §7.2)
 *
 * Reads context_thompson_scores rows with signature_version=1 that have
 * n_observations < SIGNATURE_SAMPLING_FLOOR and were last updated >30 days ago.
 * For each, sums α/β into a v1c (coarse) row keyed on shape-multiset-only hash;
 * then deletes the v1 row. Pages 1000 rows at a time. Idempotent.
 *
 * Usage:
 *   SURREALDB_URL=https://surql.metabob.com bun run scripts/collapse-stale-signatures.ts
 *   SURREALDB_URL=... DRY_RUN=true bun run scripts/collapse-stale-signatures.ts
 *
 * Environment:
 *   SURREALDB_URL          - SurrealDB connection URL (required)
 *   SURREALDB_NAMESPACE    - Namespace (default: activity-system)
 *   SURREALDB_DATABASE     - Database (default: learning_loop)
 *   SURREALDB_USERNAME     - Root username (required)
 *   SURREALDB_PASSWORD     - Root password (required)
 *   DRY_RUN                - Print plan without executing (default: false)
 *   PAGE_SIZE              - Rows per page (default: 1000)
 *   STALE_DAYS             - Days since last_updated_at (default: 30)
 *   SIGNATURE_SAMPLING_FLOOR - Minimum n_observations to keep (default: 5)
 */

import Surreal from 'surrealdb';
import { computeStateSpaceSignature } from '../src/utils/session-context';

const URL   = process.env.SURREALDB_URL ?? 'http://localhost:8000';
const NS    = process.env.SURREALDB_NAMESPACE ?? 'activity-system';
const DB    = process.env.SURREALDB_DATABASE  ?? 'learning_loop';
const USER  = process.env.SURREALDB_USERNAME  ?? 'root';
const PASS  = process.env.SURREALDB_PASSWORD  ?? '';
const DRY   = process.env.DRY_RUN === 'true';
const PAGE  = parseInt(process.env.PAGE_SIZE ?? '1000', 10);
const STALE_DAYS  = parseInt(process.env.STALE_DAYS ?? '30', 10);
const FLOOR = parseInt(process.env.SIGNATURE_SAMPLING_FLOOR ?? '5', 10);

const STALE_THRESHOLD_DAYS = `${STALE_DAYS}d`;

interface StaleRow {
  id: string;
  org_id: string;
  template_id: string;
  context_bucket: string;
  alpha: number;
  beta: number;
  n_observations: number;
}

async function main() {
  console.log(`collapse-stale-signatures: DRY_RUN=${DRY}, floor=${FLOOR}, stale_days=${STALE_DAYS}`);

  const db = new Surreal();
  await db.connect(URL);
  await db.signin({ username: USER, password: PASS });
  await db.use({ namespace: NS, database: DB });

  let offset = 0;
  let totalCollapsed = 0;
  let totalPages = 0;

  while (true) {
    const rows: StaleRow[] = await db.query<StaleRow[][]>(`
      SELECT id, org_id, template_id, context_bucket, alpha, beta, n_observations
      FROM context_thompson_scores
      WHERE signature_version = 1
        AND n_observations < $floor
        AND last_updated_at < time::now() - duration($stale)
      LIMIT $limit START $offset
    `, { floor: FLOOR, stale: STALE_THRESHOLD_DAYS, limit: PAGE, offset }).then(r => r?.[0] ?? []);

    if (rows.length === 0) break;
    totalPages++;

    console.log(`  page ${totalPages}: ${rows.length} stale rows`);

    for (const row of rows) {
      // Compute v1c signature: shape-multiset only (no provenance, no missing)
      // We don't have the original shapes array in the row — use the context_bucket
      // as-is for the v1c key to preserve grouping (collapse identical shape sets).
      // The v1c context_bucket is derived from computeStateSpaceSignature with version='1c'.
      // Since we can't reconstruct original shapes from the hash, we use the v1 bucket
      // as a stable proxy: group by (org_id, template_id, v1_bucket) into one v1c row.
      const v1cBucket = computeStateSpaceSignature({
        shapes: [row.context_bucket], // stable proxy key
        version: '1c',
      });

      if (DRY) {
        console.log(`  [DRY] collapse ${row.id} → v1c bucket ${v1cBucket} (α=${row.alpha} β=${row.beta})`);
        continue;
      }

      try {
        // Upsert v1c row
        await db.query(`
          LET $v1c = (SELECT * FROM context_thompson_scores
            WHERE org_id = $org_id AND template_id = $template_id
              AND signature_version = 2 AND context_bucket = $v1c_bucket
            LIMIT 1);
          IF array::len($v1c) > 0 THEN
            UPDATE context_thompson_scores
            SET alpha = alpha + $alpha - 1.0,
                beta  = beta  + $beta  - 1.0,
                n_observations = n_observations + $n_obs,
                last_updated_at = time::now()
            WHERE org_id = $org_id AND template_id = $template_id
              AND signature_version = 2 AND context_bucket = $v1c_bucket
          ELSE
            CREATE context_thompson_scores CONTENT {
              org_id: $org_id,
              template_id: $template_id,
              context_bucket: $v1c_bucket,
              signature_version: 2,
              alpha: $alpha,
              beta:  $beta,
              n_observations: $n_obs,
              last_updated_at: time::now(),
              created_at: time::now()
            }
          END;
          DELETE $row_id
        `, {
          org_id: row.org_id,
          template_id: row.template_id,
          v1c_bucket: v1cBucket,
          alpha: row.alpha,
          beta: row.beta,
          n_obs: row.n_observations,
          row_id: row.id,
        });
        totalCollapsed++;
      } catch (err) {
        console.error(`  ERROR collapsing ${row.id}:`, err instanceof Error ? err.message : err);
      }
    }

    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  console.log(`\ncollapse-stale-signatures: done. collapsed=${totalCollapsed} pages=${totalPages} dry=${DRY}`);
  await db.close();
}

main().catch(err => {
  console.error('collapse-stale-signatures: fatal error', err);
  process.exit(1);
});
