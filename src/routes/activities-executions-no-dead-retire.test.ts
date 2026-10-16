// POST /v2/activities/executions no longer fires checkAndRetireTemplate: that function could never complete
// (variant-creator.ts 2026-08-16) and, once composes began posting here, its `ORDER BY created_at` SELECT failed on every
// post (56 "Missing order idiom" errors in 6 h on node 1). Retirement runs at trace ingest (checkAndRetireByPosterior).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

const src = readFileSync(new URL('./activities.ts', import.meta.url), 'utf8');
describe('[MUST-FAIL] the executions route does not call the dead retire check', () => {
  test('activities.ts never calls checkAndRetireTemplate(', () => { expect(src).not.toContain('checkAndRetireTemplate('); });
  test('[CONTROL] the posterior retire is still wired at trace ingest', () => {
    expect(readFileSync(new URL('./execution-traces.ts', import.meta.url), 'utf8')).toContain('checkAndRetireByPosterior(');
  });
});
