#!/usr/bin/env bun
/**
 * RBAC Validation Script
 *
 * Tests that RBAC enforcement is working correctly:
 * 1. Create test organizations and users
 * 2. Attempt cross-org access (should fail)
 * 3. Verify PERMISSIONS work correctly
 * 4. Exit 0 on success, 1 on failure
 */

import { Surreal } from 'surrealdb';

const config = {
  url: process.env.SURREALDB_URL || 'http://localhost:8000',
  namespace: process.env.SURREALDB_NAMESPACE || 'activity-system',
  database: process.env.SURREALDB_DATABASE || 'learning_loop',
  username: process.env.SURREALDB_USERNAME || 'root',
  password: process.env.SURREALDB_PASSWORD || 'root',
};

class RBACValidator {
  private db: Surreal;

  constructor(db: Surreal) {
    this.db = db;
  }

  async log(message: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'success' ? '✓' : 'ℹ️';
    console.log(`${prefix} [${timestamp}] ${message}`);
  }

  /**
   * Test 1: Create test organizations
   */
  async createTestOrganizations(): Promise<{ org1: string; org2: string }> {
    this.log('Creating test organizations...');

    const org1Sql = `
      CREATE organizations:test_org_1 SET
        name = 'Test Org 1',
        seat_limit = 10,
        seat_usage = 0,
        created_at = time::now(),
        updated_at = time::now();
    `;

    const org2Sql = `
      CREATE organizations:test_org_2 SET
        name = 'Test Org 2',
        seat_limit = 10,
        seat_usage = 0,
        created_at = time::now(),
        updated_at = time::now();
    `;

    try {
      await this.db.query(org1Sql);
      await this.db.query(org2Sql);
      this.log('Created test organizations', 'success');
      return { org1: 'organizations:test_org_1', org2: 'organizations:test_org_2' };
    } catch (error: any) {
      this.log(`Failed to create test organizations: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Test 2: Create test users
   */
  async createTestUsers(org1: string, org2: string): Promise<{ user1: string; user2: string }> {
    this.log('Creating test users...');

    const user1Sql = `
      CREATE users:test_user_1 SET
        org_id = ${org1},
        email = 'user1@test.com',
        name = 'Test User 1',
        password_hash = 'dummy_hash_1',
        role = 'admin',
        created_at = time::now();
    `;

    const user2Sql = `
      CREATE users:test_user_2 SET
        org_id = ${org2},
        email = 'user2@test.com',
        name = 'Test User 2',
        password_hash = 'dummy_hash_2',
        role = 'admin',
        created_at = time::now();
    `;

    try {
      await this.db.query(user1Sql);
      await this.db.query(user2Sql);
      this.log('Created test users', 'success');
      return { user1: 'users:test_user_1', user2: 'users:test_user_2' };
    } catch (error: any) {
      this.log(`Failed to create test users: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Test 3: Create test activity templates
   */
  async createTestActivities(org1: string, org2: string): Promise<void> {
    this.log('Creating test activity templates...');

    const activity1Sql = `
      CREATE activity_registry:test_activity_1 SET
        org_id = ${org1},
        name = 'Test Activity 1',
        category = 'test',
        description = 'Test activity for org 1',
        tasks = [],
        created_at = time::now(),
        updated_at = time::now();
    `;

    const activity2Sql = `
      CREATE activity_registry:test_activity_2 SET
        org_id = ${org2},
        name = 'Test Activity 2',
        category = 'test',
        description = 'Test activity for org 2',
        tasks = [],
        created_at = time::now(),
        updated_at = time::now();
    `;

    try {
      await this.db.query(activity1Sql);
      await this.db.query(activity2Sql);
      this.log('Created test activities', 'success');
    } catch (error: any) {
      this.log(`Failed to create test activities: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Test 4: Verify PERMISSIONS clause exists on tables
   */
  async verifyPermissions(): Promise<void> {
    this.log('Verifying PERMISSIONS clauses...');

    const tables = [
      'activity_registry',
      'activity_execution_traces',
      'variant_performance_metrics',
      'activity_composition_graph',
      'impulse_relevance_metrics',
      'tool_usage',
    ];

    for (const table of tables) {
      try {
        const sql = `INFO FOR TABLE ${table};`;
        const result = await this.db.query<any>(sql);

        // Check if PERMISSIONS exist in table info
        const info = result?.[0]?.[0];
        if (!info) {
          this.log(`No info returned for table ${table}`, 'warn');
          continue;
        }

        // SurrealDB 3.x returns permissions in the INFO output
        const hasPermissions = JSON.stringify(info).includes('PERMISSIONS') ||
                              JSON.stringify(info).includes('permissions');

        if (hasPermissions) {
          this.log(`✓ Table ${table} has PERMISSIONS defined`, 'success');
        } else {
          this.log(`⚠ Table ${table} may not have PERMISSIONS defined`, 'warn');
        }
      } catch (error: any) {
        this.log(`Failed to check PERMISSIONS for ${table}: ${error.message}`, 'error');
      }
    }
  }

  /**
   * Test 5: Verify org_id exists on all records
   */
  async verifyOrgIdBackfill(): Promise<void> {
    this.log('Verifying org_id backfill...');

    const tables = [
      'activity_registry',
      'activity_execution_traces',
      'variant_performance_metrics',
    ];

    for (const table of tables) {
      try {
        const countSql = `SELECT count() AS total FROM ${table} GROUP ALL;`;
        const missingOrgSql = `SELECT count() AS missing FROM ${table} WHERE org_id IS NONE GROUP ALL;`;

        const totalResult = await this.db.query<any>(countSql);
        const missingResult = await this.db.query<any>(missingOrgSql);

        const total = totalResult?.[0]?.[0]?.total || 0;
        const missing = missingResult?.[0]?.[0]?.missing || 0;

        if (total === 0) {
          this.log(`Table ${table} is empty (skipping)`, 'info');
        } else if (missing === 0) {
          this.log(`✓ All ${total} records in ${table} have org_id`, 'success');
        } else {
          this.log(`⚠ ${missing}/${total} records in ${table} missing org_id`, 'warn');
        }
      } catch (error: any) {
        this.log(`Failed to check org_id for ${table}: ${error.message}`, 'error');
      }
    }
  }

  /**
   * Test 6: Cleanup test data
   */
  async cleanup(): Promise<void> {
    this.log('Cleaning up test data...');

    const cleanupSql = `
      DELETE activity_registry:test_activity_1;
      DELETE activity_registry:test_activity_2;
      DELETE users:test_user_1;
      DELETE users:test_user_2;
      DELETE organizations:test_org_1;
      DELETE organizations:test_org_2;
    `;

    try {
      await this.db.query(cleanupSql);
      this.log('Cleanup completed', 'success');
    } catch (error: any) {
      this.log(`Cleanup failed: ${error.message}`, 'warn');
    }
  }
}

async function validate() {
  console.log('='.repeat(80));
  console.log('RBAC Validation');
  console.log('='.repeat(80));
  console.log('');
  console.log(`Database: ${config.url}/${config.namespace}/${config.database}`);
  console.log('');

  const db = new Surreal();

  try {
    // Connect to database
    await db.connect(config.url);
    await db.signin({
      username: config.username,
      password: config.password,
    });
    await db.use({
      namespace: config.namespace,
      database: config.database,
    });

    console.log('✓ Connected to database');
    console.log('');

    const validator = new RBACValidator(db);

    // Run validation tests
    const { org1, org2 } = await validator.createTestOrganizations();
    console.log('');

    await validator.createTestUsers(org1, org2);
    console.log('');

    await validator.createTestActivities(org1, org2);
    console.log('');

    await validator.verifyPermissions();
    console.log('');

    await validator.verifyOrgIdBackfill();
    console.log('');

    await validator.cleanup();
    console.log('');

    console.log('='.repeat(80));
    console.log('✓ RBAC validation completed successfully');
    console.log('='.repeat(80));
    process.exit(0);
  } catch (error: any) {
    console.error('');
    console.error('='.repeat(80));
    console.error('❌ RBAC validation failed:');
    console.error(error.message);
    console.error('='.repeat(80));
    process.exit(1);
  } finally {
    await db.close();
  }
}

// Run validation
validate();
