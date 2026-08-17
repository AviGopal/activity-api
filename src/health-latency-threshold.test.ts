process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

import { describe, it, expect } from 'bun:test';

/**
 * /health MUST GRADE THE LATENCY IT MEASURES.
 *
 * From the 2026-08-13 self-development wiring audit, defect 6, still live on 2026-08-17:
 * the SurrealDB probe recorded `latency_ms` and then set `status: 'healthy'` on query success
 * alone. The verdict was a boolean sitting next to a number it ignored, so the probe read
 * `healthy` at 16.5 SECONDS and only flipped when the query timed out entirely.
 *
 * That is the same shape as this session's other findings — a measurement taken and not read —
 * and it is the most consequential place for it, because an unconditional /health disables
 * every watchdog above it. A watchdog cannot act on a signal that never changes.
 *
 * The fix reports `degraded` rather than failing the endpoint. A 503 would let watchdogs
 * restart activity-api under exactly the load that made it slow, converting a degradation into
 * an outage. Making the condition visible is the change that cannot make things worse.
 */

const SRC = new URL('./index.ts', import.meta.url);

describe('health — the recorded latency drives the verdict', () => {
  it('THE REGRESSION: the surrealdb status is not a bare literal', async () => {
    const src = await Bun.file(SRC).text();
    const idx = src.indexOf("healthStatus.checks.surrealdb = {");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 300);
    // Before the fix this was `status: 'healthy',` with latency_ms recorded beside it.
    expect(block).toMatch(/status:\s*surrealLatency\s*>\s*SURREAL_DEGRADED_MS/);
    expect(block).toContain("'degraded'");
  });

  it('the threshold is a named constant, not a magic number at the site', async () => {
    const src = await Bun.file(SRC).text();
    expect(src).toMatch(/const SURREAL_DEGRADED_MS = [\d_]+;/);
  });

  it('the threshold is meaningfully tighter than a timeout', async () => {
    const src = await Bun.file(SRC).text();
    const m = src.match(/const SURREAL_DEGRADED_MS = ([\d_]+);/);
    expect(m).not.toBeNull();
    const ms = Number(m![1]!.replace(/_/g, ''));
    // A local query is single-digit ms. Anything near the old behaviour (only failing at full
    // timeout) would restore the defect while looking like a fix.
    expect(ms).toBeGreaterThan(100);
    expect(ms).toBeLessThan(10_000);
  });

  it('degradation does NOT flip the endpoint to unhealthy', async () => {
    const src = await Bun.file(SRC).text();
    // `allHealthy` must not be cleared on the degraded path — restart-under-load is the
    // failure this deliberately avoids. Scope to the SUCCESS assignment only: the catch block
    // below it clears allHealthy for a query that actually threw, which is correct, and a
    // window wide enough to include it would fail on the right behaviour.
    const idx = src.indexOf("healthStatus.checks.surrealdb = {");
    const success = src.slice(idx, src.indexOf('} catch', idx));
    expect(success).toContain("'degraded'");
    expect(success).not.toContain('allHealthy = false');
  });
});
