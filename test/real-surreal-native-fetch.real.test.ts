// A REAL ENGINE STARTS AND ANSWERS WHILE globalThis.fetch IS A MOCK (2026-10-17).
// A test file left its fetch mock installed past its own end; the next real-engine file's health loop polled the mock
// and its beforeAll failed ("surreal did not answer /health within 8 s"): an unnamed load failure in pull-sync's gate.
// MUST-FAIL on the parent (53abcfa): the harness's health loop, raw SQL and SDK (http:// engine) all call globalThis.fetch.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startRealSurreal, type RealSurreal } from './support/real-surreal';

const REAL_FETCH = globalThis.fetch;
let mockCalls = 0;
const leakedMock = (async () => { mockCalls += 1; throw new Error('a leaked fetch mock'); }) as unknown as typeof fetch;
let rs: RealSurreal | null = null;
let startError: unknown = null;
let held: any = null;

describe('the real-engine harness under a leaked fetch mock', () => {
  beforeAll(async () => {
    globalThis.fetch = leakedMock;
    try {
      rs = await startRealSurreal();
      held = await rs.connectModuleClient();
    } catch (e) { startError = e; }
  }, 60_000);

  afterAll(async () => {
    try { await rs?.stop(); } finally { globalThis.fetch = REAL_FETCH; }
  });

  it('[MUST-FAIL] the engine starts and the schema applies with the mock installed', () => {
    expect(startError).toBeNull();
    expect(rs).not.toBeNull();
  });

  it('[MUST-FAIL] raw SQL and an SDK query through the module client reach the engine', async () => {
    const res = await rs!.sql('RETURN 41 + 1;');
    expect(res[0].result).toBe(42);
    const before = rs!.calls.length;
    await held.query('RETURN 1;');
    expect(rs!.calls.length).toBe(before + 1);
  });

  it("[CONTROL] the harness never replaced the caller's fetch, and never called the mock", () => {
    expect(globalThis.fetch).toBe(leakedMock);
    expect(mockCalls).toBe(0);
  });
});
