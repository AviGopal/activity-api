/**
 * Unit tests for goal impulse resolver
 *
 * Tests the 'goal' pointer type in POST /v2/impulses/resolve
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import impulsesRouter from '../src/routes/impulses';
import { surrealDB } from '../src/db/surreal';

// Create test app with impulses router
const app = new Hono();
app.route('/v2/impulses', impulsesRouter);

// Test JWT token (for auth context)
const TEST_JWT_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcmdJZCI6Im1ldGFib2JfaW50ZXJuYWwiLCJwcm9qZWN0SWQiOiJ0ZXN0LXByb2plY3QiLCJpbnN0YW5jZUlkIjoidGVzdC1taW5pYm9iIiwiaWF0IjoxNzAwMDAwMDAwfQ.test';

describe('Goal Impulse Resolver', () => {
  beforeAll(async () => {
    // Ensure database is connected
    try {
      await surrealDB.query('SELECT * FROM activity_template LIMIT 1');
    } catch (error) {
      console.warn('Database not available for tests:', error);
    }
  });

  test('should resolve basic goal impulse', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_JWT_TOKEN}`,
      },
      body: JSON.stringify({
        pointer: {
          type: 'goal',
          content: 'Add user authentication to the dashboard',
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.content).toBeDefined();

    // Parse content to verify structure
    const content = JSON.parse(data.content);
    expect(content.recommendations).toBeArray();
    expect(content.metadata).toBeDefined();
    expect(content.metadata.sampling_method).toBe('thompson');

    // Verify metadata
    expect(data.metadata).toBeDefined();
    expect(data.metadata.shape).toBe('activityRecommendations');
    expect(data.metadata.rowCount).toBe(content.recommendations.length);
    expect(data.metadata.availableOps).toContain('select');
    expect(data.metadata.availableOps).toContain('execute');
  });

  test('should respect limit parameter', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_JWT_TOKEN}`,
      },
      body: JSON.stringify({
        pointer: {
          type: 'goal',
          content: 'Fix authentication bug',
          limit: 2,
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    const content = JSON.parse(data.content);
    expect(content.recommendations.length).toBeLessThanOrEqual(2);
  });

  test('should handle category filter', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_JWT_TOKEN}`,
      },
      body: JSON.stringify({
        pointer: {
          type: 'goal',
          content: 'Add new feature',
          category: 'feature',
          limit: 5,
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    const content = JSON.parse(data.content);

    // All recommendations should be in 'feature' category
    for (const rec of content.recommendations) {
      expect(rec.category).toBe('feature');
    }
  });

  test('should handle impulse context', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_JWT_TOKEN}`,
      },
      body: JSON.stringify({
        pointer: {
          type: 'goal',
          content: 'Fix login bug',
          impulseRefs: ['file-src-auth-ts', 'memo-bug-report'],
          limit: 3,
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    const content = JSON.parse(data.content);

    // Verify impulse context is recorded
    expect(content.metadata.impulse_context_size).toBe(2);
  });

  test('should handle exclude_activities parameter', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_JWT_TOKEN}`,
      },
      body: JSON.stringify({
        pointer: {
          type: 'goal',
          content: 'Test goal',
          limit: 10,
          excludeActivities: ['activity-to-exclude-1', 'activity-to-exclude-2'],
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    const content = JSON.parse(data.content);

    // Verify excluded activities are not in recommendations
    const recommendedIds = content.recommendations.map((r: any) => r.template_id);
    expect(recommendedIds).not.toContain('activity-to-exclude-1');
    expect(recommendedIds).not.toContain('activity-to-exclude-2');
  });

  test('should reject missing content field', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_JWT_TOKEN}`,
      },
      body: JSON.stringify({
        pointer: {
          type: 'goal',
        },
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain('content');
  });

  test('should handle empty category gracefully', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_JWT_TOKEN}`,
      },
      body: JSON.stringify({
        pointer: {
          type: 'goal',
          content: 'Generic task',
          category: '',
        },
      }),
    });

    // Should succeed even with empty category
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  test('should include recommendation metadata', async () => {
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_JWT_TOKEN}`,
      },
      body: JSON.stringify({
        pointer: {
          type: 'goal',
          content: 'Test recommendation metadata',
          limit: 1,
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    const content = JSON.parse(data.content);

    if (content.recommendations.length > 0) {
      const rec = content.recommendations[0];
      expect(rec.template_id).toBeDefined();
      expect(rec.template_name).toBeDefined();
      expect(rec.selection_metadata).toBeDefined();
      expect(rec.selection_metadata.method).toBe('thompson_sampling');
      expect(rec.selection_metadata.alpha).toBeNumber();
      expect(rec.selection_metadata.beta).toBeNumber();
      expect(rec.selection_metadata.sample).toBeNumber();
    }
  });

  test('should return meaningful summary in metadata', async () => {
    const goalDesc = 'Add user authentication feature';
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_JWT_TOKEN}`,
      },
      body: JSON.stringify({
        pointer: {
          type: 'goal',
          content: goalDesc,
          limit: 3,
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Summary should include count and goal description snippet
    expect(data.metadata.summary).toContain('activities recommended');
    expect(data.metadata.summary).toContain(goalDesc.substring(0, 30));
  });
});
