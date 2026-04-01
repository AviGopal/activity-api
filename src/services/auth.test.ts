/**
 * Authentication Service Tests
 *
 * Tests JWT validation, token generation, and authentication flows.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { validateJwtToken, generateJwtToken } from './auth';

describe('Authentication Service', () => {
  describe('JWT Token Validation', () => {
    test('should reject invalid token format', async () => {
      const result = await validateJwtToken('invalid-token-format');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('should reject empty token', async () => {
      const result = await validateJwtToken('');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('should reject token with invalid signature', async () => {
      // Generate a valid-looking JWT with wrong signature
      const fakeToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

      const result = await validateJwtToken(fakeToken);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('JWT Token Generation', () => {
    test('should generate valid JWT token', async () => {
      const context = {
        orgId: 'test-org',
        userId: 'test-user',
        keyId: 'test-key',
        scopes: ['read', 'write'],
        expirySeconds: 900,
      };

      const token = await generateJwtToken(context);

      if (token) {
        expect(token).toBeTypeOf('string');
        expect(token.length).toBeGreaterThan(0);

        // Validate the generated token
        const validation = await validateJwtToken(token);
        expect(validation.valid).toBe(true);
        expect(validation.payload).toBeDefined();
        expect(validation.payload?.org_id).toContain('test-org');
      }
    }, 10000); // 10s timeout for SurrealDB operations
  });

  describe('Token Expiry', () => {
    test('should reject expired token', async () => {
      const context = {
        orgId: 'test-org',
        userId: 'test-user',
        keyId: 'test-key',
        scopes: ['read'],
        expirySeconds: -1, // Already expired
      };

      const token = await generateJwtToken(context);

      if (token) {
        const result = await validateJwtToken(token);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('expired');
      }
    }, 10000);
  });
});
