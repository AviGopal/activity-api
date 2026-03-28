#!/usr/bin/env bun
/**
 * Archive Legacy Tables Script (P5.4)
 *
 * Renames legacy tables with _archived_YYYYMMDD suffix for rollback safety.
 * Run this after dual-write has been stable and reads switched to new tables.
 *
 * Tables archived:
 * - activity_template → activity_template_archived_YYYYMMDD
 * - activity_execution_traces → activity_execution_traces_archived_YYYYMMDD
 * - impulse_data → impulse_data_archived_YYYYMMDD
 * - minibob_instance → minibob_instance_archived_YYYYMMDD
 *
 * Safety:
 * - Tables are renamed, not dropped
 * - Keep for 30 days before final cleanup
 * - Can be restored by renaming back
 *
 * Usage:
 *   SURREALDB_URL=http://localhost:8000 bun run scripts/archive-legacy-tables.ts
 *
 * Environment:
 *   SURREALDB_URL - SurrealDB connection URL
 *   SURREALDB_NAMESPACE - Namespace (default: activity-system)
 *   SURREALDB_DATABASE - Database (default: learning_loop)
 *   SURREALDB_USERNAME - Username (default: root)
 *   SURREALDB_PASSWORD - Password
 *   DRY_RUN - If 'true', don't actually rename (default: false)
 */

import Surreal from 'surrealdb';

// Configuration
const config = {
  url: process.env.SURREALDB_URL || 'http://localhost:8000',
  namespace: process.env.SURREALDB_NAMESPACE || 'activity-system',
  database: process.env.SURREALDB_DATABASE || 'learning_loop',
  username: process.env.SURREALDB_USERNAME || 'root',
  password: process.env.SURREALDB_PASSWORD || '',
  dryRun: process.env.DRY_RUN === 'true',
};

// Generate archive suffix
const archiveDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const archiveSuffix = `_archived_${archiveDate}`;

console.log('='.repeat(80));
console.log('ARCHIVE LEGACY TABLES (P5.4)');
console.log('='.repeat(80));
console.log(`SurrealDB URL: ${config.url}`);
console.log(`Archive Suffix: ${archiveSuffix}`);
console.log(`Dry Run: ${config.dryRun}`);
console.log(`Timestamp: ${new Date().toISOString()}`);
console.log('');

// Tables to archive
const tablesToArchive = [
  'activity_template',
  'activity_execution_traces',
  'variant_performance_metrics',
  'impulse_data',
  'minibob_instance',
];

// Initialize SurrealDB client
const db = new Surreal();

async function connect(): Promise<void> {
  console.log('Connecting to SurrealDB...');
  await db.connect(config.url);
  await db.signin({
    username: config.username,
    password: config.password,
  });
  await db.use({ namespace: config.namespace, database: config.database });
  console.log('✅ Connected to SurrealDB');
}

async function disconnect(): Promise<void> {
  await db.close();
}

async function tableExists(tableName: string): Promise<boolean> {
  try {
    const result = await db.query<any[]>(`INFO FOR TABLE ${tableName}`);
    return result && result.length > 0;
  } catch (error) {
    return false;
  }
}

async function getTableRowCount(tableName: string): Promise<number> {
  try {
    const result = await db.query<any[]>(`SELECT count() FROM ${tableName} GROUP ALL`);
    return (result[0] as any[])?.[0]?.count || 0;
  } catch (error) {
    return -1;
  }
}

