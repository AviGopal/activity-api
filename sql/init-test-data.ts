#!/usr/bin/env bun

/**
 * Initialize test data in SurrealDB
 *
 * Creates default organization and MiniBob instance for local development.
 * This script is idempotent - safe to run multiple times.
 *
 * Environment variables:
 * - SURREALDB_URL: SurrealDB connection URL
 * - SURREALDB_NAMESPACE: Database namespace
 * - SURREALDB_DATABASE: Database name
 * - SURREALDB_USERNAME: Auth username
 * - SURREALDB_PASSWORD: Auth password
 * - DEFAULT_ORG_ID: Organization ID (default: metabob_internal)
 * - DEFAULT_ORG_NAME: Organization name (default: Metabob Internal)
 * - MINIBOB_INSTANCE_ID: MiniBob instance ID (default: minibob-local-001)
 * - MINIBOB_API_KEY: MiniBob API key (default: test-api-key-123)
 * - MINIBOB_VESSEL_ID: MiniBob vessel ID (default: minibob-cli-local)
 */

import { Surreal } from 'surrealdb';

const SURREAL_URL = process.env.SURREALDB_URL || 'http://localhost:8000';
const SURREAL_NAMESPACE = process.env.SURREALDB_NAMESPACE || 'metabob';
const SURREAL_DATABASE = process.env.SURREALDB_DATABASE || 'learning_loop';
const SURREAL_USERNAME = process.env.SURREALDB_USERNAME || 'root';
const SURREAL_PASSWORD = process.env.SURREALDB_PASSWORD || 'root';

const DEFAULT_ORG_ID = process.env.DEFAULT_ORG_ID || 'metabob_internal';
const DEFAULT_ORG_NAME = process.env.DEFAULT_ORG_NAME || 'Metabob Internal';
const MINIBOB_INSTANCE_ID = process.env.MINIBOB_INSTANCE_ID || 'minibob-local-001';
const MINIBOB_API_KEY = process.env.MINIBOB_API_KEY || 'test-api-key-123';
const MINIBOB_VESSEL_ID = process.env.MINIBOB_VESSEL_ID || 'minibob-cli-local';

async function initTestData() {
  const db = new Surreal();

  try {
    console.log(`Connecting to SurrealDB at ${SURREAL_URL}...`);
    await db.connect(SURREAL_URL);

    console.log(`Signing in as ${SURREAL_USERNAME}...`);
    await db.signin({
      username: SURREAL_USERNAME,
      password: SURREAL_PASSWORD,
    });

    console.log(`Using namespace: ${SURREAL_NAMESPACE}, database: ${SURREAL_DATABASE}`);
    await db.use({
      namespace: SURREAL_NAMESPACE,
      database: SURREAL_DATABASE,
    });

    // Check if default organization exists
    console.log(`\nChecking for organization: ${DEFAULT_ORG_ID}...`);
    const orgCheck = await db.query(
      `SELECT * FROM organizations WHERE id = type::thing('organizations', $org_id)`,
      { org_id: DEFAULT_ORG_ID }
    );

    if (!orgCheck[0] || orgCheck[0].length === 0) {
      console.log(`Creating default organization: ${DEFAULT_ORG_NAME}...`);
      const orgResult = await db.query(
        `CREATE organizations:$org_id SET
          name = $name,
          created_at = time::now(),
          updated_at = time::now()`,
        {
          org_id: DEFAULT_ORG_ID,
          name: DEFAULT_ORG_NAME,
        }
      );
      console.log(`✓ Created organization: ${DEFAULT_ORG_ID}`);
      console.log(JSON.stringify(orgResult[0], null, 2));
    } else {
      console.log(`✓ Organization ${DEFAULT_ORG_ID} already exists`);
    }

    // Check if MiniBob instance exists
    console.log(`\nChecking for MiniBob instance: ${MINIBOB_INSTANCE_ID}...`);
    const instanceCheck = await db.query(
      `SELECT * FROM minibob_instance WHERE instance_id = $instance_id`,
      { instance_id: MINIBOB_INSTANCE_ID }
    );

    if (!instanceCheck[0] || instanceCheck[0].length === 0) {
      console.log(`Creating MiniBob instance: ${MINIBOB_INSTANCE_ID}...`);

      // Generate argon2 hash for API key
      const hashResult = await db.query(
        `RETURN crypto::argon2::generate($api_key)`,
        { api_key: MINIBOB_API_KEY }
      );
      const apiKeyHash = hashResult[0];

      const instanceResult = await db.query(
        `CREATE minibob_instance SET
          instance_id = $instance_id,
          org_id = type::thing('organizations', $org_id),
          project_id = NONE,
          api_key_hash = $api_key_hash,
          vessel_id = $vessel_id,
          is_active = true,
          created_at = time::now(),
          last_active_at = time::now()`,
        {
          instance_id: MINIBOB_INSTANCE_ID,
          org_id: DEFAULT_ORG_ID,
          api_key_hash: apiKeyHash,
          vessel_id: MINIBOB_VESSEL_ID,
        }
      );
      console.log(`✓ Created MiniBob instance: ${MINIBOB_INSTANCE_ID}`);
      console.log(JSON.stringify(instanceResult[0], null, 2));
    } else {
      console.log(`✓ MiniBob instance ${MINIBOB_INSTANCE_ID} already exists`);
    }

    console.log('\n✅ Test data initialization complete!');
    console.log('\nConfiguration:');
    console.log(`  Organization: ${DEFAULT_ORG_ID} (${DEFAULT_ORG_NAME})`);
    console.log(`  MiniBob Instance ID: ${MINIBOB_INSTANCE_ID}`);
    console.log(`  MiniBob Vessel ID: ${MINIBOB_VESSEL_ID}`);
    console.log(`  MiniBob API Key: ${MINIBOB_API_KEY.substring(0, 8)}... (for local dev only)`);

  } catch (error) {
    console.error('❌ Error initializing test data:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

// Run initialization
initTestData();
