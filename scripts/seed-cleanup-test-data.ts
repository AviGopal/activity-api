#!/usr/bin/env bun
/**
 * Seed execution-trace fixtures for testing cleanup-stale-traces-v1.
 *
 * Creates 50 rows in activity_execution_traces for a specified test org:
 *   15 recent  (3 days old)   - must NOT be cleaned
 *   10 week    (7 days old)   - must NOT be cleaned
 *   12 month   (30 days old)  - boundary case
 *   13 old     (60 days old)  - must be cleaned
 *
 * Usage:
 *   TEST_ORG_ID=org_cleanup_test SURREALDB_URL=... bun run scripts/seed-cleanup-test-data.ts
 *
 * Environment:
 *   TEST_ORG_ID         - required, the org to scope fixtures to
 *   SURREALDB_URL       - required, full SurrealDB HTTP endpoint
 *   SURREALDB_NAMESPACE - default 'activity-system'
 *   SURREALDB_DATABASE  - default 'learning_loop'
 *   SURREALDB_USERNAME  - default 'root'
 *   SURREALDB_PASSWORD  - required
 *
 * Run against the canary cluster by exporting SURREALDB_URL=https://surql.metabob.com
 * and the matching credentials. Locally, point to the port-forward.
 */

const TEST_ORG_ID = process.env.TEST_ORG_ID;
const SURREALDB_URL = process.env.SURREALDB_URL;
const NS = process.env.SURREALDB_NAMESPACE || 'activity-system';
const DB = process.env.SURREALDB_DATABASE || 'learning_loop';
const USER = process.env.SURREALDB_USERNAME || 'root';
const PASS = process.env.SURREALDB_PASSWORD;

if (!TEST_ORG_ID || !SURREALDB_URL || !PASS) {
  console.error('TEST_ORG_ID, SURREALDB_URL, and SURREALDB_PASSWORD are required');
  process.exit(1);
}

const FIXTURE_MARKER = 'fixture:cleanup-test';

async function runSql(sql: string, vars: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(`${SURREALDB_URL}/sql`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Authorization': 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64'),
      'surreal-ns': NS,
      'surreal-db': DB,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, vars }),
  });
  if (!res.ok) throw new Error(`SurrealDB HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function main() {
  console.log(`Seeding cleanup-test fixtures for org_id=${TEST_ORG_ID}`);

  // Buckets: [days ago, count, successRate]
  const buckets: Array<[number, number, number]> = [
    [3, 15, 0.67],
    [7, 10, 0.5],
    [30, 12, 0.5],
    [60, 13, 0.75],
  ];

  let created = 0;
  for (const [days, count, successRate] of buckets) {
    const executedAt = isoDaysAgo(days);
    for (let i = 0; i < count; i++) {
      const success = i / count < successRate;
      const execId = `fx_cleanup_${days}d_${i}_${Date.now()}`;
      await runSql(
        `CREATE activity_execution_traces CONTENT {
           execution_id: $eid,
           activity_id: 'cleanup-test-activity',
           variant_id: 'cleanup-test-activity',
           org_id: $org,
           success: $success,
           status: $status,
           duration_ms: 100,
           cost_usd: 0.0,
           tokens_input: 0,
           tokens_output: 0,
           tokens_cache: 0,
           executed_at: type::datetime($ts),
           created_at: type::datetime($ts),
           stored_at: time::now(),
           metadata: { marker: $marker, bucket_days: $days }
         }`,
        {
          eid: execId,
          org: TEST_ORG_ID,
          success,
          status: success ? 'success' : 'failure',
          ts: executedAt,
          marker: FIXTURE_MARKER,
          days,
        },
      );
      created++;
    }
  }

  console.log(`Created ${created} execution-trace fixtures`);
  console.log('Bucket breakdown: 15×3d + 10×7d + 12×30d + 13×60d');
  console.log('Expected to match olderThanDays=30: 25 rows (12 month + 13 old)');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
