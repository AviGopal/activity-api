/**
 * repair-signature-consume.ts
 * Helpers for the repair-signature feedback loop (Thompson sampling, version-2 rows).
 */

/**
 * Returns the string if it matches /^[0-9a-f]{16}$/, otherwise null.
 */
export function validRepairSignature(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return /^[0-9a-f]{16}$/.test(v) ? v : null;
}

/**
 * Builds a template_id -> boost map from context_thompson_scores rows.
 * Only rows with n_observations >= 3 produce a boost = 2 * alpha / (alpha + beta).
 */
export function repairBoostFromRows(
  rows: Array<{ template_id: string; alpha: number; beta: number; n_observations: number }>
): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    if (row.n_observations >= 3) {
      const boost = (2 * row.alpha) / (row.alpha + row.beta);
      result.set(row.template_id, boost);
    }
  }
  return result;
}

/**
 * Returns the alpha/beta increments for a Bayesian prior update.
 */
export function priorRepairDelta(traceSuccess: boolean): { dAlpha: number; dBeta: number } {
  return traceSuccess ? { dAlpha: 1, dBeta: 0 } : { dAlpha: 0, dBeta: 1 };
}
