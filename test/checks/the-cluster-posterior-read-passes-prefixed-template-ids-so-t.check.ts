import { describe, test, expect } from 'bun:test';
import * as mod from '../../src/lib/cluster-posterior';

/**
 * Repro: #8 signature-cluster fallback is dead (0 fires in 7d). Writes use a slug
 * computed from the BARE template id, while reads pass a PREFIXED id
 * (e.g. "templates:xyz"). That mismatch means the read never finds the row.
 *
 * Evidence: cluster_shadow_decision used_scope fallback 13,070, signature 3,239, cluster 0;
 * no per-template decision has scope=cluster (positive control: 3,246 rows with signature scope).
 *
 * This test asserts that the slug produced for a prefixed template_id should match the
 * one for its bare counterpart (normalization expected). Current behavior does NOT
 * normalize, so the assertion fails — demonstrating the dead path.
 */

describe('cluster posterior row slug normalization', () => {
  test('prefixed vs bare template_id should hash to the SAME slug (currently do not)', () => {
    const orgId = 'organizations:acme-corp';
    const bareTemplateId = 'tmpl_abc123';
    const prefixedTemplateId = `templates:${bareTemplateId}`;
    const version = 3;
    const cluster = 'signature-8';

    // Write path (applyClusterPosterior) effectively uses a slug derived from the BARE id.
    const writeSlug = (mod as any).clusterRowSlug(orgId, bareTemplateId, version, cluster);
    // Read path (readClusterPosterior) passes a PREFIXED template id through to the slugger.
    const readSlug = (mod as any).clusterRowSlug(orgId, prefixedTemplateId, version, cluster);

    // Expected: normalization makes these equal. Actual: they differ, so this fails and
    // reproduces the bug that prevents the cluster scope from ever matching on read.
    expect(readSlug).toBe(writeSlug);
  });
});
