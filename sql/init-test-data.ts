#!/usr/bin/env bun

/**
 * Initialize test data in SurrealDB
 *
 * Creates default organization and MiniBob instance for local development.
 * This script is idempotent - safe to run multiple times.
 *
 * =============================================================================
 * API KEY STANDARDIZATION
 * =============================================================================
 * The MiniBob instance API key must be consistent across:
 * 1. This script (creates the hash in SurrealDB)
 * 2. repos/minibob/.env (MINIBOB_INSTANCE_API_KEY)
 * 3. repos/deployment/charts/init-data/values.yaml
 * 4. repos/deployment/charts/minibob/values.yaml
 *
 * Standard local development configuration:
 *   API Key:     minibob-local-dev-key
 *   Instance ID: minibob-local-001
 *   Org ID:      organizations:metabob
 *
 * This simple, memorable key is used for all local development environments.
 * =============================================================================
 *
 * Environment variables:
 * - SURREALDB_URL: SurrealDB connection URL
 * - SURREALDB_NAMESPACE: Database namespace
 * - SURREALDB_DATABASE: Database name
 * - SURREALDB_USERNAME: Auth username
 * - SURREALDB_PASSWORD: Auth password
 * - DEFAULT_ORG_ID: Organization ID (default: metabob)
 * - DEFAULT_ORG_NAME: Organization name (default: Metabob)
 * - MINIBOB_INSTANCE_ID: MiniBob instance ID (default: minibob-local-001)
 * - MINIBOB_API_KEY: MiniBob API key (default: standard local dev key)
 * - MINIBOB_VESSEL_ID: MiniBob vessel ID (default: minibob-cli-local)
 */

import { Surreal } from 'surrealdb';

const SURREAL_URL = process.env.SURREALDB_URL || 'http://localhost:8000';
const SURREAL_NAMESPACE = process.env.SURREALDB_NAMESPACE || 'activity-system';
const SURREAL_DATABASE = process.env.SURREALDB_DATABASE || 'learning_loop';
const SURREAL_USERNAME = process.env.SURREALDB_USERNAME || 'root';
const SURREAL_PASSWORD = process.env.SURREALDB_PASSWORD || 'root';

// Organization defaults - "metabob" is the standard org for local dev
// (matches repos/deployment/secrets/local.secrets.yaml)
const DEFAULT_ORG_ID = process.env.DEFAULT_ORG_ID || 'metabob';
const DEFAULT_ORG_NAME = process.env.DEFAULT_ORG_NAME || 'Metabob';

// MiniBob instance defaults
const MINIBOB_INSTANCE_ID = process.env.MINIBOB_INSTANCE_ID || 'minibob-local-001';

// =============================================================================
// STANDARD LOCAL DEVELOPMENT API KEY
// =============================================================================
// This key MUST match across all local dev configurations:
// - repos/minibob/.env (MINIBOB_INSTANCE_API_KEY)
// - repos/deployment/charts/init-data/values.yaml (minibobInstances[].apiKey)
// - repos/deployment/charts/minibob/values.yaml (instance documentation)
//
// Key: minibob-local-dev-key (simple, memorable for local development)
// =============================================================================
const MINIBOB_API_KEY = process.env.MINIBOB_API_KEY || 'minibob-local-dev-key';

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
      `SELECT * FROM organizations WHERE id = $org_id`,
      { org_id: `organizations:${DEFAULT_ORG_ID}` }
    );

    if (!orgCheck[0] || orgCheck[0].length === 0) {
      console.log(`Creating default organization: ${DEFAULT_ORG_NAME}...`);
      const orgResult = await db.query(
        `UPDATE $org_id CONTENT {
          name: $name,
          created_at: time::now(),
          updated_at: time::now()
        }`,
        {
          org_id: `organizations:${DEFAULT_ORG_ID}`,
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

      // Use record format for org_id to match JWT $auth.org_id format
      // This ensures consistency across RECORD and JWT authentication methods
      const instanceResult = await db.query(
        `CREATE minibob_instance CONTENT {
          instance_id: $instance_id,
          org_id: $org_id,
          project_id: NONE,
          api_key_hash: $api_key_hash,
          vessel_id: $vessel_id,
          is_active: true,
          created_at: time::now(),
          last_active_at: time::now()
        }`,
        {
          instance_id: MINIBOB_INSTANCE_ID,
          org_id: `organizations:${DEFAULT_ORG_ID}`,
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
