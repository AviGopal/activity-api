#!/usr/bin/env bun
/**
 * Migration script for activity-api schemas with RBAC multi-tenancy
 *
 * This script:
 * 1. Imports and applies core schemas from @metabob/proto
 * 2. Applies activity-specific schemas from sql/schemas/
 * 3. Runs data migrations (backfill org_id, add indexes)
 *
 * Usage:
 *   bun sql/migrate.ts                    # Apply all migrations
 *   bun sql/migrate.ts --dry-run          # Preview migrations
 *   bun sql/migrate.ts --rollback v1.0    # Rollback to version
 *   bun sql/migrate.ts --data-only        # Run data migrations only
 *
 * Note: Uses named import for SurrealDB v2 compatibility
 */

import { Surreal } from 'surrealdb';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Configuration from environment
const config = {
  url: process.env.SURREALDB_URL || 'http://localhost:8000',
  namespace: process.env.SURREALDB_NAMESPACE || 'activity-system',
  database: process.env.SURREALDB_DATABASE || 'learning_loop',
  username: process.env.SURREALDB_USERNAME || 'root',
  password: process.env.SURREALDB_PASSWORD || 'root',
};

interface MigrationOptions {
  dryRun?: boolean;
  rollback?: string;
  dataOnly?: boolean;
  verbose?: boolean;
}

class MigrationRunner {
  private db: Surreal;
  private options: MigrationOptions;

  constructor(db: Surreal, options: MigrationOptions = {}) {
    this.db = db;
    this.options = options;
  }

  async log(message: string, level: 'info' | 'warn' | 'error' = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
    console.log(`${prefix} [${timestamp}] ${message}`);
  }

  /**
   * Apply core schemas from @metabob/proto
   * These provide organizations, users, projects, api_keys, and auth access definitions
   */
  async applyCoreSchemas(): Promise<void> {
    this.log('Applying core schemas from @metabob/proto...');

    // Core schema files in dependency order
    const coreSchemas = [
      '000-schema-version.surql',
      '001-auth-access.surql',
      '002-organizations.surql',
      '003-projects.surql',
      '004-subscriptions.surql',
    ];

    // Path to metabob-proto surrealdb schemas
    // In Docker container: /app/repos/metabob-proto/surrealdb/core
    // In local development: ../metabob-proto/surrealdb/core
    // Override with METABOB_PROTO_PATH env var
    const protoPath = process.env.METABOB_PROTO_PATH ||
      (process.env.NODE_ENV === 'production'
        ? '/app/repos/metabob-proto/surrealdb/core'
        : join(process.cwd(), '..', 'metabob-proto', 'surrealdb', 'core'));

    for (const schemaFile of coreSchemas) {
      const filePath = join(protoPath, schemaFile);
      try {
        const sql = await readFile(filePath, 'utf-8');

        if (this.options.dryRun) {
          this.log(`[DRY RUN] Would apply core schema: ${schemaFile}`);
          continue;
        }

        this.log(`Applying core schema: ${schemaFile}`);
        await this.executeSql(sql, schemaFile);
        this.log(`✓ Applied: ${schemaFile}`);
      } catch (error) {
        this.log(`Failed to apply ${schemaFile}: ${error}`, 'error');
        throw error;
      }
    }
  }

  /**
   * Apply activity-specific schemas from sql/schemas/
   */
  async applyActivitySchemas(): Promise<void> {
    this.log('Applying activity-specific schemas...');

    const schemaFiles = [
      '010-activity-registry.surql',
      '011-executions.surql',
      '012-composition.surql',
      '013-impulse-tool-usage.surql',
    ];

    const schemasPath = join(process.cwd(), 'sql', 'schemas');

    for (const schemaFile of schemaFiles) {
      const filePath = join(schemasPath, schemaFile);
      try {
        const sql = await readFile(filePath, 'utf-8');

        if (this.options.dryRun) {
          this.log(`[DRY RUN] Would apply activity schema: ${schemaFile}`);
          continue;
        }

        this.log(`Applying activity schema: ${schemaFile}`);
        await this.executeSql(sql, schemaFile);
        this.log(`✓ Applied: ${schemaFile}`);
      } catch (error) {
        this.log(`Failed to apply ${schemaFile}: ${error}`, 'error');
        throw error;
      }
    }
  }

