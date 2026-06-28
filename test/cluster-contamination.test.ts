/**
 * D6.5 — contaminated cluster is IGNORED by both the write (D4) and the
 * selector (D5).
 *
 * A cluster whose member success-rates spread too far is flagged
 * `contaminated = true` on its `signature_cluster_assignment` row (pooling
 * dissimilar success rates would give a misleading posterior). The contract:
 *   - D4 (applyClusterPosterior): writes NO cluster row; `skipped_contaminated`++.
 *   - D5 (selector decision):     used_scope falls back to leaf/'fallback', the
 *     contaminated cluster posterior is never used for α/β.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  applyClusterPosterior,
  lookupAssignment,
  getClusterUpdateCounters,
  resetClusterUpdateCounters,
  clearClusterAssignmentCache,
  type DBQueryable,
} from '../src/lib/cluster-posterior';

const ORG = 'org-test';
const TEMPLATE = 'tmpl-A';
const SIG = 'contaminated-sig';
const SIG_VER = 1;
const N_MIN = 5;
const SAMPLING_FLOOR = 5;

beforeEach(() => {
  resetClusterUpdateCounters();
  clearClusterAssignmentCache();
});

// ---------------------------------------------------------------------------
// D4 write-side: contaminated cluster -> no write, skipped_contaminated++
// ---------------------------------------------------------------------------

describe('applyClusterPosterior — contaminated cluster ignored (D4)', () => {
  test('contaminated assignment -> no UPSERT, skipped_contaminated++', async () => {
    const calls: string[] = [];
    const db: DBQueryable = {
      async query(sql) {
        calls.push(sql);
        if (sql.includes('signature_cluster_assignment')) {
          return [{ cluster_id: 'sigcl_bad', contaminated: true }] as any;
        }
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

    expect(calls.some((s) => s.includes('UPSERT'))).toBe(false);
    const counters = getClusterUpdateCounters();
    expect(counters.skipped_contaminated).toBe(1);
    expect(counters.attempted).toBe(0);
    expect(counters.succeeded).toBe(0);
  });

  test('lookupAssignment surfaces the contaminated flag (D5 read sees it)', async () => {
    const db: DBQueryable = {
      async query(sql) {
        if (sql.includes('signature_cluster_assignment')) {
          return [{ cluster_id: 'sigcl_bad', contaminated: true }] as any;
        }
        return [] as any;
      },
    };
    const assignment = await lookupAssignment(db, SIG, SIG_VER);
    expect(assignment).not.toBeNull();
    expect(assignment!.contaminated).toBe(true);
    expect(assignment!.cluster_id).toBe('sigcl_bad');
  });
});

// ---------------------------------------------------------------------------
// D5 selector-side: contaminated cluster -> used_scope falls back, not 'cluster'
//
// Faithful transcription of the inline decision (activities.ts L4855-4894); the
// `!clusterContaminated && clusterIdForSig` guard means a contaminated cluster is
// NEVER used for α/β, even on a cold leaf.
// ---------------------------------------------------------------------------

interface LeafRow { alpha: number; beta: number; n_observations: number }
interface ClusterRow { alpha: number; beta: number }

function partialPoolingDecision(
  sigRow: LeafRow | null,
  clusterRow: ClusterRow | null,
  clusterContaminated: boolean,
): { alpha: number; beta: number; used_scope: 'signature' | 'cluster' | 'fallback' } {
  let alphaBlended = 1;
  let betaBlended = 1;
  const leafConditionalActive = !!(sigRow && sigRow.n_observations >= SAMPLING_FLOOR);
  if (leafConditionalActive && sigRow) {
    alphaBlended = sigRow.alpha;
    betaBlended = sigRow.beta;
  }
  let usedScope: 'signature' | 'cluster' | 'fallback';
  const nSignature = sigRow ? sigRow.alpha + sigRow.beta - 2 : 0;
  if (leafConditionalActive || (sigRow && nSignature >= N_MIN)) {
    usedScope = 'signature';
  } else {
    const usableCluster = !clusterContaminated && clusterRow ? clusterRow : undefined;
    if (usableCluster) {
      alphaBlended = usableCluster.alpha;
      betaBlended = usableCluster.beta;
      usedScope = 'cluster';
    } else {
      usedScope = 'fallback';
    }
  }
  return { alpha: alphaBlended, beta: betaBlended, used_scope: usedScope };
}

describe('selector — contaminated cluster ignored (D5)', () => {
  test('cold leaf + contaminated cluster -> used_scope=fallback (cluster α/β NOT used)', async () => {
    const leaf: LeafRow = { alpha: 2, beta: 2, n_observations: 2 }; // cold, n_signature=2<5
    const contaminatedCluster: ClusterRow = { alpha: 500, beta: 1 }; // would dominate if used

    const decision = partialPoolingDecision(leaf, contaminatedCluster, /* contaminated */ true);

    expect(decision.used_scope).toBe('fallback');
    // α/β stayed at the leaf/Beta(1,1) fallback — the contaminated cluster was ignored.
    expect(decision.alpha).not.toBe(contaminatedCluster.alpha);
    expect(decision.alpha).toBe(1);
    expect(decision.beta).toBe(1);
  });

  test('sanity: the SAME cluster used_scope=cluster when NOT contaminated', async () => {
    const leaf: LeafRow = { alpha: 2, beta: 2, n_observations: 2 };
    const cluster: ClusterRow = { alpha: 500, beta: 1 };
    const decision = partialPoolingDecision(leaf, cluster, /* contaminated */ false);
    expect(decision.used_scope).toBe('cluster');
    expect(decision.alpha).toBe(500);
  });
});
