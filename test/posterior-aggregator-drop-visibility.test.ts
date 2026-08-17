import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * A ZERO-ROW UPDATE DOES NOT THROW, SO THE RE-QUEUE NEVER SAW IT.
 *
 * Found by adversarial audit, 2026-08-17. `flushPosteriors` clears the buffer before issuing
 * its writes and re-queues a delta only inside `catch`. The write is a plain
 *
 *     UPDATE variant_performance_metrics ... WHERE variant_id = $x AND org_id = $y
 *
 * with no UPSERT and no CREATE. When no row matches, SurrealDB returns an empty result
 * rather than throwing — so the delta was neither applied nor re-queued nor logged. It
 * vanished, and the arm that lost it is by definition a NEW arm: the one whose posterior is
 * still the uninformative prior and which most needs the evidence.
 *
 * The self-contradiction is what makes this worth pinning. The decay block immediately above
 * the write already reasons about the missing-row case — "Missing row ⇒ fully decayed (1,1)
 * — the uninformative prior, which the deltas then rebuild" — but the deltas cannot rebuild
 * anything through an UPDATE that matches nothing. The READ half planned for absence and the
 * WRITE half could not act on it. A comment describing an intent the code cannot carry out
 * is worse than no comment: it answers the reader's question wrongly.
 *
 * WHY THIS TESTS FOR VISIBILITY AND NOT FOR REPAIR. Rows are created in the routes through
 * `type::thing('variant_performance_metrics', $record_id_slug)` with an account-slug-derived
 * record id this module does not hold. Creating rows here under a guessed identity would
 * fragment the table across two id conventions — a worse failure than the drop, and one that
 * would look like working code. So the fix makes the loss loud and countable, and this test
 * pins exactly that and no more.
 */

const SRC = new URL('../src/lib/posterior-aggregator.ts', import.meta.url).pathname;

function source(): string {
  return readFileSync(SRC, 'utf8');
}

describe('posterior aggregator — a dropped delta is observable', () => {
  it('guards the instrument: the source is readable and is the right file', () => {
    const s = source();
    // A misresolved path would make every assertion below pass vacuously.
    expect(s.length).toBeGreaterThan(2000);
    expect(s).toContain('flushPosteriors');
    expect(s).toContain('UPDATE variant_performance_metrics');
  });

  it('THE REGRESSION: the UPDATE result is captured, not discarded', () => {
    const s = source();
    // Before the fix the query result was thrown away (`await surrealDB.query(...)` as a
    // statement), which is what made a zero-row write indistinguishable from a successful one.
    expect(s).toMatch(/const\s+updated\s*=\s*await\s+surrealDB\.query\(/);
  });

  it('a zero-row write is detected and logged, not swallowed', () => {
    const s = source();
    expect(s).toMatch(/rowsAffected\s*===\s*0/);
    expect(s).toContain('posterior_delta_dropped_no_row');
    // The message must say what was lost, not merely that something happened.
    expect(s).toMatch(/this arm learns nothing/);
  });

  it('the drop count is cumulative and readable from outside', () => {
    const s = source();
    // A single dropped delta reads as noise; a rising total reads as a severed channel.
    // Module-scope counter + an exported reader is what turns one into the other.
    expect(s).toMatch(/let\s+droppedNoRow\s*=\s*0/);
    expect(s).toContain('export function posteriorDeltasDroppedNoRow');
    expect(s).toMatch(/dropped_total/);
  });

  it('the delta values are in the log line, so the loss is quantified', () => {
    const s = source();
    // "a delta was dropped" cannot be prioritised. "alpha_delta: 2 for variant X" can.
    expect(s).toMatch(/alpha_delta/);
    expect(s).toMatch(/beta_delta/);
    expect(s).toMatch(/variant_id/);
  });

  it('NEGATIVE CONTROL: the detector can fail', () => {
    // Prove these patterns reject the pre-fix shape before trusting that they accept the
    // post-fix one. The old code awaited the query as a bare statement and had no counter.
    const preFix = `
      await surrealDB.query(\`UPDATE variant_performance_metrics SET a = 1 WHERE x = $y\`, {});
      } catch (err) {
    `;
    expect(/const\s+updated\s*=\s*await\s+surrealDB\.query\(/.test(preFix)).toBe(false);
    expect(/rowsAffected\s*===\s*0/.test(preFix)).toBe(false);
    expect(preFix.includes('posterior_delta_dropped_no_row')).toBe(false);
  });

  it('CREATION IS STILL NOT ATTEMPTED — the scope limit is deliberate and pinned', () => {
    const s = source();
    // If someone later adds UPSERT/CREATE here, this test must fail so the record-id
    // convention gets decided explicitly rather than inherited from whoever typed it first.
    const flushStart = s.indexOf('export async function flushPosteriors');
    const flushBody = s.slice(flushStart, flushStart + 4000);
    expect(flushBody).not.toMatch(/UPSERT\s+variant_performance_metrics/);
    expect(flushBody).not.toMatch(/CREATE\s+variant_performance_metrics/);
  });
});
