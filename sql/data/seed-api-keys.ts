#!/usr/bin/env bun
/**
 * Seed API Keys for Direct Authentication
 *
 * This script creates test API keys in the api_key table for direct authentication.
 * Run this after applying the 049-api-key-direct-auth.surql schema.
 *
 * Usage:
 *   bun run sql/data/seed-api-keys.ts
 *
 * Environment variables:
 *   SURREALDB_URL      - SurrealDB connection URL (default: http://localhost:8000)
 *   SURREALDB_NAMESPACE - Namespace (default: activity-system)
 *   SURREALDB_DATABASE  - Database (default: learning_loop)
 *   SURREALDB_USERNAME  - Root username (default: root)
 *   SURREALDB_PASSWORD  - Root password (required)
 */

import { Surreal } from 'surrealdb';

// Test API keys - these are hashed using SHA-256 before storage
const testApiKeys = [
  {
    // Raw key: "test-api-key-metabob-internal-001"
    raw: 'test-api-key-metabob-internal-001',
    org_id: 'metabob_internal',
    user_id: 'system',
    name: 'Metabob Internal Test Key',
    scopes: ['read', 'write', 'admin'],
  },
  {
    // Raw key: "test-api-key-dev-local-001"
    raw: 'test-api-key-dev-local-001',
    org_id: 'metabob_internal',
    user_id: 'developer',
    name: 'Local Development Key',
    scopes: ['read', 'write'],
  },
  {
    // Raw key: "minibob-direct-api-key-001"
    raw: 'minibob-direct-api-key-001',
    org_id: 'metabob_internal',
    user_id: 'minibob',
    name: 'MiniBob Direct Auth Key',
    scopes: ['read', 'write'],
  },
];

/**
 * Compute SHA-256 hash of an API key
 */
async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function main() {
  const config = {
    url: process.env.SURREALDB_URL || 'http://localhost:8000',
    namespace: process.env.SURREALDB_NAMESPACE || 'activity-system',
    database: process.env.SURREALDB_DATABASE || 'learning_loop',
    username: process.env.SURREALDB_USERNAME || 'root',
    password: process.env.SURREALDB_PASSWORD,
  };

  if (!config.password) {
    console.error('Error: SURREALDB_PASSWORD environment variable is required');
    process.exit(1);
  }

  console.log('Connecting to SurrealDB...');
  console.log(`  URL: ${config.url}`);
  console.log(`  Namespace: ${config.namespace}`);
  console.log(`  Database: ${config.database}`);

  const db = new Surreal();

  try {
    await db.connect(config.url);
    await db.use({
      namespace: config.namespace,
      database: config.database,
    });
    await db.signin({
      username: config.username,
      password: config.password,
    });

    console.log('\nCreating test API keys...\n');

    for (const keyConfig of testApiKeys) {
      const keyHash = await hashApiKey(keyConfig.raw);

      // Check if key already exists
      const existing = await db.query<{ id: string }[]>(
        'SELECT id FROM api_key WHERE key_hash = $key_hash LIMIT 1',
        { key_hash: keyHash }
      );

      if (existing && existing.length > 0 && existing[0].length > 0) {
        console.log(`[SKIP] Key already exists: ${keyConfig.name}`);
        console.log(`       Hash: ${keyHash.substring(0, 16)}...`);
        continue;
      }

      // Create the key
      const result = await db.query(
        `CREATE api_key SET
          key_hash = $key_hash,
          org_id = $org_id,
          user_id = $user_id,
          name = $name,
          scopes = $scopes,
          is_active = true,
          created_at = time::now()`,
        {
          key_hash: keyHash,
          org_id: keyConfig.org_id,
          user_id: keyConfig.user_id,
          name: keyConfig.name,
          scopes: keyConfig.scopes,
        }
      );

      console.log(`[CREATE] ${keyConfig.name}`);
      console.log(`         Raw Key: ${keyConfig.raw}`);
      console.log(`         Hash: ${keyHash.substring(0, 16)}...`);
      console.log(`         Org: ${keyConfig.org_id}`);
      console.log(`         Scopes: ${keyConfig.scopes.join(', ')}`);
      console.log('');
    }

    // List all keys
    console.log('\n--- All API Keys ---');
    const allKeys = await db.query<
      {
        id: string;
        name: string;
        org_id: string;
        is_active: boolean;
        created_at: string;
      }[]
    >('SELECT id, name, org_id, is_active, created_at FROM api_key');

    if (allKeys && allKeys.length > 0) {
      const keys = allKeys[0];
      if (Array.isArray(keys)) {
        for (const key of keys) {
          console.log(`  ${key.id}: ${key.name} (org: ${key.org_id}, active: ${key.is_active})`);
        }
      }
    }

    console.log('\nDone! Test API keys created.');
    console.log('\nTo test direct authentication:');
    console.log(
      `  curl -H "Authorization: ApiKey test-api-key-metabob-internal-001" http://activity.metabob.local/v2/activities/templates`
    );
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main();
