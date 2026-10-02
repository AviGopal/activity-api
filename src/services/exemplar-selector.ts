/**
 * Adaptive exemplar selector.
 *
 * For each active activity template, selects a balanced set of success/failure
 * exemplars from trace_digest. Balance is driven by the activity's Thompson ev
 * (COMPUTED field deployed by surrealdb-rl-layer migration 103).
 *
 * Formula: n_success = max(1, round(N * (1 - ev)))
 *          n_failure = max(1, round(N * ev))
 *
 * Rationale: when ev → 1 (template reliably succeeds), failures are the rare
 * informative class. When ev → 0, successes are rare. We over-sample the minority.
 *
 * Triggers: nightly setInterval (index.ts) + burst counter (Redis, N new traces).
 */

import { surrealDB } from '../db/surreal';
import { redis } from '../db/redis';
import { logger } from '../utils/logger';

const EXEMPLAR_N = parseInt(process.env.EXEMPLAR_N ?? '20', 10);
const BURST_THRESHOLD = parseInt(process.env.EXEMPLAR_BURST_THRESHOLD ?? '20', 10);
const BURST_KEY_PREFIX = 'exemplar_pending:';
// Rate-limit nightly bulk run: delay between activities (ms). Prevents SurrealDB
// CPU saturation when trace_digest has many distinct activities (>500). Default
// 150ms spreads 2000 activities over ~5 minutes instead of <30 seconds.
// Set to 0 to disable (not recommended in production with large datasets).
const BULK_ACTIVITY_DELAY_MS = parseInt(process.env.EXEMPLAR_BULK_DELAY_MS ?? '150', 10);

export interface ExemplarSelectResult {
  processed: number;
  failed: number;
}

export async function selectExemplarsForActivity(activity_id: string): Promise<void> {
  const evRows = await surrealDB.query<{ ev: number | null }>(
    `SELECT ev FROM activity WHERE id = $id LIMIT 1`,
    { id: activity_id }
  );
  const ev = evRows?.[0]?.ev ?? 0.5;

  const n_success = Math.max(1, Math.round(EXEMPLAR_N * (1 - ev)));
  const n_failure = Math.max(1, Math.round(EXEMPLAR_N * ev));

  // SurrealDB 3.x requires ORDER BY fields to be included in the SELECT clause.
  const successDigests = await surrealDB.query<{ id: string; execution_id: string }>(
    `SELECT id, execution_id, executed_at FROM trace_digest WHERE activity_id = $activity_id AND success = true ORDER BY executed_at DESC LIMIT $n`,
    { activity_id, n: n_success }
  );

  const failureDigests = await surrealDB.query<{ id: string; execution_id: string }>(
    `SELECT id, execution_id, executed_at FROM trace_digest WHERE activity_id = $activity_id AND success = false ORDER BY executed_at DESC LIMIT $n`,
    { activity_id, n: n_failure }
  );

  const exemplarsToInsert: { execution_id: string; digest_id: string; success: boolean }[] = [];
  const seenExecutionIds = new Set<string>();

  for (const d of (successDigests ?? [])) {
    if (!seenExecutionIds.has(d.execution_id)) {
      exemplarsToInsert.push({ execution_id: d.execution_id, digest_id: String(d.id), success: true });
      seenExecutionIds.add(d.execution_id);
    }
  }
  for (const d of (failureDigests ?? [])) {
    if (!seenExecutionIds.has(d.execution_id)) {
      exemplarsToInsert.push({ execution_id: d.execution_id, digest_id: String(d.id), success: false });
      seenExecutionIds.add(d.execution_id);
    }
  }

  // Atomically delete old exemplars and insert new ones in a single transaction.
  const statements = [`DELETE execution_exemplar WHERE activity_id = $activity_id;`];
  const params: Record<string, any> = { activity_id };

  exemplarsToInsert.forEach((exemplar, i) => {
    const execIdParam = `execution_id_${i}`;
    const digestIdParam = `digest_id_${i}`;
    statements.push(
      `INSERT INTO execution_exemplar { activity_id: $activity_id, execution_id: $${execIdParam}, success: ${String(
        exemplar.success
      )}, digest_id: $${digestIdParam}, org_id: 'public', selected_at: time::now() };`
    );
    params[execIdParam] = exemplar.execution_id;
    params[digestIdParam] = exemplar.digest_id;
  });

  await surrealDB.query(statements.join('\n'), params).catch(err => {
    logger.warn('exemplar update transaction failed', { activity_id, err: err instanceof Error ? err.message : String(err) });
  });

  logger.debug('[exemplar] selection complete', {
    activity_id, ev, n_success, n_failure,
    selected_success: successDigests?.length ?? 0,
    selected_failure: failureDigests?.length ?? 0,
  });
}

export async function selectExemplarsForAllActiveActivities(): Promise<ExemplarSelectResult> {
  const result: ExemplarSelectResult = { processed: 0, failed: 0 };

  const activities = await surrealDB.query<{ activity_id: string }>(
    `SELECT activity_id FROM trace_digest GROUP BY activity_id LIMIT 2000`
  );

  if (!activities || activities.length === 0) return result;

  logger.info('[exemplar] bulk selection starting', { total: activities.length, delay_ms: BULK_ACTIVITY_DELAY_MS });

  for (let i = 0; i < activities.length; i++) {
    const { activity_id } = activities[i];
    try {
      await selectExemplarsForActivity(activity_id);
      result.processed++;
    } catch (err) {
      logger.warn('[exemplar] selection failed for activity', { activity_id, err: err instanceof Error ? err.message : String(err) });
      result.failed++;
    }
    if (BULK_ACTIVITY_DELAY_MS > 0 && i < activities.length - 1) {
      await new Promise(resolve => setTimeout(resolve, BULK_ACTIVITY_DELAY_MS));
    }
  }

  logger.info('[exemplar] bulk selection complete', result);
  return result;
}

export async function incrementExemplarBurstCounter(activity_id: string): Promise<void> {
  if (!redis) return;
  try {
    const key = `${BURST_KEY_PREFIX}${activity_id}`;
    const current = parseInt((await redis.get(key)) ?? '0', 10);
    const next = current + 1;
    if (next >= BURST_THRESHOLD) {
      await redis.del(key);
      void selectExemplarsForActivity(activity_id).catch(err => {
        logger.warn('[exemplar] burst-trigger selection failed', { activity_id, err: err instanceof Error ? err.message : String(err) });
      });
    } else {
      await redis.set(key, String(next), 3600);
    }
  } catch {
    // Redis unavailable — skip silently
  }
}
