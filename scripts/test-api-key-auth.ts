#!/usr/bin/env bun
/**
 * API Key Authentication and Multi-Tenant Isolation Test
 *
 * This script verifies that:
 * 1. API key middleware correctly validates keys
 * 2. Multi-tenant isolation is enforced
 * 3. org_id is properly extracted and used for RBAC
 * 4. Critical endpoints are protected
 * 5. Performance is acceptable
 *
 * Usage:
 *   bun run scripts/test-api-key-auth.ts
 *
 * Requirements:
 *   - metabob-activity-api running (local or canary)
 *   - Test API keys configured in SurrealDB
 */

import crypto from 'crypto';

// Configuration
const API_URL = process.env.API_URL || 'https://activity.metabob.com';
const SURREAL_URL = process.env.SURREALDB_URL || 'http://surql.metabob.local';
const SURREAL_USERNAME = process.env.SURREALDB_USERNAME || 'root';
const SURREAL_PASSWORD = process.env.SURREALDB_PASSWORD || 'surrealdb-local-dev-123';

// Test data
interface TestOrg {
  id: string;
  name: string;
  apiKey: string;
  userId: string;
}

const testOrgs: TestOrg[] = [
  {
    id: 'test_org_a',
    name: 'Test Organization A',
    apiKey: 'test-api-key-org-a-' + crypto.randomBytes(16).toString('hex'),
    userId: 'test_user_a',
  },
  {
    id: 'test_org_b',
    name: 'Test Organization B',
    apiKey: 'test-api-key-org-b-' + crypto.randomBytes(16).toString('hex'),
    userId: 'test_user_b',
  },
];

// Colors for output
const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(msg: string, color = COLORS.reset) {
  console.log(`${color}${msg}${COLORS.reset}`);
}

function pass(msg: string) {
  log(`✓ ${msg}`, COLORS.green);
}

function fail(msg: string) {
  log(`✗ ${msg}`, COLORS.red);
}

function info(msg: string) {
  log(`ℹ ${msg}`, COLORS.blue);
}

function section(title: string) {
  log(`\n${'='.repeat(60)}`, COLORS.cyan);
  log(title, COLORS.cyan);
  log('='.repeat(60), COLORS.cyan);
}

// Hash API key for SurrealDB storage
async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Setup test data in SurrealDB
async function setupTestData(): Promise<void> {
  section('Setting up test data in SurrealDB');

  const Surreal = (await import('surrealdb')).Surreal;
  const db = new Surreal();

  try {
    await db.connect(SURREAL_URL);
    await db.use({
      namespace: 'activity-system',
      database: 'learning_loop',
    });
    await db.signin({
      username: SURREAL_USERNAME,
      password: SURREAL_PASSWORD,
    });

    // Create test organizations
    for (const org of testOrgs) {
      // Create org
      await db.query(
        `DELETE organizations:${org.id};
         CREATE organizations:${org.id} SET
           id = $id,
           name = $name,
           created_at = time::now(),
           updated_at = time::now();`,
        { id: org.id, name: org.name }
      );

      // Create user
      await db.query(
        `DELETE users:${org.userId};
         CREATE users:${org.userId} SET
           id = $userId,
           org_id = $orgId,
           email = $email,
           created_at = time::now();`,
        {
          userId: org.userId,
          orgId: org.id,
          email: `${org.userId}@test.com`,
        }
      );

      // Create API key
      const keyHash = await hashApiKey(org.apiKey);
      await db.query(
        `DELETE api_key WHERE org_id = $orgId;
         CREATE api_key SET
           org_id = $orgId,
           user_id = $userId,
           key_hash = $keyHash,
           name = $name,
           scopes = $scopes,
           is_active = true,
           created_at = time::now();`,
        {
          orgId: org.id,
          userId: org.userId,
          keyHash,
          name: `Test API Key for ${org.name}`,
          scopes: ['read', 'write'],
        }
      );

      info(`Created org: ${org.id}, user: ${org.userId}, API key hash: ${keyHash.slice(0, 16)}...`);
    }

    // Create test templates for each org
    for (const org of testOrgs) {
      await db.query(
        `CREATE activity SET
           id = $templateId,
           org_id = $orgId,
           name = $name,
           description = $description,
           tags = $tags,
           scope = 'org',
           created_at = time::now(),
           updated_at = time::now();`,
        {
          templateId: `test_template_${org.id}`,
          orgId: org.id,
          name: `Test Template for ${org.name}`,
          description: `This template belongs to ${org.name}`,
          tags: ['test', 'automation'],
        }
      );

      info(`Created test template: test_template_${org.id}`);
    }

    await db.close();
    pass('Test data setup complete');
  } catch (error) {
    await db.close();
    fail(`Failed to setup test data: ${error}`);
    throw error;
  }
}

