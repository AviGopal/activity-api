#!/usr/bin/env bun

/**
 * CI/CD Integration Test Script
 *
 * Tests the CI webhook endpoint with sample data
 *
 * Usage:
 *   bun run test-ci-integration.ts [API_URL]
 *
 * Example:
 *   bun run test-ci-integration.ts http://localhost:8080
 *   bun run test-ci-integration.ts http://api.minibob.local
 */

const API_URL = process.argv[2] || 'http://localhost:8080';
const API_KEY = process.env.ACTIVITY_API_KEY || 'test-internal-key';

interface TestCase {
  name: string;
  description: string;
  payload: any;
  expectedStatus: number;
  validation?: (response: any) => boolean | string;
}

const testCases: TestCase[] = [
  {
    name: 'Successful CI result',
    description: 'Test CI webhook with all stages passing',
    payload: {
      execution_id: `exec-test-${Date.now()}`,
      template_id: 'template-test-success',
      branch: 'feature/test-endpoint',
      commit: 'abc123def456',
      success: true,
      duration_ms: 125000,
      ci_provider: 'github_actions',
      workflow_name: 'CI with Webhook Integration',
      run_id: '12345678',
      run_url: 'https://github.com/test/repo/actions/runs/12345678',
      stages: {
        build: { success: true, duration_ms: 15000 },
        typecheck: { success: true, duration_ms: 8000 },
        test: {
          success: true,
          duration_ms: 45000,
          tests_passed: 42,
          tests_failed: 0,
          coverage_percent: 87.5,
        },
        lint: { success: true, duration_ms: 3000, errors: 0, warnings: 2 },
      },
      artifacts: [
        {
          name: 'docker-image-abc123',
          type: 'docker_image',
          url: 'https://github.com/test/repo/actions/runs/12345678',
          size_bytes: 45678900,
          metadata: { image_tag: 'metabob-activity-api:abc123' },
        },
      ],
      metadata: {
        repository: 'test/repo',
        actor: 'testbot',
        event: 'push',
        ref: 'refs/heads/feature/test-endpoint',
      },
    },
    expectedStatus: 200,
    validation: (response) => {
      if (!response.success) return 'Response success should be true';
      if (!response.ci_status_updated) return 'CI status should be updated';
      // Note: metrics_updated and deployment_enqueued may be false if prerequisites not met
      return true;
    },
  },
  {
    name: 'Failed CI result',
    description: 'Test CI webhook with test stage failing',
    payload: {
      execution_id: `exec-test-fail-${Date.now()}`,
      template_id: 'template-test-fail',
      branch: 'feature/broken-tests',
      commit: 'def456abc789',
      success: false,
      duration_ms: 85000,
      ci_provider: 'github_actions',
      workflow_name: 'CI with Webhook Integration',
      run_id: '12345679',
      run_url: 'https://github.com/test/repo/actions/runs/12345679',
      stages: {
        build: { success: true, duration_ms: 15000 },
        typecheck: { success: true, duration_ms: 8000 },
        test: {
          success: false,
          duration_ms: 45000,
          tests_passed: 38,
          tests_failed: 4,
          coverage_percent: 82.1,
          error: 'Test suite failed: 4 tests failed',
        },
        lint: { success: true, duration_ms: 3000, errors: 0, warnings: 2 },
      },
      artifacts: [],
      metadata: {
        repository: 'test/repo',
        actor: 'testbot',
        event: 'push',
        ref: 'refs/heads/feature/broken-tests',
      },
    },
    expectedStatus: 200,
    validation: (response) => {
      if (!response.success) return 'Response success should be true';
      if (!response.ci_status_updated) return 'CI status should be updated';
      if (response.deployment_enqueued) return 'Deployment should NOT be enqueued on CI failure';
      return true;
    },
  },
  {
    name: 'Minimal CI result',
    description: 'Test CI webhook with minimal required fields',
    payload: {
      execution_id: `exec-test-minimal-${Date.now()}`,
      branch: 'feature/minimal',
      commit: 'minimal123',
      success: true,
      duration_ms: 60000,
    },
    expectedStatus: 200,
  },
  {
    name: 'Invalid payload - missing execution_id',
    description: 'Test validation error handling',
    payload: {
      branch: 'feature/invalid',
      commit: 'invalid123',
      success: true,
      duration_ms: 60000,
    },
    expectedStatus: 400,
    validation: (response) => {
      if (response.success !== false) return 'Response success should be false for invalid payload';
      return true;
    },
  },
  {
    name: 'Nonexistent execution trace',
    description: 'Test behavior when execution trace not found',
    payload: {
      execution_id: 'exec-nonexistent-12345',
      branch: 'feature/nonexistent',
      commit: 'nonexist123',
      success: true,
      duration_ms: 60000,
    },
    expectedStatus: 404,
  },
];

async function runTest(testCase: TestCase): Promise<boolean> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`TEST: ${testCase.name}`);
  console.log(`DESC: ${testCase.description}`);
  console.log('='.repeat(80));

  try {
    console.log('\n📤 Sending request...');
    console.log(`URL: POST ${API_URL}/v2/activities/ci-result`);
    console.log(`Payload: ${JSON.stringify(testCase.payload, null, 2).substring(0, 500)}...`);

    const response = await fetch(`${API_URL}/v2/activities/ci-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Api-Key': API_KEY,
      },
      body: JSON.stringify(testCase.payload),
    });

    const statusMatches = response.status === testCase.expectedStatus;
    const responseData = await response.json();

    console.log(`\n📥 Response status: ${response.status} (expected: ${testCase.expectedStatus})`);
    console.log(`Response: ${JSON.stringify(responseData, null, 2)}`);

    if (!statusMatches) {
      console.log(`\n❌ FAILED: Status code mismatch`);
      return false;
    }

    if (testCase.validation) {
      const validationResult = testCase.validation(responseData);
      if (validationResult !== true) {
        console.log(`\n❌ FAILED: Validation failed - ${validationResult}`);
        return false;
      }
    }

    console.log(`\n✅ PASSED`);
    return true;

  } catch (error) {
    console.log(`\n❌ FAILED: ${error}`);
    return false;
  }
}

async function main() {
  console.log('CI/CD Integration Test Suite');
  console.log(`API URL: ${API_URL}`);
  console.log(`Using API Key: ${API_KEY.substring(0, 10)}...`);

  // Check API health
  console.log('\n🏥 Checking API health...');
  try {
    const healthResponse = await fetch(`${API_URL}/health`);
    const healthData = await healthResponse.json();
    console.log(`API Status: ${healthData.status}`);

    if (healthData.status !== 'healthy') {
      console.log('⚠️  Warning: API is not fully healthy');
      console.log(JSON.stringify(healthData, null, 2));
    }
  } catch (error) {
    console.log(`❌ Cannot connect to API: ${error}`);
    console.log('Make sure the API server is running:');
    console.log('  cd repos/metabob-activity-api && bun run dev');
    process.exit(1);
  }

  // Run tests
  const results = await Promise.all(testCases.map(runTest));
  const passed = results.filter(r => r).length;
  const failed = results.filter(r => !r).length;

  console.log('\n' + '='.repeat(80));
  console.log('TEST SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total: ${testCases.length}`);
  console.log(`Passed: ${passed} ✅`);
  console.log(`Failed: ${failed} ❌`);

  if (failed > 0) {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
    process.exit(0);
  }
}

main();
