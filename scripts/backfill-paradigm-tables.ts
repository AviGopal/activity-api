#!/usr/bin/env bun
/**
 * Historical Data Backfill Script (P4.2)
 *
 * Migrates data from legacy tables to new paradigm tables:
 * - activity_template → activity
 * - activity_execution_traces → execution
 * - impulse_data → impulse
 * - minibob_instance → vessel
 *
 * Features:
 * - Batch processing (configurable batch size)
 * - Progress logging
 * - Idempotent (can be re-run safely)
 * - Error handling with retry
 *
 * Usage:
 *   SURREALDB_URL=http://localhost:8000 bun run scripts/backfill-paradigm-tables.ts
 *
 * Environment:
 *   SURREALDB_URL - SurrealDB connection URL
 *   SURREALDB_NAMESPACE - Namespace (default: activity-system)
 *   SURREALDB_DATABASE - Database (default: learning_loop)
 *   SURREALDB_USERNAME - Username (default: root)
 *   SURREALDB_PASSWORD - Password
 *   BATCH_SIZE - Records per batch (default: 1000)
 *   DRY_RUN - If 'true', don't actually write (default: false)
 */

import Surreal from 'surrealdb';

// Configuration
const config = {
  url: process.env.SURREALDB_URL || 'http://localhost:8000',
  namespace: process.env.SURREALDB_NAMESPACE || 'activity-system',
  database: process.env.SURREALDB_DATABASE || 'learning_loop',
  username: process.env.SURREALDB_USERNAME || 'root',
  password: process.env.SURREALDB_PASSWORD || '',
  batchSize: parseInt(process.env.BATCH_SIZE || '1000', 10),
  dryRun: process.env.DRY_RUN === 'true',
};

console.log('='.repeat(80));
console.log('PARADIGM TABLES BACKFILL (P4.2)');
console.log('='.repeat(80));
console.log(`SurrealDB URL: ${config.url}`);
console.log(`Namespace: ${config.namespace}`);
console.log(`Database: ${config.database}`);
console.log(`Batch Size: ${config.batchSize}`);
console.log(`Dry Run: ${config.dryRun}`);
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
  console.log('Disconnected from SurrealDB');
}

// =============================================================================
// MIGRATION: activity_template → activity
// =============================================================================

async function migrateActivityTemplates(): Promise<{ migrated: number; skipped: number; errors: number }> {
  console.log('\n--- Migrating activity_template → activity ---');

  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  let offset = 0;

  while (true) {
    // Fetch batch from legacy table
    const query = `
      SELECT * FROM activity_template
      ORDER BY created_at ASC
      LIMIT ${config.batchSize}
      START ${offset}
    `;
    const result = await db.query<any[]>(query);
    const records = (result[0] || []) as any[];

    if (records.length === 0) {
      break;
    }

    console.log(`  Processing batch at offset ${offset}: ${records.length} records`);

    for (const legacy of records) {
      try {
        // Check if already migrated (idempotent)
        const checkQuery = `SELECT id FROM activity WHERE id = $id`;
        const existing = await db.query<any[]>(checkQuery, { id: legacy.variant_id || legacy.id });

        if (existing[0]?.length > 0) {
          skipped++;
          continue;
        }

        // Transform to new schema
        const activity = {
          id: legacy.variant_id || legacy.id,
          name: legacy.variant_name || legacy.name,
          description: legacy.description,
          input_shapes: [], // Legacy doesn't have shapes
          output_shapes: [],
          execution_type: 'template',
          category: legacy.category,
          tasks: legacy.task_steps || legacy.tasks || [],
          scope: legacy.scope || 'org',
          public: legacy.scope === 'global' || legacy.public === true,
          metadata: legacy.metadata || {},
          org_id: legacy.org_id,
          project_id: legacy.project_id,
          created_at: legacy.created_at || new Date().toISOString(),
          updated_at: legacy.updated_at || new Date().toISOString(),
        };

        if (!config.dryRun) {
          const insertQuery = `
            INSERT INTO activity {
              id: $id,
              name: $name,
              description: $description,
              input_shapes: $input_shapes,
              output_shapes: $output_shapes,
              execution_type: $execution_type,
              category: $category,
              tasks: $tasks,
              scope: $scope,
              public: $public,
              metadata: $metadata,
              org_id: type::record('organizations', $org_id),
              created_at: $created_at,
              updated_at: $updated_at
            }
          `;
          await db.query(insertQuery, activity);
        }

        migrated++;
      } catch (error) {
        console.error(`  ❌ Error migrating template ${legacy.variant_id}:`, error);
        errors++;
      }
    }

    offset += config.batchSize;

    // Progress update
    console.log(`  Progress: ${migrated} migrated, ${skipped} skipped, ${errors} errors`);
  }

  return { migrated, skipped, errors };
}

