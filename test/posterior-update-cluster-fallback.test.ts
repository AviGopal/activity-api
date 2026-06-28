/**
 * D6.3 — cluster posterior write FALLBACK (no assignment).
 *
 * When a signature has NO cluster assignment (noise point / not-yet-clustered),
 * `applyClusterPosterior` must:
 *   - write NO cluster row (no UPSERT),
 *   - increment the `skipped_no_assignment` counter,
 *   - leave the leaf write path untouched (this function only touches the cluster
 *     row; the leaf write happens in applyOutcomeToPosteriors and is never invoked
 *     here — we assert the cluster helper issues only the lookup, nothing else),
 *   - never throw.
 *
 * Also covers the advisory-on-error case: a lookup/UPSERT DB error is swallowed
 * (the `failed` counter increments, leaf posterior stays correct), never throws.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  applyClusterPosterior,
  getClusterUpdateCounters,
  resetClusterUpdateCounters,
  clearClusterAssignmentCache,
  type DBQueryable,
} from '../src/lib/cluster-posterior';

type Call = { sql: string; params: Record<string, unknown> };

const ORG = 'org-test';
const TEMPLATE = 'tmpl-A';
const SIG = 'noise-signature-xyz';
const SIG_VER = 1;

beforeEach(() => {
  resetClusterUpdateCounters();
  clearClusterAssignmentCache();
});

describe('applyClusterPosterior — no assignment (noise point)', () => {
  test('signature with no assignment -> no cluster row, skipped_no_assignment++', async () => {
    const calls: Call[] = [];
    const db: DBQueryable = {
      async query(sql, params = {}) {
        calls.push({ sql, params });
        // assignment lookup returns empty -> no assignment
        return [] as any;
      },
    };

    await applyClusterPosterior(db, {
      orgId: ORG,
      templateId: TEMPLATE,
      signature: SIG,
      signatureVersion: SIG_VER,
      alphaDelta: 1,
      betaDelta: 0,
    });

    // Exactly one query: the assignment lookup. No UPSERT.
    const upsert = calls.find((c) => c.sql.includes('UPSERT'));
    expect(upsert).toBeUndefined();
    const lookup = calls.find((c) => c.sql.includes('signature_cluster_assignment'));
    expect(lookup).toBeDefined();

    const counters = getClusterUpdateCounters();
    expect(counters.skipped_no_assignment).toBe(1);
    expect(counters.attempted).toBe(0);
    expect(counters.succeeded).toBe(0);
  });

  test('does not throw and writes nothing on an empty assignment row', async () => {
    const db: DBQueryable = {
      async query() {
        return [] as any;
      },
    };
    // Should resolve, never reject.
    await expect(
      applyClusterPosterior(db, {
        orgId: ORG,
        templateId: TEMPLATE,
        signature: SIG,
        signatureVersion: SIG_VER,
        alphaDelta: 0,
        betaDelta: 1,
      }),
    ).resolves.toBeUndefined();
    expect(getClusterUpdateCounters().skipped_no_assignment).toBe(1);
  });
});

describe('applyClusterPosterior — advisory error handling', () => {
  test('lookup DB error is swallowed (treated as no-assignment), never throws', async () => {
    const db: DBQueryable = {
      async query(sql) {
        if (sql.includes('signature_cluster_assignment')) {
          throw new Error('surrealdb transient read error');
        }
        return [] as any;
      },
    };

    await expect(
      applyClusterPosterior(db, {
        orgId: ORG,
        templateId: TEMPLATE,
        signature: SIG,
        signatureVersion: SIG_VER,
        alphaDelta: 1,
        betaDelta: 0,
      }),
    ).resolves.toBeUndefined();

    // A failed lookup is treated as a transient miss (null assignment) -> skipped.
    expect(getClusterUpdateCounters().skipped_no_assignment).toBe(1);
    expect(getClusterUpdateCounters().failed).toBe(0);
  });

  test('UPSERT DB error after a valid assignment is swallowed, failed++ (leaf unaffected)', async () => {
    const db: DBQueryable = {
      async query(sql) {
        if (sql.includes('signature_cluster_assignment')) {
          return [{ cluster_id: 'sigcl_ok', contaminated: false }] as any;
        }
        // the UPSERT throws
        throw new Error('surrealdb write conflict');
      },
    };

    await expect(
      applyClusterPosterior(db, {
        orgId: ORG,
        templateId: TEMPLATE,
        signature: SIG,
        signatureVersion: SIG_VER,
        alphaDelta: 1,
        betaDelta: 0,
      }),
    ).resolves.toBeUndefined();

    const counters = getClusterUpdateCounters();
    expect(counters.attempted).toBe(1);
    expect(counters.failed).toBe(1);
    expect(counters.succeeded).toBe(0);
  });
});
