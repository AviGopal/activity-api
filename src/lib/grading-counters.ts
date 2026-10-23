/**
 * The grading writers' "nothing was graded" counters, in one payload, for GET /metrics/db (src/index.ts).
 *
 * Each counts, per process, a record that reached a learning route and was deliberately NOT graded, so a sender that
 * stops sending verdicts shows up here as a climbing count rather than as silence:
 *   goal_path_reach_ungraded  POST /v2/goal-paths records with no boolean `reached` (routes/goal-paths.ts); written nowhere.
 *   reach_declined_recorded   declined outcomes POST /reach recorded, ungraded (routes/execution-traces.ts).
 *   reach_declined_refused    declined outcomes POST /reach refused, by reason (forbidden / already_graded / ...).
 *   reach_observe_skips       observe executions and verdicts recorded with no learning write (lib/reach-classify.ts).
 * `since` is when this process started counting, so a reader can compare across restarts.
 */
const SINCE = new Date().toISOString();

export type GradingCounters = {
  since: string;
  goal_path_reach_ungraded: number;
  reach_declined_recorded: number;
  reach_declined_refused: Readonly<Record<string, number>>;
  reach_observe_skips: number;
};

export async function gradingCounters(): Promise<GradingCounters> {
  const gp = await import('../routes/goal-paths');
  const et = await import('../routes/execution-traces');
  return {
    since: SINCE,
    goal_path_reach_ungraded: gp.goalPathUngradedSkipCount(),
    reach_declined_recorded: et.declinedOutcomesRecordedCount(),
    reach_declined_refused: et.declinedOutcomesRefusedCounts(),
    reach_observe_skips: et.reachObserveSkips(),
  };
}
