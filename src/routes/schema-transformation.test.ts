/**
 * Schema Transformation Tests
 *
 * Tests that the backend correctly handles snake_case→camelCase transformations
 * and validates against the Zod schemas.
 */

import { describe, test, expect } from 'bun:test';
import {
  CreateTemplateRequestSchema,
  TemplateTaskSchema,
  type CreateTemplateRequest,
} from '../models/schemas';

describe('Schema Transformation Tests', () => {
  describe('TemplateTaskSchema', () => {
    test('should accept camelCase field names', () => {
      const task = {
        id: 'task-1',
        description: 'Test task',
        prompt: {
          template: 'Do something',
          maxTokens: 1000,
        },
        validation: {
          requiredFiles: ['src/test.ts'],
          requiredPatterns: [{ regex: 'test', file: 'test.ts' }],
          forbiddenPatterns: [{ regex: 'console.log' }],
        },
        retry: {
          maxAttempts: 3,
          strategy: 'exponential',
        },
      };

      const result = TemplateTaskSchema.safeParse(task);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.prompt.maxTokens).toBe(1000);
        expect(result.data.validation?.requiredFiles).toEqual(['src/test.ts']);
        expect(result.data.retry?.maxAttempts).toBe(3);
      }
    });

    test('should accept snake_case max_attempts in retry', () => {
      const task = {
        id: 'task-1',
        description: 'Test task',
        prompt: {
          template: 'Do something',
        },
        retry: {
          max_attempts: 3,
          strategy: 'exponential',
        },
      };

      const result = TemplateTaskSchema.safeParse(task);

      expect(result.success).toBe(true);
      if (result.success) {
        // Schema accepts both max_attempts and maxAttempts
        expect(result.data.retry?.max_attempts).toBe(3);
      }
    });

    test('should reject retry with neither max_attempts nor maxAttempts', () => {
      const task = {
        id: 'task-1',
        description: 'Test task',
        prompt: {
          template: 'Do something',
        },
        retry: {
          // Missing both max_attempts and maxAttempts
          strategy: 'exponential',
        },
      };

      const result = TemplateTaskSchema.safeParse(task);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('max_attempts');
      }
    });

    test('should handle nested objects in validation', () => {
      const task = {
        id: 'task-1',
        description: 'Test task',
        prompt: {
          template: 'Do something',
        },
        validation: {
          requiredFiles: ['a.ts', 'b.ts'],
          requiredPatterns: [
            { regex: 'test1', file: 'test1.ts' },
            { regex: 'test2', file: 'test2.ts' },
          ],
          forbiddenPatterns: [{ regex: 'bad1' }, { regex: 'bad2' }],
          commands: [{ cmd: 'npm test', expectExit: 0 }],
        },
      };

      const result = TemplateTaskSchema.safeParse(task);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.validation?.requiredFiles).toHaveLength(2);
        expect(result.data.validation?.requiredPatterns).toHaveLength(2);
        expect(result.data.validation?.forbiddenPatterns).toHaveLength(2);
      }
    });
  });

  describe('CreateTemplateRequestSchema', () => {
    test('should accept canonical field names', () => {
      const request = {
        id: 'test-template',
        name: 'Test Template',
        description: 'A test template',
        tags: ['test.unit'],
        tasks: [
          {
            id: 'task-1',
            description: 'Test task',
            prompt: {
              template: 'Do something',
            },
          },
        ],
      };

      const result = CreateTemplateRequestSchema.safeParse(request);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('test-template');
        expect(result.data.name).toBe('Test Template');
      }
    });

    test('should accept legacy variant_id and variant_name', () => {
      const request = {
        variant_id: 'test-template',
        variant_name: 'Test Template',
        description: 'A test template',
        category: 'meta',
        tasks: [
          {
            id: 'task-1',
            description: 'Test task',
            prompt: {
              template: 'Do something',
            },
          },
        ],
      };

      const result = CreateTemplateRequestSchema.safeParse(request);

      expect(result.success).toBe(true);
    });

    test('should accept legacy task_steps', () => {
      const request = {
        id: 'test-template',
        name: 'Test Template',
        description: 'A test template',
        category: 'meta',
        task_steps: [
          {
            id: 'task-1',
            description: 'Test task',
            prompt: {
              template: 'Do something',
            },
          },
        ],
      };

      const result = CreateTemplateRequestSchema.safeParse(request);

      expect(result.success).toBe(true);
    });

    test('should require either id or variant_id', () => {
      const request = {
        // Missing both id and variant_id
        name: 'Test Template',
        description: 'A test template',
        tags: ['test'],
        tasks: [
          {
            id: 'task-1',
            description: 'Test task',
            prompt: {
              template: 'Do something',
            },
          },
        ],
      };

      const result = CreateTemplateRequestSchema.safeParse(request);

      expect(result.success).toBe(false);
    });

    test('should require either name or variant_name', () => {
      const request = {
        id: 'test-template',
        // Missing both name and variant_name
        description: 'A test template',
        tags: ['test'],
        tasks: [
          {
            id: 'task-1',
            description: 'Test task',
            prompt: {
              template: 'Do something',
            },
          },
        ],
      };

      const result = CreateTemplateRequestSchema.safeParse(request);

      expect(result.success).toBe(false);
    });

    test('should require either tasks or task_steps', () => {
      const request = {
        id: 'test-template',
        name: 'Test Template',
        description: 'A test template',
        tags: ['test'],
        // Missing both tasks and task_steps
      };

      const result = CreateTemplateRequestSchema.safeParse(request);

      expect(result.success).toBe(false);
    });

    test('should accept tags or category', () => {
      const requestWithTags = {
        id: 'test-template-1',
        name: 'Test Template 1',
        description: 'A test template',
        tags: ['test.unit'],
        tasks: [
          {
            id: 'task-1',
            description: 'Test task',
            prompt: {
              template: 'Do something',
            },
          },
        ],
      };

      const resultWithTags = CreateTemplateRequestSchema.safeParse(requestWithTags);
      expect(resultWithTags.success).toBe(true);

      const requestWithCategory = {
        id: 'test-template-2',
        name: 'Test Template 2',
        description: 'A test template',
        category: 'meta',
        tasks: [
          {
            id: 'task-1',
            description: 'Test task',
            prompt: {
              template: 'Do something',
            },
          },
        ],
      };

      const resultWithCategory = CreateTemplateRequestSchema.safeParse(requestWithCategory);
      expect(resultWithCategory.success).toBe(true);
    });

    test('should reject without both tags and category', () => {
      const request = {
        id: 'test-template',
        name: 'Test Template',
        description: 'A test template',
        // Missing both tags and category
        tasks: [
          {
            id: 'task-1',
            description: 'Test task',
            prompt: {
              template: 'Do something',
            },
          },
        ],
      };

      const result = CreateTemplateRequestSchema.safeParse(request);

      expect(result.success).toBe(false);
    });

    test('should handle input_shapes and output_shapes', () => {
      const request = {
        id: 'test-template',
        name: 'Test Template',
        description: 'A test template',
        tags: ['test'],
        tasks: [
          {
            id: 'task-1',
            description: 'Test task',
            prompt: {
              template: 'Do something',
            },
          },
        ],
        input_shapes: ['goal', 'source_code'],
        output_shapes: ['patch', 'test_result'],
      };

      const result = CreateTemplateRequestSchema.safeParse(request);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.input_shapes).toEqual(['goal', 'source_code']);
        expect(result.data.output_shapes).toEqual(['patch', 'test_result']);
      }
    });
  });

  describe('Complex Nested Structures', () => {
    test('should handle fully nested template with all fields', () => {
      const template = {
        id: 'complex-template',
        name: 'Complex Template',
        description: 'A complex template with all fields',
        tags: ['test.integration', 'test.e2e'],
        tasks: [
          {
            id: 'task-1',
            description: 'First task',
            prompt: {
              template: 'Do first thing',
              maxTokens: 1000,
              compressionStrategy: 'gzip',
              variables: [{ name: 'input', type: 'string' }],
            },
            validation: {
              requiredFiles: ['src/test.ts', 'src/other.ts'],
              requiredPatterns: [
                { regex: 'export', file: 'src/test.ts' },
              ],
              forbiddenPatterns: [
                { regex: 'console.log' },
              ],
              commands: [
                { cmd: 'npm test', expectExit: 0 },
              ],
            },
            retry: {
              maxAttempts: 3,
              strategy: 'exponential',
            },
            dependencies: [],
          },
          {
            id: 'task-2',
            description: 'Second task',
            prompt: {
              template: 'Do second thing',
              maxTokens: 500,
            },
            dependencies: ['task-1'],
          },
        ],
        input_shapes: ['goal', 'source_code'],
        output_shapes: ['patch', 'documentation'],
        scope: 'org',
        public: false,
      };

      const result = CreateTemplateRequestSchema.safeParse(template);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tasks).toHaveLength(2);
        expect(result.data.tasks![0].validation?.requiredFiles).toHaveLength(2);
        expect(result.data.tasks![0].retry?.maxAttempts).toBe(3);
        expect(result.data.tasks![1].dependencies).toEqual(['task-1']);
      }
    });

    test('should handle array of templates', () => {
      const templates = [
        {
          id: 'template-1',
          name: 'Template 1',
          description: 'First template',
          tags: ['test'],
          tasks: [
            {
              id: 'task-1',
              description: 'Task 1',
              prompt: { template: 'Do 1' },
            },
          ],
        },
        {
          id: 'template-2',
          name: 'Template 2',
          description: 'Second template',
          tags: ['test'],
          tasks: [
            {
              id: 'task-2',
              description: 'Task 2',
              prompt: { template: 'Do 2' },
            },
          ],
        },
      ];

      templates.forEach((template) => {
        const result = CreateTemplateRequestSchema.safeParse(template);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('Error Messages', () => {
    test('should provide clear error for missing required field', () => {
      const template = {
        id: 'test-template',
        name: 'Test Template',
        // Missing description
        tags: ['test'],
        tasks: [
          {
            id: 'task-1',
            description: 'Test task',
            prompt: {
              template: 'Do something',
            },
          },
        ],
      };

      const result = CreateTemplateRequestSchema.safeParse(template);

      expect(result.success).toBe(false);
      if (!result.success) {
        const errorMessage = result.error.message;
        expect(errorMessage).toContain('description');
      }
    });

    test('should provide clear error for invalid task structure', () => {
      const template = {
        id: 'test-template',
        name: 'Test Template',
        description: 'A test template',
        tags: ['test'],
        tasks: [
          {
            // Missing id, description, prompt
          },
        ],
      };

      const result = CreateTemplateRequestSchema.safeParse(template);

      expect(result.success).toBe(false);
      if (!result.success) {
        const errorMessage = result.error.message;
        expect(errorMessage).toBeDefined();
      }
    });
  })
})
