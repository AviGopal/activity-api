/**
 * Check — decision_outcome at the universal ingest path.
 *
 * GOAL: on the universal path (recordExecutionDecisionOutcome — the writer
 * posterior-update invokes at trace-ingest) the decision_outcome row must be
 * joinable to the decision that produced it (decision_id lifted from the
 * `decision:<id>` tag) and its predicted_success must be the prediction
 * recorded AT DECISION TIME, not the posterior read at ingest.
 *
 * Today the writer keys the row on the execution id
 * (`UPSERT type::thing('decision_outcome', $eid) MERGE $content` with
 * `eid = input.executionId`) and reads the prediction from
 * variant_performance_metrics after the fact. A graded outcome therefore
 * cannot be joined back to its decision, and calibration compares the outcome
 * against a prediction made afterwards.
 *
 * This check is RED now and goes GREEN when that write carries the decision id
 * and the decision-time prediction.
 */
import { describe, expect, test } from 'bun:test';
import * as mod from '../../src/lib/decision-credit';

const DECISION_ID = 'decision-row-1';
const EXECUTION_ID = 'exec-check-1';

interface QueryCall {
  sql: string;
  params?: Record<string, unknown>;
}

const WRITE_RE = /^\s*(UPSERT|UPDATE|INSERT|CREATE|RELATE)\b/i;

/**
 * Recorded fake DB.
 *  - the variant_performance_metrics posterior read (the ingest-time arm
 *    posterior) answers 5 alpha / 5 beta -> 0.5, which is NOT the prediction
 *    that was recorded at decision time;
 *  - a non-write read of the decision answers predicted_success 0.9, the value
 *    recorded at decision time.
 */
function makeRecordedDb(calls: QueryCall[]): mod.DecisionCreditDB {
  const query = async (sql: string, params?: Record<string, unknown>): Promise<unknown[]> => {
    calls.push({ sql, params });
    if (/variant_performance_metrics/i.test(sql)) {
      return [{ thompson_alpha: 5, thompson_beta: 5 }];
    }
    if (!WRITE_RE.test(sql) && /decision/i.test(sql)) {
      return [
        {
          decision_id: DECISION_ID,
          predicted_success: 0.9,
          alternatives: [{ activity_id: 'activity:other', predicted_success: 0.1 }],
          propensity: 0.25,
        },
      ];
    }
    return [];
  };
  return { query } as unknown as mod.DecisionCreditDB;
}

describe('decision_outcome is keyed on the decision and predicted at decision time', () => {
  test('universal ingest-path write joins on the decision and keeps the decision-time prediction', async () => {
    const calls: QueryCall[] = [];
    const db = makeRecordedDb(calls);

    const input = {
      executionId: EXECUTION_ID,
      activityId: 'activity:check',
      orgId: 'org:check',
      success: true,
      reached: true,
      executedAt: '2026-11-03T00:00:00.000Z',
      decisionId: DECISION_ID,
      decision_id: DECISION_ID,
      decisionTag: `decision:${DECISION_ID}`,
      tags: [`decision:${DECISION_ID}`],
      predictedSuccess: 0.9,
      predicted_success: 0.9,
      alternatives: [{ activity_id: 'activity:other', predicted_success: 0.1 }],
      propensity: 0.25,
    } as unknown as mod.ExecutionDecisionOutcomeInput;

    const record = await mod.recordExecutionDecisionOutcome(db, input);
    expect(record).not.toBeNull();

    const write = calls.find((c) => /decision_outcome/i.test(c.sql) && WRITE_RE.test(c.sql));
    expect(write).toBeDefined();
    if (!write) throw new Error('recordExecutionDecisionOutcome issued no decision_outcome write');

    const content = (write.params?.content ?? {}) as Record<string, unknown>;
    const rowKey = content.decision_id ?? write.params?.eid;
    const landsOnDecision = rowKey === DECISION_ID || write.sql.includes(DECISION_ID);

    // (1) a graded outcome must join to the decision that produced it.
    expect(landsOnDecision).toBe(true);

    // (2) predicted_success must be the decision-time prediction (0.9), never
    //     the posterior read at ingest (5/(5+5) = 0.5).
    expect(content.predicted_success).not.toBe(0.5);
    expect(content.predicted_success).toBe(0.9);
  });

  test('control: a correction with no execution or correlation id changes nothing', async () => {
    const calls: QueryCall[] = [];
    const db = makeRecordedDb(calls);

    const changed = await mod.correctExecutionDecisionOutcome(db, {
      executionId: '',
      correlationId: null,
      correction: {
        correction_of: 'reach:control',
        list_sha: 'control-sha',
        rule: 'control-rule',
        commit: 'control-commit',
      },
    });

    expect(changed).toBe(0);
    expect(calls.length).toBe(0);
  });
});
