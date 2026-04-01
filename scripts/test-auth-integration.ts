#!/usr/bin/env bun
/**
 * Auth Integration Test
 *
 * Tests authentication flows against running metabob-activity-api.
 * Requires SurrealDB and the API server to be running.
 */

const API_BASE_URL = process.env.API_BASE_URL || 'http://activity.metabob.local';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration: Date.now() - start });
    console.log(`✓ ${name} (${Date.now() - start}ms)`);
  } catch (error) {
    results.push({
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    });
    console.log(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Test 1: Health check
await test('API health check', async () => {
  const response = await fetch(`${API_BASE_URL}/health`);
  if (!response.ok) {
    throw new Error(`Health check failed: ${response.status}`);
  }
});

// Test 2: MiniBob authentication (should fail without valid credentials)
await test('MiniBob auth rejects invalid credentials', async () => {
  const response = await fetch(`${API_BASE_URL}/v2/auth/minibob/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instance_id: 'invalid-instance',
      api_key: 'invalid-key',
    }),
  });

  if (response.status !== 401) {
    throw new Error(`Expected 401, got ${response.status}`);
  }

  const data = await response.json();
  if (!data.error) {
    throw new Error('Expected error field in response');
  }
});

// Test 3: MiniBob auth requires both fields
await test('MiniBob auth validates required fields', async () => {
  const response = await fetch(`${API_BASE_URL}/v2/auth/minibob/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instance_id: 'test',
      // Missing api_key
    }),
  });

  if (response.status !== 400) {
    throw new Error(`Expected 400, got ${response.status}`);
  }
});

// Test 4: API key auth rejects invalid format
await test('API key auth validates format', async () => {
  const response = await fetch(`${API_BASE_URL}/v2/auth/apikey`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: 'not-a-valid-format',
    }),
  });

  // Should reject invalid format
  if (response.status !== 400 && response.status !== 401) {
    throw new Error(`Expected 400 or 401, got ${response.status}`);
  }
});

// Test 5: Rate limiting on auth endpoints
await test('Rate limiting works on auth endpoints', async () => {
  // Make 10 rapid requests to trigger rate limit
  const promises = Array.from({ length: 10 }, () =>
    fetch(`${API_BASE_URL}/v2/auth/minibob/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instance_id: 'test',
        api_key: 'test',
      }),
    })
  );

  const responses = await Promise.all(promises);
  const rateLimited = responses.some((r) => r.status === 429);

  if (!rateLimited) {
    throw new Error('Expected at least one 429 response');
  }
});

// Test 6: WebSocket authentication (if available)
await test('WebSocket requires authentication', async () => {
  const wsUrl = API_BASE_URL.replace('http', 'ws') + '/ws';

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket test timeout'));
    }, 5000);

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      // Try to send message without authenticating
      ws.send(JSON.stringify({ type: 'ping' }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data.toString());

        // Server should not respond to ping without authentication
        if (msg.type === 'pong') {
          clearTimeout(timeout);
          ws.close();
          reject(new Error('Server responded without authentication'));
        }
      } catch (e) {
        // Ignore parse errors
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      resolve(); // Error is expected behavior
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      resolve(); // Connection closing is fine
    };

    // Give it 2 seconds to respond
    setTimeout(() => {
      clearTimeout(timeout);
      ws.close();
      resolve(); // No pong received = good
    }, 2000);
  });
});

// Summary
console.log('\n' + '='.repeat(50));
console.log('Test Summary');
console.log('='.repeat(50));

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
const total = results.length;

console.log(`Total: ${total}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  console.log('\nFailed Tests:');
  results
    .filter((r) => !r.passed)
    .forEach((r) => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
}

process.exit(failed > 0 ? 1 : 0);