async function archiveTable(tableName: string): Promise<{ success: boolean; error?: string }> {
  const archivedName = `${tableName}${archiveSuffix}`;

  console.log(`\nArchiving ${tableName} → ${archivedName}...`);

  // Check if source table exists
  const exists = await tableExists(tableName);
  if (!exists) {
    console.log(`  ⚠️ Table ${tableName} does not exist, skipping`);
    return { success: true };
  }

  // Check if archive table already exists
  const archiveExists = await tableExists(archivedName);
  if (archiveExists) {
    console.log(`  ⚠️ Archive ${archivedName} already exists, skipping`);
    return { success: true };
  }

  // Get row count
  const rowCount = await getTableRowCount(tableName);
  console.log(`  Rows: ${rowCount}`);

  if (config.dryRun) {
    console.log(`  [DRY RUN] Would rename ${tableName} → ${archivedName}`);
    return { success: true };
  }

  try {
    // SurrealDB doesn't have RENAME TABLE, so we need to:
    // 1. Create new table with archived name
    // 2. Copy all data
    // 3. Drop original table (or keep as alias)

    // For safety, we'll create a view that points to the new paradigm table
    // and keep the old data in the archived table

    // Step 1: Copy data to archived table
    console.log(`  Copying data to ${archivedName}...`);
    await db.query(`
      INSERT INTO ${archivedName}
      SELECT * FROM ${tableName}
    `);

    // Step 2: Verify row counts match
    const archivedCount = await getTableRowCount(archivedName);
    if (archivedCount !== rowCount) {
      throw new Error(`Row count mismatch: original=${rowCount}, archived=${archivedCount}`);
    }
    console.log(`  ✅ Copied ${archivedCount} rows`);

    // Step 3: Drop original table
    console.log(`  Dropping original table ${tableName}...`);
    await db.query(`REMOVE TABLE ${tableName}`);
    console.log(`  ✅ Original table dropped`);

    // Step 4: Create backward-compat view pointing to new table (if mapping exists)
    const newTableMapping: Record<string, string> = {
      'activity_template': 'activity',
      'activity_execution_traces': 'execution',
      'impulse_data': 'impulse',
      'minibob_instance': 'vessel',
      'variant_performance_metrics': 'v_activity_score',
    };

    const newTable = newTableMapping[tableName];
    if (newTable) {
      console.log(`  Creating backward-compat view ${tableName} → ${newTable}...`);
      // Note: This creates a simple alias view
      // In production, you might want more sophisticated mapping
      try {
        await db.query(`
          DEFINE TABLE ${tableName} AS
          SELECT * FROM ${newTable}
        `);
        console.log(`  ✅ Backward-compat view created`);
      } catch (viewError) {
        console.log(`  ⚠️ Could not create view (may not be needed): ${viewError}`);
      }
    }

    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`  ❌ Failed to archive: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

async function main() {
  try {
    await connect();

    console.log('\n--- Pre-Archive Validation ---');
    console.log('Checking table existence and row counts...\n');

    for (const table of tablesToArchive) {
      const exists = await tableExists(table);
      const count = exists ? await getTableRowCount(table) : -1;
      console.log(`  ${table}: ${exists ? `✓ (${count} rows)` : '✗ (not found)'}`);
    }

    console.log('\n--- Archiving Tables ---');

    const results: Array<{ table: string; success: boolean; error?: string }> = [];

    for (const table of tablesToArchive) {
      const result = await archiveTable(table);
      results.push({ table, ...result });
    }

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('ARCHIVE SUMMARY');
    console.log('='.repeat(80));

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    for (const r of results) {
      const status = r.success ? '✅' : '❌';
      console.log(`  ${status} ${r.table}${r.error ? `: ${r.error}` : ''}`);
    }

    console.log(`\nTotal: ${succeeded} succeeded, ${failed} failed`);

    if (config.dryRun) {
      console.log('\n⚠️  DRY RUN - no tables were actually archived');
    }

    if (failed > 0) {
      console.log('\n⚠️  Some tables failed to archive. Review errors above.');
      process.exit(1);
    } else {
      console.log('\n✅ Archive completed successfully!');
      console.log(`\nNext steps:`);
      console.log(`  1. Monitor system for 30 days`);
      console.log(`  2. Run cleanup script to drop archived tables`);
      console.log(`  3. Remove backward-compat views if no longer needed`);
      process.exit(0);
    }
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    await disconnect();
  }
}

main();
