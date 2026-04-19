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
// JWT_SECRET for API key authentication - used to update ACCESS method KEY
const JWT_SECRET = process.env.JWT_SECRET;

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

    // Substitute JWT_SECRET in migrations that define ACCESS methods
    // This ensures the SurrealDB ACCESS method KEY matches the application's JWT_SECRET
    if (JWT_SECRET && sqlContent.includes("KEY 'dev-secret-change-in-production'")) {
      console.log(`[Migration] Substituting JWT_SECRET in ${fileName}`);
      sqlContent = sqlContent.replace(
        /KEY\s+'dev-secret-change-in-production'/g,
        `KEY '${JWT_SECRET}'`
      );
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
  console.log(`JWT_SECRET: ${JWT_SECRET ? '✓ configured (will substitute in ACCESS methods)' : '✗ not set (using dev default)'}`);
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
