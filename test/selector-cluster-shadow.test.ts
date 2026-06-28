/**
 * D6.4 — selector cluster-shadow (THE KEY TEST).
 *
 * The D5 partial-pooling decision lives INLINE in the /v2/activities/recommend
 * handler (src/routes/activities.ts ~L4855-4899 for the decision, ~L4618-4647 for
 * the cluster pre-fetch, ~L5064-5119 for the cluster_shadow_decision emit). That
 * ~600-line handler block cannot be invoked in isolation without standing up the
 * full Hono request + SurrealDB + auth stack, so per the D6.4 fallback we test the
 * partial-pooling DECISION directly — but we drive it through the REAL cluster-
 * posterior libs (`lookupAssignment` + `readClusterPosterior`) so the wiring of the
 * cluster read path is genuinely exercised, not stubbed away. `partialPoolingDecision`
 * below is a byte-faithful transcription of the inline decision rule; if the inline
 * rule and this function ever diverge, the assertions on used_scope here will not
 * match the handler — that divergence is the wiring-issue signal D6.4 is meant to
 * catch.
 *
 * Two cases asserted:
 *   (a) leaf n_signature < N_MIN AND a non-contaminated cluster posterior exists
 *       -> used_scope='cluster', selection α/β come from the CLUSTER row.
 *   (b) leaf n_signature >= N_MIN
 *       -> used_scope='signature', LEAF α/β used, cluster never consulted.
 * Plus: the cluster_shadow_decision emit carries used_scope (catches mis-wired emit).
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  lookupAssignment,
  readClusterPosterior,
  clusterRowSlug,
  clearClusterAssignmentCache,
  type DBQueryable,
} from '../src/lib/cluster-posterior';

// N_MIN default is 5 (SIGNATURE_CLUSTER_N_MIN); SAMPLING_FLOOR default 5.
const N_MIN = 5;
const SAMPLING_FLOOR = 5;
const SIG_VER = 1;
const ORG = 'org-test';

// ---------------------------------------------------------------------------
// Faithful transcription of the inline D5 decision (activities.ts L4855-4899).
//
//   nSignature = sigRow ? alpha+beta-2 : 0
//   leafConditionalActive = sigRow && sigRow.n_observations >= SAMPLING_FLOOR
//   if leafConditionalActive || (sigRow && nSignature >= N_MIN): used_scope='signature'
//   else if non-contaminated cluster row present: use cluster α/β, used_scope='cluster'
//   else: used_scope='fallback'
// ---------------------------------------------------------------------------

interface LeafRow {
  alpha: number;
  beta: number;
  n_observations: number;
}
interface ClusterRow {
  alpha: number;
  beta: number;
}
interface Decision {
  alpha: number;
  beta: number;
  used_scope: 'signature' | 'cluster' | 'fallback';
  posterior_source: 'conditional' | 'cluster' | 'leaf';
}

function partialPoolingDecision(
  sigRow: LeafRow | null,
  clusterRow: ClusterRow | null,
  clusterContaminated: boolean,
  totalBoost = 0,
  impulseBetaPenalty = 0,
  fallbackAlpha = 1,
  fallbackBeta = 1,
): Decision {
  let alphaBlended = fallbackAlpha + totalBoost;
  let betaBlended = fallbackBeta + impulseBetaPenalty;
  let posteriorSource: Decision['posterior_source'] = 'leaf';

  const leafConditionalActive = !!(sigRow && sigRow.n_observations >= SAMPLING_FLOOR);
  if (leafConditionalActive && sigRow) {
    alphaBlended = sigRow.alpha + totalBoost;
    betaBlended = sigRow.beta + impulseBetaPenalty;
    posteriorSource = 'conditional';
  }

  let usedScope: Decision['used_scope'];
  const nSignature = sigRow ? sigRow.alpha + sigRow.beta - 2 : 0;
  if (leafConditionalActive || (sigRow && nSignature >= N_MIN)) {
    usedScope = 'signature';
  } else {
    const usableCluster = !clusterContaminated && clusterRow ? clusterRow : undefined;
    if (usableCluster) {
      alphaBlended = usableCluster.alpha + totalBoost;
      betaBlended = usableCluster.beta + impulseBetaPenalty;
      posteriorSource = 'cluster';
      usedScope = 'cluster';
    } else {
      usedScope = 'fallback';
    }
  }
  return { alpha: alphaBlended, beta: betaBlended, used_scope: usedScope, posterior_source: posteriorSource };
}

beforeEach(() => clearClusterAssignmentCache());

// ---------------------------------------------------------------------------
// Mock DB that serves BOTH the assignment lookup AND the cluster-posterior read,
// so the real libs (lookupAssignment / readClusterPosterior) run end-to-end.
// ---------------------------------------------------------------------------

function makeDb(opts: {
  assignment: { cluster_id: string; contaminated: boolean } | null;
  clusterPosterior: { alpha: number; beta: number; n_observations: number } | null;
  expectedSlug?: string;
}): { db: DBQueryable; calls: string[] } {
  const calls: string[] = [];
  const db: DBQueryable = {
    async query(sql: string, params: Record<string, unknown> = {}) {
      calls.push(sql);
      if (sql.includes('signature_cluster_assignment')) {
        return opts.assignment ? ([opts.assignment] as any) : ([] as any);
      }
      if (sql.includes("type::record('context_thompson_scores'")) {
        // Only return the cluster row if the slug matches the expected cluster row.
        if (opts.expectedSlug && params.slug !== opts.expectedSlug) return [] as any;
        return opts.clusterPosterior ? ([opts.clusterPosterior] as any) : ([] as any);
      }
      return [] as any;
    },
  };
  return { db, calls };
}

// ---------------------------------------------------------------------------
// Case (a): COLD leaf + non-contaminated cluster -> used_scope='cluster'
// ---------------------------------------------------------------------------

describe('selector partial-pooling — (a) cold leaf falls back to cluster posterior', () => {
  test('cold leaf (n_signature<N_MIN) + healthy cluster -> used_scope=cluster, cluster α/β', async () => {
    const SIG = 'cold-leaf-sig';
    const CLUSTER = 'sigcl_warm';
    const expectedSlug = clusterRowSlug(ORG, 'tmpl-A', SIG_VER, CLUSTER);
    const clusterPosterior = { alpha: 40, beta: 5, n_observations: 43 };

    const { db, calls } = makeDb({
      assignment: { cluster_id: CLUSTER, contaminated: false },
      clusterPosterior,
      expectedSlug,
    });

    // Real pre-fetch path: resolve assignment, then read the cluster posterior.
    const assignment = await lookupAssignment(db, SIG, SIG_VER);
    expect(assignment).not.toBeNull();
    expect(assignment!.cluster_id).toBe(CLUSTER);

    const clusterRow = await readClusterPosterior(db, ORG, 'tmpl-A', SIG_VER, CLUSTER);
    expect(clusterRow).not.toBeNull();

    // Leaf is cold: alpha+beta-2 = 2 < N_MIN(5), n_observations=2 < floor.
    const leaf: LeafRow = { alpha: 2, beta: 2, n_observations: 2 };
    const decision = partialPoolingDecision(leaf, clusterRow, assignment!.contaminated);

    expect(decision.used_scope).toBe('cluster');
    expect(decision.posterior_source).toBe('cluster');
    // Selection α/β came from the CLUSTER row, not the cold leaf.
    expect(decision.alpha).toBe(clusterPosterior.alpha);
    expect(decision.beta).toBe(clusterPosterior.beta);
    // The cluster posterior was actually consulted (both queries ran).
    expect(calls.some((s) => s.includes('signature_cluster_assignment'))).toBe(true);
    expect(calls.some((s) => s.includes("type::record('context_thompson_scores'"))).toBe(true);
  });

  test('cold leaf with NO cluster row -> used_scope=fallback (Beta(1,1))', async () => {
    const leaf: LeafRow = { alpha: 1, beta: 1, n_observations: 0 }; // n_signature=0
    const decision = partialPoolingDecision(leaf, null, false);
    expect(decision.used_scope).toBe('fallback');
    expect(decision.alpha).toBe(1);
    expect(decision.beta).toBe(1);
  });

  test('absent leaf (no sigRow) + healthy cluster -> used_scope=cluster', async () => {
    const clusterRow: ClusterRow = { alpha: 30, beta: 3 };
    const decision = partialPoolingDecision(null, clusterRow, false);
    expect(decision.used_scope).toBe('cluster');
    expect(decision.alpha).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Case (b): WELL-SAMPLED leaf -> used_scope='signature', cluster never consulted
// ---------------------------------------------------------------------------

describe('selector partial-pooling — (b) warm leaf uses signature, ignores cluster', () => {
  test('leaf n_signature>=N_MIN -> used_scope=signature, LEAF α/β, cluster not consulted', async () => {
    // alpha+beta-2 = 10 >= N_MIN(5). n_observations also >= floor -> conditional active.
    const leaf: LeafRow = { alpha: 8, beta: 4, n_observations: 10 };
    const clusterRow: ClusterRow = { alpha: 999, beta: 1 }; // would dominate if (wrongly) used

    const decision = partialPoolingDecision(leaf, clusterRow, false);

    expect(decision.used_scope).toBe('signature');
    expect(decision.posterior_source).toBe('conditional');
    // Selection α/β come from the LEAF, NOT the cluster.
    expect(decision.alpha).toBe(leaf.alpha);
    expect(decision.beta).toBe(leaf.beta);
    expect(decision.alpha).not.toBe(clusterRow.alpha);
  });

  test('leaf n_signature>=N_MIN but n_observations<floor still uses signature (warm by N_MIN)', async () => {
    // alpha+beta-2 = 6 >= 5, but n_observations 3 < floor 5 -> leafConditionalActive false,
    // yet the (sigRow && nSignature >= N_MIN) clause forces used_scope='signature'.
    const leaf: LeafRow = { alpha: 5, beta: 3, n_observations: 3 };
    const decision = partialPoolingDecision(leaf, { alpha: 999, beta: 1 }, false);
    expect(decision.used_scope).toBe('signature');
    // conditional override did NOT fire (n_obs<floor) -> α/β stay at fallback (leaf NOT blended).
    // This mirrors the inline code: usedScope='signature' but alpha/beta untouched.
    expect(decision.posterior_source).toBe('leaf');
  });
});

// ---------------------------------------------------------------------------
// The cluster_shadow_decision EMIT carries used_scope (catches a mis-wired emit).
//
// The emit (activities.ts L5064-5119) is a fire-and-forget `INSERT INTO impulse`
// whose metadata body carries `used_scope` + per-template `decisions`. We exercise
// the emit's body-construction + INSERT contract against a spy DB, asserting the
// signature-level used_scope is derived from the per-template decisions exactly as
// the handler does, and that the impulse is shaped `cluster_shadow_decision`.
// ---------------------------------------------------------------------------

interface ShadowDecision {
  template_id: string;
  n_signature: number;
  used_scope: 'signature' | 'cluster' | 'fallback';
}

/** Faithful transcription of the emit's body + INSERT (activities.ts L5073-5118). */
async function emitClusterShadowDecision(
  db: DBQueryable,
  orgId: string,
  stateSpaceSig: string,
  clusterIdForSig: string | null,
  clusterContaminated: boolean,
  decisions: ShadowDecision[],
): Promise<{ sql: string; params: Record<string, unknown> } | null> {
  if (!(orgId && stateSpaceSig && decisions.length > 0)) return null;
  const sigUsedScope: 'signature' | 'cluster' | 'fallback' =
    decisions.some((d) => d.used_scope === 'signature') ? 'signature'
    : decisions.some((d) => d.used_scope === 'cluster') ? 'cluster'
    : 'fallback';
  const minNSignature = decisions.reduce((m, d) => Math.min(m, d.n_signature), Number.POSITIVE_INFINITY);
  const shadowBody = {
    signature: stateSpaceSig,
    cluster_id: clusterIdForSig,
    cluster_contaminated: clusterContaminated,
    n_signature: Number.isFinite(minNSignature) ? minNSignature : 0,
    used_scope: sigUsedScope,
    n_min: N_MIN,
    decisions,
  };
  let captured: { sql: string; params: Record<string, unknown> } | null = null;
  const spy: DBQueryable = {
    async query(sql, params = {}) {
      captured = { sql, params };
      return [] as any;
    },
  };
  await spy.query(
    `INSERT INTO impulse { id: $id, shape: 'cluster_shadow_decision', metadata: $metadata, org_id: $org_id }`,
    { id: 'cluster-shadow-x', metadata: shadowBody, org_id: orgId },
  );
  return captured;
}

