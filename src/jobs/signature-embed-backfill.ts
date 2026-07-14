/**
 * signature-embed-backfill — embed state-space signatures that appear in
 * `context_thompson_scores` but have no `signature_embedding` row yet.
 *
 * Spec: openspec/changes/2026-06-04-learning-rate-8-hierarchical-signature-clustering/
 *       (task D2.2).
 *
 * SIGNATURE -> SHAPES RECOVERY (the correctness crux):
 *   A signature (the `context_bucket` value, for `signature_version >= 1`) is a
 *   HASH produced by computeStateSpaceSignature() from a sorted impulse-shape set
 *   (+ optional provenance/missing). The hash string itself has no semantic
 *   similarity, so we must embed the underlying shape-set TEXT, not the hash.
 *
 *   The shape set is recoverable from execution traces: `activity_execution_traces`
 *   stores `input_impulse_shapes` (sql/schemas/011-executions.surql:179), and the
 *   v1 signature is derived from exactly those shapes (execution-traces.ts:2386 ->
 *   computeStateSpaceSignature). We therefore rebuild the inverse map by scanning
 *   traces, recomputing the signature from each trace's `input_impulse_shapes`, and
 *   keying the sorted/comma-joined shape text by the resulting signature. A signature
 *   in context_thompson_scores is embeddable iff some trace reproduces it.
 *
 *   LIMITATION (documented, not silently hashed): for `signature_version = 0` rows
 *   (legacy v0 context buckets) and for any v1 signature whose originating trace no
 *   longer carries `input_impulse_shapes`, the shape set is NOT recoverable. Those
 *   signatures are SKIPPED (left un-embedded) rather than embedding the meaningless
 *   hash. They simply never join a cluster — which is the correct degraded behaviour
 *   (the selector falls back to leaf-only for them).
 *
 * Idempotent: signatures that already have a `signature_embedding` row are skipped.
 * Embeds in batches of 50 via concept-db (advisory; a null embedding => skip-row).
 *
 * This module exports a runnable function only. It does NOT start a timer — the
 * periodic driver is owned by D3.
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { embedSignatures, embedSignature } from '../lib/signature-embedding';
import { computeStateSpaceSignature } from '../utils/session-context';

const EMBED_BATCH_SIZE = 50;

/** A signature that needs embedding, paired with its recovered shape-set text. */
interface PendingSignature {
  org_id: string;
  signature: string;
  signature_version: number;
  shapeText: string;
}

interface BackfillResult {
  scanned_signatures: number;
  already_embedded: number;
  unrecoverable: number;
  embedded: number;
  embed_failed: number;
}

/**
 * Build the signature -> sorted-shape-text inverse map by scanning recent traces.
 *
 * Keyed by `${signature_version}|${signature}`. Only v1 signatures are
 * reproducible here (computeStateSpaceSignature emits the v1 hash); v0 buckets
 * are intentionally absent from this map and therefore skipped by the caller.
 */
async function buildSignatureShapeMap(traceLimit: number): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  const traces = await surrealDB.query<{
    input_impulse_shapes?: string[];
    executed_at?: string;
  }>(
    `
    SELECT input_impulse_shapes, executed_at FROM v_paradigm_execution_traces
    WHERE input_impulse_shapes IS NOT NONE
      AND array::len(input_impulse_shapes) > 0
    ORDER BY executed_at DESC
    LIMIT $limit
  `,
    { limit: traceLimit }
  );

  for (const trace of traces ?? []) {
    const shapes = trace.input_impulse_shapes;
    if (!Array.isArray(shapes) || shapes.length === 0) continue;

    // Reproduce the v1 signature exactly as the write path does. We embed the
    // canonical sorted, comma-joined shape set — the same byte string used as the
    // `shapes` component of the hash (computeStateSpaceSignature: shapes.join(',')).
    const sorted = [...shapes].sort();
    const shapeText = sorted.join(',');

    // signature_version 1 is the default v1 (shape + provenance + missing). Without
    // the original provenance/missing we recompute the shape-only form, which
    // matches signatures produced for traces that had no provenance/missing (the
    // common case). Provenance-bearing signatures simply will not be found here,
    // and are skipped — correct degraded behaviour, never a hash embed.
    const sig = computeStateSpaceSignature({ shapes: sorted });
    map.set(`1|${sig}`, shapeText);
  }

  return map;
}

/**
 * Run one full backfill pass. Returns counts. Never throws fatally — per-batch
 * embed failures are logged and counted, not propagated.
 *
 * @param traceLimit how many recent traces to scan when building the inverse map
 *                   (caps memory; default 50k mirrors the clustering row cap).
 */
