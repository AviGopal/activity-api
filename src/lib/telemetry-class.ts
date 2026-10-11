/**
 * The telemetry trace class, VETTED (migration 215; see lib/tuning-params TRACE_TELEMETRY_ACTIVITIES_PARAM).
 *
 * Declaring an activity id telemetry-class is a DELETION LEVER: trace retention drains its executions
 * first, and the shape counter stops counting it. So the declaration is only honoured for ids with no
 * reach-graded evidence. An id is REFUSED (logged, ignored) when either holds:
 *   - shape_score_counter has a row for it (a reach-graded, shaped execution was counted), or
 *   - a variant_performance_metrics row for it has thompson_alpha > 1 (it received reach CREDIT).
 *
 * Why α and not α+β: the learner's ungraded-failure arm (`failedByTask` in applyOutcomeToPosteriors)
 * charges β for failures that classifyReach deliberately leaves ungraded — telemetry included. On node 1
 * auth_resolve_v1 (no activity record, every row tagged telemetry:auth) carries VPM α 1 / β ~425k under
 * org `unknown` and no counter rows: β from that backdoor is not reach-graded evidence, so it must not
 * block the declaration. α only ever grows from a `reached` verdict (graded yield, floor > 0), so α > 1
 * is reach-graded credit by construction (decay pulls toward 1 but never reaches it).
 * Known gap: an UNSHAPED activity graded only `not-reached` (β only, no counter rows) is not protected —
 * its β is indistinguishable from failedByTask β with the data stored today.
 *
 * FAIL CLOSED: if the evidence read fails, every declared id is refused for this round.
 * NO FORCE OVERRIDE: POST /v2/tuning-params requires a policy-write principal only for the rows in
 * src/policy/gate-input-rows.ts GATE_INPUT_ROWS; this row is not one, so any authenticated API key
 * or JWT may author it, and a force flag would be exactly as strong as the declaration it
 * overrides. Not implemented until writes to this row are authority-gated.
 */
import { surrealDB } from '../db/surreal';
import { withDeadline } from './deadline';
import { logger } from '../utils/logger';
import { getTuningParamList, TRACE_TELEMETRY_ACTIVITIES_PARAM } from './tuning-params';

export interface TelemetryClass {
  accepted: string[];
  refused: Array<{ activity_id: string; reason: string }>;
}

const TTL_MS = 30_000;
let cached: { value: TelemetryClass; expiresAt: number } | null = null;

// BOUNDED (both reads carry a server TIMEOUT, and the call a client deadline): this read runs inside
// the retention valve, which holds the sweep's in-flight flag, so it must never await forever. A
// timeout is an evidence-read failure and fails closed like any other. The counter read is a table
// scan of shape_score_counter (no activity_id-leading index; the table is one row per shape group,
// tens of rows on the hub), the VPM read is two idx_variant_performance_variant_id lookups.
export const EVIDENCE_TIMEOUT_S = 10;
const EVIDENCE_SQL = `
LET $__c = (SELECT count() AS n FROM shape_score_counter WHERE activity_id = $aid GROUP ALL TIMEOUT ${EVIDENCE_TIMEOUT_S}s)[0].n ?? 0;
LET $__a = (SELECT VALUE thompson_alpha FROM variant_performance_metrics WHERE variant_id = $aid OR variant_id = $br TIMEOUT ${EVIDENCE_TIMEOUT_S}s);
RETURN { counter_rows: $__c, max_alpha: math::max(array::concat([1.0], $__a)) };`;

export async function resolveTelemetryClass(): Promise<TelemetryClass> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const declared = await getTuningParamList(TRACE_TELEMETRY_ACTIVITIES_PARAM);
  const out: TelemetryClass = { accepted: [], refused: [] };
  for (const raw of declared) {
    const aid = raw.replace(/^activity:/, '').replace(/[⟨⟩`]/g, '');
    let reason: string | null = null;
    const started = Date.now();
    try {
      const res = await withDeadline(
        surrealDB.queryAll(EVIDENCE_SQL, { aid, br: `activity:⟨${aid}⟩` }),
        (2 * EVIDENCE_TIMEOUT_S + 5) * 1000,
        `telemetry-class evidence read for ${aid}`,
      );
      const ev = (Array.isArray(res) ? res : []).filter((r): r is { counter_rows: number; max_alpha: number } =>
        !!r && typeof r === 'object' && 'counter_rows' in (r as object)).pop();
      if (!ev) reason = 'evidence read returned nothing (fail closed)';
      else if (Number(ev.counter_rows) > 0) reason = `${ev.counter_rows} shape_score_counter row(s): reach-graded shaped executions`;
      else if (Number(ev.max_alpha) > 1) reason = `variant_performance_metrics thompson_alpha ${Number(ev.max_alpha).toFixed(3)} > 1: reach credit received`;
    } catch (err) {
      reason = `evidence read failed (fail closed): ${err instanceof Error ? err.message : String(err)}`;
    }
    logger.info('[telemetry-class] evidence read', {
      event: 'telemetry_class_evidence', activity_id: aid, ms: Date.now() - started, accepted: reason === null,
    });
    if (reason) out.refused.push({ activity_id: aid, reason });
    else out.accepted.push(aid);
  }
  for (const r of out.refused) {
    logger.warn('[telemetry-class] declaration REFUSED: graded evidence (not drained first, still counted)', {
      event: 'telemetry_class_refused', param: TRACE_TELEMETRY_ACTIVITIES_PARAM, activity_id: r.activity_id, reason: r.reason,
    });
  }
  cached = { value: out, expiresAt: now + TTL_MS };
  return out;
}

/** Test hook — drop the cache so a changed declaration or evidence is observed immediately. */
export function __clearTelemetryClassCache(): void {
  cached = null;
}
