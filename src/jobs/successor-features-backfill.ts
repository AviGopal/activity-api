import { updateSuccessorFeatures } from '../lib/successor-features';
import { logger } from '../utils/logger';

export async function runSuccessorFeaturesBackfill(
  surrealDB: any,
): Promise<{ backfilled: number; skipped: number }> {
  let backfilled = 0;
  let skipped = 0;

  const cellRows: { activity_id: string }[][] = await surrealDB.query(
    'SELECT activity_id FROM variant_performance_metrics WHERE total_executions > 0',
  );
  const cells: { activity_id: string }[] = cellRows.flat();

  const coveredRows: { template_id: string }[][] = await surrealDB.query(
    'SELECT template_id FROM successor_features',
  );
  const covered = new Set<string>(coveredRows.flat().map((r) => r.template_id));

  for (const cell of cells) {
    const id = cell.activity_id;
    if (covered.has(id)) {
      skipped++;
      continue;
    }
    try {
      const traceRows: { signature: any; output_impulse_shapes: any; org_id: string }[][] =
        await surrealDB.query(
          'SELECT signature, output_impulse_shapes, org_id FROM activity_execution_traces WHERE (variant_id = $id OR variant_id = $prefixed) AND signature != NONE ORDER BY created_at DESC LIMIT 5',
          { id, prefixed: 'activity:' + id },
        );
      const traces: { signature: any; output_impulse_shapes: any; org_id: string }[] =
        traceRows.flat();

      let updatedCount = 0;
      for (const row of traces) {
        await updateSuccessorFeatures(
          {
            activity_id: id,
            signature: row.signature,
            output_impulse_shapes: row.output_impulse_shapes,
          },
          surrealDB,
          row.org_id,
        );
        updatedCount++;
      }

      if (updatedCount >= 1) {
        backfilled++;
      } else {
        skipped++;
      }
    } catch (err) {
      logger.warn('[SF-backfill] error processing cell', { id, error: String(err) });
      skipped++;
    }
  }

  return { backfilled, skipped };
}