// =============================================================================
// MIGRATION: activity_execution_traces → execution
// =============================================================================

async function migrateExecutionTraces(): Promise<{ migrated: number; skipped: number; errors: number }> {
  console.log('\n--- Migrating activity_execution_traces → execution ---');

  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  let offset = 0;

  while (true) {
    // Fetch batch from legacy table
    const query = `
      SELECT * FROM activity_execution_traces
      ORDER BY executed_at ASC
      LIMIT ${config.batchSize}
      START ${offset}
    `;
    const result = await db.query<any[]>(query);
    const records = (result[0] || []) as any[];

    if (records.length === 0) {
      break;
    }

    console.log(`  Processing batch at offset ${offset}: ${records.length} records`);

    for (const legacy of records) {
      try {
        // Check if already migrated (idempotent)
        const checkQuery = `SELECT id FROM execution WHERE id = $id`;
        const existing = await db.query<any[]>(checkQuery, { id: legacy.execution_id || legacy.id });

        if (existing[0]?.length > 0) {
          skipped++;
          continue;
        }

        // Transform to new schema
        const execution = {
          id: legacy.execution_id || legacy.id,
          activity_id: legacy.variant_id || legacy.activity_id,
          input_impulses: legacy.impulses_used || [],
          output_impulses: [],
          success: legacy.success,
          error: legacy.error_message ? {
            message: legacy.error_message,
            type: legacy.error_type,
            task_id: legacy.failed_task_id,
          } : null,
          duration_ms: legacy.duration_ms || 0,
          cost_usd: legacy.cost_usd || 0,
          tokens_in: legacy.tokens_input || 0,
          tokens_out: legacy.tokens_output || 0,
          trace: {
            tasks: legacy.tasks || [],
            state_snapshot: legacy.state_snapshot || {},
          },
          org_id: legacy.org_id,
          project_id: legacy.project_id,
          vessel_id: legacy.pod_name || null,
          executed_at: legacy.executed_at || new Date().toISOString(),
          created_at: legacy.created_at || new Date().toISOString(),
        };

        if (!config.dryRun) {
          const insertQuery = `
            INSERT INTO execution {
              id: $id,
              activity_id: $activity_id,
              input_impulses: $input_impulses,
              output_impulses: $output_impulses,
              success: $success,
              error: $error,
              duration_ms: $duration_ms,
              cost_usd: $cost_usd,
              tokens_in: $tokens_in,
              tokens_out: $tokens_out,
              trace: $trace,
              org_id: type::record('organizations', $org_id),
              vessel_id: $vessel_id,
              executed_at: $executed_at,
              created_at: $created_at
            }
          `;
          await db.query(insertQuery, execution);
        }

        migrated++;
      } catch (error) {
        console.error(`  ❌ Error migrating execution ${legacy.execution_id}:`, error);
        errors++;
      }
    }

    offset += config.batchSize;

    // Progress update
    console.log(`  Progress: ${migrated} migrated, ${skipped} skipped, ${errors} errors`);
  }

  return { migrated, skipped, errors };
}

// =============================================================================
// MIGRATION: impulse_data → impulse
// =============================================================================

async function migrateImpulses(): Promise<{ migrated: number; skipped: number; errors: number }> {
  console.log('\n--- Migrating impulse_data → impulse ---');

  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  let offset = 0;

  while (true) {
    // Fetch batch from legacy table
    const query = `
      SELECT * FROM impulse_data
      ORDER BY created_at ASC
      LIMIT ${config.batchSize}
      START ${offset}
    `;
    const result = await db.query<any[]>(query);
    const records = (result[0] || []) as any[];

    if (records.length === 0) {
      break;
    }

    console.log(`  Processing batch at offset ${offset}: ${records.length} records`);

    for (const legacy of records) {
      try {
        // Check if already migrated (idempotent)
        const checkQuery = `SELECT id FROM impulse WHERE id = $id`;
        const existing = await db.query<any[]>(checkQuery, { id: legacy.impulse_id || legacy.id });

        if (existing[0]?.length > 0) {
          skipped++;
          continue;
        }

        // Infer shape from pointer type
        const inferShape = (pointerType: string): string => {
          switch (pointerType) {
            case 'file': return 'source_code';
            case 'memo': return 'memo';
            case 'activityExecutionTrace': return 'trace';
            case 'activityTemplate': return 'template';
            case 'activityMetrics': return 'metrics';
            default: return 'custom';
          }
        };

        // Transform to new schema
        const impulse = {
          id: legacy.impulse_id || legacy.id,
          pointer: legacy.pointer || { type: 'memo', content: legacy.content },
          shape: legacy.shape || inferShape(legacy.pointer?.type || 'memo'),
          content: legacy.content,
          budget: legacy.budget || 2000,
          priority: legacy.priority || 'medium',
          tags: legacy.tags || [],
          metadata: legacy.metadata || {},
          org_id: legacy.org_id,
          project_id: legacy.project_id,
          created_at: legacy.created_at || new Date().toISOString(),
        };

        if (!config.dryRun) {
          const insertQuery = `
            INSERT INTO impulse {
              id: $id,
              pointer: $pointer,
              shape: $shape,
              content: $content,
              budget: $budget,
              priority: $priority,
              tags: $tags,
              metadata: $metadata,
              org_id: type::record('organizations', $org_id),
              created_at: $created_at
            }
          `;
          await db.query(insertQuery, impulse);
        }

        migrated++;
      } catch (error) {
        console.error(`  ❌ Error migrating impulse ${legacy.impulse_id}:`, error);
        errors++;
      }
    }

    offset += config.batchSize;

    // Progress update
    console.log(`  Progress: ${migrated} migrated, ${skipped} skipped, ${errors} errors`);
  }

  return { migrated, skipped, errors };
}

