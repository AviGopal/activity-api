/**
 * Tests for POST /v2/activities/feedback endpoint
 *
 * Tests manual feedback from /teach and /warn commands
 * Verifies Thompson Sampling parameter updates (alpha/beta)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import activitiesRouter from './activities';
import { surrealDB } from '../db/surreal';

// Test org ID
const TEST_ORG_ID = 'test-org-feedback';
const TEST_ACTIVITY_ID = 'test-activity-feedback';

// Create test app
const app = new Hono();
app.route('/v2/activities', activitiesRouter);

// Helper to create mock session context
function createTestContext(orgId: string) {
  return {
    req: {} as any,
    get: (key: string) => {
      if (key === 'session') {
        return {
          session_id: 'test-session',
          org_id: orgId,
          project_id: null,
          api_key: null,
          latest_job_id: null,
        };
      }
      return undefined;
    },
    set: () => {},
    json: (data: any, status?: number) => ({
      status: status || 200,
      json: () => Promise.resolve(data),
    }),
  } as any;
}

// Setup test data
beforeAll(async () => {
  // Create test activity
  await surrealDB.query(
    `UPSERT activity:\`${TEST_ACTIVITY_ID}\` CONTENT {
      id: $id,
      name: "Test Activity for Feedback",
      description: "Test activity",
      tags: ["test"],
      scope: "org",
      org_id: $org_id,
      public: false,
      input_shapes: ["goal", "error"],
      output_shapes: ["solution"],
      created_at: time::now(),
      updated_at: time::now()
    }`,
    {
      id: TEST_ACTIVITY_ID,
      org_id: TEST_ORG_ID,
    }
  );

  // Create initial shape scores
  await surrealDB.query(
    `CREATE impulse_shape_activity_score CONTENT {
      shape: "goal",
      activity_id: $activity_id,
      org_id: $org_id,
      success_count: 5,
      failure_count: 2,
      alpha: 6,
      beta: 3,
      updated_at: time::now()
    }`,
    {
      activity_id: TEST_ACTIVITY_ID,
      org_id: TEST_ORG_ID,
    }
  );

  await surrealDB.query(
    `CREATE impulse_shape_activity_score CONTENT {
      shape: "error",
      activity_id: $activity_id,
      org_id: $org_id,
      success_count: 3,
      failure_count: 1,
      alpha: 4,
      beta: 2,
      updated_at: time::now()
    }`,
    {
      activity_id: TEST_ACTIVITY_ID,
      org_id: TEST_ORG_ID,
    }
  );
});

// Cleanup test data
afterAll(async () => {
  await surrealDB.query(
    `DELETE FROM activity WHERE id = $id`,
    { id: TEST_ACTIVITY_ID }
  );

  await surrealDB.query(
    `DELETE FROM impulse_shape_activity_score
     WHERE org_id = $org_id AND activity_id = $activity_id`,
    {
      org_id: TEST_ORG_ID,
      activity_id: TEST_ACTIVITY_ID,
    }
  );
});

describe('POST /v2/activities/feedback', () => {
  test('positive feedback with intensity 0 (1.5x multiplier)', async () => {
    const response = await app.request('/v2/activities/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        activity_id: TEST_ACTIVITY_ID,
        direction: 'positive',
        intensity: 0,
        reason: 'Test positive feedback',
      }),
    });

    expect(response.status).toBe(200);

    const data = await response.json() as {
      success: boolean;
      direction: string;
      multiplier: number;
      affected_activities: string[];
    };
    expect(data.success).toBe(true);
    expect(data.direction).toBe('positive');
    expect(data.multiplier).toBe(1.5);
    expect(data.affected_activities).toContain(TEST_ACTIVITY_ID);

    // Verify alpha was updated
    const scores = await surrealDB.query(
      `SELECT * FROM impulse_shape_activity_score
       WHERE org_id = $org_id AND activity_id = $activity_id AND shape = "goal"`,
      {
        org_id: TEST_ORG_ID,
        activity_id: TEST_ACTIVITY_ID,
      }
    );

    expect(scores.length).toBeGreaterThan(0);
    const goalScore = scores[0];
    // Original alpha was 6, 6 * 1.5 = 9
    expect(goalScore.alpha).toBe(9);
    // Beta should be unchanged
    expect(goalScore.beta).toBe(3);
  });

  test('positive feedback with intensity 3 (3x multiplier)', async () => {
    // First, get current alpha
    const beforeScores = await surrealDB.query(
      `SELECT * FROM impulse_shape_activity_score
       WHERE org_id = $org_id AND activity_id = $activity_id AND shape = "error"`,
      {
        org_id: TEST_ORG_ID,
        activity_id: TEST_ACTIVITY_ID,
      }
    );
    const beforeAlpha = beforeScores[0].alpha;

    const response = await app.request('/v2/activities/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        activity_id: TEST_ACTIVITY_ID,
        direction: 'positive',
        intensity: 3,
        reason: 'Strong positive feedback',
      }),
    });

    expect(response.status).toBe(200);

    const data = await response.json() as {
      success: boolean;
      multiplier: number;
    };
    expect(data.success).toBe(true);
    expect(data.multiplier).toBe(3.0); // 1.5 + (3 * 0.5)

    // Verify alpha was updated
    const afterScores = await surrealDB.query(
      `SELECT * FROM impulse_shape_activity_score
       WHERE org_id = $org_id AND activity_id = $activity_id AND shape = "error"`,
      {
        org_id: TEST_ORG_ID,
        activity_id: TEST_ACTIVITY_ID,
      }
    );

    const afterAlpha = afterScores[0].alpha;
    expect(afterAlpha).toBeGreaterThan(beforeAlpha);
    // Should be 3x the previous value
    expect(afterAlpha).toBe(Math.ceil(beforeAlpha * 3));
  });

  test('negative feedback with intensity 1 (2x multiplier)', async () => {
    // Get current beta
    const beforeScores = await surrealDB.query(
      `SELECT * FROM impulse_shape_activity_score
       WHERE org_id = $org_id AND activity_id = $activity_id AND shape = "goal"`,
      {
        org_id: TEST_ORG_ID,
        activity_id: TEST_ACTIVITY_ID,
      }
    );
    const beforeBeta = beforeScores[0].beta;

    const response = await app.request('/v2/activities/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        activity_id: TEST_ACTIVITY_ID,
        direction: 'negative',
        intensity: 1,
        reason: 'Activity failed in unexpected way',
      }),
    });

    expect(response.status).toBe(200);

    const data = await response.json() as {
      success: boolean;
      direction: string;
      multiplier: number;
    };
    expect(data.success).toBe(true);
    expect(data.direction).toBe('negative');
    expect(data.multiplier).toBe(2.0); // 1.5 + (1 * 0.5)

    // Verify beta was updated
    const afterScores = await surrealDB.query(
      `SELECT * FROM impulse_shape_activity_score
       WHERE org_id = $org_id AND activity_id = $activity_id AND shape = "goal"`,
      {
        org_id: TEST_ORG_ID,
        activity_id: TEST_ACTIVITY_ID,
      }
    );

    const afterBeta = afterScores[0].beta;
    expect(afterBeta).toBeGreaterThan(beforeBeta);
    // Should be 2x the previous value
    expect(afterBeta).toBe(Math.ceil(beforeBeta * 2));
  });

  test('activity not found returns 404', async () => {
    const response = await app.request('/v2/activities/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        activity_id: 'non-existent-activity',
        direction: 'positive',
        intensity: 0,
      }),
    });

    expect(response.status).toBe(404);

    const data = await response.json() as { error: string };
    expect(data.error).toBe('Activity not found');
  });

  test('invalid direction returns 400', async () => {
    const response = await app.request('/v2/activities/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        activity_id: TEST_ACTIVITY_ID,
        direction: 'invalid',
        intensity: 0,
      }),
    });

    expect(response.status).toBe(400);

    const data = await response.json() as { error: string };
    expect(data.error).toBe('Validation error');
  });

  test('invalid intensity returns 400', async () => {
    const response = await app.request('/v2/activities/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        activity_id: TEST_ACTIVITY_ID,
        direction: 'positive',
        intensity: 5, // Max is 3
      }),
    });

    expect(response.status).toBe(400);

    const data = await response.json() as { error: string };
    expect(data.error).toBe('Validation error');
  });

  test('initializes scores for activity without existing scores', async () => {
    const newActivityId = 'test-activity-no-scores';

    // Create activity without scores
    await surrealDB.query(
      `UPSERT activity:\`${newActivityId}\` CONTENT {
        id: $id,
        name: "New Activity",
        description: "Test activity without scores",
        tags: ["test"],
        scope: "org",
        org_id: $org_id,
        public: false,
        input_shapes: ["goal"],
        output_shapes: ["result"],
        created_at: time::now(),
        updated_at: time::now()
      }`,
      {
        id: newActivityId,
        org_id: TEST_ORG_ID,
      }
    );

    try {
      const response = await app.request('/v2/activities/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          activity_id: newActivityId,
          direction: 'positive',
          intensity: 0,
        }),
      });

      expect(response.status).toBe(200);

      // Verify scores were initialized
      const scores = await surrealDB.query(
        `SELECT * FROM impulse_shape_activity_score
         WHERE org_id = $org_id AND activity_id = $activity_id`,
        {
          org_id: TEST_ORG_ID,
          activity_id: newActivityId,
        }
      );

      expect(scores.length).toBeGreaterThan(0);
      const goalScore = scores.find((s: any) => s.shape === 'goal');
      expect(goalScore).toBeDefined();
      // After feedback, alpha should be 1 * 1.5 = 1.5 (rounded to 2)
      expect(goalScore.alpha).toBeGreaterThanOrEqual(1);

    } finally {
      // Cleanup
      await surrealDB.query(
        `DELETE FROM activity WHERE id = $id`,
        { id: newActivityId }
      );
      await surrealDB.query(
        `DELETE FROM impulse_shape_activity_score
         WHERE org_id = $org_id AND activity_id = $activity_id`,
        {
          org_id: TEST_ORG_ID,
          activity_id: newActivityId,
        }
      );
    }
  });

  test('feedback affects Thompson Sampling selection probability', async () => {
    // Create two similar activities
    const activityA = 'test-activity-a';
    const activityB = 'test-activity-b';

    // Create activities
    await surrealDB.query(
      `UPSERT activity:\`${activityA}\` CONTENT {
        id: $id,
        name: "Activity A",
        description: "Test activity A",
        tags: ["test"],
        scope: "org",
        org_id: $org_id,
        public: false,
        input_shapes: ["goal"],
        output_shapes: ["result"],
        created_at: time::now(),
        updated_at: time::now()
      }`,
      { id: activityA, org_id: TEST_ORG_ID }
    );

    await surrealDB.query(
      `UPSERT activity:\`${activityB}\` CONTENT {
        id: $id,
        name: "Activity B",
        description: "Test activity B",
        tags: ["test"],
        scope: "org",
        org_id: $org_id,
        public: false,
        input_shapes: ["goal"],
        output_shapes: ["result"],
        created_at: time::now(),
        updated_at: time::now()
      }`,
      { id: activityB, org_id: TEST_ORG_ID }
    );

    // Create identical initial scores
    for (const activityId of [activityA, activityB]) {
      await surrealDB.query(
        `CREATE impulse_shape_activity_score CONTENT {
          shape: "goal",
          activity_id: $activity_id,
          org_id: $org_id,
          success_count: 5,
          failure_count: 5,
          alpha: 6,
          beta: 6,
          updated_at: time::now()
        }`,
        { activity_id: activityId, org_id: TEST_ORG_ID }
      );
    }

    try {
      // Give positive feedback to activity A
      await app.request('/v2/activities/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activity_id: activityA,
          direction: 'positive',
          intensity: 2, // 2.5x multiplier
        }),
      });

      // Get updated scores
      const scoresA = await surrealDB.query(
        `SELECT * FROM impulse_shape_activity_score
         WHERE org_id = $org_id AND activity_id = $activity_id AND shape = "goal"`,
        { org_id: TEST_ORG_ID, activity_id: activityA }
      );

      const scoresB = await surrealDB.query(
        `SELECT * FROM impulse_shape_activity_score
         WHERE org_id = $org_id AND activity_id = $activity_id AND shape = "goal"`,
        { org_id: TEST_ORG_ID, activity_id: activityB }
      );

      // Activity A should have higher alpha
      expect(scoresA[0].alpha).toBeGreaterThan(scoresB[0].alpha);

      // Calculate expected values from Beta distribution
      const beliefA = scoresA[0].alpha / (scoresA[0].alpha + scoresA[0].beta);
      const beliefB = scoresB[0].alpha / (scoresB[0].alpha + scoresB[0].beta);

      // Activity A should have higher belief (expected success rate)
      expect(beliefA).toBeGreaterThan(beliefB);

    } finally {
      // Cleanup
      for (const activityId of [activityA, activityB]) {
        await surrealDB.query(
          `DELETE FROM activity WHERE id = $id`,
          { id: activityId }
        );
        await surrealDB.query(
          `DELETE FROM impulse_shape_activity_score
           WHERE org_id = $org_id AND activity_id = $activity_id`,
          { org_id: TEST_ORG_ID, activity_id: activityId }
        );
      }
    }
  });
});
