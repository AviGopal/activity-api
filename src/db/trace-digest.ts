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
      INSERT INTO activity_execution_trace_digest {
        execution_id: $execution_id,
        activity_template_id: $activity_template_id,
        status: $status,
        success: $success,
        executed_at: $executed_at,
        duration_ms: $duration_ms,
        output_shapes: $output_shapes,
        failure_mode_type: $failure_mode_type,
        org_id: $org_id,
        project_id: $project_id
      } ON DUPLICATE KEY UPDATE
        activity_template_id = $activity_template_id,
        status = $status,
        success = $success,
        executed_at = $executed_at,
        duration_ms = $duration_ms,
        output_shapes = $output_shapes,
        failure_mode_type = $failure_mode_type,
        org_id = $org_id,
        project_id = $project_id
    `;
    await surrealDB.query(sql, {
      execution_id: row.execution_id,
      activity_template_id: row.activity_template_id,
      status: row.status,
      success: row.success,
      executed_at: row.executed_at,
      duration_ms: row.duration_ms,
      output_shapes: row.output_shapes,
      failure_mode_type: row.failure_mode_type,
      org_id: row.org_id,
      project_id: row.project_id,
    });
  } catch (err) {
    logger.warn('[trace-digest] upsertTraceDigest failed', { error: (err as Error).message });
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

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `SELECT execution_id, activity_template_id, status, success, executed_at, duration_ms, output_shapes, failure_mode_type, org_id, project_id FROM activity_execution_trace_digest ${whereClause} ORDER BY executed_at DESC LIMIT $limit`;

  if (opts.token !== undefined) {
    const result = await queryWithAuth(opts.token, sql, params);
    if (Array.isArray(result)) {
      return result as TraceDigestRow[];
    }
    return [];
  }

  const result = await surrealDB.query<TraceDigestRow[]>(sql, params);
  const first = Array.isArray(result) ? result[0] : undefined;
  if (Array.isArray(first)) {
    return first;
  }
  return [];
}
