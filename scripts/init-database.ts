#!/usr/bin/env bun
/**
 * Database initialization script
 * Applies all SQL migrations to SurrealDB
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

const SURREALDB_URL = process.env.SURREALDB_URL || 'http://surrealdb.activity-system.svc.cluster.local:8000';
const SURREALDB_NAMESPACE = process.env.SURREALDB_NAMESPACE || 'activity-system';
const SURREALDB_DATABASE = process.env.SURREALDB_DATABASE || 'learning_loop';
const SURREALDB_USERNAME = process.env.SURREALDB_USERNAME || 'root';
const SURREALDB_PASSWORD = process.env.SURREALDB_PASSWORD || 'surrealdb-local-dev-123';
const SURREALDB_AUTH_ENABLED = process.env.SURREALDB_AUTH_ENABLED?.toLowerCase() !== 'false';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

// =============================================================================
// JWT_SECRET - single source of truth for the apikey_token JWT ACCESS method
// =============================================================================
// Schema files use the placeholder `__JWT_SECRET__` in their `DEFINE ACCESS ...
// JWT KEY '...'` clauses. This script substitutes the placeholder with the
// JWT_SECRET env var before sending SQL to SurrealDB. The same env var is
// consumed by `src/config.ts` at runtime, so signing and verification share
// one source.
//
// Production: JWT_SECRET MUST be set; we fail-fast if missing.
// Development: a clearly-marked sentinel keeps `bun run init-db` working
//              against a local stack, with a loud warning.
// =============================================================================
const JWT_SECRET_PLACEHOLDER = '__JWT_SECRET__';
const DEV_JWT_SECRET_SENTINEL = 'dev-only-jwt-secret-do-not-use-in-prod';

function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  if (IS_PRODUCTION) {
    console.error(
      '[Init] FATAL: JWT_SECRET environment variable is unset in production. ' +
      'It must come from k8s secret `metabob-activity-api.jwt-secret`. ' +
      'Refusing to apply schema with placeholder.'
    );
    process.exit(1);
  }

  console.warn(
    '[Init] WARNING: JWT_SECRET unset; using non-production sentinel ' +
    `"${DEV_JWT_SECRET_SENTINEL}". Schema's apikey_token ACCESS will use this. ` +
    'Set JWT_SECRET to silence this warning.'
  );
  return DEV_JWT_SECRET_SENTINEL;
}

const JWT_SECRET = resolveJwtSecret();

const SQL_DIR = join(import.meta.dir, '../sql');

interface SQLResult {
  status: 'OK' | 'ERR';
  result?: any;
  time?: string;
}

// Build shared SurrealDB request headers (auth-conditional).
function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'surreal-ns': SURREALDB_NAMESPACE,
    'surreal-db': SURREALDB_DATABASE,
  };
  if (SURREALDB_AUTH_ENABLED) {
    headers['Authorization'] =
      'Basic ' + Buffer.from(`${SURREALDB_USERNAME}:${SURREALDB_PASSWORD}`).toString('base64');
  }
  return headers;
}

// ── Migration tracking ────────────────────────────────────────────────────────
// Stores applied migration filenames in `init_migrations` so re-runs skip them.
// This prevents REBUILD INDEX (and other slow/idempotent) migrations from
// blocking the init container on every pod restart.
//
// Bootstrap rule: if `init_migrations` is empty but `activity_template` has
// rows, the DB is a pre-tracking live instance — mark all known files as
// applied so this run is a no-op (they were all applied by previous deploys).

async function runSQL(sql: string): Promise<SQLResult[]> {
  // Per-request timeout: the `-` prefix on the unit's ExecStartPre neutralizes a
  // non-zero EXIT, but not a HANG. A contended-but-up SurrealDB can otherwise
  // stall a migration statement indefinitely and eat the unit's TimeoutStartSec
  // budget -> SIGKILL despite the `-`. Bound every statement; migration tracking
  // + idempotent DDL make a skipped/aborted statement safe to retry next start.
  try {
    const response = await fetch(`${SURREALDB_URL}/sql`, {
      method: 'POST',
      headers: buildHeaders(),
      body: sql,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return [];
    return await response.json().catch(() => []);
  } catch {
    // Aborted (timeout) or network error — treat as empty; caller tolerates it.
    return [];
  }
}

async function ensureMigrationsTable(): Promise<void> {
  await runSQL(`
    DEFINE TABLE IF NOT EXISTS init_migrations SCHEMAFULL
      PERMISSIONS FOR select, create FULL;
    DEFINE FIELD IF NOT EXISTS filename ON init_migrations TYPE string;
    DEFINE FIELD IF NOT EXISTS applied_at ON init_migrations TYPE datetime DEFAULT time::now();
    DEFINE INDEX IF NOT EXISTS idx_init_migrations_filename ON init_migrations FIELDS filename UNIQUE;
  `);
}

async function getAppliedMigrations(): Promise<Set<string> | null> {
  const results = await runSQL('SELECT filename FROM init_migrations;');
  // Distinguish a genuine empty result from a FAILED read (timeout/contention).
  // Returning an empty Set on failure is what let a contended-startup timeout
  // trigger the live-DB bootstrap, which marks every pending migration (e.g. a
  // freshly pull-synced DEFINE FIELD like 188) as applied WITHOUT running it —
  // silently skipping it forever. A failed read must NOT look like "nothing
  // applied", so the caller can tell the two apart and refuse to bootstrap.
  if (!results[0] || results[0].status !== 'OK') return null;
  const rows: any[] = Array.isArray(results[0].result) ? results[0].result : [];
  return new Set(rows.map((r: any) => r.filename));
}

async function markMigrationApplied(filename: string): Promise<void> {
  await runSQL(
    `INSERT IGNORE INTO init_migrations (filename) VALUES ('${filename.replace(/'/g, "\\'")}');`
  );
}

async function bootstrapMigrationsTable(allFiles: string[]): Promise<boolean> {
  // Check if DB already has data (live instance predating migration tracking).
  // Use activity_execution_traces (guaranteed non-empty on any live DB) rather
  // than activity_template, which lives in the `activity` table in the new paradigm.
  const results = await runSQL('SELECT count() AS c FROM activity_execution_traces GROUP ALL;');
  const count: number =
    results[0]?.status === 'OK' && Array.isArray(results[0].result) && results[0].result[0]
      ? (results[0].result[0].c ?? 0)
      : 0;

  if (count === 0) {
    // Fresh DB — apply everything normally.
    console.log('[Init] Fresh DB detected — applying all migrations.');
    return false;
  }

  // Live DB: pre-populate the tracking table with all known migration filenames.
  // This marks them as already applied so the init container skips them on
  // this and future restarts, preventing slow REBUILD INDEX re-runs.
  console.log(
    `[Init] Live DB detected (${count} activity_execution_traces rows). ` +
    `Pre-populating init_migrations with ${allFiles.length} known files.`
  );
  for (const file of allFiles) {
    const filename = file.split('/').pop()!;
    await markMigrationApplied(filename);
  }
  console.log('[Init] ✓ init_migrations bootstrapped — this run will skip all existing migrations.');
  return true; // caller should skip all migrations this run
}

async function applySQLFile(filePath: string): Promise<boolean> {
  const fileName = filePath.split('/').pop();
  console.log(`\n[Migration] Applying ${fileName}...`);

  try {
    let sqlContent = await readFile(filePath, 'utf-8');

    // Substitute the JWT_SECRET placeholder in schema files that DEFINE
    // ACCESS ... TYPE JWT methods. The placeholder `__JWT_SECRET__` is the
    // single source of truth for the JWT secret across schema and runtime
    // config (see resolveJwtSecret() above and src/config.ts).
    if (sqlContent.includes(JWT_SECRET_PLACEHOLDER)) {
      console.log(`[Migration] Substituting ${JWT_SECRET_PLACEHOLDER} in ${fileName}`);
      sqlContent = sqlContent.replaceAll(JWT_SECRET_PLACEHOLDER, JWT_SECRET);
    }

    // Backward-compat: older migrations (064, pre-fix) used a literal
    // 'dev-secret-change-in-production'. Substitute those too so re-runs
    // against existing databases still upgrade to the env-var JWT secret.
    if (sqlContent.includes("'dev-secret-change-in-production'")) {
      console.log(`[Migration] Substituting legacy literal in ${fileName}`);
      sqlContent = sqlContent.replaceAll(
        "'dev-secret-change-in-production'",
        `'${JWT_SECRET}'`
      );
    }

    // Defense-in-depth: never apply a schema that still mentions our
    // placeholder. If we got here with the placeholder still in the SQL,
    // a future schema author added it without going through resolveJwtSecret().
    if (sqlContent.includes(JWT_SECRET_PLACEHOLDER)) {
      console.error(
        `[Migration] FATAL: ${fileName} still contains ${JWT_SECRET_PLACEHOLDER} ` +
        'after substitution. This would leak a non-functional JWT KEY into ' +
        'SurrealDB and break authentication. Aborting.'
      );
      return false;
    }

    const headers = buildHeaders();

    // 30s was too short for a DEFINE TABLE ... AS over a large base table: SurrealDB
    // backfills the computed view at definition time, so cost scales with the source
    // rows (execution is ~143k). 023-shape-conditioned-scores and
    // 048-goal-execution-alignment both timed out here AFTER their syntax was fixed,
    // and the failure is indistinguishable from a parse error at the call site — the
    // file is skipped wholesale and its views silently never exist.
    // Measured on the live store: the 023 aggregation alone takes ~4s to return rows,
    // and the DEFINE's index build is a multiple of that. 300s is bounded (init-database
    // is an ExecStartPre that must not hang a boot) but large enough for a full backfill.
    const response = await fetch(`${SURREALDB_URL}/sql`, {
      method: 'POST',
      headers,
      body: sqlContent,
      // 2026-08-03 REVERTED from 300_000 back to 45_000. Raising this to 300s to let a
      // DEFINE TABLE ... AS backfill finish turned a FAST failure into a SLOW one: on the hub
      // (execution = 143k rows) 023/048 each burned minutes, init-database is an ExecStartPre,
      // and the unit never reached ready — measured 10 PIDs and 9 re-runs of the same migration
      // in 25 minutes, a restart loop that took the trace store offline and blinded the ribosome
      // (its WS closed every 150s; last trace 03:15). 45s is above the ~4s the 023 aggregation
      // needs and well under the boot budget. A view too expensive to define inside that window
      // must be built OUT OF BAND, not by extending a startup gate.
      signal: AbortSignal.timeout(45_000),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[Migration] HTTP ${response.status}: ${text}`);
      return false;
    }

    const results: SQLResult[] = await response.json();

    // Check for errors
    const errors = results.filter(r => r.status === 'ERR');
    if (errors.length > 0) {
      // Filter out "already exists" errors which are okay on re-run
      const criticalErrors = errors.filter(e =>
        !e.result?.includes('already exists') &&
        !e.result?.includes('Already exists')
      );

      if (criticalErrors.length > 0) {
        console.error(`[Migration] ✗ ${fileName} failed with ${criticalErrors.length} error(s):`);
        criticalErrors.slice(0, 3).forEach(err => {
          console.error(`  - ${err.result}`);
        });
        return false;
      } else {
        console.log(`[Migration] ⚠ ${fileName} - ${errors.length} statements already exist (skipped)`);
      }
    }

    const successCount = results.filter(r => r.status === 'OK').length;
    console.log(`[Migration] ✓ ${fileName} applied successfully (${successCount} statements)`);
    return true;

  } catch (error) {
    console.error(`[Migration] ✗ ${fileName} error:`, error);
    return false;
  }
}

async function waitForDatabase(maxRetries = 40, delayMs = 1000): Promise<boolean> {
  // 40x1s = 40s bound: generous enough to cover a normal cold SurrealDB boot,
  // but bounded so a genuinely-down store can't consume the whole start budget.
  console.log('[Init] Waiting for SurrealDB to be ready...');

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${SURREALDB_URL}/health`, {
        method: 'GET',
        headers: {
          'surreal-ns': SURREALDB_NAMESPACE,
          'surreal-db': SURREALDB_DATABASE,
        },
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        console.log('[Init] ✓ SurrealDB is ready');
        return true;
      }
    } catch (error) {
      // Connection failed, retry
    }

    if (i < maxRetries - 1) {
      console.log(`[Init] SurrealDB not ready, retrying... (${i + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  console.error('[Init] ✗ SurrealDB failed to become ready');
  return false;
}

async function main() {
  console.log('='.repeat(80));
  console.log('SurrealDB Schema Initialization');
  console.log('='.repeat(80));
  console.log(`Database: ${SURREALDB_NAMESPACE}.${SURREALDB_DATABASE}`);
  console.log(`URL: ${SURREALDB_URL}`);
  console.log(
    `JWT_SECRET: ${
      process.env.JWT_SECRET
        ? '✓ from env (will substitute __JWT_SECRET__ in ACCESS methods)'
        : '⚠ unset; using dev sentinel (production-mode init-db would have aborted)'
    }`
  );
  console.log('='.repeat(80));

  // Wait for database to be ready
  const dbReady = await waitForDatabase();
  if (!dbReady) {
    // SurrealDB never answered within the bounded wait. Exit non-zero to signal
    // "schema not applied" honestly — but the unit's ExecStartPre carries a `-`
    // prefix, so this does NOT fail activity-api startup: ExecStart still runs,
    // the server boots listener-first, serves /health, registers with discovery,
    // and converges per-request once SurrealDB is reachable. The next restart
    // re-runs init to apply any pending schema. On a live DB the schema is
    // already applied (init_migrations tracking), so nothing is lost.
    console.error(
      '[Init] SurrealDB unreachable within bounded wait — skipping schema apply. ' +
      'Non-fatal via ExecStartPre `-`; server will boot and converge.'
    );
    process.exit(1);
  }

  // Find all .surql files in sql directory and schemas subdirectory
  const files = await readdir(SQL_DIR);
  const sqlFiles = files
    .filter(f => f.endsWith('.surql'))
    .sort(); // Apply migrations in order (000-, 001-, etc.)

  // Also include schema files from sql/schemas/ subdirectory
  const schemasDir = join(SQL_DIR, 'schemas');
  try {
    const schemaFiles = await readdir(schemasDir);
    const schemasSqlFiles = schemaFiles
      .filter(f => f.endsWith('.surql'))
      .map(f => `schemas/${f}`)  // Prefix with subdirectory
      .sort();
    sqlFiles.push(...schemasSqlFiles);
  } catch (error) {
    // schemas directory may not exist, that's okay
    console.log('[Init] No schemas subdirectory found, skipping...');
  }

  // Also include migration files from sql/migrations/ subdirectory.
  // F-35: prior versions silently skipped this dir, leaving 60+ migrations
  // (including 064/069 JWT secret OVERWRITE) unapplied on canary. The
  // applySQLFile path is idempotent — DEFINE * IF NOT EXISTS / OVERWRITE
  // semantics mean re-runs are safe. Errors continue rather than abort.
  const migrationsDir = join(SQL_DIR, 'migrations');
  try {
    const migrationFiles = await readdir(migrationsDir);
    const migrationsSqlFiles = migrationFiles
      .filter(f => f.endsWith('.surql'))
      .map(f => `migrations/${f}`)
      .sort();
    sqlFiles.push(...migrationsSqlFiles);
  } catch (error) {
    console.log('[Init] No migrations subdirectory found, skipping...');
  }

  if (sqlFiles.length === 0) {
    console.log('[Init] No migration files found');
    return;
  }

  console.log(`\n[Init] Found ${sqlFiles.length} migration file(s)`);

  // ── Migration tracking ───────────────────────────────────────────────────
  // Ensure the tracking table exists, then load the set of applied migrations.
  // On a live DB where the table is brand-new (empty), bootstrap it by marking
  // all current files as already applied — they were applied by prior deploys.
  await ensureMigrationsTable();

  // ── Load-bearing denormalized fields: ensure FIRST, before the migration loop ──
  // endpoint_output_shapes (mig 092) + expected_output_shapes (mig 188/189) on
  // goal_execution_paths carry the OBSERVED and EXPECTED shape sets the learning
  // loop reconciles. These MUST be ensured up front: the migration loop below
  // re-runs slow/broken migrations (e.g. 048 DEFINE-AS backfill ~45s, 030 parse
  // error) that were never tracked, and can burn the whole ExecStartPre boot
  // budget → SIGKILL before the loop reaches a late migration or any post-loop
  // step. Ensuring here (a sub-second DEFINE FIELD IF NOT EXISTS) guarantees the
  // field exists on every start regardless of how far the slow loop gets — the
  // same lockstep guarantee the JWT ACCESS re-apply provides for auth.
  // Non-destructive idempotent re-assert. An earlier revision force-recreated the
  // field with `REMOVE FIELD ... ; DEFINE FIELD ...` on every start, on a FALSE
  // diagnosis that the field def was broken — a credential-free `INFO FOR TABLE`
  // probe (since removed) proved endpoint_output_shapes and expected_output_shapes
  // are defined identically and correctly; the real null-on-write cause was an
  // UNBOUND $expected_output_shapes param in the API CREATE (fixed in the route
  // handler, 4d0f627). REMOVE FIELD every startup is a standing hazard on a
  // SCHEMAFULL table, so this is back to a sub-second `IF NOT EXISTS` guard that
  // only creates the field if a deploy somehow lacks migration 188/189. Inspect
  // runSQL's per-statement result so a real DEFINE error surfaces (never log ✓
  // unconditionally).
  try {
    const _ensureRes = await runSQL(
      `DEFINE FIELD IF NOT EXISTS expected_output_shapes ON goal_execution_paths TYPE option<array<string>>;\n` +
      `DEFINE INDEX IF NOT EXISTS idx_goal_paths_expected_shapes ON goal_execution_paths FIELDS expected_output_shapes;`
    );
    const _ensureErrs = (Array.isArray(_ensureRes) ? _ensureRes : []).filter((r: any) => r && r.status === 'ERR');
    if (_ensureErrs.length > 0) {
      console.error('[Init] ✗ shape-field ensure had errors:', JSON.stringify(_ensureErrs).slice(0, 800));
    } else {
      console.log('[Init] ✓ goal_execution_paths.expected_output_shapes field ensured (pre-loop, non-destructive)');
    }
  } catch (error) {
    console.warn('[Init] ⚠ could not ensure goal_execution_paths shape fields:', error);
  }

  let appliedMigrations = await getAppliedMigrations();
  let bootstrapped = false;

  // A null result means the tracking read FAILED (timeout/contention), NOT that
  // the table is empty. Retry a few times; a transient failure here is the exact
  // trigger for the false bootstrap that silently skips pending migrations.
  for (let r = 0; appliedMigrations === null && r < 3; r++) {
    console.warn(`[Init] init_migrations unreadable — retry ${r + 1}/3`);
    await new Promise((res) => setTimeout(res, 2000));
    appliedMigrations = await getAppliedMigrations();
  }

  // Apply each migration
  let successCount = 0;
  let skippedCount = 0;

  if (appliedMigrations === null) {
    // Still unreadable after retries: do NOT bootstrap (which would mark every
    // pending migration applied-without-running) and do NOT blindly re-apply all.
    // Skip the tracked-migration pass this run; the unconditional idempotent
    // re-ensure below still runs, and the next start retries. Safe because DDL is
    // idempotent and nothing is silently marked.
    console.error(
      '[Init] init_migrations still unreadable after retries — skipping the tracked ' +
      'migration pass this run to avoid a false bootstrap. Next start retries.'
    );
  } else {
    if (appliedMigrations.size === 0) {
      bootstrapped = await bootstrapMigrationsTable(sqlFiles);
      if (bootstrapped) {
        appliedMigrations = (await getAppliedMigrations()) ?? new Set<string>();
      }
    }

    for (const file of sqlFiles) {
      const filename = file.split('/').pop()!;

      if (appliedMigrations.has(filename)) {
        console.log(`[Migration] ⏭ Skipping ${filename} (already applied)`);
        successCount++;
        skippedCount++;
        continue;
      }

      const filePath = join(SQL_DIR, file);
      const success = await applySQLFile(filePath);
      if (success) {
        successCount++;
        await markMigrationApplied(filename);
      } else {
        // Continue even on failure (for idempotency)
        console.warn(`[Init] ⚠ Migration ${file} had errors but continuing...`);
      }
    }
  }

  // ── Secret-bearing DDL: ALWAYS re-apply, outside migration tracking ──────
  // The apikey_token JWT ACCESS method embeds JWT_SECRET. Migration files
  // (064/069/112) each ran ONCE and are then skipped forever by
  // init_migrations — so when JWT_SECRET changes (e.g. a container recreate
  // regenerated it, 2026-07-02), every JWT-authed query fails 'problem with
  // authentication' until an operator re-defines the access method by hand.
  // Re-applying here on every start keeps the DB verifier in lockstep with
  // the secret the app signs with; DEFINE ... OVERWRITE is idempotent.
  try {
    await runSQL(
      `DEFINE ACCESS OVERWRITE apikey_token ON DATABASE TYPE JWT ` +
      `ALGORITHM HS512 KEY '${JWT_SECRET.replace(/'/g, "\\'")}' ` +
      `DURATION FOR TOKEN 15m, FOR SESSION 1h;`
    );
    console.log('[Init] ✓ apikey_token ACCESS re-applied with current JWT_SECRET');
  } catch (error) {
    console.warn('[Init] ⚠ could not re-apply apikey_token ACCESS:', error);
  }

  console.log('\n' + '='.repeat(80));
  console.log(
    `[Init] Migration complete: ${successCount}/${sqlFiles.length} succeeded` +
    (skippedCount > 0 ? ` (${skippedCount} skipped — already applied)` : '')
  );
  console.log('='.repeat(80));

  if (successCount < sqlFiles.length) {
    console.warn('[Init] Some migrations had errors (this may be okay if re-running)');
  }
}

main().catch(error => {
  console.error('[Init] Fatal error:', error);
  process.exit(1);
});
