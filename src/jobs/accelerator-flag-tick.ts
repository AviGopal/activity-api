import { surrealDB } from '../db/surreal';
import { getTuningParam, writeTuningParam } from '../lib/tuning-params';
import { logger } from '../utils/logger';

interface CountResult {
  count: number;
}

interface ThompsonRow {
  template_id: string;
  context_bucket: string;
  alpha: number;
  beta: number;
  n_observations: number;
}

interface VariantMetricsRow {
  template_id: string;
  alpha: number;
  beta: number;
  n_observations: number;
}

interface FlagResult {
  flag: string;
  value: number;
  flipped: boolean;
  evidence: string;
}

async function evaluateRepairSignatureConsume(): Promise<FlagResult> {
  const flag = 'REPAIR_SIGNATURE_CONSUME';
  const q = 'SELECT count() FROM context_thompson_scores WHERE signature_version = 2 GROUP ALL';
  const rows = await surrealDB.query<CountResult>(q);
  const count = rows[0]?.count ?? 0;
  const evidence = `signature_v2_rows=${count}`;
  const desired = count >= 5 ? 1 : 0;
  const current = await getTuningParam(flag, undefined, 0);
  // monotone ON: never flip OFF automatically
  const next = current === 1 ? 1 : desired;
  let flipped = false;
  if (next !== current) {
    await writeTuningParam(flag, next);
    flipped = true;
    logger.warn(`[flag-policy] ${flag} evidence=${evidence} value=${next} flipped=true`);
  } else {
    logger.info(`[flag-policy] ${flag} evidence=${evidence} value=${next} flipped=false`);
  }
  return { flag, value: next, flipped, evidence };
}

async function evaluateSfBlend(): Promise<FlagResult> {
  const flag = 'SF_BLEND';
  const q = 'SELECT count() FROM successor_features GROUP ALL';
  const rows = await surrealDB.query<CountResult>(q);
  const count = rows[0]?.count ?? 0;
  const evidence = `sf_rows=${count}`;
  const desired = count >= 200 ? 1 : 0;
  const current = await getTuningParam(flag, undefined, 0);
  const next = current === 1 ? 1 : desired;
  let flipped = false;
  if (next !== current) {
    await writeTuningParam(flag, next);
    flipped = true;
    logger.warn(`[flag-policy] ${flag} evidence=${evidence} value=${next} flipped=true`);
  } else {
    logger.info(`[flag-policy] ${flag} evidence=${evidence} value=${next} flipped=false`);
  }
  return { flag, value: next, flipped, evidence };
}

async function evaluateCrossSigReputationPenalty(): Promise<FlagResult> {
  const flag = 'CROSS_SIG_REPUTATION_PENALTY';
  const localQ =
    'SELECT template_id, context_bucket, alpha, beta, n_observations FROM context_thompson_scores WHERE signature_version = 1 AND n_observations >= 5 LIMIT 500';
  const localRows = await surrealDB.query<ThompsonRow>(localQ);

  let gamingCandidates = 0;
  let evidence = `local_rows=${localRows.length}`;

  if (localRows.length > 0) {
    // Collect unique template ids
    const templateIds = [...new Set(localRows.map((r) => r.template_id))];

    // Fetch global posteriors for these templates
    const globalQ =
      'SELECT template_id, alpha, beta, n_observations FROM variant_performance_metrics WHERE template_id IN $ids';
    const globalRows = await surrealDB.query<VariantMetricsRow>(globalQ, { ids: templateIds });

    const globalMap = new Map<string, VariantMetricsRow>();
    for (const g of globalRows) {
      globalMap.set(g.template_id, g);
    }

    for (const row of localRows) {
      const localMean = row.alpha / (row.alpha + row.beta);
      const global = globalMap.get(row.template_id);
      if (global !== undefined && global.n_observations >= 5) {
        const globalMean = global.alpha / (global.alpha + global.beta);
        if (localMean - globalMean > 0.3) {
          gamingCandidates += 1;
        }
      }
    }
    evidence = `local_rows=${localRows.length} gaming_candidates=${gamingCandidates}`;
  }

  const desired = gamingCandidates >= 1 ? 1 : 0;
  const current = await getTuningParam(flag, undefined, 0);
  const next = current === 1 ? 1 : desired;
  let flipped = false;
  if (next !== current) {
    await writeTuningParam(flag, next);
    flipped = true;
    logger.warn(`[flag-policy] ${flag} evidence=${evidence} value=${next} flipped=true`);
  } else {
    logger.info(`[flag-policy] ${flag} evidence=${evidence} value=${next} flipped=false`);
  }
  return { flag, value: next, flipped, evidence };
}

export async function runAcceleratorFlagTick(): Promise<FlagResult[]> {
  const results: FlagResult[] = [];

  try {
    const r = await evaluateRepairSignatureConsume();
    results.push(r);
  } catch (err) {
    logger.warn('[flag-policy] REPAIR_SIGNATURE_CONSUME evaluation failed', { error: String(err) });
  }

  try {
    const r = await evaluateSfBlend();
    results.push(r);
  } catch (err) {
    logger.warn('[flag-policy] SF_BLEND evaluation failed', { error: String(err) });
  }

  try {
    const r = await evaluateCrossSigReputationPenalty();
    results.push(r);
  } catch (err) {
    logger.warn('[flag-policy] CROSS_SIG_REPUTATION_PENALTY evaluation failed', { error: String(err) });
  }

  return results;
}