export async function runSignatureEmbedBackfill(traceLimit = 50_000): Promise<BackfillResult> {
  const result: BackfillResult = {
    scanned_signatures: 0,
    already_embedded: 0,
    unrecoverable: 0,
    embedded: 0,
    embed_failed: 0,
  };

  // 1. Distinct signatures present in context_thompson_scores.
  const sigRows = await surrealDB.query<{
    org_id: string;
    context_bucket: string;
    signature_version: number;
  }>(
    `
    SELECT org_id, context_bucket, signature_version FROM context_thompson_scores
    WHERE context_bucket IS NOT NONE
      AND signature_version >= 1
    GROUP BY org_id, context_bucket, signature_version
  `
  );

  if (!sigRows || sigRows.length === 0) {
    logger.info('signature-embed-backfill: no v1 signatures in context_thompson_scores');
    return result;
  }
  result.scanned_signatures = sigRows.length;

  // 2. Signatures already embedded (idempotency).
  const embeddedRows = await surrealDB.query<{
    signature: string;
    signature_version: number;
  }>(
    `SELECT signature, signature_version FROM signature_embedding`
  );
  const alreadyEmbedded = new Set<string>(
    (embeddedRows ?? []).map((r) => `${r.signature_version}|${r.signature}`)
  );

  // 3. Recover shape text per signature.
  const shapeMap = await buildSignatureShapeMap(traceLimit);

  const pending: PendingSignature[] = [];
  for (const row of sigRows) {
    const key = `${row.signature_version}|${row.context_bucket}`;
    if (alreadyEmbedded.has(key)) {
      result.already_embedded++;
      continue;
    }
    const shapeText = shapeMap.get(key);
    if (!shapeText) {
      // Shape set not recoverable for this signature — skip (never embed the hash).
      result.unrecoverable++;
      continue;
    }
    pending.push({
      org_id: row.org_id,
      signature: row.context_bucket,
      signature_version: row.signature_version,
      shapeText,
    });
  }

  logger.info('signature-embed-backfill: pending signatures resolved', {
    scanned: result.scanned_signatures,
    already_embedded: result.already_embedded,
    unrecoverable: result.unrecoverable,
    to_embed: pending.length,
  });

  // 4. Embed in batches of 50 and INSERT.
  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await embedSignatures(batch.map((p) => p.shapeText));

    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const embedding = embeddings[j];
      if (!embedding) {
        // Advisory failure for this text — leave un-embedded, retried next pass.
        result.embed_failed++;
        continue;
      }
      try {
        await surrealDB.query(
          `
          CREATE signature_embedding CONTENT {
            org_id: $org_id,
            signature: $signature,
            signature_version: $signature_version,
            embedding: $embedding,
            embedded_at: time::now()
          }
        `,
          {
            org_id: item.org_id,
            signature: item.signature,
            signature_version: item.signature_version,
            embedding,
          }
        );
        result.embedded++;
      } catch (err) {
        result.embed_failed++;
        logger.warn('signature-embed-backfill: insert failed (non-blocking)', {
          signature: item.signature,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  logger.info('signature-embed-backfill: complete', { ...result });
  return result;
}

/**
 * Embed a single signature on demand (fire-and-forget hook target). Resolves the
 * signature's shape set from its `input_impulse_shapes`, embeds, and INSERTs one
 * `signature_embedding` row. Idempotent (skips if already embedded). Swallows all
 * errors — best-effort only.
 *
 * @param inputImpulseShapes the shapes the signature was derived from (available
 *        at the posterior-update create site). Avoids a trace scan for the hot path.
 */
export async function embedSignatureForShapes(
  orgId: string,
  signature: string,
  signatureVersion: number,
  inputImpulseShapes: string[]
): Promise<void> {
  try {
    if (!Array.isArray(inputImpulseShapes) || inputImpulseShapes.length === 0) {
      return; // shape set not available — never embed the hash
    }

    // Idempotency: skip if already embedded.
    const existing = await surrealDB.query<{ id: string }>(
      `
      SELECT id FROM signature_embedding
      WHERE signature = $signature AND signature_version = $signature_version
      LIMIT 1
    `,
      { signature, signature_version: signatureVersion }
    );
    if (existing && existing.length > 0) return;

    const shapeText = [...inputImpulseShapes].sort().join(',');
    const embedding = await embedSignature(shapeText);
    if (!embedding) return; // advisory failure — backfill will retry

    await surrealDB.query(
      `
      CREATE signature_embedding CONTENT {
        org_id: $org_id,
        signature: $signature,
        signature_version: $signature_version,
        embedding: $embedding,
        embedded_at: time::now()
      }
    `,
      { org_id: orgId, signature, signature_version: signatureVersion, embedding }
    );
  } catch (err) {
    logger.debug('signature-embed-backfill: on-demand embed failed (non-blocking)', {
      signature,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Allow running as a standalone script: `bun run src/jobs/signature-embed-backfill.ts`.
if (import.meta.main) {
  surrealDB
    .connect()
    .then(() => runSignatureEmbedBackfill())
    .then((res) => {
      console.log('signature-embed-backfill result:', JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('signature-embed-backfill failed:', err);
      process.exit(1);
    });
}
