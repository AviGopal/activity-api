#!/usr/bin/env bun
/**
 * Test script: MiniBob API Key Authentication Flow
 *
 * Validates the complete flow:
 * 1. MiniBob authenticates with API key (Authorization: ApiKey <key>)
 * 2. API key validated via identity service (with direct SurrealDB fallback)
 * 3. Fetches templates (scoped to org)
 * 4. Creates execution trace (scoped to org)
 * 5. Verifies audit trail uses key_id
 *
 * This demonstrates: minibob → metabob-activity-api → identity-vessel/SurrealDB
 *
 * Prerequisites:
 * - SurrealDB running with schemas deployed
 * - activity-api running on localhost:8080
 * - identity-vessel running (or direct SurrealDB fallback active)
 *
 * Usage: bun run test-minibob-auth-flow.ts
 */

import { Surreal } from 'surrealdb';

// Default to local cluster deployment via Istio Gateway
// Override with ACTIVITY_API_URL and SURREALDB_URL for different environments
const API_URL = process.env.ACTIVITY_API_URL || 'http://activity.metabob.local';
// SurrealDB SDK requires /rpc suffix for HTTP connections
const SURREALDB_URL = process.env.SURREALDB_URL || 'http://surql.metabob.local/rpc';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: unknown;
}

const results: TestResult[] = [];

function test(name: string, passed: boolean, error?: string, details?: unknown) {
  results.push({ name, passed, error, details });
  const icon = passed ? '✓' : '✗';
  console.log(`${icon} ${name}${error ? `: ${error}` : ''}`);
}

async function setupTestData() {
  console.log('\n=== Setting up MiniBob test data ===\n');

  const db = new Surreal();
  await db.connect(SURREALDB_URL);
  await db.signin({
    username: process.env.SURREALDB_USERNAME || 'root',
    password: process.env.SURREALDB_PASSWORD || 'surrealdb-local-dev-123',
  });
  await db.use({ namespace: 'activity-system', database: 'learning_loop' });

  // Create test organization
  const orgId = 'organizations:test_minibob_org';
  await db.query(`
    DELETE ${orgId};
    CREATE ${orgId} SET
      name = 'Test MiniBob Org',
      seat_limit = 10,
      created_at = time::now()
  `);
  console.log('Created organization:', orgId);

  // Create two test projects
  const project1Id = 'projects:test_minibob_backend';
  const project2Id = 'projects:test_minibob_frontend';

  await db.query(`
    DELETE ${project1Id};
    DELETE ${project2Id};
    CREATE ${project1Id} SET
      org_id = ${orgId},
      name = 'Backend Project',
      created_at = time::now();
    CREATE ${project2Id} SET
      org_id = ${orgId},
      name = 'Frontend Project',
      created_at = time::now();
  `);
  console.log('Created projects:', project1Id, project2Id);

  // Create API key for MiniBob authentication
  const apiKey = 'mb_test_key_' + Date.now();
  const keyId = `api_key:test_minibob_key_${Date.now()}`;

  await db.query(`
    DELETE api_key WHERE id = $key_id;
    CREATE $key_id SET
      org_id = ${orgId},
      user_id = NONE,
      key_hash = crypto::sha256::hash($api_key),
      scopes = ['read', 'write'],
      is_active = true,
      created_at = time::now(),
      expires_at = NONE
  `, { key_id: keyId, api_key: apiKey });
  console.log('Created API key:', keyId);

  // Create templates with different scopes
  await db.query(`
    DELETE activity_registry WHERE name CONTAINS 'test-minibob-';

    -- Global template (needs org_id for schema but public=true makes it visible to all)
    CREATE activity_registry SET
      id = 'test-minibob-global',
      name = 'test-minibob-global',
      description = 'Global template visible to all',
      execution_format = 'template',
      scope = 'global',
      org_id = ${orgId},
      public = true,
      category = 'tool',
      created_at = time::now();

    -- Backend project template (visible to backend MiniBob)
    CREATE activity_registry SET
      id = 'test-minibob-backend-deploy',
      name = 'test-minibob-backend-deploy',
      description = 'Backend deployment template',
      execution_format = 'template',
      scope = 'project',
      org_id = ${orgId},
      project_id = ${project1Id},
      category = 'infrastructure',
      created_at = time::now();

    -- Frontend project template (NOT visible to backend MiniBob)
    CREATE activity_registry SET
      id = 'test-minibob-frontend-build',
      name = 'test-minibob-frontend-build',
      description = 'Frontend build template',
      execution_format = 'template',
      scope = 'project',
      org_id = ${orgId},
      project_id = ${project2Id},
      category = 'feature',
      created_at = time::now();

    -- Org-scoped template (visible to all in org)
    CREATE activity_registry SET
      id = 'test-minibob-org-shared',
      name = 'test-minibob-org-shared',
      description = 'Shared org template',
      execution_format = 'template',
      scope = 'org',
      org_id = ${orgId},
      category = 'tool',
      created_at = time::now();
  `);
  console.log('Created test templates');

  await db.close();

  return { apiKey, keyId, orgId, project1Id, project2Id };
}

async function testMiniBobApiKeyAuth(apiKey: string): Promise<boolean> {
  console.log('\n=== Test: MiniBob API Key Authentication ===\n');
  console.log(`API Key: ${apiKey.substring(0, 10)}...`);

  try {
    // Test direct template fetch with API key (no signin needed)
    const response = await fetch(`${API_URL}/v2/activities/templates`, {
      headers: { 'Authorization': `ApiKey ${apiKey}` },
    });

    if (!response.ok) {
      const error = await response.text();
      test('API key authentication returns 200', false, `Got ${response.status}: ${error}`);
      return false;
    }

    test('API key authentication returns 200', true);

    const data = await response.json() as { templates?: Array<{ name: string }> };
    test('Response contains templates array', Array.isArray(data.templates));

    console.log(`Received ${data.templates?.length || 0} templates`);

    return true;
  } catch (error) {
    test('MiniBob API key auth', false, String(error));
    return false;
  }
}