  /**
   * Run data migrations to backfill org_id on existing records
   */
  async runDataMigrations(): Promise<void> {
    this.log('Running data migrations...');

    if (this.options.dryRun) {
      this.log('[DRY RUN] Would run data migrations');
      return;
    }

    // Create default organization if it doesn't exist
    await this.ensureDefaultOrganization();

    // Backfill org_id on existing records
    await this.backfillOrgId('activity_registry');
    await this.backfillOrgId('activity_execution_traces');
    await this.backfillOrgId('variant_performance_metrics');
    await this.backfillOrgId('activity_composition_graph');
    await this.backfillOrgId('impulse_relevance_metrics');
    await this.backfillOrgId('tool_usage');
    await this.backfillOrgId('goal_execution_paths');
    await this.backfillOrgId('activity_dataflows');
    await this.backfillOrgId('activity_prerequisites');
    await this.backfillOrgId('prerequisite_patterns');
    await this.backfillOrgId('execution_sequences');
    await this.backfillOrgId('impulse_data');
    await this.backfillOrgId('impulse_usage_history');
    await this.backfillOrgId('ci_runs');
    await this.backfillOrgId('code_variants');

    this.log('✓ Data migrations completed');
  }

  /**
   * Ensure default organization exists for migration
   */
  private async ensureDefaultOrganization(): Promise<void> {
    this.log('Ensuring default organization exists...');

    try {
      const checkSql = `SELECT * FROM organizations WHERE id = organization:metabob_internal;`;
      const existing = await this.db.query<any>(checkSql);

      if (existing && existing[0]?.length > 0) {
        this.log('Default organization already exists');
        return;
      }

      const createSql = `
        CREATE organizations:metabob_internal SET
          name = 'Metabob Internal',
          seat_limit = 1000,
          seat_usage = 0,
          created_at = time::now(),
          updated_at = time::now();
      `;

      await this.db.query(createSql);
      this.log('✓ Created default organization: organization:metabob_internal');
    } catch (error: any) {
      // Ignore "already exists" errors
      if (error.message?.includes('already exists')) {
        this.log('Default organization already exists (caught on create)');
        return;
      }
      throw error;
    }
  }

  /**
   * Backfill org_id on existing records in a table
   * Uses batching to avoid timeout on large tables
   */
  private async backfillOrgId(tableName: string): Promise<void> {
    this.log(`Backfilling org_id on ${tableName}...`);

    // Check if table exists
    const checkTable = `INFO FOR TABLE ${tableName};`;
    try {
      await this.db.query(checkTable);
    } catch (error) {
      this.log(`Table ${tableName} does not exist, skipping`, 'warn');
      return;
    }

    // Count records without org_id
    const countSql = `SELECT count() AS count FROM ${tableName} WHERE org_id IS NONE GROUP ALL;`;
    const countResult = await this.db.query<any>(countSql);
    const count = countResult?.[0]?.[0]?.count || 0;

    if (count === 0) {
      this.log(`No records to backfill in ${tableName}`);
      return;
    }

    this.log(`Found ${count} records without org_id in ${tableName}`);

    // Backfill in batches of 10,000 records
    const batchSize = 10000;
    let processed = 0;

    while (processed < count) {
      const updateSql = `
        UPDATE ${tableName}
        SET org_id = organization:metabob_internal
        WHERE org_id IS NONE
        LIMIT ${batchSize};
      `;

      const result = await this.db.query<any>(updateSql);
      const updated = Array.isArray(result?.[0]) ? result[0].length : 0;
      processed += updated;

      this.log(`  Backfilled ${processed}/${count} records in ${tableName}`);

      if (updated === 0) {
        break; // No more records to update
      }
    }

    this.log(`✓ Backfilled org_id on ${tableName} (${processed} records)`);
  }