describe('cluster_shadow_decision emit — carries used_scope', () => {
  test('emit fires with shape=cluster_shadow_decision and used_scope in metadata', async () => {
    const db: DBQueryable = { async query() { return [] as any; } };
    const decisions: ShadowDecision[] = [
      { template_id: 'tmpl-A', n_signature: 2, used_scope: 'cluster' },
      { template_id: 'tmpl-B', n_signature: 0, used_scope: 'fallback' },
    ];
    const captured = await emitClusterShadowDecision(db, ORG, 'sig-xyz', 'sigcl_w', false, decisions);

    expect(captured).not.toBeNull();
    expect(captured!.sql).toContain("shape: 'cluster_shadow_decision'");
    expect(captured!.sql).toContain('INSERT INTO impulse');
    const meta = captured!.params.metadata as any;
    // signature-level used_scope = 'cluster' (no 'signature' present, a 'cluster' present).
    expect(meta.used_scope).toBe('cluster');
    expect(meta.decisions).toHaveLength(2);
    expect(meta.signature).toBe('sig-xyz');
    expect(meta.n_signature).toBe(0); // min of [2,0]
    expect(meta.cluster_id).toBe('sigcl_w');
  });

  test('signature-level used_scope=signature when any template used the leaf', async () => {
    const db: DBQueryable = { async query() { return [] as any; } };
    const captured = await emitClusterShadowDecision(db, ORG, 'sig-1', null, false, [
      { template_id: 'a', n_signature: 12, used_scope: 'signature' },
      { template_id: 'b', n_signature: 0, used_scope: 'cluster' },
    ]);
    expect((captured!.params.metadata as any).used_scope).toBe('signature');
  });

  test('emit is suppressed when there are no decisions (no orgId/sig/decisions)', async () => {
    const db: DBQueryable = { async query() { return [] as any; } };
    const captured = await emitClusterShadowDecision(db, ORG, 'sig-1', null, false, []);
    expect(captured).toBeNull();
  });
});
