// Pins TimestampSchema's Date normalization (task #9).
//
// THE FAILURE THIS EXISTS FOR: the SurrealDB driver hands back a real `Date`.
// It failed the string branch, matched the object branch, and a Date has no own
// enumerable keys — so zod returned `{}` and every timestamp JSON-serialized as
// an empty object. Measured on the live hub: created_at, updated_at and
// last_executed_at were `{}` on **4421/4421** goal_execution_paths rows, zero
// strings. The values were stored correctly the whole time; the response parse
// destroyed them on read.
//
// Not cosmetic: with no readable write time you cannot order by recency,
// attribute a row to a deploy, or measure gap latency — the second leg of the
// gap-metrics triple. Data that is written and stored but unreadable is
// indistinguishable from data never written.
//
// The fix carried no test, which is how a silent read-side destruction returns.
import { describe, expect, it } from 'bun:test';
import { TimestampSchema } from './schemas';

describe('TimestampSchema', () => {
  it('normalizes a Date to an ISO string — the 4421/4421 failure', () => {
    const parsed = TimestampSchema.parse(new Date('2026-08-10T02:00:00.000Z'));
    expect(parsed).toBe('2026-08-10T02:00:00.000Z');
    // The precise regression: it must not serialize as an empty object.
    expect(JSON.stringify(parsed)).not.toBe('{}');
  });

  it('passes an ISO string through unchanged', () => {
    expect(TimestampSchema.parse('2026-08-10T02:00:00.000Z')).toBe('2026-08-10T02:00:00.000Z');
  });

  it('leaves a non-Date object alone', () => {
    // Normalizing BEFORE the union means a driver returning a richer object is
    // unaffected — the fix must not become a filter.
    expect(TimestampSchema.parse({ custom: 1 })).toEqual({ custom: 1 });
  });

  it('normalizes anything with toISOString, not just instanceof Date', () => {
    // Driver wrappers and Luxon/dayjs-style objects are Date-like without being
    // Dates; keying on the METHOD is what makes this robust across drivers.
    const dateLike = { toISOString: () => '2026-01-01T00:00:00.000Z' };
    expect(TimestampSchema.parse(dateLike)).toBe('2026-01-01T00:00:00.000Z');
  });
});
