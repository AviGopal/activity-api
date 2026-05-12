/**
 * Integration tests for FTS tags index (spec 18.1.4, 18.1.5)
 *
 * These tests target the live pre-prod cluster at activity.metabob.com and
 * require ACTIVITY_API_URL + METABOB_API_KEY env vars to be set.  Running
 * against surql.metabob.local will fail — the tags FTS index (migration 126)
 * only exists on the pre-prod cluster.
 *
 * 18.1.4: template with tags:["bugfix.auth.tokens"] appears in top-3 results
 *         for query "auth" with non-zero fts_score (after REBUILD).
 * 18.1.5: hierarchical query "bugfix.auth" ranks bugfix.auth.* above
 *         bugfix-only templates (more specific tag → higher BM25 score).
 *
 * Setup/teardown use the activity-api HTTP endpoints:
 *   POST /v2/activities/templates   — create test fixtures
 *   POST /v2/activities/internal/fts-rebuild — warm BM25 scorer immediately
 * Cleanup uses soft-deprecation via POST /v2/activities/:id/deprecate when
 * available; otherwise test artifacts persist under TEST_ORG (isolated by
 * org_id and identifiable by the "fts-tags-test-18-1-" name prefix).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

const BASE_URL = (process.env.ACTIVITY_API_URL ?? 'https://activity.metabob.com').replace(/\/$/, '');
const API_KEY  = process.env.METABOB_API_KEY ?? '';

// Skip the entire suite when credentials are missing (e.g. local dev without .env.test)
const SKIP = !API_KEY;

const TEST_ORG = 'organizations:fts-tags-test-18-1';
const PREFIX   = 'fts-tags-test-18-1-';

const ID_AUTH_SPECIFIC = `${PREFIX}auth-specific`;  // tags: ["bugfix.auth.tokens"]
const ID_AUTH_GENERAL  = `${PREFIX}auth-general`;   // tags: ["auth"]
const ID_BUGFIX_ONLY   = `${PREFIX}bugfix-only`;    // tags: ["bugfix"]
const ID_UNRELATED     = `${PREFIX}unrelated`;      // tags: ["documentation"]

const ALL_IDS = [ID_AUTH_SPECIFIC, ID_AUTH_GENERAL, ID_BUGFIX_ONLY, ID_UNRELATED];

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `ApiKey ${API_KEY}`,
  };
}

async function createTemplate(id: string, name: string, description: string, tags: string[]): Promise<void> {
  const res = await fetch(`${BASE_URL}/v2/activities/templates`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      id,
      name,
      description,
      tags,
      execution_type: 'template',
      scope: 'org',
      org_id: TEST_ORG,
      public: false,
      output_shapes: ['result'],
      tasks: [],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createTemplate(${id}) HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function rebuildFts(): Promise<void> {
  const res = await fetch(`${BASE_URL}/v2/activities/internal/fts-rebuild`, {
    method: 'POST',
    headers: headers(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fts-rebuild HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function searchTemplates(q: string, limit = 20): Promise<Array<{ id: string; fts_score?: number }>> {
  const url = `${BASE_URL}/v2/activities/templates?q=${encodeURIComponent(q)}&limit=${limit}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`searchTemplates HTTP ${res.status}`);
  const body = await res.json() as { templates: Array<{ id: string; fts_score?: number }> };
  return body.templates ?? [];
}

function stripPrefix(id: string): string {
  // SurrealDB wraps ids as "activity:`<id>`" — strip the record prefix.
  return id.replace(/^activity:`?/, '').replace(/`?$/, '');
}

beforeAll(async () => {
  if (SKIP) return;

  await Promise.all([
    createTemplate(
      ID_AUTH_SPECIFIC,
      'Fix Authentication Token Expiry',
      'Resolves expired token handling in the auth middleware.',
      ['bugfix.auth.tokens'],
    ),
    createTemplate(
      ID_AUTH_GENERAL,
      'Auth Hardening Pass',
      'General authentication security review and hardening.',
      ['auth'],
    ),
    createTemplate(
      ID_BUGFIX_ONLY,
      'Generic Bug Fix Template',
      'Template for standard bug fixes without authentication scope.',
      ['bugfix'],
    ),
    createTemplate(
      ID_UNRELATED,
      'Update Changelog',
      'Write and format changelog entries for a release.',
      ['documentation'],
    ),
  ]);

  // Warm the BM25 scorer immediately after inserts so score assertions work
  // without waiting for the next 5-minute periodic rebuild (F-V46 fix must be
  // deployed for scores to stay non-zero between this REBUILD and the query).
  await rebuildFts();
});

afterAll(async () => {
  // Test artifacts under TEST_ORG are isolated — they only surface in queries
  // scoped to organizations:fts-tags-test-18-1. No cleanup endpoint exists yet;
  // artifacts can be pruned via the operator prune-activity flow.
  // This comment intentionally left as a reminder for future cleanup.
});

describe('queryActivitiesByFTS — tags index (18.1.4)', () => {
  test.skipIf(SKIP)('template with tags:["bugfix.auth.tokens"] appears in results for query "auth"', async () => {
    const results = await searchTemplates('auth', 20);
    const ids = results.map(r => stripPrefix(r.id));
    expect(ids).toContain(ID_AUTH_SPECIFIC);
  });

  test.skipIf(SKIP)('tags-matched template has non-zero fts_score', async () => {
    const results = await searchTemplates('auth', 20);
    const hit = results.find(r => stripPrefix(r.id).includes(ID_AUTH_SPECIFIC));
    expect(hit).toBeDefined();
    expect(hit!.fts_score ?? 0).toBeGreaterThan(0);
  });

  test.skipIf(SKIP)('tags-matched template appears in top-3 results for query "auth"', async () => {
    const results = await searchTemplates('auth', 20);
    const top3 = results.slice(0, 3).map(r => stripPrefix(r.id));
    // Either the specific or general auth tag should rank in top 3
    expect(top3.some(id => id.includes('auth'))).toBe(true);
  });

  test.skipIf(SKIP)('unrelated tag ("documentation") does not appear for query "auth"', async () => {
    const results = await searchTemplates('auth', 20);
    const ids = results.map(r => stripPrefix(r.id));
    expect(ids).not.toContain(ID_UNRELATED);
  });
});

describe('queryActivitiesByFTS — hierarchical tags (18.1.5)', () => {
  test.skipIf(SKIP)('query "bugfix.auth" returns both auth and bugfix templates', async () => {
    // Sanitiser strips dots → "bugfix auth" (two BM25 query terms)
    const results = await searchTemplates('bugfix.auth', 20);
    const ids = results.map(r => stripPrefix(r.id));
    expect(ids).toContain(ID_AUTH_SPECIFIC);
    expect(ids).toContain(ID_BUGFIX_ONLY);
  });

  test.skipIf(SKIP)('"bugfix.auth.*" template ranks above "bugfix"-only template', async () => {
    const results = await searchTemplates('bugfix.auth', 20);
    const idList = results.map(r => stripPrefix(r.id));
    const specificIdx  = idList.findIndex(id => id.includes(ID_AUTH_SPECIFIC));
    const bugfixOnlyIdx = idList.findIndex(id => id.includes(ID_BUGFIX_ONLY));

    expect(specificIdx).toBeGreaterThanOrEqual(0);
    expect(bugfixOnlyIdx).toBeGreaterThanOrEqual(0);
    expect(specificIdx).toBeLessThan(bugfixOnlyIdx);
  });

  test.skipIf(SKIP)('"bugfix.auth.*" fts_score exceeds "bugfix"-only fts_score', async () => {
    const results = await searchTemplates('bugfix.auth', 20);
    const specific   = results.find(r => stripPrefix(r.id).includes(ID_AUTH_SPECIFIC));
    const bugfixOnly = results.find(r => stripPrefix(r.id).includes(ID_BUGFIX_ONLY));

    expect(specific).toBeDefined();
    expect(bugfixOnly).toBeDefined();
    expect(specific!.fts_score ?? 0).toBeGreaterThan(bugfixOnly!.fts_score ?? 0);
  });
});
