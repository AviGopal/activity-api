/**
 * Phase A: zod schemas accept optional `account_id` alongside `org_id`.
 *
 * OpenSpec change: activity-api-account-id-migration-2026-04-28
 *
 * Schemas mirror the SurrealDB additive migration 095. account_id is
 * optional during Phase A so legacy callers (no account_id) still parse;
 * Phase B handlers populate it from JWT $token.account_id; Phase D requires it.
 */

import { describe, expect, test } from 'bun:test';
import {
  ActivityTemplateSchema,
  CreateTemplateRequestSchema,
  ImpulseCreateRequestSchema,
  ShapeScoreUpdateRequestSchema,
  StoreExecutionTraceRequestSchema,
} from './schemas';

describe('Phase A: account_id is optional on multi-tenant schemas', () => {
  test('ActivityTemplateSchema accepts account_id alongside org_id', () => {
    const parsed = ActivityTemplateSchema.parse({
      id: 'tmpl-1',
      name: 'test',
      description: 'desc',
      tags: ['feature.test'],
      scope: 'global',
      org_id: 'org-1',
      account_id: 'acc-1',
      account_id_version: 1,
      project_id: null,
      output_shapes: ['something'],
      created_at: '2026-04-28T00:00:00Z',
      updated_at: '2026-04-28T00:00:00Z',
    });
    expect(parsed.account_id).toBe('acc-1');
    expect(parsed.account_id_version).toBe(1);
    expect(parsed.org_id).toBe('org-1');
  });

  test('ActivityTemplateSchema parses without account_id (legacy callers)', () => {
    const parsed = ActivityTemplateSchema.parse({
      id: 'tmpl-1',
      name: 'test',
      description: 'desc',
      tags: ['feature.test'],
      scope: 'global',
      org_id: 'org-1',
      project_id: null,
      output_shapes: ['something'],
      created_at: '2026-04-28T00:00:00Z',
      updated_at: '2026-04-28T00:00:00Z',
    });
    expect(parsed.account_id).toBeUndefined();
  });

  test('CreateTemplateRequestSchema accepts account_id', () => {
    const parsed = CreateTemplateRequestSchema.parse({
      id: 'tmpl-1',
      name: 'test',
      description: 'desc',
      tags: ['feature.test'],
      tasks: [{
        id: 't0',
        description: 'task 0',
        prompt: { template: 'noop' },
      }],
      org_id: 'org-1',
      account_id: 'acc-1',
    });
    expect(parsed.account_id).toBe('acc-1');
  });

  test('ImpulseCreateRequestSchema accepts account_id', () => {
    const parsed = ImpulseCreateRequestSchema.parse({
      impulse_id: 'imp-1',
      impulse_data: {
        id: 'imp-1',
        type: 'memo',
        pointer: { type: 'memo', content: 'hello' },
        budget: 100,
      },
      org_id: 'org-1',
      account_id: 'acc-1',
    });
    expect(parsed.account_id).toBe('acc-1');
  });

  test('ShapeScoreUpdateRequestSchema accepts account_id', () => {
    const parsed = ShapeScoreUpdateRequestSchema.parse({
      activity_id: 'act-1',
      shapes: ['shape-a'],
      success: true,
      org_id: 'org-1',
      account_id: 'acc-1',
    });
    expect(parsed.account_id).toBe('acc-1');
  });

  test('StoreExecutionTraceRequestSchema accepts account_id', () => {
    const parsed = StoreExecutionTraceRequestSchema.parse({
      execution_id: 'exec-1',
      template_id: 'tmpl-1',
      status: 'success',
      duration_ms: 100,
      cost_usd: 0.01,
      execution_trace: {
        tasks: [],
        impulsesCreated: [],
        filesModified: [],
      },
      account_id: 'acc-1',
    });
    expect(parsed.account_id).toBe('acc-1');
  });

  test('StoreExecutionTraceRequestSchema parses without account_id (legacy)', () => {
    const parsed = StoreExecutionTraceRequestSchema.parse({
      execution_id: 'exec-1',
      template_id: 'tmpl-1',
      status: 'success',
      duration_ms: 100,
      cost_usd: 0.01,
      execution_trace: {
        tasks: [],
        impulsesCreated: [],
        filesModified: [],
      },
    });
    expect(parsed.account_id).toBeUndefined();
  });
});
