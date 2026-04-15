/**
 * Tests for Variant Creator Service
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { surrealDB } from '../db/surreal';
import {
  shouldCreateVariant,
  createVariant,
  checkAndRetireTemplate,
  autoCreateVariantIfNeeded,
} from './variant-creator';

const TEST_ORG_ID = 'test-org-variant-creator';
const TEST_TEMPLATE_ID = 'test.template.failing';

describe('Variant Creator Service', () => {
  beforeAll(async () => {
    // Create test template
    await surrealDB.query(`
      CREATE activity:⟨${TEST_TEMPLATE_ID}⟩ SET
        name = "Test Failing Template",
        description = "Template for testing variant creation",
        tags = ["test", "variant"],
        category = "test",
        tasks = [{
          id: "task1",
          description: "Test task",
          prompt: { template: "Do something" },
          validation: {}
        }],
        scope = "org",
        org_id = $org_id,
        input_shapes = ["test_input"],
        output_shapes = ["test_output"],
        execution_type = "template",
        variant_generation = 0,
        retired = false
    `, { org_id: TEST_ORG_ID });
  });

  afterAll(async () => {
    // Clean up test data
    await surrealDB.query(`DELETE activity WHERE org_id = $org_id`, {
      org_id: TEST_ORG_ID,
    });
    await surrealDB.query(`DELETE execution WHERE org_id = $org_id`, {
      org_id: TEST_ORG_ID,
    });
  });

  test('shouldCreateVariant returns null when no failures', async () => {
    // Create successful executions
    for (let i = 0; i < 3; i++) {
      await surrealDB.query(`
        INSERT INTO execution {
          id: "exec_success_${i}",
          activity_id: $activity_id,
          success: true,
          duration_ms: 1000,
          cost_usd: 0.01,
          org_id: $org_id,
          tokens_in: 100,
          tokens_out: 100,
          input_impulses: [],
          output_impulses: []
        }
      `, {
        activity_id: TEST_TEMPLATE_ID,
        org_id: TEST_ORG_ID,
      });
    }

    const result = await shouldCreateVariant(TEST_TEMPLATE_ID, TEST_ORG_ID);
    expect(result).toBeNull();
  });

  test('shouldCreateVariant detects 3 consecutive failures', async () => {
    // Clean previous executions
    await surrealDB.query(`DELETE execution WHERE activity_id = $activity_id`, {
      activity_id: TEST_TEMPLATE_ID,
    });

    // Create 3 consecutive failures
    for (let i = 0; i < 3; i++) {
      await surrealDB.query(`
        INSERT INTO execution {
          id: "exec_fail_${i}",
          activity_id: $activity_id,
          success: false,
          duration_ms: 1000,
          cost_usd: 0.01,
          org_id: $org_id,
          tokens_in: 100,
          tokens_out: 100,
          input_impulses: [],
          output_impulses: [],
          error: {
            message: "Test error ${i}",
            type: "test_error",
            task_id: "task1"
          }
        }
      `, {
        activity_id: TEST_TEMPLATE_ID,
        org_id: TEST_ORG_ID,
      });

      // Add small delay to ensure ordering
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    const result = await shouldCreateVariant(TEST_TEMPLATE_ID, TEST_ORG_ID);
    expect(result).not.toBeNull();
    expect(result?.consecutiveFailures).toBe(3);
    expect(result?.commonErrors.length).toBeGreaterThan(0);
    expect(result?.failedTasks).toContain('task1');
  });

  test('createVariant generates a new variant', async () => {
    const failurePattern = {
      templateId: TEST_TEMPLATE_ID,
      consecutiveFailures: 3,
      totalExecutions: 3,
      successRate: 0,
      commonErrors: ['Test error'],
      failedTasks: ['task1'],
    };

    const result = await createVariant(
      TEST_TEMPLATE_ID,
      failurePattern,
      TEST_ORG_ID,
      'consecutive_failures'
    );

    expect(result).not.toBeNull();
    expect(result?.variantId).toBeDefined();
    expect(result?.variantGeneration).toBe(1);
    expect(result?.reason).toBe('consecutive_failures');
    expect(result?.modifications.length).toBeGreaterThan(0);

    // Verify variant was created in database
    const variant = await surrealDB.query(`
      SELECT * FROM activity WHERE id = $variant_id
    `, { variant_id: result?.variantId });

    expect(variant).toBeDefined();
    expect(variant[0]).toBeDefined();
    expect(variant[0].variant_of).toBe(TEST_TEMPLATE_ID);
    expect(variant[0].variant_generation).toBe(1);
    expect(variant[0].variant_reason).toBe('consecutive_failures');
  });

  test('checkAndRetireTemplate retires poorly performing templates', async () => {
    const testTemplateId = 'test.template.poor';

    // Create test template
    await surrealDB.query(`
      CREATE activity:⟨${testTemplateId}⟩ SET
        name = "Poor Performance Template",
        description = "Template for testing retirement",
        tags = ["test"],
        category = "test",
        tasks = [],
        scope = "org",
        org_id = $org_id,
        input_shapes = [],
        output_shapes = ["test"],
        execution_type = "template",
        variant_generation = 0,
        retired = false
    `, { org_id: TEST_ORG_ID });

    // Create 20 executions with < 30% success rate (5 successes, 15 failures)
    for (let i = 0; i < 20; i++) {
      const success = i < 5;
      await surrealDB.query(`
        INSERT INTO execution {
          id: "exec_retire_${i}",
          activity_id: $activity_id,
          success: $success,
          duration_ms: 1000,
          cost_usd: 0.01,
          org_id: $org_id,
          tokens_in: 100,
          tokens_out: 100,
          input_impulses: [],
          output_impulses: []
        }
      `, {
        activity_id: testTemplateId,
        org_id: TEST_ORG_ID,
        success,
      });
    }

    const wasRetired = await checkAndRetireTemplate(testTemplateId, TEST_ORG_ID);
    expect(wasRetired).toBe(true);

    // Verify retirement in database
    const retired = await surrealDB.query(`
      SELECT retired, retired_reason FROM activity WHERE id = $template_id
    `, { template_id: testTemplateId });

    expect(retired[0].retired).toBe(true);
    expect(retired[0].retired_reason).toBe('poor_performance');
  });

  test('autoCreateVariantIfNeeded creates variant after 3 failures', async () => {
    const testTemplateId = 'test.template.auto';

    // Create test template
    await surrealDB.query(`
      CREATE activity:⟨${testTemplateId}⟩ SET
        name = "Auto Variant Template",
        description = "Template for testing auto variant creation",
        tags = ["test"],
        category = "test",
        tasks = [{
          id: "task1",
          description: "Test task",
          prompt: { template: "Do something" }
        }],
        scope = "org",
        org_id = $org_id,
        input_shapes = [],
        output_shapes = ["test"],
        execution_type = "template",
        variant_generation = 0,
        retired = false
    `, { org_id: TEST_ORG_ID });

    // Create 3 consecutive failures
    for (let i = 0; i < 3; i++) {
      await surrealDB.query(`
        INSERT INTO execution {
          id: "exec_auto_${i}",
          activity_id: $activity_id,
          success: false,
          duration_ms: 1000,
          cost_usd: 0.01,
          org_id: $org_id,
          tokens_in: 100,
          tokens_out: 100,
          input_impulses: [],
          output_impulses: [],
          error: {
            message: "Auto test error",
            type: "test_error",
            task_id: "task1"
          }
        }
      `, {
        activity_id: testTemplateId,
        org_id: TEST_ORG_ID,
      });

      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // This should trigger variant creation
    const result = await autoCreateVariantIfNeeded(testTemplateId, TEST_ORG_ID, false);

    expect(result).not.toBeNull();
    expect(result?.variantId).toBeDefined();
    expect(result?.variantGeneration).toBe(1);

    // Verify variant exists
    const variants = await surrealDB.query(`
      SELECT id FROM activity WHERE variant_of = $parent_id
    `, { parent_id: testTemplateId });

    expect(variants.length).toBeGreaterThan(0);
  });

  test('variant creation respects maximum variant limit', async () => {
    const testTemplateId = 'test.template.maxvariants';

    // Create test template
    await surrealDB.query(`
      CREATE activity:⟨${testTemplateId}⟩ SET
        name = "Max Variants Template",
        description = "Template for testing max variants",
        tags = ["test"],
        category = "test",
        tasks = [],
        scope = "org",
        org_id = $org_id,
        input_shapes = [],
        output_shapes = ["test"],
        execution_type = "template",
        variant_generation = 0,
        retired = false
    `, { org_id: TEST_ORG_ID });

    // Create 5 variants (maximum)
    for (let i = 0; i < 5; i++) {
      await surrealDB.query(`
        CREATE activity:⟨${testTemplateId}.v${i}⟩ SET
          name = "Variant ${i}",
          description = "Variant",
          tags = ["test"],
          category = "test",
          tasks = [],
          scope = "org",
          org_id = $org_id,
          input_shapes = [],
          output_shapes = ["test"],
          execution_type = "template",
          variant_of = $parent_id,
          variant_generation = ${i + 1},
          retired = false
      `, { parent_id: testTemplateId, org_id: TEST_ORG_ID });
    }

    const failurePattern = {
      templateId: testTemplateId,
      consecutiveFailures: 3,
      totalExecutions: 3,
      successRate: 0,
      commonErrors: [],
      failedTasks: [],
    };

    // Try to create 6th variant (should fail)
    const result = await createVariant(
      testTemplateId,
      failurePattern,
      TEST_ORG_ID,
      'test'
    );

    expect(result).toBeNull();
  });

  test('variant modifications include error awareness', async () => {
    const failurePattern = {
      templateId: TEST_TEMPLATE_ID,
      consecutiveFailures: 3,
      totalExecutions: 3,
      successRate: 0,
      commonErrors: ['Specific error message'],
      failedTasks: ['task1'],
    };

    const result = await createVariant(
      TEST_TEMPLATE_ID,
      failurePattern,
      TEST_ORG_ID,
      'test_modifications'
    );

    expect(result).not.toBeNull();
    expect(result?.modifications).toBeDefined();

    // Check that error awareness modification was applied
    const hasErrorAwareness = result?.modifications.some((mod: string) =>
      mod.includes('error awareness')
    );
    expect(hasErrorAwareness).toBe(true);

    // Verify the variant has modified prompts
    const variant = await surrealDB.query(`
      SELECT tasks FROM activity WHERE id = $variant_id
    `, { variant_id: result?.variantId });

    const tasks = variant[0]?.tasks || [];
    if (tasks.length > 0) {
      const firstTask = tasks[0];
      if (firstTask.prompt?.template) {
        expect(firstTask.prompt.template).toContain('Previous attempts failed');
      }
    }
  });
});
