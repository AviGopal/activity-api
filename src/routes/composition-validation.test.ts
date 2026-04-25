/**
 * Tests for composition validation endpoint
 * POST /v2/activities/validate-composition
 */

import { describe, test, expect } from 'bun:test';

describe('POST /v2/activities/validate-composition', () => {
  const baseUrl = process.env.TEST_API_URL || 'http://localhost:8080';

  test('should validate a valid composition with no errors', async () => {
    const response = await fetch(`${baseUrl}/v2/activities/validate-composition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodes: [
          { activity_id: 'activity-a', output_shapes: ['shape-1'] },
          { activity_id: 'activity-b', output_shapes: ['shape-2'] },
        ],
        edges: [
          { from: 'activity-a', to: 'activity-b' },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('valid');
    expect(data).toHaveProperty('errors');
    expect(data).toHaveProperty('summary');
    expect(data.summary).toHaveProperty('nodeCount', 2);
    expect(data.summary).toHaveProperty('edgeCount', 1);
  });

  test('should detect a cycle in the composition', async () => {
    const response = await fetch(`${baseUrl}/v2/activities/validate-composition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodes: [
          { activity_id: 'activity-a' },
          { activity_id: 'activity-b' },
          { activity_id: 'activity-c' },
        ],
        edges: [
          { from: 'activity-a', to: 'activity-b' },
          { from: 'activity-b', to: 'activity-c' },
          { from: 'activity-c', to: 'activity-a' }, // Creates a cycle
        ],
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.valid).toBe(false);
    expect(data.errors.length).toBeGreaterThan(0);
    expect(data.errors[0].type).toBe('cycle');
    expect(data.errors[0]).toHaveProperty('path');
    expect(data.summary.cyclesDetected).toBeGreaterThan(0);
  });

  test('should reject invalid request body', async () => {
    const response = await fetch(`${baseUrl}/v2/activities/validate-composition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodes: 'invalid', // Should be array
      }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data).toHaveProperty('error');
  });

  test('should validate an empty composition', async () => {
    const response = await fetch(`${baseUrl}/v2/activities/validate-composition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodes: [],
        edges: [],
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.valid).toBe(true);
    expect(data.errors.length).toBe(0);
    expect(data.summary.nodeCount).toBe(0);
    expect(data.summary.edgeCount).toBe(0);
  });

  test('should detect multiple cycles', async () => {
    const response = await fetch(`${baseUrl}/v2/activities/validate-composition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodes: [
          { activity_id: 'a' },
          { activity_id: 'b' },
          { activity_id: 'c' },
          { activity_id: 'd' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' }, // Cycle 1
          { from: 'c', to: 'd' },
          { from: 'd', to: 'c' }, // Cycle 2
        ],
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.valid).toBe(false);
    expect(data.summary.cyclesDetected).toBeGreaterThan(0);
  });
});
