#!/usr/bin/env bun

/**
 * Bootstrap Core Shape Definitions
 *
 * Registers the 8 foundational shapes that all vessels can use for communication.
 * These are registered as global public shapes (org_id = null, public = true).
 *
 * SPEC: openspec/changes/vessel-integration-standardization/specs/shape-registry/spec.md
 */

import { surrealDB } from '../src/db/surreal';
import { logger } from '../src/utils/logger';

interface ShapeDefinition {
  name: string;
  version: string;
  schema: object;
  description: string;
  example: object;
  tags: string[];
  public: boolean;
  org_id: null;
  deprecated: boolean;
  breaking_changes: string[];
  changelog: string;
  created_by: string;
}

const coreShapes: ShapeDefinition[] = [
  {
    name: 'memo',
    version: '1.0.0',
    schema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: {
          type: 'string',
          description: 'Embedded text content',
        },
      },
    },
    description: 'Embedded text content for simple context injection',
    example: {
      content: 'The user wants to implement feature X using pattern Y.',
    },
    tags: ['basic', 'text'],
    public: true,
    org_id: null,
    deprecated: false,
    breaking_changes: [],
    changelog: 'Initial release - basic text memo',
    created_by: 'system',
  },

  {
    name: 'file',
    version: '1.0.0',
    schema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'File system path (absolute or relative)',
        },
        offset: {
          type: 'number',
          description: 'Starting line number (1-indexed)',
        },
        limit: {
          type: 'number',
          description: 'Number of lines to read',
        },
      },
    },
    description: 'File system reference with optional line range',
    example: {
      path: 'src/index.ts',
      offset: 10,
      limit: 50,
    },
    tags: ['filesystem', 'basic'],
    public: true,
    org_id: null,
    deprecated: false,
    breaking_changes: [],
    changelog: 'Initial release - file reference with range support',
    created_by: 'system',
  },

  {
    name: 'activityExecutionTrace',
    version: '1.0.0',
    schema: {
      type: 'object',
      required: ['execution_id', 'activity_id', 'status'],
      properties: {
        execution_id: { type: 'string' },
        activity_id: { type: 'string' },
        status: {
          type: 'string',
          enum: ['success', 'failure', 'partial'],
        },
        duration_ms: { type: 'number' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              task_id: { type: 'string' },
              status: { type: 'string' },
              tool_calls: { type: 'array' },
            },
          },
        },
        input_state: { type: 'object' },
        output_state: { type: 'object' },
      },
    },
    description: 'Full execution trace with state transitions and tool calls',
    example: {
      execution_id: 'exec_01HZYX9W3KQZ8YV0GCDPQR5T2F',
      activity_id: 'debug_failed_test',
      status: 'success',
      duration_ms: 4523,
      tasks: [
        {
          task_id: 'task_1',
          status: 'success',
          tool_calls: ['bash', 'read', 'edit'],
        },
      ],
      input_state: { files: ['test.ts'] },
      output_state: { files_modified: ['test.ts'] },
    },
    tags: ['learning', 'trace'],
    public: true,
    org_id: null,
    deprecated: false,
    breaking_changes: [],
    changelog: 'Initial release - execution trace format',
    created_by: 'system',
  },

  {
    name: 'activityTemplate',
    version: '1.0.0',
    schema: {
      type: 'object',
      required: ['variant_id', 'activity_id', 'task_steps'],
      properties: {
        variant_id: { type: 'string' },
        activity_id: { type: 'string' },
        variant_name: { type: 'string' },
        description: { type: 'string' },
        task_steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              prompt: { type: 'object' },
            },
          },
        },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    description: 'Activity template structure and metadata',
    example: {
      variant_id: 'debug_v1',
      activity_id: 'debug',
      variant_name: 'Debug with Git Bisect',
      description: 'Debug failing tests using git bisect',
      task_steps: [
        {
          id: 'task_1',
          description: 'Run test suite',
          prompt: { template: 'Run the test suite and capture output' },
        },
      ],
      tags: ['debugging'],
    },
    tags: ['template', 'activity'],
    public: true,
    org_id: null,
    deprecated: false,
    breaking_changes: [],
    changelog: 'Initial release - activity template format',
    created_by: 'system',
  },

  {
    name: 'activityMetrics',
    version: '1.0.0',
    schema: {
      type: 'object',
      required: ['activity_id', 'success_rate'],
      properties: {
        activity_id: { type: 'string' },
        success_rate: { type: 'number', minimum: 0, maximum: 1 },
        total_executions: { type: 'number' },
        avg_duration_ms: { type: 'number' },
        avg_cost_usd: { type: 'number' },
        last_executed_at: { type: 'string', format: 'date-time' },
      },
    },
    description: 'Performance metrics for Thompson Sampling',
    example: {
      activity_id: 'debug_v1',
      success_rate: 0.85,
      total_executions: 42,
      avg_duration_ms: 3421,
      avg_cost_usd: 0.0123,
      last_executed_at: '2026-04-10T14:30:00Z',
    },
    tags: ['metrics', 'learning'],
    public: true,
    org_id: null,
    deprecated: false,
    breaking_changes: [],
    changelog: 'Initial release - activity metrics',
    created_by: 'system',
  },

  {
    name: 'error_log',
    version: '1.0.0',
    schema: {
      type: 'object',
      required: ['message', 'timestamp'],
      properties: {
        message: { type: 'string' },
        timestamp: { type: 'string', format: 'date-time' },
        level: {
          type: 'string',
          enum: ['error', 'warning', 'info', 'debug'],
        },
        source: { type: 'string' },
        stack_trace: { type: 'string' },
        context: { type: 'object' },
      },
    },
    description: 'Structured error log entry',
    example: {
      message: 'Failed to connect to database',
      timestamp: '2026-04-10T14:30:00Z',
      level: 'error',
      source: 'db/surreal.ts:42',
      stack_trace: 'Error: Connection timeout\n  at connect (db/surreal.ts:42)',
      context: { retry_count: 3 },
    },
    tags: ['logging', 'debugging'],
    public: true,
    org_id: null,
    deprecated: false,
    breaking_changes: [],
    changelog: 'Initial release - error logging format',
    created_by: 'system',
  },

  {
    name: 'file_diff',
    version: '1.0.0',
    schema: {
      type: 'object',
      required: ['old_path', 'new_path', 'hunks'],
      properties: {
        old_path: { type: 'string' },
        new_path: { type: 'string' },
        hunks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['old_start', 'old_lines', 'new_start', 'new_lines', 'content'],
            properties: {
              old_start: { type: 'number' },
              old_lines: { type: 'number' },
              new_start: { type: 'number' },
              new_lines: { type: 'number' },
              content: { type: 'string' },
            },
          },
        },
      },
    },
    description: 'Unified diff format for file changes',
    example: {
      old_path: 'src/index.ts',
      new_path: 'src/index.ts',
      hunks: [
        {
          old_start: 10,
          old_lines: 3,
          new_start: 10,
          new_lines: 5,
          content: '@@ -10,3 +10,5 @@\n-old line\n+new line\n+another line',
        },
      ],
    },
    tags: ['analysis', 'git', 'code'],
    public: true,
    org_id: null,
    deprecated: false,
    breaking_changes: [],
    changelog: 'Initial release - unified diff format',
    created_by: 'system',
  },

  {
    name: 'code_review_comment',
    version: '1.0.0',
    schema: {
      type: 'object',
      required: ['file_path', 'line', 'message'],
      properties: {
        file_path: { type: 'string' },
        line: { type: 'number' },
        message: { type: 'string' },
        severity: {
          type: 'string',
          enum: ['error', 'warning', 'suggestion', 'info'],
        },
        suggested_fix: { type: 'string' },
        category: { type: 'string' },
      },
    },
    description: 'Code review feedback structure',
    example: {
      file_path: 'src/auth.ts',
      line: 42,
      message: 'Use parameterized query to prevent SQL injection',
      severity: 'error',
      suggested_fix: 'Replace string concatenation with prepared statement',
      category: 'security',
    },
    tags: ['review', 'code', 'quality'],
    public: true,
    org_id: null,
    deprecated: false,
    breaking_changes: [],
    changelog: 'Initial release - code review comment format',
    created_by: 'system',
  },
];

