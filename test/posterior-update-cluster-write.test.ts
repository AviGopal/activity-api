/**
 * D6.2 — cluster posterior WRITE (the coarsening write).
 *
 * After `applyClusterPosterior` is called for a signature whose assignment maps
 * to a known NON-CONTAMINATED cluster_id, the cluster row (keyed by
 * `clusterRowSlug`) must be UPSERTed with alpha/beta incremented by the SAME
 * deltas passed in. We also assert the UPSERT-by-id SQL shape (no SELECT→CREATE
 * race) and that the deterministic slug is the row target.
 *
 * No real DB — a spy captures every db.query() call and returns the assignment
 * row for the lookup query, matching the existing posterior-update.test.ts mock
 * convention.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  applyClusterPosterior,
  clusterRowSlug,
  getClusterUpdateCounters,
  resetClusterUpdateCounters,
  clearClusterAssignmentCache,
  type DBQueryable,
} from '../src/lib/cluster-posterior';

// ---------------------------------------------------------------------------
// Mock DB: returns an assignment row for the assignment SELECT, [] otherwise.
// ---------------------------------------------------------------------------

type Call = { sql: string; params: Record<string, unknown> };

function makeDb(assignment: { cluster_id: string; contaminated: boolean } | null): {
  db: DBQueryable;
  calls: Call[];
} {
  const calls: Call[] = [];
  const db: DBQueryable = {
    async query(sql: string, params: Record<string, unknown> = {}) {
      calls.push({ sql, params });
      if (sql.includes('signature_cluster_assignment')) {
        return assignment ? ([assignment] as any) : ([] as any);
      }
      return [] as any;
    },
  };
  return { db, calls };
}

const ORG = 'org-test';
const TEMPLATE = 'tmpl-A';
const SIG = 'abc123signature';
const SIG_VER = 1;

beforeEach(() => {
  resetClusterUpdateCounters();
  clearClusterAssignmentCache(); // avoid TTL-cache bleed between tests
});

describe('applyClusterPosterior — cluster row write on known cluster', () => {
  test('UPSERTs the cluster row with the SAME deltas as passed', async () => {
    const { db, calls } = makeDb({ cluster_id: 'sigcl_deadbeef', contaminated: false });

    await applyClusterPosterior(db, {
      orgId: ORG,
      templateId: TEMPLATE,
      signature: SIG,
      signatureVersion: SIG_VER,
      alphaDelta: 1,
      betaDelta: 0,
    });

    const upsert = calls.find((c) => c.sql.includes('UPSERT'));
    expect(upsert).toBeDefined();
    // Deltas threaded verbatim into the increment params.
    expect(upsert!.params.alpha_delta).toBe(1);
    expect(upsert!.params.beta_delta).toBe(0);
    expect(upsert!.params.cluster_id).toBe('sigcl_deadbeef');
    expect(upsert!.params.context_bucket).toBe('cluster:sigcl_deadbeef');
    // Same deltas attribution: success leaf delta (1,0) -> same cluster delta (1,0).
    expect(getClusterUpdateCounters().succeeded).toBe(1);
    expect(getClusterUpdateCounters().attempted).toBe(1);
  });

  test('beta delta (failure) threads through identically', async () => {
    const { db, calls } = makeDb({ cluster_id: 'sigcl_feed', contaminated: false });

    await applyClusterPosterior(db, {
      orgId: ORG,
      templateId: TEMPLATE,
      signature: SIG,
      signatureVersion: SIG_VER,
      alphaDelta: 0,
      betaDelta: 1,
    });

    const upsert = calls.find((c) => c.sql.includes('UPSERT'));
    expect(upsert!.params.alpha_delta).toBe(0);
    expect(upsert!.params.beta_delta).toBe(1);
  });

  test('row is targeted by the deterministic clusterRowSlug (no SELECT→CREATE race)', async () => {
    const { db, calls } = makeDb({ cluster_id: 'sigcl_abc', contaminated: false });

    await applyClusterPosterior(db, {
      orgId: ORG,
      templateId: TEMPLATE,
      signature: SIG,
      signatureVersion: SIG_VER,
      alphaDelta: 1,
      betaDelta: 0,
    });

    const upsert = calls.find((c) => c.sql.includes('UPSERT'))!;
    const expectedSlug = clusterRowSlug(ORG, TEMPLATE, SIG_VER, 'sigcl_abc');
    // The UPSERT addresses the row by the deterministic slug via type::record(...).
    expect(upsert.params.slug).toBe(expectedSlug);
    expect(upsert.sql).toContain("type::record('context_thompson_scores', $slug)");
    // UPSERT-by-id: a single create-or-update statement, NOT SELECT then CREATE.
    expect(upsert.sql).toContain('UPSERT');
    expect(upsert.sql).not.toContain('SELECT');
    expect(upsert.sql).not.toContain('CREATE ');
    // Server-side atomic increment idiom (no read-modify-write in app code).
    expect(upsert.sql).toContain('(alpha ?? 1) + $alpha_delta');
    expect(upsert.sql).toContain('(beta  ?? 1) + $beta_delta');
  });

  test('slug is stable for the same (org, template, version, cluster) tuple', () => {
    const a = clusterRowSlug(ORG, TEMPLATE, SIG_VER, 'sigcl_x');
    const b = clusterRowSlug(ORG, TEMPLATE, SIG_VER, 'sigcl_x');
    const different = clusterRowSlug(ORG, TEMPLATE, SIG_VER, 'sigcl_y');
    expect(a).toBe(b);
    expect(a).not.toBe(different);
    expect(a).toMatch(/^[0-9a-f]{32}$/); // 32-hex slug
  });

  test('both deltas zero -> no lookup, no write', async () => {
    const { db, calls } = makeDb({ cluster_id: 'sigcl_z', contaminated: false });
    await applyClusterPosterior(db, {
      orgId: ORG,
      templateId: TEMPLATE,
      signature: SIG,
      signatureVersion: SIG_VER,
      alphaDelta: 0,
      betaDelta: 0,
    });
    expect(calls).toHaveLength(0);
    expect(getClusterUpdateCounters().attempted).toBe(0);
  });
});
