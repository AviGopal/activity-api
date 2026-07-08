/**
 * trace-digest.ts
 *
 * Backs the narrow `activity_execution_trace_digest` table used to avoid
 * full-scanning the large JSONB `activity_execution_traces` table.
 */

import { surrealDB, queryWithAuth } from './surreal';
import { logger } from '../utils/logger';

export interface TraceDigestRow {
  execution_id: string;
  activity_template_id: string | null;
  status: string;
  success: boolean;
  executed_at: string;
  duration_ms: number | null;
  output_shapes: string[];
  failure_mode_type: string | null;
  org_id: string | null;
  project_id: string | null;
}

export async function upsertTraceDigest(row: TraceDigestRow): Promise<void> {
  try {
    const sql = `
      UPSERT activity_execution_trace_digest
      SET
        execution_id          = $execution_id,
        activity_template_id  = $activity_template_id,
        status                = $status,
        success               = $success,
        executed_at           = $executed_at,
        duration_ms           = $duration_ms,
        output_shapes         = $output_shapes,
        failure_mode_type     = $failure_mode_type,
        org_id                = $org_id,
        project_id            = $project_id
      WHERE execution_id = $execution_id
    `;
    await surrealDB.query(sql, {
      execution_id:         row.execution_id,
      activity_template_id: row.activity_template_id,
      status:               row.status,
      success:              row.success,
      executed_at:          row.executed_at,
      duration_ms:          row.duration_ms,
      output_shapes:        row.output_shapes,
      failure_mode_type:    row.failure_mode_type,
      org_id:               row.org_id,
      project_id:           row.project_id,
    });
  } catch (err) {
    logger.warn('[trace-digest] upsertTraceDigest failed', {
      execution_id: row.execution_id,
      error: (err as Error).message,
    });
  }
}

export async function queryTraceDigestList(opts: {
  token?: string;
  limit: number;
  startDate?: string;
  endDate?: string;
  orgScoped?: boolean;
}): Promise<TraceDigestRow[]> {
  const conditions: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit };

  if (opts.startDate !== undefined) {
    conditions.push('executed_at >= $start_date');
    params['start_date'] = opts.startDate;
  }
  if (opts.endDate !== undefined) {
    conditions.push('executed_at <= $end_date');
    params['end_date'] = opts.endDate;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = [
    'SELECT execution_id, activity_template_id, status, success, executed_at,',
    '       duration_ms, output_shapes, failure_mode_type, org_id, project_id',
    'FROM activity_execution_trace_digest',
    where,
    'ORDER BY executed_at DESC LIMIT $limit',
  ]
    .filter((line) => line.trim().length > 0)
    .join(' ');

  if (opts.token !== undefined && opts.token.length > 0) {
    const rows = await queryWithAuth<TraceDigestRow>(opts.token, sql, params);
    return Array.isArray(rows) ? rows : [];
  }

  const result = await surrealDB.query<TraceDigestRow[]>(sql, params);
  const first = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(first) ? first : [];
}
