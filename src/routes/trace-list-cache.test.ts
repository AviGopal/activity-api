import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * A CACHE ON A MULTI-TENANT PATH IS A DATA LEAK UNLESS THE KEY CARRIES THE TENANT.
 *
 * WHY THE CACHE EXISTS. Measured on the hub 2026-08-18: GET /v2/activities/execution-traces
 * received 50 requests in 3 minutes from a browser dashboard whose global 5s refetchInterval
 * reached it. SurrealDB 2.3.3 answers each by materialising all 473,176 rows of
 * v_paradigm_execution_traces into a sort BEFORE applying the LIMIT, so ~40 concurrent sorts
 * pinned all 8 DB workers at ~96% with 0.0% iowait and took the fleet to 30s query latency —
 * including the substrate's own learning writes, which timed out and were lost.
 *
 * The client fix (dashboard 3f5e35e) is correct and cannot help a browser already running the
 * old bundle, so the server must be able to defend itself. The property that was missing is
 * that cost stopped scaling with the number of open tabs.
 *
 * WHY THIS TEST IS ABOUT THE KEY AND NOT THE SPEEDUP. The JWT path calls `queryWithAuth`,
 * where row visibility is enforced by the DATABASE against the caller's token. Two different
 * orgs can therefore issue a byte-identical query with byte-identical params and each be
 * entitled to different rows. A cache keyed on the SQL alone would serve one org's page to
 * another — turning a performance fix into a tenant-isolation breach, which is far worse than
 * the slow page it set out to fix.
 *
 * CLAUDE.md: "Tenant isolation is enforced in the database via PERMISSIONS on $token.org_id,
 * not in application code." A cache sits in application code and in front of that enforcement,
 * so it is exactly the place where the guarantee can be lost without the database noticing.
 */

const SRC = new URL('./execution-traces.ts', import.meta.url).pathname;

function source(): string {
  return readFileSync(SRC, 'utf8');
}

describe('trace-list cache — tenant isolation', () => {
  it('guards the instrument: the file and the cache are present', () => {
    const s = source();
    expect(s.length).toBeGreaterThan(5000);
    expect(s).toContain('traceListCache');
  });

  it('THE INVARIANT: the cache key begins with the org identity', () => {
    const s = source();
    // org-first so a missing identity cannot collide with a real one by prefix.
    expect(s).toMatch(/const cacheKey = effectiveOrgId\s*\?\s*`\$\{effectiveOrgId\}\|/);
  });

  it('the key also separates the two auth paths', () => {
    // JWT and session paths build different WHERE clauses and are enforced differently;
    // sharing an entry between them would serve an RBAC-filtered page to a caller whose
    // filtering happens in application code, or vice versa.
    expect(source()).toMatch(/useJwtAuth \? 'jwt' : 'session'/);
  });

  it('NO ORG IDENTITY MEANS NO CACHING — it does not fall back to a shared key', () => {
    const s = source();
    // `effectiveOrgId ? ... : null` and every use guarded by `if (cacheKey)`. Guessing a key
    // for an unidentified caller is the leak; refusing to cache is the safe default.
    expect(s).toMatch(/:\s*null;/);
    expect(s).toMatch(/if \(cacheKey\) \{[\s\S]{0,200}traceListCache\.get\(cacheKey\)/);
    expect(s).toMatch(/if \(cacheKey\) \{[\s\S]{0,200}traceListCache\.set\(cacheKey/);
  });

  it('only a SUCCESSFUL response is cached', () => {
    const s = source();
    // The set must sit after the response object is built and before `return c.json(response)`,
    // never in the catch. Memoising an error turns one bad second into a whole TTL of them.
    const setIdx = s.indexOf('traceListCache.set(cacheKey');
    const catchIdx = s.indexOf('} catch (error) {', setIdx);
    expect(setIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(setIdx);
  });

  it('the cache is BOUNDED — an unbounded request-keyed map is a slow OOM', () => {
    const s = source();
    expect(s).toMatch(/const TRACE_LIST_CACHE_MAX = \d+/);
    expect(s).toMatch(/traceListCache\.size > TRACE_LIST_CACHE_MAX/);
    // Expired entries pruned before evicting live ones.
    expect(s).toMatch(/if \(v\.expiresAt <= now\) traceListCache\.delete\(k\)/);
  });

  it('the TTL is short enough to stay honest about staleness', () => {
    const s = source();
    const m = s.match(/const TRACE_LIST_CACHE_TTL_MS = ([\d_]+)/);
    expect(m).not.toBeNull();
    const ttl = Number((m![1] as string).replace(/_/g, ''));
    // Long enough to collapse a 5s poll, short enough that a trace list is never meaningfully
    // out of date. A cache that hides minutes of history on an observability view would be
    // solving the load problem by breaking the feature.
    expect(ttl).toBeGreaterThanOrEqual(5_000);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });

  it('THE MEASURED FAILURE: a per-request timestamp must not poison the key', () => {
    const s = source();
    // The first version keyed on JSON.stringify(params) and hit ZERO times in three minutes
    // against 60 queries, on a process that definitely had the code. `start_date` defaults to
    // now-30d computed per request to the millisecond — 73 distinct values in 4 minutes — so
    // every poll minted a fresh key and the cache was pure overhead.
    expect(s).toContain('const keyParams =');
    expect(s).toMatch(/Math\.floor\(t \/ TRACE_LIST_CACHE_TTL_MS\) \* TRACE_LIST_CACHE_TTL_MS/);
    // And the key must be built from the bucketed copy, not the raw params.
    expect(s).toMatch(/JSON\.stringify\(keyParams\)/);
    expect(s).not.toMatch(/\|\$\{JSON\.stringify\(params\)\}`/);
  });

  it('the QUERY still receives the exact timestamp — bucketing is key-only', () => {
    // If the quantised value ever reached `params`, the cache would silently change which
    // rows the query returns. Only the key copy is rounded.
    const s = source();
    const i = s.indexOf('const keyParams =');
    const block = s.slice(i, i + 600);
    expect(block).toMatch(/keyParams\.start_date =/);
    expect(block).not.toMatch(/[^y]params\.start_date =/);
  });

  it('BUCKETING PRESERVES A REAL RANGE DIFFERENCE', () => {
    // A user picking a different window must not share a cache entry. 10s granularity is far
    // finer than any range a human selects, so this only ever collapses machine-generated
    // near-identical timestamps.
    const TTL = 10_000;
    const bucket = (iso: string) => Math.floor(Date.parse(iso) / TTL) * TTL;
    // two polls ~5s apart -> same or adjacent bucket, and identical within a bucket
    expect(bucket('2026-07-19T02:43:30.542Z')).toBe(bucket('2026-07-19T02:43:35.152Z'));
    // a genuinely different range stays distinct
    expect(bucket('2026-07-19T02:43:30.542Z')).not.toBe(bucket('2026-07-18T02:43:30.542Z'));
  });

  it('NEGATIVE CONTROL: the key regex rejects a tenant-less key', () => {
    // Before trusting the assertion above, prove it would catch the dangerous form.
    const dangerous = 'const cacheKey = `${query}|${JSON.stringify(params)}`;';
    expect(/const cacheKey = effectiveOrgId\s*\?\s*`\$\{effectiveOrgId\}\|/.test(dangerous)).toBe(false);
  });
});