async function bootstrapShapes() {
  logger.info('Starting shape bootstrap', { count: coreShapes.length });

  for (const shape of coreShapes) {
    try {
      // Check if shape already exists
      const existingQuery = `
        SELECT id FROM shape_definition
        WHERE name = $name AND version = $version
        LIMIT 1;
      `;
      const existing = await surrealDB.query(existingQuery, {
        name: shape.name,
        version: shape.version,
      });

      if (existing[0]?.length > 0) {
        logger.info('Shape already exists, skipping', {
          name: shape.name,
          version: shape.version,
        });
        continue;
      }

      // Create shape
      const createQuery = `
        CREATE shape_definition CONTENT {
          name: $name,
          version: $version,
          schema: $schema,
          description: $description,
          example: $example,
          tags: $tags,
          public: $public,
          org_id: $orgId,
          deprecated: $deprecated,
          breaking_changes: $breaking_changes,
          changelog: $changelog,
          created_at: time::now(),
          created_by: $created_by
        };
      `;

      await surrealDB.query(createQuery, {
        name: shape.name,
        version: shape.version,
        schema: shape.schema,
        description: shape.description,
        example: shape.example,
        tags: shape.tags,
        public: shape.public,
        orgId: shape.org_id,
        deprecated: shape.deprecated,
        breaking_changes: shape.breaking_changes,
        changelog: shape.changelog,
        created_by: shape.created_by,
      });

      logger.info('Shape bootstrapped', {
        name: shape.name,
        version: shape.version,
      });
    } catch (error: any) {
      logger.error('Failed to bootstrap shape', {
        name: shape.name,
        version: shape.version,
        error: error.message,
      });
    }
  }

  logger.info('Shape bootstrap complete');
  process.exit(0);
}

bootstrapShapes();
