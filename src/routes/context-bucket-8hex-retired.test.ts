// The 8-hex context-bucket pair on context_thompson_scores is RETIRED (2026-10-16, user decision). Its recommend reader
// keyed on computeContextBucket, which the credit path never writes, and matched in ~1% of lookups; its trace-ingest
// re-derive writer credited exit status and caused most write conflicts on the table (1,959 in 6 h on node 1). The
// conditional posterior is the v1 state-space signature (signature_version = 1), written by credit and read by recommend.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

const ingest = readFileSync(new URL('./execution-traces.ts', import.meta.url), 'latin1');
const recommend = readFileSync(new URL('./activities.ts', import.meta.url), 'utf8');

describe('[MUST-FAIL] the 8-hex context-bucket pair is retired', () => {
  test('trace ingest no longer re-derives or writes an 8-hex context bucket', () => {
    expect(ingest).not.toContain('computeContextBucket(taskDesc');
    expect(ingest).not.toContain("re-derive update failed");
    expect(ingest).not.toMatch(/\/\^\[0-9a-f\]\{8\}\$\//);
  });
  test('recommend no longer looks up an 8-hex bucket', () => {
    expect(recommend).not.toContain("bucket_subject: 'task_semantics_8hex'");
    expect(recommend).not.toContain('computeContextBucket(task_description');
  });
  test('[CONTROL] the v1 signature-keyed conditional lookup is still there', () => {
    expect(recommend).toContain('signature_version = 1 AND context_bucket = $sig');
  });
});