async function testTemplateVisibility(apiKey: string) {
  console.log('\n=== Test: Template Visibility (Org Scoping) ===\n');

  try {
    const response = await fetch(`${API_URL}/v2/activities/templates`, {
      headers: { 'Authorization': `ApiKey ${apiKey}` },
    });

    if (!response.ok) {
      test('Template query returns 200', false, `Got ${response.status}`);
      return;
    }

    test('Template query returns 200', true);

    const data = await response.json() as { templates?: Array<{ name: string; scope?: string }> };
    const templates = data.templates || [];
    const templateNames = templates.map(t => t.name);

    console.log('Returned templates:', templateNames);

    // Should see: global, org-shared, backend-deploy, frontend-build
    // All are org-scoped with API key auth (no project filtering)

    test('Global template is visible',
      templateNames.includes('test-minibob-global'));

    test('Org-scoped template is visible',
      templateNames.includes('test-minibob-org-shared'));

    test('Backend project template is visible',
      templateNames.includes('test-minibob-backend-deploy'));

    test('Frontend project template is visible',
      templateNames.includes('test-minibob-frontend-build'));

  } catch (error) {
    test('Template visibility', false, String(error));
  }
}

async function testExecutionTraceWithOrgScope(apiKey: string, keyId: string) {
  console.log('\n=== Test: Execution Trace Creation (Org Scoped) ===\n');

  try {
    const executionId = `test_minibob_exec_${Date.now()}`;

    const trace = {
      execution_id: executionId,
      template_id: 'test-minibob-backend-deploy',
      variant_name: 'default',
      status: 'success',
      duration_ms: 5678,
      cost_usd: 0.05,
      total_tokens: 1500,
    };

    const response = await fetch(`${API_URL}/v2/activities/execution-traces`, {
      method: 'POST',
      headers: {
        'Authorization': `ApiKey ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(trace),
    });

    if (!response.ok) {
      const error = await response.text();
      test('Execution trace creation returns 2xx', false, `Got ${response.status}: ${error}`);
      return;
    }

    test('Execution trace creation returns 2xx', true);

    const data = await response.json() as { trace?: Record<string, unknown> };
    console.log('Created trace:', JSON.stringify(data.trace, null, 2));

    test('Trace has org_id', !!data.trace?.org_id);

    // Verify audit trail uses key_id
    const createdBy = data.trace?.created_by as string;
    test('Trace created_by uses key_id format',
      createdBy?.startsWith('api_key:'),
      createdBy ? `Expected api_key:*, got: ${createdBy}` : 'No created_by field');

  } catch (error) {
    test('Execution trace creation', false, String(error));
  }
}

async function testInactiveApiKeyRejected() {
  console.log('\n=== Test: Inactive API Key Rejected ===\n');

  const db = new Surreal();
  await db.connect(SURREALDB_URL);
  await db.signin({
    username: process.env.SURREALDB_USERNAME || 'root',
    password: process.env.SURREALDB_PASSWORD || 'surrealdb-local-dev-123',
  });
  await db.use({ namespace: 'activity-system', database: 'learning_loop' });

  // Create inactive API key
  const inactiveKey = 'inactive_key_' + Date.now();
  const inactiveKeyId = `api_key:test_inactive_${Date.now()}`;

  await db.query(`
    DELETE $key_id;
    CREATE $key_id SET
      org_id = organizations:test_minibob_org,
      user_id = NONE,
      key_hash = crypto::sha256::hash($api_key),
      scopes = ['read', 'write'],
      is_active = false,
      created_at = time::now(),
      expires_at = NONE
  `, { key_id: inactiveKeyId, api_key: inactiveKey });

  await db.close();

  try {
    const response = await fetch(`${API_URL}/v2/activities/templates`, {
      headers: { 'Authorization': `ApiKey ${inactiveKey}` },
    });

    test('Inactive API key returns 401 or 403', response.status === 401 || response.status === 403);

  } catch (error) {
    test('Inactive API key test', false, String(error));
  }
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
    DELETE activity_registry WHERE name CONTAINS 'test-minibob-';
    DELETE activity_execution_traces WHERE execution_id CONTAINS 'test_minibob_';
    DELETE api_key WHERE id CONTAINS 'test_minibob_key_' OR id CONTAINS 'test_inactive_';
    DELETE projects WHERE org_id = organizations:test_minibob_org;
    DELETE organizations:test_minibob_org;
  `);

  await db.close();
  console.log('Cleaned up test data');
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║      MiniBob API Key Authentication Flow Test              ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Validates: minibob → activity-api → identity/SurrealDB    ║');
  console.log('║                                                            ║');
  console.log('║  Data Flow:                                                ║');
  console.log('║  1. MiniBob authenticates with API key header              ║');
  console.log('║  2. Validated via identity service (or direct fallback)    ║');
  console.log('║  3. Fetches templates (filtered by org scope)              ║');
  console.log('║  4. Creates execution trace (scoped to org, uses key_id)   ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    // Setup
    const { apiKey, keyId } = await setupTestData();

    // Test MiniBob API key authentication
    const authSuccess = await testMiniBobApiKeyAuth(apiKey);

    if (authSuccess) {
      // Test template visibility with org scoping
      await testTemplateVisibility(apiKey);

      // Test execution trace creation
      await testExecutionTraceWithOrgScope(apiKey, keyId);
    }

    // Test inactive API key rejection
    await testInactiveApiKeyRejected();

    // Cleanup
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
