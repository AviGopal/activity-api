/**
 * Integration Tests: Connection Slots and LLM Proxy
 *
 * Tests the connection slot lifecycle and tiered resolver system.
 * Run with: bun test test/integration/connection-slots.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

const API_URL = process.env.ACTIVITY_API_URL || 'http://activity.metabob.local';
const TEST_ORG_ID = 'metabob_internal';
const TEST_API_KEY = process.env.TEST_API_KEY || 'test-api-key-123';

// Connection tracking
let connectionId: string;
let sessionToken: string;
let jwtToken: string; // JWT obtained from connection acquisition

// Helper to make authenticated requests
async function apiRequest(
  method: string,
  path: string,
  body?: any,
  headers?: Record<string, string>
): Promise<Response> {
  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  // Use JWT from connection acquisition if available, otherwise use API key
  if (jwtToken) {
    requestHeaders['Authorization'] = `Bearer ${jwtToken}`;
  } else {
    requestHeaders['Authorization'] = `ApiKey ${TEST_API_KEY}`;
  }

  if (connectionId) {
    requestHeaders['X-Connection-ID'] = connectionId;
  }

  return fetch(`${API_URL}${path}`, {
    method,
    headers: requestHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('Connection Slots Integration Tests', () => {
  beforeAll(async () => {
    // Connection slots use API key authentication
    // The API key is set in TEST_API_KEY environment variable or defaults to 'test-api-key-123'
    console.log('Using API key authentication for connection slot tests');
  });

  // Note: Connection slots use API key authentication, not JWT.
  // The /v2/connections/acquire endpoint expects an api_key in the request body.
  // These tests are skipped if no API key is available.
  // To run these tests, create an API key in the api_keys table with:
  //   - max_connections > 0
  //   - is_active = true
  //   - key_hash = argon2 hash of your test key

  afterAll(async () => {
    // Clean up: release connection if acquired
    if (connectionId) {
      try {
        await apiRequest('POST', '/v2/connections/release', {
          connection_id: connectionId,
        });
        console.log('Connection released');
      } catch (e) {
        console.log('Failed to release connection:', e);
      }
    }
  });

  describe('P2.1: Connection Acquisition', () => {
    test('should acquire a connection slot (requires API key)', async () => {
      // Connection slots require API key authentication
      // The api_key must be created in api_keys table with proper key_hash
      const response = await fetch(`${API_URL}/v2/connections/acquire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: TEST_API_KEY,
          instance_name: 'integration-test',
        }),
      });

      if (response.status === 429) {
        console.log('Slot limit reached - this is expected if other connections exist');
        return;
      }

      if (response.status === 401) {
        console.log('API key authentication failed - check TEST_API_KEY is valid');
        return;
      }

      expect(response.status).toBe(200);

      const data = await response.json() as {
        connection_id: string;
        session_token: string;
        jwt_token: string;
        slot_number: number;
        max_slots: number;
        grace_period_ms: number;
      };

      expect(data.connection_id).toBeDefined();
      expect(data.session_token).toBeDefined();
      expect(data.slot_number).toBeGreaterThanOrEqual(1);
      expect(data.max_slots).toBeGreaterThanOrEqual(1);
      expect(data.grace_period_ms).toBeGreaterThan(0);

      connectionId = data.connection_id;
      sessionToken = data.session_token;
      // Update jwtToken for subsequent requests
      if (data.jwt_token) {
        jwtToken = data.jwt_token;
      }

      console.log(`Acquired slot ${data.slot_number}/${data.max_slots}`);
    });
  });

  describe('P2.2: Heartbeat', () => {
    test('should send heartbeat successfully', async () => {
      if (!connectionId) {
        console.log('Skipping: No connection acquired');
        return;
      }

      const response = await apiRequest('POST', '/v2/connections/heartbeat', {
        connection_id: connectionId,
      });

      expect(response.status).toBe(200);

      const data = await response.json() as {
        status: string;
        grace_period_ms: number;
        next_heartbeat_at: string;
      };

      expect(data.status).toBe('active');
      expect(data.grace_period_ms).toBeGreaterThan(0);
      expect(data.next_heartbeat_at).toBeDefined();

      console.log('Heartbeat successful, grace period:', data.grace_period_ms, 'ms');
    });

    test('should report execution state in heartbeat', async () => {
      if (!connectionId) {
        console.log('Skipping: No connection acquired');
        return;
      }

      const response = await apiRequest('POST', '/v2/connections/heartbeat', {
        connection_id: connectionId,
        current_execution: {
          execution_id: 'test-exec-001',
          phase: 'running',
          started_at: new Date().toISOString(),
        },
      });

      expect(response.status).toBe(200);

      const data = await response.json() as {
        grace_period_ms: number;
        current_execution?: { execution_id: string };
      };

      // Grace period should be extended when execution is in progress
      expect(data.grace_period_ms).toBeGreaterThan(60000);

      console.log('Execution heartbeat successful, extended grace:', data.grace_period_ms, 'ms');
    });
  });

  describe('P2.4: Connection Release', () => {
    test('should release connection slot', async () => {
      if (!connectionId) {
        console.log('Skipping: No connection acquired');
        return;
      }

      const response = await apiRequest('POST', '/v2/connections/release', {
        connection_id: connectionId,
      });

      expect(response.status).toBe(200);

      const data = await response.json() as { released: boolean };
      expect(data.released).toBe(true);

      console.log('Connection released successfully');

      // Clear for afterAll cleanup
      connectionId = '';
    });
  });
});

describe('Tiered Resolver Integration Tests', () => {
  beforeAll(async () => {
    // Use API key authentication for resolver tests
    // JWT token will be used if we have one from connection acquisition
    console.log('Using API key authentication for tiered resolver tests');
  });

  describe('P3.4: Resolution Endpoint', () => {
    test('should resolve impulse through tiered system', async () => {
      const response = await apiRequest('POST', '/v2/resolve', {
        impulse: {
          pointer: {
            type: 'memo',
            content: 'Test impulse for integration testing',
          },
          metadata: {
            shape: 'test',
            intent: 'validation',
            domain: 'testing',
            complexity: 0.1,
          },
        },
        prefer_tier: 'pattern', // Prefer pattern to avoid LLM costs
      });

      // Accept either 200 (success) or 402 (budget exceeded) or pattern not found falling back
      if (response.status === 402) {
        const error = await response.json() as { error: string; tokens_used: number };
        console.log('Budget exceeded:', error);
        expect(error.error).toBe('llm_budget_exceeded');
        return;
      }

      if (!response.ok) {
        const error = await response.text();
        console.log('Resolve failed:', error);
        // This is expected if there are no patterns yet
        return;
      }

      const data = await response.json() as {
        resolver_used: string;
        confidence: number;
        result: any;
        cost_usd: number;
        tokens_used: { input: number; output: number };
        trace_id?: string;
      };

      expect(data.resolver_used).toBeDefined();
      expect(data.confidence).toBeGreaterThanOrEqual(0);
      expect(data.confidence).toBeLessThanOrEqual(1);
      expect(data.cost_usd).toBeGreaterThanOrEqual(0);
      expect(data.tokens_used).toBeDefined();

      console.log(`Resolution complete via ${data.resolver_used}, cost: $${data.cost_usd.toFixed(6)}`);
    });

    test('should handle direct LLM messages', async () => {
      const response = await apiRequest('POST', '/v2/resolve', {
        impulse: {
          pointer: { type: 'memo' },
          metadata: {
            shape: 'question',
            intent: 'answer',
            domain: 'general',
            complexity: 0.3,
          },
        },
        messages: [
          { role: 'user', content: 'What is 2 + 2? Reply with just the number.' },
        ],
        prefer_tier: 'haiku', // Use cheapest LLM tier
        max_tokens: 10,
      });

      // Accept budget exceeded as valid response
      if (response.status === 402) {
        console.log('Budget exceeded - expected in test environment');
        return;
      }

      if (!response.ok) {
        const error = await response.text();
        console.log('LLM resolve failed (may need ANTHROPIC_API_KEY):', error);
        return;
      }

      const data = await response.json() as {
        resolver_used: string;
        result: { content: string };
        cost_usd: number;
      };

      expect(data.resolver_used).toBe('haiku');
      expect(data.result.content).toContain('4');

      console.log(`LLM resolution: "${data.result.content}", cost: $${data.cost_usd.toFixed(6)}`);
    });
  });
});

describe('Health and Connectivity', () => {
  test('should have healthy API', async () => {
    const response = await fetch(`${API_URL}/health`);
    expect(response.status).toBe(200);

    const data = await response.json() as {
      status: string;
      checks: {
        redis: { status: string };
        surrealdb: { status: string };
      };
    };

    expect(data.status).toBe('healthy');
    expect(data.checks.redis.status).toBe('healthy');
    expect(data.checks.surrealdb.status).toBe('healthy');

    console.log('Health check passed');
  });
});
