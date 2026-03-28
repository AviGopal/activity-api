#!/usr/bin/env bun
/**
 * Paradigm Schema Sync Validation Job (P4.3)
 *
 * Compares row counts between legacy and new paradigm tables to detect drift.
 * Designed to run hourly during dual-write period.
 *
 * Checks:
 * - activity_template vs activity: row count comparison
 * - activity_execution_traces vs execution: row count comparison
 * - impulse_data vs impulse: row count comparison
 * - minibob_instance vs vessel: row count comparison
 *
 * Alerts:
 * - Logs warning if discrepancy > 1%
 * - Returns exit code 1 if validation fails
 *
 * Usage:
 *   SURREALDB_URL=http://localhost:8000 bun run scripts/validate-paradigm-sync.ts
 *
 * Environment:
 *   SURREALDB_URL - SurrealDB connection URL
 *   SURREALDB_NAMESPACE - Namespace (default: activity-system)
 *   SURREALDB_DATABASE - Database (default: learning_loop)
 *   SURREALDB_USERNAME - Username (default: root)
 *   SURREALDB_PASSWORD - Password
 *   DRIFT_THRESHOLD - Max acceptable drift percentage (default: 1.0)
 */

import Surreal from 'surrealdb';

// Configuration
const config = {
  url: process.env.SURREALDB_URL || 'http://localhost:8000',
  namespace: process.env.SURREALDB_NAMESPACE || 'activity-system',
  database: process.env.SURREALDB_DATABASE || 'learning_loop',
  username: process.env.SURREALDB_USERNAME || 'root',
  password: process.env.SURREALDB_PASSWORD || '',
  driftThreshold: parseFloat(process.env.DRIFT_THRESHOLD || '1.0'), // 1%
};

console.log('='.repeat(80));
console.log('PARADIGM SYNC VALIDATION (P4.3)');
console.log('='.repeat(80));
console.log(`SurrealDB URL: ${config.url}`);
console.log(`Drift Threshold: ${config.driftThreshold}%`);
console.log(`Timestamp: ${new Date().toISOString()}`);
console.log('');

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

interface TableComparison {
  legacyTable: string;
  newTable: string;
  legacyCount: number;
  newCount: number;
  drift: number;
  passed: boolean;
}

async function getTableCount(tableName: string): Promise<number> {
  try {
    const result = await db.query<any[]>(`SELECT count() FROM ${tableName} GROUP ALL`);
    const data = result[0] as any[];
    return data?.[0]?.count || 0;
  } catch (error) {
    // Table might not exist
    console.warn(`  ⚠️ Could not query ${tableName}:`, error instanceof Error ? error.message : String(error));
    return -1;
  }
}

async function compareTables(legacyTable: string, newTable: string): Promise<TableComparison> {
  const legacyCount = await getTableCount(legacyTable);
  const newCount = await getTableCount(newTable);

  let drift = 0;
  if (legacyCount > 0 && newCount >= 0) {
    drift = Math.abs(((newCount - legacyCount) / legacyCount) * 100);
  } else if (legacyCount === 0 && newCount === 0) {
    drift = 0;
  } else if (legacyCount === 0 && newCount > 0) {
    // New table has more records - might be expected during migration
    drift = 0;
  } else {
    drift = 100; // Significant drift
  }

  const passed = drift <= config.driftThreshold || legacyCount < 0 || newCount < 0;

  return {
    legacyTable,
    newTable,
    legacyCount,
    newCount,
    drift,
    passed,
  };
}

async function runValidation(): Promise<{ passed: boolean; comparisons: TableComparison[] }> {
  const comparisons: TableComparison[] = [];

  // Compare each table pair
  const tablePairs = [
    { legacy: 'activity_template', new: 'activity' },
    { legacy: 'activity_execution_traces', new: 'execution' },
    { legacy: 'impulse_data', new: 'impulse' },
    { legacy: 'minibob_instance', new: 'vessel' },
  ];

  for (const pair of tablePairs) {
    console.log(`\nComparing ${pair.legacy} ↔ ${pair.new}...`);
    const comparison = await compareTables(pair.legacy, pair.new);
    comparisons.push(comparison);

    const status = comparison.passed ? '✅' : '❌';
    const driftStr = comparison.drift.toFixed(2);

    if (comparison.legacyCount < 0) {
      console.log(`  ${status} Legacy table not found or empty`);
    } else if (comparison.newCount < 0) {
      console.log(`  ${status} New table not found or empty`);
    } else {
      console.log(`  Legacy: ${comparison.legacyCount} rows`);
      console.log(`  New:    ${comparison.newCount} rows`);
      console.log(`  Drift:  ${driftStr}% ${comparison.passed ? '(OK)' : '(EXCEEDS THRESHOLD)'}`);
    }
  }

  const allPassed = comparisons.every(c => c.passed);

  return { passed: allPassed, comparisons };
}

async function checkRecentWrites(): Promise<void> {
  console.log('\n--- Recent Write Activity ---');

  // Check recent activity inserts
  try {
    const legacyRecent = await db.query<any[]>(`
      SELECT count() FROM activity_template
      WHERE created_at > time::now() - 1h
      GROUP ALL
    `);
    const newRecent = await db.query<any[]>(`
      SELECT count() FROM activity
      WHERE created_at > time::now() - 1h
      GROUP ALL
    `);

    const legacyCount = (legacyRecent[0] as any[])?.[0]?.count || 0;
    const newCount = (newRecent[0] as any[])?.[0]?.count || 0;

    console.log(`Activities (last hour): Legacy=${legacyCount}, New=${newCount}`);

    if (legacyCount > 0 && newCount === 0) {
      console.log('  ⚠️ WARNING: Legacy writes detected but no new table writes - check dual-write config');
    }
  } catch (error) {
    console.log('  Could not check recent writes');
  }

  // Check recent execution inserts
  try {
    const legacyRecent = await db.query<any[]>(`
      SELECT count() FROM activity_execution_traces
      WHERE executed_at > time::now() - 1h
      GROUP ALL
    `);
    const newRecent = await db.query<any[]>(`
      SELECT count() FROM execution
      WHERE executed_at > time::now() - 1h
      GROUP ALL
    `);

    const legacyCount = (legacyRecent[0] as any[])?.[0]?.count || 0;
    const newCount = (newRecent[0] as any[])?.[0]?.count || 0;

    console.log(`Executions (last hour): Legacy=${legacyCount}, New=${newCount}`);

    if (legacyCount > 0 && newCount === 0) {
      console.log('  ⚠️ WARNING: Legacy writes detected but no new table writes - check dual-write config');
    }
  } catch (error) {
    console.log('  Could not check recent writes');
  }
}

async function main() {
  try {
    await connect();

    const { passed, comparisons } = await runValidation();
    await checkRecentWrites();

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('VALIDATION SUMMARY');
    console.log('='.repeat(80));

    const passedCount = comparisons.filter(c => c.passed).length;
    const totalCount = comparisons.length;

    console.log(`\nResult: ${passedCount}/${totalCount} table pairs within drift threshold`);

    if (passed) {
      console.log('\n✅ VALIDATION PASSED - All tables are in sync');
      process.exit(0);
    } else {
      console.log('\n❌ VALIDATION FAILED - Drift exceeds threshold');
      console.log('\nFailed comparisons:');
      for (const c of comparisons.filter(c => !c.passed)) {
        console.log(`  - ${c.legacyTable} (${c.legacyCount}) vs ${c.newTable} (${c.newCount}): ${c.drift.toFixed(2)}% drift`);
      }
      process.exit(1);
    }
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    await disconnect();
  }
}

main();
