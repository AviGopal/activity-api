#!/usr/bin/env bun
/**
 * Test SurrealDB RECORD authentication directly
 *
 * Validates that the apikey_record and minibob_record ACCESS methods work correctly.
 * This bypasses the HTTP API to test SurrealDB auth directly.
 */
import { Surreal } from 'surrealdb';

const SURREALDB_URL = process.env.SURREALDB_URL || 'http://surql.metabob.local/rpc';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function test(name: string, passed: boolean, error?: string) {
  results.push({ name, passed, error });
  console.log(`${passed ? '✓' : '✗'} ${name}${error ? `: ${error}` : ''}`);
}

async function setupTestData() {
  console.log('\n=== Setting up test data ===\n');

  const db = new Surreal();
  await db.connect(SURREALDB_URL);
  await db.signin({
    username: process.env.SURREALDB_USERNAME || 'root',
    password: process.env.SURREALDB_PASSWORD || 'surrealdb-local-dev-123',
  });
  await db.use({ namespace: 'activity-system', database: 'learning_loop' });

  // Create test org
  const orgId = 'organizations:test_auth_org';
  await db.query(`DELETE ${orgId}`);
  await db.query(`CREATE ${orgId} SET name = 'Test Auth Org', seat_limit = 10`);
  console.log('Created org:', orgId);

  // Create test user
  const userId = 'users:test_auth_user';
  await db.query(`DELETE ${userId}`);
  await db.query(`
    CREATE ${userId} SET
      org_id = ${orgId},
      email = 'auth@test.com',
      name = 'Test Auth User',
      role = 'admin',
      password_hash = 'x'
  `);
  console.log('Created user:', userId);

  // Create test project and membership
  const projectId = 'projects:test_auth_project';
  await db.query(`DELETE ${projectId}`);
  await db.query(`CREATE ${projectId} SET org_id = ${orgId}, name = 'Test Project'`);
  await db.query(`
    DELETE project_members WHERE user_id = ${userId};
    CREATE project_members SET
      org_id = ${orgId},
      project_id = ${projectId},
      user_id = ${userId},
      role = 'developer'
  `);
  console.log('Created project membership');

  // Create API key
  const apiKey = 'mb_test_auth_' + Date.now();
  await db.query(`DELETE api_keys WHERE org_id = ${orgId}`);
  await db.query(`
    CREATE api_keys SET
      org_id = ${orgId},
      user_id = ${userId},
      key_hash = crypto::argon2::generate($api_key),
      scopes = ['read', 'write'],
      is_active = true
  `, { api_key: apiKey });
  console.log('Created API key');

  // Create MiniBob instance
  const instanceId = 'mb-auth-test-001';
  const instanceKey = 'mb_key_' + Date.now();
  await db.query(`DELETE minibob_instance WHERE instance_id = $id`, { id: instanceId });
  await db.query(`
    CREATE minibob_instance SET
      instance_id = $instance_id,
      org_id = ${orgId},
      project_id = ${projectId},
      api_key_hash = crypto::argon2::generate($api_key),
      vessel_id = 'minibob:test',
      is_active = true
  `, { instance_id: instanceId, api_key: instanceKey });
  console.log('Created MiniBob instance');

  await db.close();

  return { apiKey, instanceId, instanceKey, orgId, projectId };
}

async function testApiKeyAuth(apiKey: string) {
  console.log('\n=== Test: API Key RECORD Authentication ===\n');

  const db = new Surreal();
  await db.connect(SURREALDB_URL);
  await db.use({ namespace: 'activity-system', database: 'learning_loop' });

  try {
    // Attempt RECORD signin with API key
    const token = await db.signin({
      access: 'apikey_record',
      variables: { api_key: apiKey },
    });

    test('API key signin returns token', !!token);

    // SurrealDB SDK v2 returns { access: "JWT..." }
    const jwtToken = typeof token === 'string' ? token : (token as { access: string }).access;
    if (jwtToken) {
      // JWT only contains ID - claims are looked up via $auth at query time
      const parts = jwtToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        console.log('JWT payload (ID only):', payload.ID);
        test('JWT contains record ID', !!payload.ID);
      }

      // Query $auth to verify claims are accessible
      const authResult = await db.query<[{ id: string; org_id: string; user_id: string; scopes: string[] }]>(
        'RETURN { id: $auth.id, org_id: $auth.org_id, user_id: $auth.user_id, scopes: $auth.scopes }'
      );
      const authData = authResult[0];
      console.log('$auth fields:', JSON.stringify(authData, null, 2));

      test('$auth.org_id accessible', !!authData?.org_id);
      test('$auth.user_id accessible', !!authData?.user_id);
      test('$auth.scopes accessible', Array.isArray(authData?.scopes));

      // Test that authenticated session can query
      const result = await db.query('SELECT count() FROM activity_registry GROUP ALL');
      test('Authenticated session can query activity_registry', true);
      console.log('Query result:', JSON.stringify(result));
    }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    test('API key signin', false, msg);
  }

  await db.close();
}

