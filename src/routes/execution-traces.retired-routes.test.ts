/**
 * /selection-outcomes and /calibration-summary are RETIRED, not repaired.
 *
 * Both shipped SurrealQL the engine cannot parse (`FROM thompson_selection_log AS sel`; `LEFT
 * JOIN activity_execution_traces`), so neither ever answered, and nothing reads them: no caller
 * in any repo, script, UI or activity template, and the only live requests were operator
 * probes. A route nothing reads cannot be observed failing. The selection-to-outcome reader
 * that is live is /selection-calibration (JOIN-free since 471febb); /decision-calibration
 * covers decision_outcome.
 *
 * The router must not register either path again; the two live siblings are the positive
 * control that this reads the real route table.
 */
import { describe, test, expect } from 'bun:test';

process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= 'http://127.0.0.1:8000';
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';

const app = (await import('./execution-traces')).default;

describe('retired selection observability routes', () => {
  test('selection-outcomes and calibration-summary are not registered; their live siblings are', () => {
    const gets = app.routes.filter((r) => r.method === 'GET').map((r) => r.path);
    expect(gets).toContain('/selection-calibration');
    expect(gets).toContain('/selection-events');
    expect(gets).not.toContain('/selection-outcomes');
    expect(gets).not.toContain('/calibration-summary');
  });
});
