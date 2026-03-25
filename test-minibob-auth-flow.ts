#!/usr/bin/env bun
/**
 * Test script: MiniBob Instance Authentication Flow
 *
 * Validates the complete flow:
 * 1. MiniBob instance signs in with instance_id + api_key
 * 2. Receives JWT with org_id and project_id
 * 3. Fetches templates (scoped to org/project)
 * 4. Creates execution trace (scoped to org/project)
 * 5. Verifies isolation from other projects
 *
 * This demonstrates: minibob → metabob-activity-api → SurrealDB
 *
 * Prerequisites:
 * - SurrealDB running with schemas deployed
 * - activity-api running on localhost:8080
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

  // Create MiniBob instance for backend project
  const instanceId = 'mb-test-backend-001';
  const instanceApiKey = 'mb_test_key_' + Date.now();

  await db.query(`
    DELETE minibob_instance WHERE instance_id = $instance_id;
    CREATE minibob_instance SET
      instance_id = $instance_id,
      org_id = ${orgId},
      project_id = ${project1Id},
      api_key_hash = crypto::argon2::generate($api_key),
      vessel_id = 'minibob:v2',
      is_active = true,
      created_at = time::now()
  `, { instance_id: instanceId, api_key: instanceApiKey });
  console.log('Created MiniBob instance:', instanceId);

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

  return { instanceId, instanceApiKey, orgId, project1Id, project2Id };
}

async function testMiniBobSignin(instanceId: string, apiKey: string): Promise<string | null> {
  console.log('\n=== Test: MiniBob Instance Signin ===\n');
  console.log(`Instance ID: ${instanceId}`);

  try {
    const response = await fetch(`${API_URL}/v2/auth/minibob/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instance_id: instanceId,
        api_key: apiKey,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      test('MiniBob signin returns 200', false, `Got ${response.status}: ${error}`);
      return null;
    }

    test('MiniBob signin returns 200', true);

    const data = await response.json() as { token?: string; org_id?: string; project_id?: string };

    test('Response contains JWT token', !!data.token);
    test('Response contains org_id', !!data.org_id);
    test('Response contains project_id', !!data.project_id);

    if (data.token) {
      // Decode JWT to verify claims
      const parts = data.token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        console.log('\nJWT payload:', JSON.stringify(payload, null, 2));

        test('JWT contains org_id', !!payload.org_id || !!payload.ID);
        test('JWT contains project_id', !!payload.project_id);
        test('JWT contains instance_id', !!payload.instance_id);
      }
    }

    return data.token || null;
  } catch (error) {
    test('MiniBob signin', false, String(error));
    return null;
  }
}

async function testTemplateVisibility(jwt: string) {
  console.log('\n=== Test: Template Visibility (Project Scoping) ===\n');

  try {
    const response = await fetch(`${API_URL}/v2/activities/templates`, {
      headers: { 'Authorization': `Bearer ${jwt}` },
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

    // Should see: global, org-shared, backend-deploy
    // Should NOT see: frontend-build (different project)

    test('Global template is visible',
      templateNames.includes('test-minibob-global'));

    test('Org-scoped template is visible',
      templateNames.includes('test-minibob-org-shared'));

    test('Backend project template is visible',
      templateNames.includes('test-minibob-backend-deploy'));

    test('Frontend project template is NOT visible',
      !templateNames.includes('test-minibob-frontend-build'),
      templateNames.includes('test-minibob-frontend-build') ? 'Should be hidden!' : undefined);

  } catch (error) {
    test('Template visibility', false, String(error));
  }
}

async function testExecutionTraceWithProjectScope(jwt: string) {
  console.log('\n=== Test: Execution Trace Creation (Project Scoped) ===\n');

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
        'Authorization': `Bearer ${jwt}`,
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
    test('Trace has project_id', !!data.trace?.project_id);

  } catch (error) {
    test('Execution trace creation', false, String(error));
  }
}

async function testInactiveInstanceRejected() {
  console.log('\n=== Test: Inactive Instance Rejected ===\n');

  const db = new Surreal();
  await db.connect(SURREALDB_URL);
  await db.signin({
    username: process.env.SURREALDB_USERNAME || 'root',
    password: process.env.SURREALDB_PASSWORD || 'surrealdb-local-dev-123',
  });
  await db.use({ namespace: 'activity-system', database: 'learning_loop' });

  // Create inactive instance
  const inactiveId = 'mb-test-inactive';
  const inactiveKey = 'inactive_key_' + Date.now();

  await db.query(`
    DELETE minibob_instance WHERE instance_id = $instance_id;
    CREATE minibob_instance SET
      instance_id = $instance_id,
      org_id = organizations:test_minibob_org,
      project_id = projects:test_minibob_backend,
      api_key_hash = crypto::argon2::generate($api_key),
      vessel_id = 'minibob:v2',
      is_active = false,
      created_at = time::now()
  `, { instance_id: inactiveId, api_key: inactiveKey });

  await db.close();

  try {
    const response = await fetch(`${API_URL}/v2/auth/minibob/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instance_id: inactiveId,
        api_key: inactiveKey,
      }),
    });

    test('Inactive instance signin returns 401', response.status === 401);

  } catch (error) {
    test('Inactive instance test', false, String(error));
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
    DELETE minibob_instance WHERE instance_id CONTAINS 'mb-test-';
    DELETE projects WHERE org_id = organizations:test_minibob_org;
    DELETE organizations:test_minibob_org;
  `);

  await db.close();
  console.log('Cleaned up test data');
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║      MiniBob Instance Authentication Flow Test             ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Validates: minibob → activity-api → SurrealDB             ║');
  console.log('║                                                            ║');
  console.log('║  Data Flow:                                                ║');
  console.log('║  1. MiniBob signs in with instance_id + api_key            ║');
  console.log('║  2. Receives JWT with org_id + project_id (singular)       ║');
  console.log('║  3. Fetches templates (filtered by project scope)          ║');
  console.log('║  4. Creates execution trace (scoped to project)            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    // Setup
    const { instanceId, instanceApiKey } = await setupTestData();

    // Test MiniBob signin
    const jwt = await testMiniBobSignin(instanceId, instanceApiKey);

    if (jwt) {
      // Test template visibility with project scoping
      await testTemplateVisibility(jwt);

      // Test execution trace creation
      await testExecutionTraceWithProjectScope(jwt);
    }

    // Test inactive instance rejection
    await testInactiveInstanceRejected();

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
