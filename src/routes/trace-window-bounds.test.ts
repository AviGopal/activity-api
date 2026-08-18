import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * A GUARD THAT BOUNDS BY CALENDAR ERODES AS THE TABLE GROWS, AND KEEPS LOOKING LIKE A GUARD.
 *
 * The trace-list default window was written as "last 30 days ... instead of scanning all 25k+
 * historical rows (OOMKill prevention)". At 25k rows spanning more than a month, that bounded
 * the scan exactly as intended.
 *
 * Measured on the hub 2026-08-18: 473,176 rows spanning TWENTY-FIVE DAYS. Oldest row
 * 2026-07-24; the default asked for >= 2026-07-19. The predicate excluded ZERO rows. Every
 * request sorted the whole view, because SurrealDB 2.3.3 answers `ORDER BY ... LIMIT n` with a
 * MemoryOrderedLimit collector — all matching rows are materialised into a sort BEFORE the
 * LIMIT applies. ~40 concurrent sorts pinned all 8 DB workers at ~96% with 0.0% iowait and
 * took the fleet to 30s query latency, which is where the substrate's own learning writes
 * started timing out.
 *
 * ★ THE FAILURE MODE IS THE POINT. The guard did not break, throw, or log. It crossed a
 *   threshold — somewhere between 111k and 473k rows — after which `now - 30d` was older than
 *   the oldest row, and from then on it was a no-op that still read as protection. The
 *   comment above it went on asserting a bound it no longer provided. Nothing in the system
 *   could tell "filtered to a window" from "filtered to everything".
 *
 * This test pins that the default window is expressed in HOURS and stays small. It cannot
 * detect the erosion itself — that needs the row count and time span, which live in the
 * database — so it guards the one property that makes erosion unlikely: a window short enough
 * that no plausible retention horizon outruns it.
 */

const SRC = new URL('./execution-traces.ts', import.meta.url).pathname;
const source = () => readFileSync(SRC, 'utf8');

describe('trace-list default window', () => {
  it('guards the instrument: the default branch is findable', () => {
    const s = source();
    expect(s).toContain('TRACE_LIST_DEFAULT_WINDOW_HOURS');
    expect(s).toContain('executed_at >= type::datetime($start_date)');
  });

  it('THE REGRESSION: the window is hours, not a 30-day calendar span', () => {
    const s = source();
    // The old form. A month-scale default cannot bound a table whose whole history is 25 days.
    expect(s).not.toMatch(/30 \* 24 \* 60 \* 60 \* 1000/);
    expect(s).toMatch(/hours \* 60 \* 60 \* 1000/);
  });

  it('the default is small enough that retention outruns it', () => {
    const s = source();
    const m = s.match(/TRACE_LIST_DEFAULT_WINDOW_HOURS \?\? '(\d+)'/);
    expect(m).not.toBeNull();
    const hours = Number(m![1]);
    // Must stay well inside any plausible retention horizon. If the default ever exceeds a
    // few days it is back to bounding the calendar rather than the row set.
    expect(hours).toBeGreaterThanOrEqual(1);
    expect(hours).toBeLessThanOrEqual(72);
  });

  it('a non-numeric or non-positive override falls back rather than disabling the bound', () => {
    const s = source();
    // `TRACE_LIST_DEFAULT_WINDOW_HOURS=0` or `=abc` must not produce an unbounded window —
    // that would reintroduce the exact outage through configuration instead of growth.
    expect(s).toMatch(/Number\.isFinite\(windowHours\) && windowHours > 0 \? windowHours : 24/);
  });

  it('an EXPLICIT start_date still works — history is available on request', () => {
    const s = source();
    // The fix must not make old data unreachable; it makes reaching it deliberate.
    expect(s).toMatch(/if \(startDate\) \{[\s\S]{0,200}params\.start_date = startDate;/);
  });

  it('NEGATIVE CONTROL: the hours check can reject a calendar-scale default', () => {
    // Prove the assertion above would catch a regression to a month.
    const monthLike = 24 * 30;
    expect(monthLike <= 72).toBe(false);
    expect(24 <= 72).toBe(true);
  });
});
