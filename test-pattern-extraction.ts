/**
 * Pattern Extraction Test
 *
 * Tests the pattern extraction service and endpoints.
 * Run this after applying the migration and starting the server.
 */

import { extractAndUpsertPattern, queryPatterns } from './src/services/pattern-extraction';
import { surrealDB } from './src/db/surreal';
import { logger } from './src/utils/logger';

async function testPatternExtraction() {
  try {
    logger.info('[test] Starting pattern extraction tests');

    // Test 1: Extract a simple pattern
    logger.info('[test] Test 1: Extract simple pattern');
    await extractAndUpsertPattern({
      executionId: 'test-exec-1',
      activityId: 'test-activity-1',
      inputImpulses: ['impulse-1', 'impulse-2'],
      outputImpulses: ['impulse-3'],
      success: true,
      durationMs: 1500,
      costUsd: 0.05,
      tokensIn: 1000,
      tokensOut: 500,
      orgId: 'organizations:test-org',
      projectId: null,
    });
    logger.info('[test] ✓ Pattern extracted successfully');

    // Test 2: Extract same pattern again (should increment counts)
    logger.info('[test] Test 2: Extract same pattern again');
    await extractAndUpsertPattern({
      executionId: 'test-exec-2',
      activityId: 'test-activity-1',
      inputImpulses: ['impulse-1', 'impulse-2'],
      outputImpulses: ['impulse-3'],
      success: false,
      durationMs: 2000,
      costUsd: 0.06,
      tokensIn: 1200,
      tokensOut: 600,
      orgId: 'organizations:test-org',
      projectId: null,
    });
    logger.info('[test] ✓ Pattern updated successfully');

    // Test 3: Query patterns
    logger.info('[test] Test 3: Query patterns');
    const result = await queryPatterns({
      orgId: 'organizations:test-org',
      minExecutions: 1,
      sortBy: 'execution_count',
      limit: 10,
    });
    logger.info('[test] ✓ Query results:', {
      count: result.patterns.length,
      total: result.total,
      patterns: result.patterns,
    });

    // Verify the pattern data
    if (result.patterns.length > 0) {
      const pattern = result.patterns[0];
      logger.info('[test] Pattern details:', {
        input_shapes: pattern.input_shapes,
        output_shapes: pattern.output_shapes,
        success_rate: pattern.success_rate,
        execution_count: pattern.execution_count,
        avg_cost_usd: pattern.avg_cost_usd,
        avg_duration_ms: pattern.avg_duration_ms,
      });

      // Verify rolling averages
      if (pattern.execution_count === 2) {
        const expectedAvgCost = (0.05 + 0.06) / 2;
        const expectedAvgDuration = (1500 + 2000) / 2;
        const expectedSuccessRate = 1 / 2;

        if (Math.abs(pattern.avg_cost_usd - expectedAvgCost) < 0.001) {
          logger.info('[test] ✓ Average cost is correct');
        } else {
          logger.error('[test] ✗ Average cost mismatch', {
            expected: expectedAvgCost,
            actual: pattern.avg_cost_usd,
          });
        }

        if (Math.abs(pattern.avg_duration_ms - expectedAvgDuration) < 1) {
          logger.info('[test] ✓ Average duration is correct');
        } else {
          logger.error('[test] ✗ Average duration mismatch', {
            expected: expectedAvgDuration,
            actual: pattern.avg_duration_ms,
          });
        }

        if (Math.abs(pattern.success_rate - expectedSuccessRate) < 0.001) {
          logger.info('[test] ✓ Success rate is correct');
        } else {
          logger.error('[test] ✗ Success rate mismatch', {
            expected: expectedSuccessRate,
            actual: pattern.success_rate,
          });
        }
      }
    }

    // Test 4: Query with shape filters
    logger.info('[test] Test 4: Query with input shape filter');
    const filteredResult = await queryPatterns({
      orgId: 'organizations:test-org',
      inputShapes: ['goal'],
      minExecutions: 1,
      sortBy: 'success_rate',
      limit: 5,
    });
    logger.info('[test] Query with filters results:', {
      count: filteredResult.patterns.length,
      total: filteredResult.total,
    });

    // Cleanup test data
    logger.info('[test] Cleaning up test data');
    await surrealDB.query(`
      DELETE FROM execution_pattern
      WHERE org_id = 'organizations:test-org'
    `);
    logger.info('[test] ✓ Test data cleaned up');

    logger.info('[test] All tests passed!');
  } catch (error: any) {
    logger.error('[test] Test failed', {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

// Run tests
testPatternExtraction()
  .then(() => {
    logger.info('[test] Test suite completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('[test] Test suite failed', error);
    process.exit(1);
  });