  /**
   * Execute SQL with error handling
   */
  private async executeSql(sql: string, source: string): Promise<void> {
    try {
      await this.db.query(sql);
      if (this.options.verbose) {
        this.log(`  Executed SQL from ${source}`);
      }
    } catch (error: any) {
      this.log(`SQL execution failed for ${source}:`, 'error');
      this.log(`  Error: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Record migration in schema_version table
   */
  private async recordMigration(version: string, name: string, checksum: string = 'auto'): Promise<void> {
    if (this.options.dryRun) {
      this.log(`[DRY RUN] Would record migration: ${version} - ${name}`);
      return;
    }

    const sql = `
      CREATE schema_version SET
        version = '${version}',
        name = '${name}',
        checksum = '${checksum}',
        migration_type = 'activity',
        applied_at = time::now();
    `;

    await this.db.query(sql);
    this.log(`Recorded migration: ${version}`);
  }

  /**
   * Get current schema version
   */
  async getCurrentVersion(): Promise<string | null> {
    try {
      const sql = `SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1;`;
      const result = await this.db.query<any>(sql);
      return result?.[0]?.[0]?.version || null;
    } catch (error) {
      // schema_version table doesn't exist yet
      return null;
    }
  }
}

/**
 * Wait for SurrealDB to be ready with exponential backoff
 */
async function waitForDatabase(maxAttempts: number = 30): Promise<void> {
  const baseDelay = 2000; // Start with 2 seconds

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`Attempt ${attempt}/${maxAttempts}: Connecting to ${config.url}...`);

      const testDb = new Surreal();
      // SurrealDB 3.0: Connect, use, then signin
      await testDb.connect(config.url);
      // Use a minimal namespace/db just to test connection
      await testDb.use({ namespace: 'test', database: 'test' });
      await testDb.signin({
        username: config.username,
        password: config.password,
      });
      await testDb.close();

      console.log('✓ SurrealDB is ready');
      return;
    } catch (error: any) {
      const delay = baseDelay * Math.min(attempt, 10); // Cap at 20 seconds

      if (attempt === maxAttempts) {
        throw new Error(`Failed to connect to SurrealDB after ${maxAttempts} attempts: ${error.message}`);
      }

      console.log(`  Connection failed: ${error.message}`);
      console.log(`  Retrying in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Main migration function
 */
async function migrate(options: MigrationOptions = {}) {
  console.log('='.repeat(80));
  console.log('Activity API Schema Migration with RBAC Multi-Tenancy');
  console.log('='.repeat(80));
  console.log('');
  console.log(`Database: ${config.url}/${config.namespace}/${config.database}`);
  console.log(`Mode: ${options.dryRun ? 'DRY RUN' : 'APPLY'}`);
  console.log('');

  // Wait for SurrealDB to be ready
  await waitForDatabase();
  console.log('');

  const db = new Surreal();

  try {
    // SurrealDB 3.0: Connect, use, signin pattern
    await db.connect(config.url);

    // Use namespace and database (will be created if they don't exist)
    await db.use({
      namespace: config.namespace,
      database: config.database,
    });

    // Signin as root user
    await db.signin({
      username: config.username,
      password: config.password,
    });

    console.log('✓ Connected to database');
    console.log('');

    const runner = new MigrationRunner(db, options);

    // Check current version
    const currentVersion = await runner.getCurrentVersion();
    console.log(`Current schema version: ${currentVersion || 'none'}`);
    console.log('');

    if (options.rollback) {
      console.log(`⚠️  Rollback to version ${options.rollback} not implemented yet`);
      console.log('  Manual rollback required - see ROLLBACK_RUNBOOK.md');
      return;
    }

    // Apply migrations
    if (!options.dataOnly) {
      await runner.applyCoreSchemas();
      console.log('');

      await runner.applyActivitySchemas();
      console.log('');
    }

    // Run data migrations
    await runner.runDataMigrations();
    console.log('');

    // Record migration
    if (!options.dryRun) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      await runner.recordMigration(
        `phase2-rbac-${timestamp}`,
        'Phase 2: Activity API RBAC Multi-Tenancy Migration',
        'manual'  // checksum for manual migration
      );
    }

    console.log('='.repeat(80));
    console.log('✓ Migration completed successfully');
    console.log('='.repeat(80));
  } catch (error: any) {
    console.error('');
    console.error('='.repeat(80));
    console.error('❌ Migration failed:');
    console.error(error.message);
    console.error('='.repeat(80));
    process.exit(1);
  } finally {
    await db.close();
  }
}

// Parse command-line arguments
const args = process.argv.slice(2);
const options: MigrationOptions = {
  dryRun: args.includes('--dry-run'),
  rollback: args.find(arg => arg.startsWith('--rollback='))?.split('=')[1],
  dataOnly: args.includes('--data-only'),
  verbose: args.includes('--verbose') || args.includes('-v'),
};

// Run migration
migrate(options);
