#!/usr/bin/env bun

import { Surreal } from 'surrealdb';

const SURREAL_URL = process.env.SURREALDB_URL || 'http://surrealdb.activity-system.svc.cluster.local:8000';
const SURREAL_NAMESPACE = process.env.SURREALDB_NAMESPACE || 'activity-system';
const SURREAL_DATABASE = process.env.SURREALDB_DATABASE || 'learning_loop';
const SURREAL_USERNAME = process.env.SURREALDB_USERNAME || 'root';
const SURREAL_PASSWORD = process.env.SURREALDB_PASSWORD || 'FJKokzYmiEIxGtTkrVvCI6VTaTfGR26x';

const MINIBOB_INSTANCE_ID = 'minibob-local-001';
const MINIBOB_API_KEY = process.env.MINIBOB_API_KEY || 'mb_svc_local_29dfb059a84306ea4f9cc58c65b67335b3c3f03645c361b5dc1a8507a72ad4c9';
const ORG_ID = 'metabob_internal';
const VESSEL_ID = 'minibob-cli-local';

async function createInstance() {
  const db = new Surreal();

  try {
    console.log(`Connecting to ${SURREAL_URL}...`);
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

    // Check if instance exists
    console.log(`\nChecking for MiniBob instance: ${MINIBOB_INSTANCE_ID}...`);
    const instanceCheck = await db.query(
      `SELECT * FROM minibob_instance WHERE instance_id = $instance_id`,
      { instance_id: MINIBOB_INSTANCE_ID }
    );

    if (instanceCheck[0] && instanceCheck[0].length > 0) {
      console.log(`✓ MiniBob instance ${MINIBOB_INSTANCE_ID} already exists`);
      console.log(JSON.stringify(instanceCheck[0][0], null, 2));
      return;
    }

    // Generate argon2 hash for API key
    console.log(`Generating API key hash...`);
    const hashResult = await db.query(
      `RETURN crypto::argon2::generate($api_key)`,
      { api_key: MINIBOB_API_KEY }
    );
    const apiKeyHash = hashResult[0];
    console.log(`Hash: ${apiKeyHash.substring(0, 20)}...`);

    // Create instance
    console.log(`Creating MiniBob instance...`);
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
        org_id: ORG_ID,
        api_key_hash: apiKeyHash,
        vessel_id: VESSEL_ID,
      }
    );

    console.log(`✓ Created MiniBob instance: ${MINIBOB_INSTANCE_ID}`);
    console.log(JSON.stringify(instanceResult[0], null, 2));

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

createInstance();
