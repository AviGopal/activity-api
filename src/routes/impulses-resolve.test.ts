/**
 * Tests for impulse resolution endpoint
 *
 * Phase 5: Removal of Analysis API proxy pattern
 * Tasks: 13.1-13.10
 */

import { describe, test, expect } from 'bun:test';

describe('POST /v2/impulses/resolve - Phase 5 (Proxy Removal)', () => {
  const ACTIVITY_API_URL = process.env.ACTIVITY_API_URL || 'http://localhost:8080';

  /**
   * Task 13.6: Test that Activity-API rejects Analysis API shapes with helpful error
   */
  describe('Analysis API shapes - reject with vessel-direct error', () => {
    const analysisShapes = [
      'analysisResult',
      'cochangeSuggestions',
      'impactAnalysis',
      'codebaseSearch',
      'problemCluster',
    ];

    for (const shape of analysisShapes) {
      test(`${shape} shape returns 410 Gone with vessel-direct error`, async () => {
        const response = await fetch(`${ACTIVITY_API_URL}/v2/impulses/resolve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            pointer: {
              type: shape,
              // Add minimal required fields for each shape
              ...(shape === 'analysisResult' && { resultId: 'test-id' }),
              ...(shape === 'cochangeSuggestions' && { componentIds: ['test::component'] }),
              ...(shape === 'impactAnalysis' && { changedFiles: ['test.ts'] }),
              ...(shape === 'codebaseSearch' && { query: 'test' }),
              ...(shape === 'problemCluster' && { sessionId: 'test-session' }),
            },
          }),
        });

        expect(response.status).toBe(410); // 410 Gone

        const data = await response.json();
        expect(data.success).toBe(false);
        expect(data.error).toBe('resolver_moved');
        expect(data.message).toContain('Resolvers live WHERE THE DATA IS');
        expect(data.pointer_type).toBe(shape);
        expect(data.suggested_approach).toBeTruthy();
        expect(data.analysis_api_url).toBeTruthy();
      });
    }
  });

  /**
   * Task 13.7: Test that Activity-API still routes unknown shapes to vessel discovery
   */
  test('Unknown shape returns 404 with vessel discovery hint', async () => {
    const response = await fetch(`${ACTIVITY_API_URL}/v2/impulses/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pointer: {
          type: 'totally_unknown_shape_xyz',
        },
      }),
    });

    expect(response.status).toBe(404); // Not Found

    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.error).toBe('use_vessel_discovery');
    expect(data.message).toContain('use vessel discovery');
    expect(data.shape).toBe('totally_unknown_shape_xyz');
    expect(data.suggested_approach).toContain('/v2/vessels/discover');
  });

  /**
   * Task 13.4: Verify backward compatibility for known Activity-API shapes
   */
  describe('Activity-API native shapes - still resolve correctly', () => {
    // These shapes should still work because they resolve from Activity-API's own data
    const nativeShapes = [
      { type: 'activityTemplate', templateId: 'test-template-id' },
      { type: 'activityMetrics', activityId: 'test-activity-id' },
    ];

    for (const pointer of nativeShapes) {
      test(`${pointer.type} shape still resolves (may 404 if data missing)`, async () => {
        const response = await fetch(`${ACTIVITY_API_URL}/v2/impulses/resolve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ pointer }),
        });

        // Should NOT return 410 Gone (proxy removed)
        // May return 404 if data doesn't exist, or 200 if it does
        expect(response.status).not.toBe(410);

        // Should be either 200 (found) or 404 (not found), not 400 (bad request)
        expect([200, 404]).toContain(response.status);
      });
    }
  });
});

/**
 * Integration test: Verify no Analysis API proxy calls
 *
 * This test ensures the deprecated proxyToAnalysisApi function is not being called.
 * We can't directly test this without instrumentation, but we verify the behavior.
 */
describe('Integration: No Analysis API proxy calls', () => {
  test('Analysis API shapes fail immediately without network call', async () => {
    const startTime = Date.now();

    const response = await fetch(`${process.env.ACTIVITY_API_URL || 'http://localhost:8080'}/v2/impulses/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pointer: {
          type: 'analysisResult',
          resultId: 'test-id',
        },
      }),
    });

    const duration = Date.now() - startTime;

    // Should return immediately (< 100ms), not wait for network timeout
    expect(duration).toBeLessThan(100);
    expect(response.status).toBe(410);
  });
});
