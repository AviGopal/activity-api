/**
 * G5: Embedding backfill — replaces mismatched-dimension OpenAI vectors with
 * 384-dim all-MiniLM-L6-v2 vectors for all activity templates.
 *
 * Run inside the activity-api pod (model files are at EMBEDDING_MODEL_DIR) or
 * locally when EMBEDDING_MODEL_DIR points to src/assets/models/all-MiniLM-L6-v2.
 *
 *   # Inside pod — copy script then run (dynamic imports resolve from /app/scripts/)
 *   POD=$(kubectl get pod -n activity-system -l app.kubernetes.io/name=metabob-activity-api -o name | head -1 | sed 's|pod/||')
 *   kubectl cp scripts/backfill-embeddings.ts activity-system/$POD:/tmp/backfill-embeddings.ts
 *   kubectl exec -n activity-system $POD -- bun run /tmp/backfill-embeddings.ts
 *
 *   # Locally (model present at default path relative to repo root)
 *   EMBEDDING_MODEL_DIR=src/assets/models/all-MiniLM-L6-v2 \
 *   SURREALDB_URL=... SURREALDB_USERNAME=... SURREALDB_PASSWORD=... \
 *     bun run scripts/backfill-embeddings.ts
 *
 *   # Dry-run (no DB writes)
 *   bun run scripts/backfill-embeddings.ts --dry-run
 *
 *   # Limit scope
 *   bun run scripts/backfill-embeddings.ts --batch-size=20 --max-templates=100
 */

import { resolve } from 'path';
import { existsSync } from 'fs';

// Locate app root: when copied to /tmp/ for ad-hoc pod execution, import.meta.dir
// is /tmp and ../src resolves incorrectly. Check standard pod path first.
const appRoot = existsSync('/app/src') ? '/app' : resolve(import.meta.dir, '..');
const srcDir = resolve(appRoot, 'src');
const { surrealDB } = await import(resolve(srcDir, 'db/surreal'));
const { localEmbeddingService } = await import(resolve(srcDir, 'services/embedding-service'));

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BATCH_SIZE = parseInt(args.find(a => a.startsWith('--batch-size='))?.split('=')[1] ?? '50');
const MAX_TEMPLATES = parseInt(args.find(a => a.startsWith('--max-templates='))?.split('=')[1] ?? '0');
const FORCE_ALL = args.includes('--force-all'); // Re-embed even templates already on all-MiniLM-L6-v2

const TARGET_MODEL = 'all-MiniLM-L6-v2';

// ── helpers ──────────────────────────────────────────────────────────────────

function log(msg: string, data?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  if (data) {
    console.log(`[${ts}] ${msg}`, JSON.stringify(data));
  } else {
    console.log(`[${ts}] ${msg}`);
  }
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('=== Embedding backfill — all-MiniLM-L6-v2 ===');
  log('Config', { DRY_RUN, BATCH_SIZE, MAX_TEMPLATES: MAX_TEMPLATES || 'unlimited', FORCE_ALL });

  // Initialise embedding service
  log('Initialising embedding service…');
  await localEmbeddingService.init();
  if (!localEmbeddingService.isReady()) {
    log('ERROR: LocalEmbeddingService failed to initialise. Check EMBEDDING_MODEL_DIR.');
    process.exit(1);
  }
  const status = (localEmbeddingService as any).getStatus?.() ?? { model: 'all-MiniLM-L6-v2', dim: 384 };
  log('Embedding service ready', status);

  // Connect to SurrealDB
  log('Connecting to SurrealDB…');
  await surrealDB.connect();
  log('Connected.');

  // Count candidates
  const whereClause = FORCE_ALL
    ? `(retired = false OR retired IS NONE)`
    : `(embedding_model != '${TARGET_MODEL}' OR embedding_model IS NONE) AND (retired = false OR retired IS NONE)`;

  // surrealDB.query() returns result[0] (first result set already unwrapped)
  const countRows = await surrealDB.query<{ count: number }>(
    `SELECT count() AS count FROM activity WHERE ${whereClause} GROUP ALL`
  );
  const totalCandidates: number = (countRows as any)?.[0]?.count ?? 0;
  const toProcess = MAX_TEMPLATES > 0 ? Math.min(totalCandidates, MAX_TEMPLATES) : totalCandidates;
  log(`Found ${totalCandidates} candidate templates; will process ${toProcess}`);

  if (toProcess === 0) {
    log('Nothing to do — all templates already use all-MiniLM-L6-v2 embeddings.');
    process.exit(0);
  }

  // Stats
  let processed = 0;
  let succeeded = 0;
  let skipped = 0;
  let errors = 0;
  const startTime = Date.now();

  // Batch loop
  let offset = 0;
  while (processed < toProcess) {
    const batchLimit = Math.min(BATCH_SIZE, toProcess - processed);
    // surrealDB.query() already unwraps first result set — batch is the row array directly
    const batch = await surrealDB.query<any>(
      `SELECT id, name, description, embedding_model FROM activity WHERE ${whereClause} LIMIT ${batchLimit} START ${offset}`
    );

    if (!batch || batch.length === 0) {
      break;
    }

    log(`Processing batch offset=${offset} size=${batch.length}`);

    // Build text pairs for embedBatch
    const names = batch.map(r => String(r.name || r.id || ''));
    const descs = batch.map(r => String(r.description || ''));

    // Embed names and descriptions together in one call for efficiency
    const allTexts = [...names, ...descs];
    let allVecs: Float32Array[];
    try {
      allVecs = await localEmbeddingService.embedBatch(allTexts);
    } catch (err) {
      log(`ERROR: embedBatch failed for batch at offset ${offset}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      errors += batch.length;
      offset += batch.length;
      processed += batch.length;
      continue;
    }

    const nameVecs = allVecs.slice(0, batch.length);
    const descVecs = allVecs.slice(batch.length);

    // Write back per row
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      const nameArr = Array.from(nameVecs[i]);
      const descArr = Array.from(descVecs[i]);
      const recordId = String(row.id);

      if (DRY_RUN) {
        log(`DRY-RUN: would update ${recordId} (name="${names[i].slice(0, 40)}…")`);
        succeeded++;
        processed++;
        continue;
      }

      try {
        await surrealDB.query(
          `UPDATE type::record($id) SET
            name_embedding = $name_emb,
            description_embedding = $desc_emb,
            embedding_model = $model`,
          {
            id: recordId,  // full "activity:⟨…⟩" — type::record() requires table prefix
            name_emb: nameArr,
            desc_emb: descArr,
            model: TARGET_MODEL,
          }
        );
        succeeded++;
        log(`  ✓ ${recordId} (${names[i].slice(0, 50)})`);
      } catch (err) {
        log(`  ✗ ERROR updating ${recordId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        errors++;
      }
      processed++;
    }

    offset += batch.length;

    // Brief pause between batches to avoid overwhelming the DB
    if (offset < toProcess) {
      await sleep(200);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('=== Backfill complete ===', {
    processed,
    succeeded,
    skipped,
    errors,
    elapsed_s: elapsed,
    dry_run: DRY_RUN,
  });

  if (errors > 0) {
    log(`WARNING: ${errors} templates failed. Re-run to retry.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
