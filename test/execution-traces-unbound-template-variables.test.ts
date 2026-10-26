/**
 * A TASK'S UNBOUND TEMPLATE VARIABLES SURVIVE THE TRACE WRITE.
 *
 * ias-executor records, per task, the plain {{name}} template tokens that had no run-variable
 * binding (`unboundTemplateVariables`). normalizePersistedTask keeps only the task keys it lists,
 * so an unlisted field never reached the trace store and the unbound count could not be observed.
 * The normalized task array is written whole into execution_trace_content.tasks, whose `tasks.*`
 * is a FLEXIBLE object (migrations 115 and 120), so the normalizer is the only filter on the path.
 *
 *   [MUST-FAIL] a task carrying unboundTemplateVariables keeps it as unbound_template_variables;
 *               a malformed value is dropped whole; the list and each name are bounded.
 *   [CONTROL]   a task without the field normalizes exactly as before, with no such key.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { normalizePersistedTask } from '../src/routes/execution-traces';

const baseTask = {
  task_id: 'task-a',
  description: 'render a goal',
  status: 'success',
  duration_ms: 42,
  tool_calls: null,
  input_impulse_ids: ['imp-in-1'],
  output_impulse_ids: ['imp-out-1'],
};

describe('normalizePersistedTask: unbound template variables', () => {
  test('[MUST-FAIL] a task carrying unboundTemplateVariables keeps it', () => {
    const out = normalizePersistedTask({ ...baseTask, unboundTemplateVariables: ['goal', 'target_file'] });
    expect(out.unbound_template_variables).toEqual(['goal', 'target_file']);
  });

  test('[MUST-FAIL] the snake_case spelling (a stored row re-normalized) is kept too', () => {
    const out = normalizePersistedTask({ ...baseTask, unbound_template_variables: ['goal'] });
    expect(out.unbound_template_variables).toEqual(['goal']);
  });

  test('[MUST-FAIL] an empty array is kept: it declares every token was bound', () => {
    const out = normalizePersistedTask({ ...baseTask, unboundTemplateVariables: [] });
    expect(out.unbound_template_variables).toEqual([]);
  });

  test('[MUST-FAIL] the list is capped at 50 and each name at 200 chars', () => {
    const many = Array.from({ length: 80 }, (_, i) => `v${i}`);
    const out = normalizePersistedTask({ ...baseTask, unboundTemplateVariables: ['x'.repeat(500), ...many] });
    expect(out.unbound_template_variables).toHaveLength(50);
    expect(out.unbound_template_variables![0]).toBe('x'.repeat(200));
    expect(out.unbound_template_variables![1]).toBe('v0');
    expect(out.unbound_template_variables![49]).toBe('v48');
  });

  test('a malformed value is dropped whole', () => {
    for (const bad of ['goal', 3, { goal: true }, ['goal', 7], [null], null]) {
      const out = normalizePersistedTask({ ...baseTask, unboundTemplateVariables: bad });
      expect('unbound_template_variables' in out).toBe(false);
    }
  });

  test('[CONTROL] a task without the field normalizes exactly as before', () => {
    const out = normalizePersistedTask({ ...baseTask });
    expect('unbound_template_variables' in out).toBe(false);
    expect(out).toEqual({
      task_id: 'task-a',
      description: 'render a goal',
      status: 'success',
      duration_ms: 42,
      tool_calls: null,
      input_impulse_ids: ['imp-in-1'],
      output_impulse_ids: ['imp-out-1'],
    });
  });

  test('the stored tasks.* column admits undeclared task keys (FLEXIBLE in its latest definition)', () => {
    const dir = new URL('../sql/migrations/', import.meta.url).pathname;
    const defs: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.surql')).sort()) {
      for (const line of readFileSync(dir + f, 'utf8').split('\n')) {
        if (/^\s*DEFINE FIELD\b.*\btasks(\.\*)?\s+ON\s+(TABLE\s+)?execution_trace_content\b/i.test(line)) defs.push(line);
      }
    }
    const lastStar = defs.filter((l) => /\btasks\.\*\s+ON/i.test(l)).pop();
    expect(lastStar).toBeDefined();
    expect(lastStar!).toMatch(/\bFLEXIBLE\b/);
  });
});
