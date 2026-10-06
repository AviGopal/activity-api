/**
 * A FAILED IMPULSE-RELEVANCE PENALTY WRITE IS VISIBLE, AND THE REPORTED COUNT IS WHAT LANDED (check-first).
 *
 * Core-loop bootstrap, credit from use (user ruling 2026-10-05).
 *
 * MEASURED (docs-session audit, node 1, 2026-10-05; re-read at bd7ff19): writeImpulseRelevancePenalty
 * fires the shaped impulseRelevancePenalty_write at the relevance sink and does not wait: no
 * Authorization header, `.catch(() => {})` swallows every error, and it returns uniqueIds.length
 * whatever happened. Live, 0 of 21,986 impulse_relevance_metrics rows have times_failed > 0 while
 * 1,388 rows were updated through other fields since 09-29, so the penalty path has never landed a
 * write and nothing said so. The sink answers {written: N} with the rows MATCHED (relevance-sink
 * applyPenalty), so a write that matched nothing is distinguishable — but only if someone reads it.
 *
 * Pinned against a fake sink (Bun.serve on an ephemeral port; the endpoint is read at use):
 *   - the penalty is sent with the caller's API key when one is configured;
 *   - a sink answer of {written: 0} is logged (WARN) and reported as 0, not as the request length;
 *   - an unreachable sink is logged in the catch and reported as 0;
 *   - CONTROL: a sink that writes N rows reports N and logs nothing.
 */
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

import { afterEach, describe, expect, test } from 'bun:test';

const { writeImpulseRelevancePenalty } = await import('./posterior-update');
const { logger } = await import('../utils/logger');

type Seen = { auth: string | null; body: any };
let server: ReturnType<typeof Bun.serve> | null = null;
const warns: string[] = [];
const origWarn = logger.warn.bind(logger);
(logger as any).warn = (msg: string, ...rest: unknown[]) => { warns.push(String(msg)); return (origWarn as any)(msg, ...rest); };

afterEach(() => { server?.stop(true); server = null; warns.length = 0; delete process.env.RELEVANCE_SINK_ENDPOINT; delete process.env.METABOB_API_KEY; });

function fakeSink(answer: (seen: Seen) => Response): Seen[] {
  const seen: Seen[] = [];
  server = Bun.serve({ port: 0, async fetch(req) { const s = { auth: req.headers.get('authorization'), body: await req.json() }; seen.push(s); return answer(s); } });
  process.env.RELEVANCE_SINK_ENDPOINT = `http://127.0.0.1:${server.port}`;
  return seen;
}

const TRACE = { activity_id: 'a', success: false, tasks: [{ input_impulse_ids: ['imp-1', 'imp-2'] }, { input_impulse_ids: ['imp-2'] }] } as never;

describe('MUST-FAIL — the penalty write is observable', () => {
  test('the penalty carries the configured API key', async () => {
    process.env.METABOB_API_KEY = 'test-key-not-secret';
    const seen = fakeSink(() => Response.json({ success: true, body: { written: 2 } }));
    await writeImpulseRelevancePenalty(TRACE, {} as never, 'org-1');
    expect(seen.length).toBe(1);
    expect(seen[0]!.auth).toBe('ApiKey test-key-not-secret');
    expect(seen[0]!.body.impulse.pointer).toEqual({ type: 'impulseRelevancePenalty_write', impulse_ids: ['imp-1', 'imp-2'], org_id: 'org-1' });
  });

  test('a sink that matched nothing is reported as 0 written and logged', async () => {
    fakeSink(() => Response.json({ success: true, body: { written: 0 } }));
    const n = await writeImpulseRelevancePenalty(TRACE, {} as never, 'org-1');
    expect(n).toBe(0);
    expect(warns.some((w) => /impulse-relevance penalty/i.test(w))).toBe(true);
  });

  test('a sink error status is reported as 0 written and logged', async () => {
    fakeSink(() => Response.json({ success: false, error: 'db error' }, { status: 502 }));
    expect(await writeImpulseRelevancePenalty(TRACE, {} as never, 'org-1')).toBe(0);
    expect(warns.some((w) => /impulse-relevance penalty/i.test(w))).toBe(true);
  });

  test('an unreachable sink is logged in the catch and reported as 0', async () => {
    process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';
    expect(await writeImpulseRelevancePenalty(TRACE, {} as never, 'org-1')).toBe(0);
    expect(warns.some((w) => /impulse-relevance penalty/i.test(w))).toBe(true);
  });
});

describe('CONTROL', () => {
  test('a sink that writes N rows reports N and logs nothing', async () => {
    fakeSink(() => Response.json({ success: true, body: { written: 2 } }));
    expect(await writeImpulseRelevancePenalty(TRACE, {} as never, 'org-1')).toBe(2);
    expect(warns.filter((w) => /impulse-relevance penalty/i.test(w))).toEqual([]);
  });

  test('a trace with no input impulses sends nothing', async () => {
    const seen = fakeSink(() => Response.json({ success: true, body: { written: 0 } }));
    expect(await writeImpulseRelevancePenalty({ activity_id: 'a', success: false, tasks: [] } as never, {} as never, 'org-1')).toBe(0);
    expect(seen).toEqual([]);
  });
});