async function testMiniBobAuth(instanceId: string, instanceKey: string) {
  console.log('\n=== Test: MiniBob RECORD Authentication ===\n');

  const db = new Surreal();
  await db.connect(SURREALDB_URL);
  await db.use({ namespace: 'activity-system', database: 'learning_loop' });

  try {
    const token = await db.signin({
      access: 'minibob_record',
      variables: {
        instance_id: instanceId,
        api_key: instanceKey,
      },
    });

    test('MiniBob signin returns token', !!token);

    // SurrealDB SDK v2 returns { access: "JWT..." }
    const jwtToken = typeof token === 'string' ? token : (token as { access: string }).access;
    if (jwtToken) {
      const parts = jwtToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        console.log('JWT payload (ID only):', payload.ID);
        test('JWT contains record ID', !!payload.ID);
      }

      // Query $auth to verify MiniBob claims
      const authResult = await db.query<[{ org_id: string; project_id: string; instance_id: string }]>(
        'RETURN { org_id: $auth.org_id, project_id: $auth.project_id, instance_id: $auth.instance_id }'
      );
      const authData = authResult[0];
      console.log('$auth fields:', JSON.stringify(authData, null, 2));

      test('$auth.org_id accessible', !!authData?.org_id);
      test('$auth.project_id accessible', !!authData?.project_id);
      test('$auth.instance_id accessible', !!authData?.instance_id);
    }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    test('MiniBob signin', false, msg);
  }

  await db.close();
}

async function testInvalidCredentials() {
  console.log('\n=== Test: Invalid Credentials Rejected ===\n');

  const db = new Surreal();
  await db.connect(SURREALDB_URL);
  await db.use({ namespace: 'activity-system', database: 'learning_loop' });

  try {
    await db.signin({
      access: 'apikey_record',
      variables: { api_key: 'mb_invalid_key_12345' },
    });
    test('Invalid API key rejected', false, 'Should have thrown');
  } catch {
    test('Invalid API key rejected', true);
  }

  try {
    await db.signin({
      access: 'minibob_record',
      variables: { instance_id: 'invalid', api_key: 'invalid' },
    });
    test('Invalid MiniBob credentials rejected', false, 'Should have thrown');
  } catch {
    test('Invalid MiniBob credentials rejected', true);
  }

  await db.close();
}

async function cleanup() {
  console.log('\n=== Cleanup ===\n');

  const db = new Surreal();
  await db.connect(SURREALDB_URL);
  await db.signin({
    username: process.env.SURREALDB_USERNAME || 'root',
    password: process.env.SURREALDB_PASSWORD || 'surrealdb-local-dev-123',
  });
  await db.use({ namespace: 'activity-system', database: 'learning_loop' });

  await db.query(`
    DELETE api_keys WHERE org_id = organizations:test_auth_org;
    DELETE minibob_instance WHERE instance_id CONTAINS 'mb-auth-test';
    DELETE project_members WHERE org_id = organizations:test_auth_org;
    DELETE projects WHERE org_id = organizations:test_auth_org;
    DELETE users WHERE org_id = organizations:test_auth_org;
    DELETE organizations:test_auth_org;
  `);

  await db.close();
  console.log('Cleaned up test data');
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║    SurrealDB RECORD Authentication Direct Test             ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Validates: apikey_record and minibob_record ACCESS        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    const { apiKey, instanceId, instanceKey } = await setupTestData();

    await testApiKeyAuth(apiKey);
    await testMiniBobAuth(instanceId, instanceKey);
    await testInvalidCredentials();

    await cleanup();

  } catch (error) {
    console.error('Test suite error:', error);
  }

  // Summary
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                        RESULTS                              ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${results.length}\n`);

  if (failed > 0) {
    console.log('Failed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  ✗ ${r.name}: ${r.error || 'Unknown error'}`);
    });
    process.exit(1);
  }

  console.log('All tests passed! ✓');
}

main();
