/**
 * Tests for POST /v2/activities/discover-by-shapes endpoint
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { surrealDB } from '../db/surreal';
import activitiesRoutes from './activities';

describe('POST /v2/activities/discover-by-shapes', () => {
  let app: Hono;

  beforeEach(async () => {
    // Create test app
    app = new Hono();
    app.route('/v2/activities', activitiesRoutes);

    // Clean up test data
    await surrealDB.query('DELETE FROM activity WHERE name CONTAINS "Test Shape Discovery"');
    await surrealDB.query('DELETE FROM activity_metrics WHERE activity CONTAINS "activity:test_shape_"');

    // Create test activities with different output shapes
    await surrealDB.query(`
      CREATE activity:test_shape_fix CONTENT {
        name: "Test Shape Discovery Fix Activity",
        description: "Test activity for shape discovery",
        tags: ["test", "bugfix"],
        scope: "private",
        org_id: "test-org",
        output_shapes: ["errorFixed", "bugFixed"],
        created_at: time::now(),
        updated_at: time::now()
      }
    `);

    await surrealDB.query(`
      CREATE activity:test_shape_analyze CONTENT {
        name: "Test Shape Discovery Analysis Activity",
        description: "Test activity for shape discovery",
        tags: ["test", "analysis"],
        scope: "private",
        org_id: "test-org",
        output_shapes: ["analysisReport", "metrics"],
        created_at: time::now(),
        updated_at: time::now()
      }
    `);

    await surrealDB.query(`
      CREATE activity:test_shape_deploy CONTENT {
        name: "Test Shape Discovery Deploy Activity",
        description: "Test activity for shape discovery",
        tags: ["test", "deployment"],
        scope: "private",
        org_id: "test-org",
        output_shapes: ["deploymentStatus", "artifact"],
        created_at: time::now(),
        updated_at: time::now()
      }
    `);

    // Create metrics for sorting
    await surrealDB.query(`
      CREATE activity_metrics CONTENT {
        activity: activity:test_shape_fix,
        total_executions: 10,
        successful_executions: 9,
        failed_executions: 1,
        alpha: 10.0,
        beta: 2.0,
        success_rate: 0.9,
        created_at: time::now(),
        updated_at: time::now()
      }
    `);
  });

  afterEach(async () => {
    // Clean up
    await surrealDB.query('DELETE FROM activity WHERE name CONTAINS "Test Shape Discovery"');
    await surrealDB.query('DELETE FROM activity_metrics WHERE activity CONTAINS "activity:test_shape_"');
  });

  it('should return 400 when required_shapes is missing', async () => {
    const res = await app.request('/v2/activities/discover-by-shapes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Validation failed');
  });

  it('should return 400 when required_shapes is empty array', async () => {
    const res = await app.request('/v2/activities/discover-by-shapes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ required_shapes: [] }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Validation failed');
  });

  it('should discover activities by single output shape', async () => {
    const res = await app.request('/v2/activities/discover-by-shapes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        required_shapes: ['errorFixed'],
        limit: 10,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.activities).toBeDefined();
    expect(Array.isArray(data.activities)).toBe(true);
    expect(data.activities.length).toBeGreaterThan(0);

    // Should find the fix activity
    const fixActivity = data.activities.find((a: any) =>
      a.name === 'Test Shape Discovery Fix Activity'
    );
    expect(fixActivity).toBeDefined();
    expect(fixActivity.output_shapes).toContain('errorFixed');
  });

  it('should discover activities by multiple output shapes', async () => {
    const res = await app.request('/v2/activities/discover-by-shapes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        required_shapes: ['errorFixed', 'analysisReport'],
        limit: 10,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.activities).toBeDefined();
    expect(data.activities.length).toBeGreaterThanOrEqual(2);

    // Should find both fix and analysis activities
    const activityNames = data.activities.map((a: any) => a.name);
    expect(activityNames).toContain('Test Shape Discovery Fix Activity');
    expect(activityNames).toContain('Test Shape Discovery Analysis Activity');
  });

  it('should return empty array when no activities match', async () => {
    const res = await app.request('/v2/activities/discover-by-shapes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        required_shapes: ['nonexistentShape'],
        limit: 10,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.activities).toBeDefined();
    expect(Array.isArray(data.activities)).toBe(true);

    // Should not contain test activities
    const hasTestActivity = data.activities.some((a: any) =>
      a.name.includes('Test Shape Discovery')
    );
    expect(hasTestActivity).toBe(false);
  });

  it('should respect limit parameter', async () => {
    const res = await app.request('/v2/activities/discover-by-shapes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        required_shapes: ['errorFixed', 'analysisReport', 'deploymentStatus'],
        limit: 2,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.activities.length).toBeLessThanOrEqual(2);
  });

  it('should include Thompson Sampling metrics when available', async () => {
    const res = await app.request('/v2/activities/discover-by-shapes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        required_shapes: ['errorFixed'],
        limit: 10,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    const fixActivity = data.activities.find((a: any) =>
      a.name === 'Test Shape Discovery Fix Activity'
    );

    if (fixActivity) {
      expect(fixActivity.metrics).toBeDefined();
      expect(fixActivity.metrics.total_executions).toBe(10);
      expect(fixActivity.metrics.thompson_alpha).toBe(10.0);
      expect(fixActivity.metrics.thompson_beta).toBe(2.0);
      expect(fixActivity.metrics.confidence).toBeGreaterThan(0.5);
    }
  });

  it('should order by total_executions DESC', async () => {
    // Create another activity with fewer executions
    await surrealDB.query(`
      CREATE activity:test_shape_fix_new CONTENT {
        name: "Test Shape Discovery New Fix Activity",
        description: "Newer test activity",
        tags: ["test", "bugfix"],
        scope: "private",
        org_id: "test-org",
        output_shapes: ["errorFixed"],
        created_at: time::now(),
        updated_at: time::now()
      }
    `);

    await surrealDB.query(`
      CREATE activity_metrics CONTENT {
        activity: activity:test_shape_fix_new,
        total_executions: 2,
        successful_executions: 2,
        failed_executions: 0,
        alpha: 3.0,
        beta: 1.0,
        success_rate: 1.0,
        created_at: time::now(),
        updated_at: time::now()
      }
    `);

    const res = await app.request('/v2/activities/discover-by-shapes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        required_shapes: ['errorFixed'],
        limit: 10,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    const fixActivities = data.activities.filter((a: any) =>
      a.output_shapes?.includes('errorFixed') && a.name.includes('Test Shape Discovery')
    );

    // The activity with more executions should come first
    expect(fixActivities[0]?.metrics?.total_executions).toBeGreaterThanOrEqual(
      fixActivities[1]?.metrics?.total_executions || 0
    );

    // Clean up
    await surrealDB.query('DELETE activity:test_shape_fix_new');
  });
});
