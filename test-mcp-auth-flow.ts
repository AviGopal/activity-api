#!/usr/bin/env bun
/**
 * Test script: metabob-mcp API Key Authentication Flow
 *
 * Validates the complete flow:
 * 1. Exchange API key for JWT
 * 2. Query templates with JWT (scoped by org/project)
 * 3. Create execution trace with JWT
 * 4. Verify scoping works correctly
 *
 * Prerequisites:
 * - SurrealDB running with schemas deployed
 * - activity-api running on localhost:8080
 * - Test API key created in database
 *
 * Usage: bun run test-mcp-auth-flow.ts
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

  // Create test organization
  const orgId = 'organizations:test_mcp_org';
  await db.query(`
    DELETE ${orgId};
    CREATE ${orgId} SET
      name = 'Test MCP Org',
      seat_limit = 10,
      created_at = time::now()
  `);
  console.log('Created test organization:', orgId);

  // Create test user
  const userId = 'users:test_mcp_user';
  await db.query(`
    DELETE ${userId};
    CREATE ${userId} SET
      org_id = ${orgId},
      email = 'test@mcp.test',
      name = 'Test MCP User',
      password_hash = crypto::argon2::generate('test123'),
      role = 'member',
      created_at = time::now()
  `);
  console.log('Created test user:', userId);

  // Create test project
  const projectId = 'projects:test_mcp_project';
  await db.query(`
    DELETE ${projectId};
    CREATE ${projectId} SET
      org_id = ${orgId},
      name = 'Test MCP Project',
      created_at = time::now()
  `);
  console.log('Created test project:', projectId);

  // Add user to project
  await db.query(`
    DELETE project_members WHERE user_id = ${userId};
    CREATE project_members SET
      org_id = ${orgId},
      project_id = ${projectId},
      user_id = ${userId},
      role = 'developer',
      added_at = time::now()
  `);
  console.log('Added user to project');

  // Create test API key (plain text key that will be hashed for comparison)
  const testApiKey = 'mb_test_mcp_' + Date.now();
  const apiKeyId = 'api_keys:test_mcp_key';
  await db.query(`
    DELETE ${apiKeyId};
    CREATE ${apiKeyId} SET
      org_id = ${orgId},
      user_id = ${userId},
      key_hash = crypto::argon2::generate($api_key),
      scopes = ['read', 'write'],
      is_active = true,
      created_at = time::now()
  `, { api_key: testApiKey });
  console.log('Created test API key:', testApiKey);

  // Create test templates with different scopes
  // NOTE: Using activity_template table (not activity_registry) as that's what the API queries
  // Schema uses activity_id and variant_name fields (not 'name')
  await db.query(`
    DELETE activity_template WHERE activity_id CONTAINS 'test-mcp-';

    -- Global template (visible to all)
    CREATE activity_template SET
      activity_id = 'test-mcp-global-template',
      variant_id = 'test-mcp-global-template-v1',
      variant_name = 'Test MCP Global Template',
      description = 'Global test template',
      scope = 'global',
      org_id = ${orgId},
      category = 'tool',
      created_at = time::now();

    -- Org-scoped template (visible to org members)
    CREATE activity_template SET
      activity_id = 'test-mcp-org-template',
      variant_id = 'test-mcp-org-template-v1',
      variant_name = 'Test MCP Org Template',
      description = 'Org-scoped test template',
      scope = 'org',
      org_id = ${orgId},
      category = 'tool',
      created_at = time::now();

    -- Project-scoped template (visible to project members)
    CREATE activity_template SET
      activity_id = 'test-mcp-project-template',
      variant_id = 'test-mcp-project-template-v1',
      variant_name = 'Test MCP Project Template',
      description = 'Project-scoped test template',
      scope = 'project',
      org_id = ${orgId},
      project_id = ${projectId},
      category = 'tool',
      created_at = time::now();

    -- Other org's template (should NOT be visible)
    CREATE activity_template SET
      activity_id = 'test-mcp-other-org-template',
      variant_id = 'test-mcp-other-org-template-v1',
      variant_name = 'Test MCP Other Org Template',
      description = 'Other org template - should not be visible',
      scope = 'org',
      org_id = organizations:other_org,
      category = 'tool',
      created_at = time::now();
  `);
  console.log('Created test templates');

  await db.close();

  return { testApiKey, orgId, projectId, userId };
}

async function testApiKeyExchange(apiKey: string): Promise<string | null> {
  console.log('\n=== Test: API Key Exchange ===\n');

  try {
    const response = await fetch(`${API_URL}/v2/auth/apikey`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey }),
    });

    if (!response.ok) {
      const error = await response.text();
      test('API key exchange returns 200', false, `Got ${response.status}: ${error}`);
      return null;
    }

    const data = await response.json() as {
      token?: string;
      org_id?: string;
      user_id?: string;
      scopes?: string[];
      project_ids?: string[];
    };

    test('API key exchange returns 200', true);
    test('Response contains JWT token', !!data.token, data.token ? undefined : 'No token in response');

    if (data.token) {
      // Decode JWT payload (only contains record ID, claims are in $auth)
      const parts = data.token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        console.log('\nJWT payload:', JSON.stringify(payload, null, 2));
        test('JWT contains record ID', !!payload.ID, undefined, payload);
      }

      // Check response fields (not JWT) for org/project data
      console.log('\nResponse data:', JSON.stringify({ org_id: data.org_id, user_id: data.user_id, project_ids: data.project_ids }, null, 2));
      test('Response contains org_id', !!data.org_id, undefined, data);
      test('Response contains project_ids (array)', Array.isArray(data.project_ids),
        Array.isArray(data.project_ids) ? undefined : 'project_ids is not an array', data.project_ids);
    }

    return data.token || null;
  } catch (error) {
    test('API key exchange', false, String(error));
    return null;
  }
}

async function testTemplateQuery(jwt: string, expectedVisible: string[], expectedHidden: string[]) {
  console.log('\n=== Test: Template Query with JWT ===\n');

  try {
    const response = await fetch(`${API_URL}/v2/activities/templates`, {
      headers: { 'Authorization': `Bearer ${jwt}` },
    });

    if (!response.ok) {
      test('Template query returns 200', false, `Got ${response.status}`);
      return;
    }

    test('Template query returns 200', true);

    const data = await response.json() as { templates?: Array<{ variant_name?: string; activity_id?: string }> };
    // Templates use variant_name or activity_id, not name
    const templateNames = (data.templates || []).map(t => t.variant_name || t.activity_id);

    console.log('Returned templates:', templateNames);

    // Check expected visible templates
    for (const name of expectedVisible) {
      test(`Template "${name}" is visible`, templateNames.includes(name));
    }

    // Check expected hidden templates
    for (const name of expectedHidden) {
      test(`Template "${name}" is NOT visible`, !templateNames.includes(name));
    }
  } catch (error) {
    test('Template query', false, String(error));
  }
}

async function testExecutionTraceCreation(jwt: string) {
  console.log('\n=== Test: Execution Trace Creation ===\n');

  try {
    const trace = {
      execution_id: `test_mcp_flow_${Date.now()}`,
      template_id: 'test-mcp-global-template',
      variant_name: 'default',
      status: 'success',
      duration_ms: 1234,
      cost_usd: 0.01,
      total_tokens: 500,
      component_changes: [],  // Required field
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

    const data = await response.json() as { trace?: { org_id?: string; project_id?: string } };
    console.log('Created trace:', JSON.stringify(data, null, 2));

    test('Trace has org_id set', !!data.trace?.org_id);
  } catch (error) {
    test('Execution trace creation', false, String(error));
  }
}

async function testInvalidApiKey() {
  console.log('\n=== Test: Invalid API Key ===\n');

  try {
    const response = await fetch(`${API_URL}/v2/auth/apikey`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: 'mb_invalid_key_12345' }),
    });

    test('Invalid API key returns 401', response.status === 401);

    const data = await response.json() as { error?: string };
    test('Error message is generic (no info leak)',
      !data.error?.includes('not found') && !data.error?.includes('does not exist'),
      data.error);
  } catch (error) {
    test('Invalid API key test', false, String(error));
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
    DELETE activity_template WHERE activity_id CONTAINS 'test-mcp-';
    DELETE project_members WHERE org_id = organizations:test_mcp_org;
    DELETE api_keys WHERE org_id = organizations:test_mcp_org;
    DELETE projects WHERE org_id = organizations:test_mcp_org;
    DELETE users WHERE org_id = organizations:test_mcp_org;
    DELETE organizations:test_mcp_org;
  `);

  await db.close();
  console.log('Cleaned up test data');
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║    metabob-mcp API Key Authentication Flow Test            ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Validates: API key → JWT → scoped queries                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    // Setup
    const { testApiKey } = await setupTestData();

    // Test API key exchange
    const jwt = await testApiKeyExchange(testApiKey);

    if (jwt) {
      // Test template queries with scoping
      await testTemplateQuery(
        jwt,
        ['test-mcp-global-template', 'test-mcp-org-template', 'test-mcp-project-template'],
        ['test-mcp-other-org-template']
      );

      // Test execution trace creation
      await testExecutionTraceCreation(jwt);
    }

    // Test invalid API key
    await testInvalidApiKey();

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
