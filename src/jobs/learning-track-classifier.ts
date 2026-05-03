/**
 * Learning-track classifier job.
 *
 * Re-evaluates each activity template's learning_track field every 6h (default)
 * by observing signals from trace_digest rows. Three tracks:
 *   unclassified — not enough samples yet, or signals straddle thresholds
 *   learning     — template produces tasks and/or shapes; feeds Thompson posteriors
 *   system       — bookkeeping template (zero tasks, zero shapes); isolated to execution_system_traces
 *
 * Falls through gracefully on any error — a stale classification keeps prior routing,
 * which is exactly the desired null state.
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { bustLearningTrackCache, type LearningTrack } from '../lib/learning-track';

// Env-tunable constants
const SAMPLE_WINDOW = parseInt(process.env.LEARNING_TRACK_SAMPLE_WINDOW ?? '50', 10);
const MIN_SAMPLES = parseInt(process.env.LEARNING_TRACK_MIN_SAMPLES ?? '5', 10);
const CADENCE_MS = parseInt(process.env.LEARNING_TRACK_CADENCE_MS ?? String(6 * 60 * 60 * 1000), 10);

const THRESHOLDS = {
  taskLearning:  parseFloat(process.env.LEARNING_TRACK_TASK_LEARNING_THRESHOLD  ?? '1.0'),
  taskSystem:    parseFloat(process.env.LEARNING_TRACK_TASK_SYSTEM_THRESHOLD    ?? '0.5'),
  shapeLearning: parseFloat(process.env.LEARNING_TRACK_SHAPE_LEARNING_THRESHOLD ?? '1.0'),
  shapeSystem:   parseFloat(process.env.LEARNING_TRACK_SHAPE_SYSTEM_THRESHOLD   ?? '0.5'),
};

export interface ClassifierSignals {
  avg_task_count: number;
  avg_output_shape_count: number;
  declared_output_shapes_count: number;
  sample_count: number;
}

export interface ClassifyResult {
  from: LearningTrack;
  to: LearningTrack;
  signals: ClassifierSignals;
  skipped: boolean;
}

export interface CycleResult {
  evaluated: number;
  transitions: number;
  skipped_low_sample: number;
  transitions_to_learning: number;
  transitions_to_system: number;
  transitions_to_unclassified: number;
}

function determineTrack(signals: ClassifierSignals): LearningTrack {
  const { avg_task_count, avg_output_shape_count, declared_output_shapes_count, sample_count } = signals;

  if (sample_count < MIN_SAMPLES) return 'unclassified';

  // learning: sufficient tasks OR sufficient shapes OR template declares output shapes
  const isLearning =
    avg_task_count >= THRESHOLDS.taskLearning ||
    avg_output_shape_count >= THRESHOLDS.shapeLearning ||
    declared_output_shapes_count >= 1;

  // system: persistently zero tasks AND zero shapes AND no declared output shapes
  const isSystem =
    avg_task_count < THRESHOLDS.taskSystem &&
    avg_output_shape_count < THRESHOLDS.shapeSystem &&
    declared_output_shapes_count === 0;

  if (isLearning) return 'learning';
  if (isSystem) return 'system';
  return 'unclassified'; // ambiguous — straddles threshold gap
}

export async function classifyOneTemplate(activity_id: string): Promise<ClassifyResult> {
  // Fetch current track and declared output shapes from the activity table
  const activityRows = await surrealDB.query<{
    id: string;
    learning_track: string | null;
    last_classified_at: string | null;
    output_shapes: string[] | null;
  }>(
    `SELECT id, learning_track, last_classified_at, output_shapes FROM activity WHERE id = $id LIMIT 1`,
    { id: activity_id }
  );

  const activityRow = activityRows?.[0];
  const from: LearningTrack = (activityRow?.learning_track as LearningTrack) ?? 'unclassified';
  const declared_output_shapes_count = activityRow?.output_shapes?.length ?? 0;

  // Cadence guard
  if (activityRow?.last_classified_at) {
    const age = Date.now() - new Date(activityRow.last_classified_at).getTime();
    if (age < CADENCE_MS) {
      return { from, to: from, signals: { avg_task_count: 0, avg_output_shape_count: 0, declared_output_shapes_count, sample_count: 0 }, skipped: true };
    }
  }

  // Fetch recent trace_digest rows for this activity
  const digestRows = await surrealDB.query<{
    task_count: number;
    shape_count: number;
  }>(
    `
    SELECT
      array::len(task_summaries ?? []) AS task_count,
      array::len(output_impulse_shapes ?? []) AS shape_count,
      executed_at
    FROM trace_digest
    WHERE activity_id = $activity_id
    ORDER BY executed_at DESC
    LIMIT $limit
    `,
    { activity_id, limit: SAMPLE_WINDOW }
  );

  const sample_count = digestRows?.length ?? 0;

  if (sample_count < MIN_SAMPLES) {
    // Not enough data — always update last_classified_at to advance the cadence guard
    await surrealDB.query(
      `UPDATE activity SET last_classified_at = time::now() WHERE id = $id`,
      { id: activity_id }
    );
    return {
      from,
      to: from,
      signals: { avg_task_count: 0, avg_output_shape_count: 0, declared_output_shapes_count, sample_count },
      skipped: true,
    };
  }

  const avg_task_count = digestRows.reduce((s: number, r) => s + (r.task_count ?? 0), 0) / sample_count;
  const avg_output_shape_count = digestRows.reduce((s: number, r) => s + (r.shape_count ?? 0), 0) / sample_count;

  const signals: ClassifierSignals = {
    avg_task_count,
    avg_output_shape_count,
    declared_output_shapes_count,
    sample_count,
  };

  const to = determineTrack(signals);

  // Write the new track and advance last_classified_at regardless of transition
  await surrealDB.query(
    `UPDATE activity SET learning_track = $track, last_classified_at = time::now() WHERE id = $id`,
    { id: activity_id, track: to }
  );

  // Bust the in-process cache so the next write uses the new classification
  bustLearningTrackCache(activity_id);

  return { from, to, signals, skipped: false };
}

export async function runClassifierCycle(): Promise<CycleResult> {
  const result: CycleResult = {
    evaluated: 0,
    transitions: 0,
    skipped_low_sample: 0,
    transitions_to_learning: 0,
    transitions_to_system: 0,
    transitions_to_unclassified: 0,
  };

  // Fetch all template activity ids that are due for classification
  const templates = await surrealDB.query<{ id: string }>(
    `
    SELECT id FROM activity
    WHERE execution_type = 'template'
      AND (last_classified_at IS NONE OR last_classified_at < (time::now() - ${CADENCE_MS}ms))
    LIMIT 2000
    `
  );

  if (!templates || templates.length === 0) {
    logger.debug('[classifier] No templates due for classification');
    return result;
  }

  for (const { id } of templates) {
    try {
      const r = await classifyOneTemplate(id);
      result.evaluated++;
      if (r.skipped) {
        result.skipped_low_sample++;
        continue;
      }
      if (r.from !== r.to) {
        result.transitions++;
        if (r.to === 'learning') result.transitions_to_learning++;
        else if (r.to === 'system') result.transitions_to_system++;
        else result.transitions_to_unclassified++;
      }
    } catch (err) {
      logger.warn('[classifier] classifyOneTemplate failed; skipping', { activity_id: id, err: err instanceof Error ? err.message : String(err) });
    }
  }

  logger.info('[classifier] Cycle complete', result);
  return result;
}
