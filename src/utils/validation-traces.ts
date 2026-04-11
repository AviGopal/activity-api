/**
 * Validation Error Trace Capture
 *
 * Captures API validation errors as traces for pattern detection.
 * This enables the system to detect recurring schema issues like
 * snake_case vs camelCase mismatches and suggest/apply fixes.
 */

import { surrealDB } from '../db/surreal';
import { logger } from './logger';
import { createHash } from 'crypto';

/**
 * Structured validation error from Zod
 */
interface ValidationError {
  field_path: string[];
  expected_type: string;
  received_type: string;
  received_value?: unknown;
  code: string;
  message: string;
}

/**
 * API validation trace record
 */
interface ApiValidationTrace {
  trace_id: string;
  trace_type: 'api_validation_error';
  endpoint: string;
  method: string;
  timestamp: string;
  validation_errors: ValidationError[];
  request_payload_hash: string;
  caller_id?: string;
  caller_version?: string;
  org_id?: string;
  project_id?: string;
}

/**
 * Parse Zod errors into structured validation errors
 */
function parseZodErrors(zodErrors: any[]): ValidationError[] {
  return zodErrors.map(err => ({
    field_path: err.path || [],
    expected_type: err.expected || 'unknown',
    received_type: err.received || 'unknown',
    received_value: err.received !== 'undefined' ? undefined : err.received,
    code: err.code || 'unknown',
    message: err.message || '',
  }));
}

/**
 * Hash payload for deduplication (avoid storing sensitive data)
 */
function hashPayload(payload: any): string {
  const str = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash('sha256').update(str).digest('hex').substring(0, 16);
}

/**
 * Generate trace ID
 */
function generateTraceId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `vt_${timestamp}_${random}`;
}

/**
 * Capture a validation error as a trace
 *
 * @param endpoint - API endpoint path
 * @param method - HTTP method
 * @param zodErrors - Zod validation errors
 * @param payload - Original request payload (will be hashed)
 * @param context - Additional context (caller, org, project)
 */
export async function captureValidationTrace(
  endpoint: string,
  method: string,
  zodErrors: any[],
  payload: any,
  context?: {
    callerId?: string;
    callerVersion?: string;
    orgId?: string;
    projectId?: string;
  }
): Promise<void> {
  try {
    const trace: ApiValidationTrace = {
      trace_id: generateTraceId(),
      trace_type: 'api_validation_error',
      endpoint,
      method,
      timestamp: new Date().toISOString(),
      validation_errors: parseZodErrors(zodErrors),
      request_payload_hash: hashPayload(payload),
      caller_id: context?.callerId,
      caller_version: context?.callerVersion,
      org_id: context?.orgId,
      project_id: context?.projectId,
    };

    // Build query with only non-null fields (SurrealDB doesn't accept NULL for optional fields)
    // Use time::now() for timestamp since SurrealDB requires datetime type, not string
    const fields: string[] = [
      'trace_id = $trace_id',
      'trace_type = $trace_type',
      'endpoint = $endpoint',
      'method = $method',
      'timestamp = time::now()',
      'validation_errors = $validation_errors',
      'request_payload_hash = $request_payload_hash',
    ];
    const params: Record<string, any> = {
      trace_id: trace.trace_id,
      trace_type: trace.trace_type,
      endpoint: trace.endpoint,
      method: trace.method,
      validation_errors: trace.validation_errors,
      request_payload_hash: trace.request_payload_hash,
    };

    // Only include optional fields if they have values
    if (trace.caller_id) {
      fields.push('caller_id = $caller_id');
      params.caller_id = trace.caller_id;
    }
    if (trace.org_id) {
      fields.push('org_id = $org_id');
      params.org_id = trace.org_id;
    }
    if (trace.project_id) {
      fields.push('project_id = $project_id');
      params.project_id = trace.project_id;
    }

    const query = `CREATE api_validation_trace SET ${fields.join(', ')}`;

    // Fire and forget - don't block the response
    surrealDB.query(query, params).then(() => {
      logger.debug('Validation trace captured', {
        trace_id: trace.trace_id,
        endpoint,
        error_count: trace.validation_errors.length,
      });
    }).catch(err => {
      // Log but don't fail - trace capture is best-effort
      logger.warn('Failed to capture validation trace', {
        error: err.message,
        endpoint,
      });
    });

  } catch (error: any) {
    logger.warn('Error preparing validation trace', { error: error.message });
  }
}

/**
 * Detect patterns in recent validation errors
 * Returns field paths that have failed validation multiple times
 */
export async function detectValidationPatterns(
  timeWindowHours: number = 24,
  minFrequency: number = 3
): Promise<Array<{
  field_path: string;
  error_code: string;
  frequency: number;
  likely_cause: string;
  first_seen: string;
  last_seen: string;
}>> {
  try {
    // Note: SurrealDB doesn't support HAVING clause, so we filter in code
    const query = `
      SELECT
        string::join('.', validation_errors[0].field_path) as field_path,
        validation_errors[0].code as error_code,
        count() as frequency,
        math::min(timestamp) as first_seen,
        math::max(timestamp) as last_seen
      FROM api_validation_trace
      WHERE timestamp > time::now() - ${timeWindowHours}h
      GROUP BY field_path, error_code
      ORDER BY frequency DESC
    `;

    type ValidationPatternResult = {
      field_path: string;
      error_code: string;
      frequency: number;
      first_seen: string;
      last_seen: string;
    };

    const queryResults = await surrealDB.query<ValidationPatternResult[]>(query);
    const results = queryResults[0] || [];

    // Filter by minimum frequency (since SurrealDB doesn't support HAVING)
    return (Array.isArray(results) ? results : [])
      .filter((r: ValidationPatternResult) => r.frequency >= minFrequency)
      .map((r: ValidationPatternResult) => ({
        ...r,
        likely_cause: inferCause(r.field_path, r.error_code),
      }));
  } catch (error: any) {
    logger.error('Failed to detect validation patterns', { error: error.message });
    return [];
  }
}

/**
 * Infer the likely cause of a validation error
 */
function inferCause(fieldPath: string, errorCode: string): string {
  const fieldName = fieldPath.split('.').pop() || '';

  // Detect snake_case vs camelCase mismatch
  if (fieldName.includes('_')) {
    return 'snake_case_mismatch';
  }

  if (errorCode === 'invalid_type' && fieldPath.includes('undefined')) {
    return 'missing_field';
  }

  if (errorCode === 'invalid_enum_value') {
    return 'enum_mismatch';
  }

  return 'unknown';
}