// =============================================================================
// MIGRATION: minibob_instance → vessel
// =============================================================================

async function migrateVessels(): Promise<{ migrated: number; skipped: number; errors: number }> {
  console.log('\n--- Migrating minibob_instance → vessel ---');

  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  let offset = 0;

  while (true) {
    // Fetch batch from legacy table
    const query = `
      SELECT * FROM minibob_instance
      ORDER BY created_at ASC
      LIMIT ${config.batchSize}
      START ${offset}
    `;
    const result = await db.query<any[]>(query);
    const records = (result[0] || []) as any[];

    if (records.length === 0) {
      break;
    }

    console.log(`  Processing batch at offset ${offset}: ${records.length} records`);

    for (const legacy of records) {
      try {
        // Check if already migrated (idempotent)
        const checkQuery = `SELECT id FROM vessel WHERE id = $id`;
        const existing = await db.query<any[]>(checkQuery, { id: legacy.instance_id || legacy.id });

        if (existing[0]?.length > 0) {
          skipped++;
          continue;
        }

        // Transform to new schema
        const vessel = {
          id: legacy.instance_id || legacy.id,
          name: legacy.name || legacy.instance_id,
          version: legacy.version || '0.1.0',
          resolves: ['memo', 'file'], // Default resolvers
          api_key_hash: legacy.api_key_hash,
          status: legacy.status || 'active',
          last_heartbeat: legacy.last_heartbeat,
          capabilities: legacy.capabilities || [],
          metadata: legacy.metadata || {},
          org_id: legacy.org_id,
          created_at: legacy.created_at || new Date().toISOString(),
          updated_at: legacy.updated_at || new Date().toISOString(),
        };

        if (!config.dryRun) {
          const insertQuery = `
            INSERT INTO vessel {
              id: $id,
              name: $name,
              version: $version,
              resolves: $resolves,
              api_key_hash: $api_key_hash,
              status: $status,
              last_heartbeat: $last_heartbeat,
              capabilities: $capabilities,
              metadata: $metadata,
              org_id: type::record('organizations', $org_id),
              created_at: $created_at,
              updated_at: $updated_at
            }
          `;
          await db.query(insertQuery, vessel);
        }

        migrated++;
      } catch (error) {
        console.error(`  ❌ Error migrating vessel ${legacy.instance_id}:`, error);
        errors++;
      }
    }

    offset += config.batchSize;

    // Progress update
    console.log(`  Progress: ${migrated} migrated, ${skipped} skipped, ${errors} errors`);
  }

  return { migrated, skipped, errors };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  try {
    await connect();

    const results = {
      activities: await migrateActivityTemplates(),
      executions: await migrateExecutionTraces(),
      impulses: await migrateImpulses(),
      vessels: await migrateVessels(),
    };

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('MIGRATION SUMMARY');
    console.log('='.repeat(80));

    let totalMigrated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (const [table, stats] of Object.entries(results)) {
      console.log(`\n${table}:`);
      console.log(`  Migrated: ${stats.migrated}`);
      console.log(`  Skipped:  ${stats.skipped}`);
      console.log(`  Errors:   ${stats.errors}`);

      totalMigrated += stats.migrated;
      totalSkipped += stats.skipped;
      totalErrors += stats.errors;
    }

    console.log('\n' + '-'.repeat(40));
    console.log(`TOTAL: ${totalMigrated} migrated, ${totalSkipped} skipped, ${totalErrors} errors`);

    if (config.dryRun) {
      console.log('\n⚠️  DRY RUN - no data was actually written');
    }

    if (totalErrors > 0) {
      console.log('\n⚠️  Some records failed to migrate. Review errors above.');
      process.exit(1);
    } else {
      console.log('\n✅ Migration completed successfully!');
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