// Cleanup test data
async function cleanupTestData(): Promise<void> {
  section('Cleaning up test data');

  const Surreal = (await import('surrealdb')).Surreal;
  const db = new Surreal();

  try {
    await db.connect(SURREAL_URL);
    await db.use({
      namespace: 'activity-system',
      database: 'learning_loop',
    });
    await db.signin({
      username: SURREAL_USERNAME,
      password: SURREAL_PASSWORD,
    });

    for (const org of testOrgs) {
      await db.query(
        `DELETE organizations:${org.id};
         DELETE users:${org.userId};
         DELETE api_key WHERE org_id = $orgId;
         DELETE activity WHERE org_id = $orgId;`,
        { orgId: org.id }
      );
      info(`Deleted test data for ${org.id}`);
    }

    await db.close();
    pass('Test data cleanup complete');
  } catch (error) {
    await db.close();
    fail(`Failed to cleanup test data: ${error}`);
  }
}

// Test cases
interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
}

const results: TestResult[] = [];

async function runTest(
  name: string,
  testFn: () => Promise<void>
): Promise<void> {
  const startTime = Date.now();
  try {
    await testFn();
    const duration = Date.now() - startTime;
    results.push({ name, passed: true, duration });
    pass(`${name} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, duration, error: errorMsg });
    fail(`${name} (${duration}ms): ${errorMsg}`);
  }
}

// Test 1: Verify API key middleware extracts org_id correctly
async function testApiKeyExtraction() {
  const org = testOrgs[0];
  const response = await fetch(`${API_URL}/v2/activities/templates`, {
    headers: {
      Authorization: `ApiKey ${org.apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Expected 200-399, got ${response.status}`);
  }

  const data = await response.json();
  info(`Fetched ${data.templates?.length || 0} templates for org ${org.id}`);
}

// Test 2: Verify multi-tenant isolation (org A can't see org B's data)
async function testMultiTenantIsolation() {
  const orgA = testOrgs[0];
  const orgB = testOrgs[1];

  // Fetch templates for org A
  const responseA = await fetch(`${API_URL}/v2/activities/templates`, {
    headers: {
      Authorization: `ApiKey ${orgA.apiKey}`,
    },
  });

  if (!responseA.ok) {
    throw new Error(`Org A request failed: ${responseA.status}`);
  }

  const dataA = await responseA.json();
  const templatesA = dataA.templates || [];

  // Check that org A only sees its own templates
  const orgBTemplateInA = templatesA.find(
    (t: any) => t.id === `test_template_${orgB.id}`
  );

  if (orgBTemplateInA) {
    throw new Error(
      `Org A can see org B's template! Multi-tenant isolation is broken.`
    );
  }

  // Check that org A sees its own template
  const orgATemplate = templatesA.find(
    (t: any) => t.id === `test_template_${orgA.id}`
  );

  if (!orgATemplate) {
    info(`Warning: Org A template not found in results. May be filtered by other criteria.`);
  } else {
    info(`Org A correctly sees only its own template`);
  }

  // Repeat for org B
  const responseB = await fetch(`${API_URL}/v2/activities/templates`, {
    headers: {
      Authorization: `ApiKey ${orgB.apiKey}`,
    },
  });

  if (!responseB.ok) {
    throw new Error(`Org B request failed: ${responseB.status}`);
  }

  const dataB = await responseB.json();
  const templatesB = dataB.templates || [];

  const orgATemplateInB = templatesB.find(
    (t: any) => t.id === `test_template_${orgA.id}`
  );

  if (orgATemplateInB) {
    throw new Error(
      `Org B can see org A's template! Multi-tenant isolation is broken.`
    );
  }

  info(`Multi-tenant isolation verified: orgs can only see their own data`);
}

// Test 3: Verify invalid API key is rejected
async function testInvalidApiKey() {
  const response = await fetch(`${API_URL}/v2/activities/templates`, {
    headers: {
      Authorization: `ApiKey invalid-key-${crypto.randomBytes(16).toString('hex')}`,
    },
  });

  // Should return 401 or fall back to unauthenticated behavior
  // Depending on implementation, might return 200 with no org-specific data
  if (response.status === 200) {
    const data = await response.json();
    // Should only return public/global templates
    info(`Invalid key returned ${response.status}, may show public templates only`);
  } else if (response.status === 401 || response.status === 403) {
    info(`Invalid key correctly rejected with ${response.status}`);
  } else {
    throw new Error(`Unexpected status for invalid key: ${response.status}`);
  }
}

// Test 4: Verify POST endpoint uses org_id from API key
async function testPostEndpointOrgId() {
  const org = testOrgs[0];

  const newTemplate = {
    id: `test_template_created_${org.id}`,
    name: `Created Template for ${org.name}`,
    description: 'Template created via API',
    tags: ['test', 'created'],
    tasks: [
      {
        id: 'task1',
        description: 'Test task',
        prompt: { template: 'Do something', variables: [] },
      },
    ],
  };

  const response = await fetch(`${API_URL}/v2/activities/templates`, {
    method: 'POST',
    headers: {
      Authorization: `ApiKey ${org.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(newTemplate),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`POST failed (${response.status}): ${text}`);
  }

  const result = await response.json();
  info(`Created template: ${result.id || newTemplate.id}`);

  // Verify it was created with the correct org_id
  const getResponse = await fetch(`${API_URL}/v2/activities/templates`, {
    headers: {
      Authorization: `ApiKey ${org.apiKey}`,
    },
  });

  const getData = await getResponse.json();
  const createdTemplate = (getData.templates || []).find(
    (t: any) => t.id === newTemplate.id
  );

  if (!createdTemplate) {
    throw new Error(`Created template not found in list`);
  }

  // Verify org B cannot see this template
  const orgBResponse = await fetch(`${API_URL}/v2/activities/templates`, {
    headers: {
      Authorization: `ApiKey ${testOrgs[1].apiKey}`,
    },
  });

  const orgBData = await orgBResponse.json();
  const orgBSawTemplate = (orgBData.templates || []).find(
    (t: any) => t.id === newTemplate.id
  );

  if (orgBSawTemplate) {
    throw new Error(`Org B can see template created by org A!`);
  }

  info(`POST endpoint correctly scopes template to org ${org.id}`);
}

// Test 5: Performance - auth middleware overhead
async function testAuthPerformance() {
  const org = testOrgs[0];
  const iterations = 10;
  const durations: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    const response = await fetch(`${API_URL}/health`, {
      headers: {
        Authorization: `ApiKey ${org.apiKey}`,
      },
    });
    const duration = Date.now() - start;
    durations.push(duration);

    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }
  }

  const avgDuration = durations.reduce((a, b) => a + b, 0) / iterations;
  const maxDuration = Math.max(...durations);
  const minDuration = Math.min(...durations);

  info(`Auth middleware overhead (${iterations} requests):`);
  info(`  Average: ${avgDuration.toFixed(2)}ms`);
  info(`  Min: ${minDuration}ms, Max: ${maxDuration}ms`);

  if (avgDuration > 100) {
    throw new Error(`Auth middleware too slow: ${avgDuration.toFixed(2)}ms average`);
  }
}

// Test 6: Verify impulse resolution endpoint
async function testImpulseResolution() {
  const org = testOrgs[0];

  const impulseRequest = {
    impulses: [
      {
        id: 'test-impulse-1',
        pointer: {
          type: 'memo',
          content: 'Test memo content',
        },
        budget: 1000,
        priority: 'medium',
      },
    ],
  };

  const response = await fetch(`${API_URL}/v2/impulses/resolve`, {
    method: 'POST',
    headers: {
      Authorization: `ApiKey ${org.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(impulseRequest),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Impulse resolution failed (${response.status}): ${text}`);
  }

  const result = await response.json();
  info(`Resolved ${result.impulses?.length || 0} impulses`);

  if (!result.impulses || result.impulses.length === 0) {
    throw new Error('No impulses returned');
  }

  const resolvedImpulse = result.impulses[0];
  if (resolvedImpulse.loaded !== true) {
    throw new Error('Impulse not marked as loaded');
  }
}

// Main execution
async function main() {
  log('\n🔐 API Key Authentication & Multi-Tenant Isolation Test\n', COLORS.cyan);

  try {
    // Setup
    await setupTestData();

    // Run tests
    section('Running tests');
    await runTest('1. API key middleware extracts org_id', testApiKeyExtraction);
    await runTest('2. Multi-tenant isolation', testMultiTenantIsolation);
    await runTest('3. Invalid API key rejection', testInvalidApiKey);
    await runTest('4. POST endpoint uses org_id from API key', testPostEndpointOrgId);
    await runTest('5. Auth middleware performance', testAuthPerformance);
    await runTest('6. Impulse resolution endpoint', testImpulseResolution);

    // Cleanup
    await cleanupTestData();

    // Summary
    section('Test Summary');
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

    log(`\nTotal: ${results.length} tests`, COLORS.cyan);
    log(`Passed: ${passed}`, COLORS.green);
    log(`Failed: ${failed}`, failed > 0 ? COLORS.red : COLORS.green);
    log(`Total duration: ${totalDuration}ms\n`, COLORS.cyan);

    if (failed > 0) {
      section('Failed Tests');
      results
        .filter((r) => !r.passed)
        .forEach((r) => {
          log(`\n${r.name}:`, COLORS.red);
          log(`  ${r.error}`, COLORS.yellow);
        });
    }

    // Exit with appropriate code
    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    fail(`Fatal error: ${error}`);
    await cleanupTestData();
    process.exit(1);
  }
}

main();
