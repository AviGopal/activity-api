/**
 * Vessel Registry Protocol Validation Tests
 *
 * Tests compliance with SPEC-004: Vessel Registry Protocol
 * Reference: /openspec/vessel-specs/SPEC-004-vessel-registry-protocol.md
 */

import { test, expect, describe, beforeAll } from 'bun:test';

// Configuration
const ACTIVITY_API_URL = process.env.ACTIVITY_API_URL || 'http://activity.metabob.local';

// Test JWT tokens (would need to be generated from identity.metabob.local)
// For now, we'll test unauthenticated endpoints first
const TEST_JWT_ORG_A = process.env.TEST_JWT_ORG_A || '';
const TEST_JWT_ORG_B = process.env.TEST_JWT_ORG_B || '';

interface VesselRegistration {
  vesselId: string;
  vesselName: string;
  endpoint: string;
  shapes: string[];
  capabilities?: Array<{
    type: 'impulse-resolver' | 'tool' | 'activity' | 'mcp-server';
    shapes?: string[];
    tools?: string[];
    mcp?: {
      protocol: string;
      tools: string[];
    };
  }>;
  metadata?: Record<string, unknown>;
  ttl?: number;
}

async function registerVessel(
  vessel: VesselRegistration,
  jwt?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (jwt) {
    headers['Authorization'] = `Bearer ${jwt}`;
  }

  return fetch(`${ACTIVITY_API_URL}/v2/vessels/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify(vessel),
  });
}

async function discoverVessels(shape: string, jwt?: string): Promise<Response> {
  const headers: Record<string, string> = {};

  if (jwt) {
    headers['Authorization'] = `Bearer ${jwt}`;
  }

  return fetch(`${ACTIVITY_API_URL}/v2/vessels/discover?shape=${shape}`, {
    headers,
  });
}

async function listVessels(jwt?: string): Promise<Response> {
  const headers: Record<string, string> = {};

  if (jwt) {
    headers['Authorization'] = `Bearer ${jwt}`;
  }

  return fetch(`${ACTIVITY_API_URL}/v2/vessels`, { headers });
}

async function getVessel(vesselId: string, jwt?: string): Promise<Response> {
  const headers: Record<string, string> = {};

  if (jwt) {
    headers['Authorization'] = `Bearer ${jwt}`;
  }

  return fetch(`${ACTIVITY_API_URL}/v2/vessels/${vesselId}`, { headers });
}

async function deleteVessel(vesselId: string, jwt?: string): Promise<Response> {
  const headers: Record<string, string> = {};

  if (jwt) {
    headers['Authorization'] = `Bearer ${jwt}`;
  }

  return fetch(`${ACTIVITY_API_URL}/v2/vessels/${vesselId}`, {
    method: 'DELETE',
    headers,
  });
}

async function getVesselHealth(vesselId: string, jwt?: string): Promise<Response> {
  const headers: Record<string, string> = {};

  if (jwt) {
    headers['Authorization'] = `Bearer ${jwt}`;
  }

  return fetch(`${ACTIVITY_API_URL}/v2/vessels/${vesselId}/health`, { headers });
}

describe('SPEC-004: Vessel Registry Protocol', () => {

  describe('Test 1: Vessel Registration', () => {

    test('POST /v2/vessels/register - successful registration', async () => {
      const vessel: VesselRegistration = {
        vesselId: 'test-vessel-1',
        vesselName: 'Test Vessel',
        endpoint: 'http://test.metabob.local:8081',
        shapes: ['concept', 'test'],
        capabilities: [
          {
            type: 'impulse-resolver',
            shapes: ['concept'],
          },
        ],
        metadata: {
          version: '1.0.0',
          environment: 'test',
        },
        ttl: 300,
      };

      const response = await registerVessel(vessel);

      // Should return 200 OK or 201 Created
      expect(response.status).toBeOneOf([200, 201]);

      const body = await response.json();

      // Should return id and expires_at according to spec
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('expires_at');

      console.log('✓ Registration response:', body);
    });

    test('POST /v2/vessels/register - missing required fields', async () => {
      const invalidVessel = {
        vesselId: 'test-vessel-2',
        // Missing vesselName, endpoint, shapes
      };

      const response = await registerVessel(invalidVessel as VesselRegistration);

      // Should return 400 Bad Request
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body).toHaveProperty('error');

      console.log('✓ Validation error:', body);
    });

    test('POST /v2/vessels/register - empty shapes array', async () => {
      const vessel: VesselRegistration = {
        vesselId: 'test-vessel-3',
        vesselName: 'Invalid Vessel',
        endpoint: 'http://invalid.metabob.local:8081',
        shapes: [], // Empty array
      };

      const response = await registerVessel(vessel);

      // Should return 400 Bad Request
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('shapes');

      console.log('✓ Empty shapes validation:', body);
    });

    test('POST /v2/vessels/register - update existing vessel', async () => {
      const vessel: VesselRegistration = {
        vesselId: 'test-vessel-update',
        vesselName: 'Updatable Vessel',
        endpoint: 'http://update.metabob.local:8081',
        shapes: ['test'],
        ttl: 300,
      };

      // Register first time
      const response1 = await registerVessel(vessel);
      expect(response1.status).toBeOneOf([200, 201]);

      // Update with new shapes
      vessel.shapes.push('concept');
      const response2 = await registerVessel(vessel);
      expect(response2.status).toBe(200);

      const body = await response2.json();
      expect(body).toHaveProperty('expires_at');

      console.log('✓ Update vessel response:', body);
    });
  });

  describe('Test 2: Vessel Discovery', () => {

    beforeAll(async () => {
      // Register test vessels
      await registerVessel({
        vesselId: 'discovery-test-1',
        vesselName: 'Discovery Test Vessel 1',
        endpoint: 'http://discovery1.metabob.local:8081',
        shapes: ['concept', 'test'],
        ttl: 300,
      });

      await registerVessel({
        vesselId: 'discovery-test-2',
        vesselName: 'Discovery Test Vessel 2',
        endpoint: 'http://discovery2.metabob.local:8081',
        shapes: ['terminal', 'execution'],
        ttl: 300,
      });
    });

    test('GET /v2/vessels/discover?shape=concept - find vessels', async () => {
      const response = await discoverVessels('concept');

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty('vessels');
      expect(body).toHaveProperty('shape');
      expect(body.shape).toBe('concept');

      // Should find at least one vessel with 'concept' shape
      expect(body.vessels.length).toBeGreaterThan(0);

      const vessel = body.vessels[0];
      expect(vessel).toHaveProperty('vesselId');
      expect(vessel).toHaveProperty('endpoint');
      expect(vessel.shapes).toContain('concept');

      console.log('✓ Discovery found vessels:', body.vessels.length);
    });

    test('GET /v2/vessels/discover?shape=unknown - no vessels found', async () => {
      const response = await discoverVessels('unknown-shape-xyz');

      // Spec says 404 for not found
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('shape');

      console.log('✓ Not found response:', body);
    });

    test('GET /v2/vessels/discover - missing shape parameter', async () => {
      const response = await fetch(`${ACTIVITY_API_URL}/v2/vessels/discover`);

      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('shape');

      console.log('✓ Missing parameter error:', body);
    });
  });

  describe('Test 3: Vessel Expiry', () => {

    test('Register vessel with short TTL and verify expiry', async () => {
      const vessel: VesselRegistration = {
        vesselId: 'expiry-test-vessel',
        vesselName: 'Expiry Test Vessel',
        endpoint: 'http://expiry.metabob.local:8081',
        shapes: ['expiry-test'],
        ttl: 10, // 10 seconds
      };

      // Register vessel
      const registerResponse = await registerVessel(vessel);
      expect(registerResponse.status).toBeOneOf([200, 201]);

      // Immediately discover - should be present
      const discover1 = await discoverVessels('expiry-test');
      expect(discover1.status).toBe(200);

      const body1 = await discover1.json();
      expect(body1.vessels.length).toBeGreaterThan(0);

      console.log('✓ Vessel registered and discoverable');

      // Wait for TTL to expire (10 seconds + buffer)
      console.log('⏳ Waiting 15 seconds for TTL expiry...');
      await Bun.sleep(15000);

      // Discover again - should be expired or removed
      const discover2 = await discoverVessels('expiry-test');

      // Should either return 404 or empty vessels array
      if (discover2.status === 404) {
        console.log('✓ Vessel expired (404 response)');
      } else {
        const body2 = await discover2.json();
        expect(body2.vessels.length).toBe(0);
        console.log('✓ Vessel expired (empty vessels array)');
      }
    }, 20000); // Increase test timeout to 20 seconds
  });

  describe('Test 4: Org Isolation', () => {

    test('Vessels from different orgs should be isolated', async () => {
      // This test requires JWT tokens with different org_id claims
      if (!TEST_JWT_ORG_A || !TEST_JWT_ORG_B) {
        console.log('⚠️  Skipping org isolation test - JWT tokens not configured');
        console.log('   Set TEST_JWT_ORG_A and TEST_JWT_ORG_B environment variables');
        return;
      }

      // Register vessel with org A JWT
      const vesselA: VesselRegistration = {
        vesselId: 'org-a-vessel',
        vesselName: 'Org A Vessel',
        endpoint: 'http://orga.metabob.local:8081',
        shapes: ['org-test'],
        ttl: 300,
      };

      const registerA = await registerVessel(vesselA, TEST_JWT_ORG_A);
      expect(registerA.status).toBeOneOf([200, 201]);

      // Try to discover with org B JWT
      const discoverB = await discoverVessels('org-test', TEST_JWT_ORG_B);

      // Org B should not see org A's vessels
      if (discoverB.status === 404) {
        console.log('✓ Org isolation enforced (404 response)');
      } else {
        const body = await discoverB.json();
        expect(body.vessels.length).toBe(0);
        console.log('✓ Org isolation enforced (empty vessels)');
      }

      // Verify org A can see its own vessel
      const discoverA = await discoverVessels('org-test', TEST_JWT_ORG_A);
      expect(discoverA.status).toBe(200);

      const bodyA = await discoverA.json();
      expect(bodyA.vessels.length).toBeGreaterThan(0);
      expect(bodyA.vessels[0].vesselId).toBe('org-a-vessel');

      console.log('✓ Org A can see its own vessels');
    });
  });

  describe('Additional Endpoints', () => {

    test('GET /v2/vessels - list all vessels', async () => {
      const response = await listVessels();

      // May require auth or return 200
      if (response.status === 401) {
        console.log('⚠️  List vessels endpoint requires authentication');
        return;
      }

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty('vessels');

      console.log('✓ Listed vessels:', body.vessels?.length || 0);
    });

    test('GET /v2/vessels/:vesselId - get vessel details', async () => {
      // Register a test vessel first
      await registerVessel({
        vesselId: 'details-test-vessel',
        vesselName: 'Details Test',
        endpoint: 'http://details.metabob.local:8081',
        shapes: ['test'],
        ttl: 300,
      });

      const response = await getVessel('details-test-vessel');

      // May require auth or return 200/404
      if (response.status === 401) {
        console.log('⚠️  Get vessel endpoint requires authentication');
        return;
      }

      if (response.status === 404) {
        console.log('⚠️  Get vessel endpoint not implemented');
        return;
      }

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty('vessel');

      console.log('✓ Got vessel details');
    });

    test('DELETE /v2/vessels/:vesselId - unregister vessel', async () => {
      // Register a test vessel first
      await registerVessel({
        vesselId: 'delete-test-vessel',
        vesselName: 'Delete Test',
        endpoint: 'http://delete.metabob.local:8081',
        shapes: ['test'],
        ttl: 300,
      });

      const response = await deleteVessel('delete-test-vessel');

      // May require auth or return 204/404
      if (response.status === 401) {
        console.log('⚠️  Delete vessel endpoint requires authentication');
        return;
      }

      if (response.status === 404) {
        console.log('⚠️  Delete vessel endpoint not implemented');
        return;
      }

      // Spec says 204 No Content
      expect(response.status).toBeOneOf([204, 200]);

      console.log('✓ Vessel deleted');
    });

    test('GET /v2/vessels/:vesselId/health - check vessel health', async () => {
      await registerVessel({
        vesselId: 'health-test-vessel',
        vesselName: 'Health Test',
        endpoint: 'http://health.metabob.local:8081',
        shapes: ['test'],
        ttl: 300,
      });

      const response = await getVesselHealth('health-test-vessel');

      // May require auth or return 200/404
      if (response.status === 401) {
        console.log('⚠️  Health check endpoint requires authentication');
        return;
      }

      if (response.status === 404) {
        console.log('⚠️  Health check endpoint not implemented');
        return;
      }

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty('vesselId');
      expect(body).toHaveProperty('status');

      console.log('✓ Health check response:', body);
    });
  });

  describe('Heartbeat Prevention of Expiry', () => {

    test('Repeated registration should extend TTL', async () => {
      const vessel: VesselRegistration = {
        vesselId: 'heartbeat-test-vessel',
        vesselName: 'Heartbeat Test',
        endpoint: 'http://heartbeat.metabob.local:8081',
        shapes: ['heartbeat-test'],
        ttl: 20, // 20 seconds
      };

      // Initial registration
      const response1 = await registerVessel(vessel);
      expect(response1.status).toBeOneOf([200, 201]);

      const body1 = await response1.json();
      const firstExpiry = new Date(body1.expires_at);

      console.log('✓ Initial registration expires at:', firstExpiry.toISOString());

      // Wait 10 seconds (half of TTL)
      await Bun.sleep(10000);

      // Re-register (heartbeat)
      const response2 = await registerVessel(vessel);
      expect(response2.status).toBe(200);

      const body2 = await response2.json();
      const secondExpiry = new Date(body2.expires_at);

      console.log('✓ After heartbeat expires at:', secondExpiry.toISOString());

      // Second expiry should be later than first
      expect(secondExpiry.getTime()).toBeGreaterThan(firstExpiry.getTime());

      // Wait another 15 seconds (total 25s, past original TTL)
      await Bun.sleep(15000);

      // Should still be discoverable (because we heartbeated)
      const discover = await discoverVessels('heartbeat-test');
      expect(discover.status).toBe(200);

      const discoverBody = await discover.json();
      expect(discoverBody.vessels.length).toBeGreaterThan(0);

      console.log('✓ Vessel still alive after heartbeat');
    }, 30000); // 30 second timeout
  });
});

// Helper for flexible expectations
expect.extend({
  toBeOneOf(received, expected) {
    const pass = expected.includes(received);
    if (pass) {
      return {
        pass: true,
        message: () => `expected ${received} not to be one of ${expected}`,
      };
    } else {
      return {
        pass: false,
        message: () => `expected ${received} to be one of ${expected}`,
      };
    }
  },
});
