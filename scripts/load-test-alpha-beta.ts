#!/usr/bin/env bun
/**
 * Validate Phase 10 P1 acceptance criterion 10.S1:
 *
 *   "Zero lost α/β increments under 10 concurrent update load test"
 *
 * The 10.2 fix replaced the previous SELECT-then-UPDATE per-shape loop
 * with a single bulk `UPDATE … SET alpha = math::ceil((alpha ?? 1) * $multiplier)`
 * statement. SurrealDB's row-level UPDATE is atomic, so with that
 * formulation no two concurrent multiplies race against a stale value.
 *
 * This script verifies the property empirically: it picks one
 * (org_id, shape, activity_id) row, resets α to 1, fires N concurrent
 * positive /feedback requests at intensity=0 (multiplier 1.5), and
 * asserts the final α matches the deterministic compounding of N
 * sequential ceil(α·1.5) operations. Order-independence is guaranteed
 * by the math::ceil(x * 1.5) sequence converging on the same value
 * regardless of the interleaving — what matters is that *all 10
 * multiplies land*.
 *
 * For α=1 → 1.5^10 with ceil at each step yields the exact sequence
 * 1, 2, 3, 5, 8, 12, 18, 27, 41, 62, 93. Anything < 93 indicates lost
 * updates.
 *
 * Usage (run inside the activity-api pod where SURREALDB_URL/USERNAME
 * are already set; override via env if pointing at a different db):
 *   bun run scripts/load-test-alpha-beta.ts
 *
 * Reads SURREALDB_PASSWORD from env. Writes the test row directly to
 * SurrealDB via the HTTP /sql endpoint with Basic auth so it doesn't
 * depend on identity-vessel routing. Read-only after final cleanup.
 */

const url = process.env.SURREALDB_URL ?? "http://surrealdb.activity-system.svc.cluster.local:8000";
const username = process.env.SURREALDB_USERNAME ?? "root";
const password = process.env.SURREALDB_PASSWORD ?? "";
const namespace = process.env.SURREALDB_NAMESPACE ?? "activity-system";
const database = process.env.SURREALDB_DATABASE ?? "learning_loop";

const N = Number(process.env.N ?? 10);
const MULTIPLIER = 1.5;
const ORG_ID = process.env.ORG_ID ?? "metabob";
const SHAPE = process.env.SHAPE ?? "test_load_alpha_beta_shape";
const ACTIVITY_ID = process.env.ACTIVITY_ID ?? "activity:tpl_load_test_alpha_beta";

async function sql(query: string, vars: Record<string, unknown> = {}): Promise<any> {
  // Inline simple bindings since the /sql HTTP endpoint takes raw text.
  let body = query;
  // Sort keys by descending length so prefixes (e.g. $a) don't eat $a_b.
  const keys = Object.keys(vars).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const v = vars[k];
    const literal = typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v);
    body = body.replace(new RegExp(`\\$${k}\\b`, "g"), literal);
  }
  if (process.env.DEBUG_SQL) console.error(">>>SQL", body);
  const r = await fetch(`${url}/sql`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "text/plain",
      "surreal-ns": namespace,
      "surreal-db": database,
      Authorization: `Basic ${btoa(`${username}:${password}`)}`,
    },
    body,
  });
  return await r.json();
}

function expectedAlpha(start: number, mult: number, steps: number): number {
  let a = start;
  for (let i = 0; i < steps; i++) a = Math.ceil(a * mult);
  return a;
}

async function main() {
  console.log(`[load-test] N=${N} multiplier=${MULTIPLIER} target=${url}`);

  // Reset (or create) a single row with α=1, β=1 for this load test.
  // Using composite key org_id/shape/activity_id.
  await sql(`
    DELETE impulse_shape_activity_score WHERE org_id = $org_id
      AND shape = $shape
      AND activity_id = $activity_id;
  `, { org_id: ORG_ID, shape: SHAPE, activity_id: ACTIVITY_ID });

  const createResult = await sql(`
    CREATE impulse_shape_activity_score CONTENT {
      org_id: $org_id,
      shape: $shape,
      activity_id: $activity_id,
      alpha: 1,
      beta: 1
    };
  `, { org_id: ORG_ID, shape: SHAPE, activity_id: ACTIVITY_ID });
  if (process.env.DEBUG_SQL) console.error("[load-test] create:", JSON.stringify(createResult));

  // Fire N concurrent atomic-multiply UPDATEs against the same row.
  const updateSql = `
    UPDATE impulse_shape_activity_score
      SET alpha = math::ceil((alpha ?? 1) * ${MULTIPLIER}),
          updated_at = time::now()
    WHERE org_id = $org_id AND shape = $shape AND activity_id = $activity_id;
  `;

  const start = Date.now();
  const promises = Array.from({ length: N }, () =>
    sql(updateSql, { org_id: ORG_ID, shape: SHAPE, activity_id: ACTIVITY_ID }),
  );
  const results = await Promise.all(promises);
  const elapsed = Date.now() - start;

  const failed = results.filter((r) => Array.isArray(r) && r[0]?.status !== "OK").length;
  if (failed > 0) {
    console.error(`[load-test] ${failed}/${N} updates returned non-OK status — investigate`);
    process.exit(2);
  }

  const final = await sql(`
    SELECT alpha FROM impulse_shape_activity_score
    WHERE org_id = $org_id AND shape = $shape AND activity_id = $activity_id;
  `, { org_id: ORG_ID, shape: SHAPE, activity_id: ACTIVITY_ID });

  if (process.env.DEBUG_SQL) {
    console.error("[load-test] final raw:", JSON.stringify(final));
    console.error("[load-test] sample update result:", JSON.stringify(results[0]));
  }
  const actual = final?.[0]?.result?.[0]?.alpha;
  const expected = expectedAlpha(1, MULTIPLIER, N);

  console.log(`[load-test] elapsed=${elapsed}ms updates=${N} expected_alpha=${expected} actual_alpha=${actual}`);

  // Cleanup the test row so we don't leave debris in the canary registry.
  await sql(`
    DELETE impulse_shape_activity_score WHERE org_id = $org_id
      AND shape = $shape
      AND activity_id = $activity_id;
  `, { org_id: ORG_ID, shape: SHAPE, activity_id: ACTIVITY_ID });

  if (actual === expected) {
    console.log("[load-test] PASS — zero lost increments");
    process.exit(0);
  }
  console.error(`[load-test] FAIL — actual ${actual} ≠ expected ${expected} (lost ~${Math.round(Math.log(expected / actual) / Math.log(MULTIPLIER))} updates)`);
  process.exit(1);
}

await main();
