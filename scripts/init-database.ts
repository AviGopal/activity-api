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

    // Build headers - only include Authorization when auth is enabled
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'surreal-ns': SURREALDB_NAMESPACE,
      'surreal-db': SURREALDB_DATABASE,
    };
    if (SURREALDB_AUTH_ENABLED) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${SURREALDB_USERNAME}:${SURREALDB_PASSWORD}`).toString('base64');
    }

    const response = await fetch(`${SURREALDB_URL}/sql`, {
      method: 'POST',
      headers,
      body: sqlContent,
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

async function waitForDatabase(maxRetries = 30, delayMs = 2000): Promise<boolean> {
  console.log('[Init] Waiting for SurrealDB to be ready...');

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${SURREALDB_URL}/health`, {
        method: 'GET',
        headers: {
          'surreal-ns': SURREALDB_NAMESPACE,
          'surreal-db': SURREALDB_DATABASE,
        }
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

  // Apply each migration
  let successCount = 0;
  for (const file of sqlFiles) {
    const filePath = join(SQL_DIR, file);
    const success = await applySQLFile(filePath);
    if (success) {
      successCount++;
    } else {
      // Continue even on failure (for idempotency)
      console.warn(`[Init] ⚠ Migration ${file} had errors but continuing...`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log(`[Init] Migration complete: ${successCount}/${sqlFiles.length} succeeded`);
  console.log('='.repeat(80));

  if (successCount < sqlFiles.length) {
    console.warn('[Init] Some migrations had errors (this may be okay if re-running)');
  }
}

main().catch(error => {
  console.error('[Init] Fatal error:', error);
  process.exit(1);
});
