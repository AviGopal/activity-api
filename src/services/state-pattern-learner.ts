/**
 * State Pattern Learner
 *
 * Automatically discovers patterns from execution_state_snapshot data.
 * NO predefined patterns - everything is learned from real executions.
 */

import { Database } from '../db.js';
import crypto from 'crypto';

export interface StateSnapshot {
  execution_id: string;
  trace_id: string;
  timestamp: Date;
  org_id: string;

  impulse_state: {
    total_impulses: number;
    loaded_impulses: number;
    impulse_types: Record<string, number>;
    impulses: Array<{
      id: string;
      type: string;
      loaded: boolean;
      budget: number;
      budget_used: number;
    }>;
  };

  activity_history: {
    last_activity_id?: string;
    last_activity_name?: string;
    last_success?: boolean;
    minutes_since_last?: number;
    activities_last_hour: string[];
    activities_last_day: string[];
  };

  git_state: {
    branch: string;
    total_changes: number;
    has_staged: boolean;
    has_code_changes: boolean;
    has_test_changes: boolean;
    has_activity_changes: boolean;
  };

  goal_context: {
    goal_description: string;
    goal_type: string;
    implied_shapes: string[];
  };

  selected_activity_id: string;
  selected_activity_name: string;

  outcome_success?: boolean;
  outcome_duration_ms?: number;
  outcome_cost_usd?: number;
}

export interface StateSignature {
  impulse_types_present: string[];
  last_activity_id?: string;
  has_git_changes: boolean;
  minutes_since_last_min?: number;
  minutes_since_last_max?: number;
  goal_type?: string;
}

export interface DiscoveredPattern {
  pattern_id: string;
  pattern_hash: string;
  org_id: string;
  state_signature: StateSignature;
  best_activity_id: string;
  best_activity_name: string;
  observations: number;
  recommendations: number;
  successes: number;
  failures: number;
  alpha: number;
  beta: number;
  success_rate: number;
  confidence: number;
}

export class StatePatternLearner {
  constructor(private db: Database) {}

  /**
   * Generate state signature from snapshot
   * This creates a canonical representation of the state for pattern matching
   */
  private extractStateSignature(snapshot: StateSnapshot): StateSignature {
    // Extract impulse types present (sorted for consistency)
    const impulseTypes = Object.keys(snapshot.impulse_state.impulse_types).sort();

    // Bucket time since last activity
    let minutesBucket: { min?: number; max?: number } | undefined;
    if (snapshot.activity_history.minutes_since_last !== undefined) {
      const minutes = snapshot.activity_history.minutes_since_last;
      // Bucket into ranges: 0-15, 15-60, 60-240, 240+
      if (minutes < 15) {
        minutesBucket = { min: 0, max: 15 };
      } else if (minutes < 60) {
        minutesBucket = { min: 15, max: 60 };
      } else if (minutes < 240) {
        minutesBucket = { min: 60, max: 240 };
      } else {
        minutesBucket = { min: 240 };
      }
    }

    return {
      impulse_types_present: impulseTypes,
      last_activity_id: snapshot.activity_history.last_activity_id,
      has_git_changes: snapshot.git_state.total_changes > 0,
      minutes_since_last_min: minutesBucket?.min,
      minutes_since_last_max: minutesBucket?.max,
      goal_type: snapshot.goal_context.goal_type
    };
  }

  /**
   * Hash state signature for pattern matching
   */
  private hashStateSignature(signature: StateSignature): string {
    const canonical = JSON.stringify(signature, Object.keys(signature).sort());
    return crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
  }

  /**
   * Update pattern statistics after an execution completes
   */
  async updatePatternsFromSnapshot(
    snapshotId: string,
    outcome: {
      success: boolean;
      duration_ms: number;
      cost_usd: number;
      summary: string;
    }
  ): Promise<void> {
    // 1. Get the state snapshot
    const snapshot = await this.db.query<StateSnapshot[]>(
      `SELECT * FROM execution_state_snapshot WHERE execution_id = $execution_id`,
      { execution_id: snapshotId }
    );

    if (!snapshot || snapshot.length === 0) {
      throw new Error(`Snapshot ${snapshotId} not found`);
    }

    const snap = snapshot[0];

    // 2. Update snapshot with outcome
    await this.db.query(
      `UPDATE execution_state_snapshot SET
        outcome_success = $success,
        outcome_duration_ms = $duration_ms,
        outcome_cost_usd = $cost_usd,
        outcome_summary = $summary
      WHERE execution_id = $execution_id`,
      {
        execution_id: snapshotId,
        success: outcome.success,
        duration_ms: outcome.duration_ms,
        cost_usd: outcome.cost_usd,
        summary: outcome.summary
      }
    );

    // 3. Extract state signature
    const signature = this.extractStateSignature(snap);
    const hash = this.hashStateSignature(signature);

    // 4. Find or create pattern
    let pattern = await this.db.query<DiscoveredPattern[]>(
      `SELECT * FROM discovered_state_pattern
       WHERE pattern_hash = $hash AND org_id = $org_id`,
      { hash, org_id: snap.org_id }
    );

    if (!pattern || pattern.length === 0) {
      // Create new pattern
      await this.db.query(
        `CREATE discovered_state_pattern SET
          pattern_id = $pattern_id,
          pattern_hash = $hash,
          org_id = $org_id,
          state_signature = $signature,
          best_activity_id = $activity_id,
          best_activity_name = $activity_name,
          observations = 1,
          recommendations = 1,
          successes = $successes,
          failures = $failures,
          alpha = $alpha,
          beta = $beta,
          success_rate = $success_rate,
          confidence = 0.1,
          last_observed = time::now(),
          enabled = true`,
        {
          pattern_id: `pattern_${hash}`,
          hash,
          org_id: snap.org_id,
          signature,
          activity_id: snap.selected_activity_id,
          activity_name: snap.selected_activity_name,
          successes: outcome.success ? 1 : 0,
          failures: outcome.success ? 0 : 1,
          alpha: outcome.success ? 2.0 : 1.0,
          beta: outcome.success ? 1.0 : 2.0,
          success_rate: outcome.success ? 1.0 : 0.0
        }
      );
    } else {
      // Update existing pattern
      const p = pattern[0];
      const newObservations = p.observations + 1;
      const newSuccesses = p.successes + (outcome.success ? 1 : 0);
      const newFailures = p.failures + (outcome.success ? 0 : 1);
      const newAlpha = p.alpha + (outcome.success ? 1 : 0);
      const newBeta = p.beta + (outcome.success ? 0 : 1);
      const newSuccessRate = newSuccesses / newObservations;

      // Confidence increases with observations (max 1.0)
      const newConfidence = Math.min(1.0, Math.log10(newObservations + 1) / 2);

      // If this activity performed better, update best_activity
      let bestActivityId = p.best_activity_id;
      let bestActivityName = p.best_activity_name;

      if (snap.selected_activity_id !== p.best_activity_id) {
        // Check if new activity has better success rate
        const activityPerf = await this.getActivityPerformanceInState(
          snap.selected_activity_id,
          hash,
          snap.org_id
        );
        const currentPerf = await this.getActivityPerformanceInState(
          p.best_activity_id,
          hash,
          snap.org_id
        );

        if (activityPerf.success_rate > currentPerf.success_rate) {
          bestActivityId = snap.selected_activity_id;
          bestActivityName = snap.selected_activity_name;
        }
      }

      await this.db.query(
        `UPDATE discovered_state_pattern SET
          observations = $observations,
          successes = $successes,
          failures = $failures,
          alpha = $alpha,
          beta = $beta,
          success_rate = $success_rate,
          confidence = $confidence,
          best_activity_id = $best_activity_id,
          best_activity_name = $best_activity_name,
          last_observed = time::now(),
          updated_at = time::now()
        WHERE pattern_hash = $hash AND org_id = $org_id`,
        {
          hash,
          org_id: snap.org_id,
          observations: newObservations,
          successes: newSuccesses,
          failures: newFailures,
          alpha: newAlpha,
          beta: newBeta,
          success_rate: newSuccessRate,
          confidence: newConfidence,
          best_activity_id: bestActivityId,
          best_activity_name: bestActivityName
        }
      );
    }

    // 5. Update activity-state affinity
    await this.updateActivityStateAffinity(
      snap.selected_activity_id,
      hash,
      snap.org_id,
      signature,
      outcome
    );

    // 6. Update state feature importance
    await this.updateFeatureImportance(snap, outcome.success);
  }

  /**
   * Get activity performance in a specific state
   */
  private async getActivityPerformanceInState(
    activityId: string,
    stateHash: string,
    orgId: string
  ): Promise<{ success_rate: number; executions: number }> {
    const result = await this.db.query<any[]>(
      `SELECT success_rate, executions FROM activity_state_affinity
       WHERE activity_id = $activity_id AND state_hash = $state_hash AND org_id = $org_id`,
      { activity_id: activityId, state_hash: stateHash, org_id: orgId }
    );

    if (!result || result.length === 0) {
      return { success_rate: 0, executions: 0 };
    }

    return result[0];
  }

  /**
   * Update activity-state affinity matrix
   */
  private async updateActivityStateAffinity(
    activityId: string,
    stateHash: string,
    orgId: string,
    stateConditions: StateSignature,
    outcome: { success: boolean; duration_ms: number; cost_usd: number }
  ): Promise<void> {
    const existing = await this.db.query<any[]>(
      `SELECT * FROM activity_state_affinity
       WHERE activity_id = $activity_id AND state_hash = $state_hash AND org_id = $org_id`,
      { activity_id: activityId, state_hash: stateHash, org_id: orgId }
    );

    if (!existing || existing.length === 0) {
      // Create new affinity record
      await this.db.query(
        `CREATE activity_state_affinity SET
          activity_id = $activity_id,
          state_hash = $state_hash,
          org_id = $org_id,
          state_conditions = $state_conditions,
          executions = 1,
          successes = $successes,
          failures = $failures,
          success_rate = $success_rate,
          avg_duration_ms = $duration_ms,
          avg_cost_usd = $cost_usd,
          alpha = $alpha,
          beta = $beta`,
        {
          activity_id: activityId,
          state_hash: stateHash,
          org_id: orgId,
          state_conditions: stateConditions,
          successes: outcome.success ? 1 : 0,
          failures: outcome.success ? 0 : 1,
          success_rate: outcome.success ? 1.0 : 0.0,
          duration_ms: outcome.duration_ms,
          cost_usd: outcome.cost_usd,
          alpha: outcome.success ? 2.0 : 1.0,
          beta: outcome.success ? 1.0 : 2.0
        }
      );
    } else {
      // Update existing affinity
      const aff = existing[0];
      const newExecs = aff.executions + 1;
      const newSuccesses = aff.successes + (outcome.success ? 1 : 0);
      const newFailures = aff.failures + (outcome.success ? 0 : 1);
      const newSuccessRate = newSuccesses / newExecs;

      // Running average for duration and cost
      const newAvgDuration = Math.round(
        (aff.avg_duration_ms * aff.executions + outcome.duration_ms) / newExecs
      );
      const newAvgCost =
        (aff.avg_cost_usd * aff.executions + outcome.cost_usd) / newExecs;

      await this.db.query(
        `UPDATE activity_state_affinity SET
          executions = $executions,
          successes = $successes,
          failures = $failures,
          success_rate = $success_rate,
          avg_duration_ms = $avg_duration_ms,
          avg_cost_usd = $avg_cost_usd,
          alpha = $alpha,
          beta = $beta,
          updated_at = time::now()
        WHERE activity_id = $activity_id AND state_hash = $state_hash AND org_id = $org_id`,
        {
          activity_id: activityId,
          state_hash: stateHash,
          org_id: orgId,
          executions: newExecs,
          successes: newSuccesses,
          failures: newFailures,
          success_rate: newSuccessRate,
          avg_duration_ms: newAvgDuration,
          avg_cost_usd: newAvgCost,
          alpha: aff.alpha + (outcome.success ? 1 : 0),
          beta: aff.beta + (outcome.success ? 0 : 1)
        }
      );
    }
  }

  /**
   * Update feature importance based on execution outcome
   */
  private async updateFeatureImportance(
    snapshot: StateSnapshot,
    success: boolean
  ): Promise<void> {
    const features: Array<{ name: string; type: string }> = [];

    // Impulse type features
    for (const impulseType of Object.keys(snapshot.impulse_state.impulse_types)) {
      features.push({ name: `impulse_type:${impulseType}`, type: 'impulse_type' });
    }

    // Recent activity feature
    if (snapshot.activity_history.last_activity_id) {
      features.push({
        name: `recent_activity:${snapshot.activity_history.last_activity_id}`,
        type: 'recent_activity'
      });
    }

    // Git state features
    if (snapshot.git_state.has_code_changes) {
      features.push({ name: 'git:code_changes', type: 'git_state' });
    }
    if (snapshot.git_state.has_test_changes) {
      features.push({ name: 'git:test_changes', type: 'git_state' });
    }
    if (snapshot.git_state.total_changes > 0) {
      features.push({ name: 'git:has_changes', type: 'git_state' });
    }

    // Goal type feature
    if (snapshot.goal_context.goal_type) {
      features.push({
        name: `goal_type:${snapshot.goal_context.goal_type}`,
        type: 'goal_type'
      });
    }

    // Update each feature
    for (const feature of features) {
      const existing = await this.db.query<any[]>(
        `SELECT * FROM state_feature_importance
         WHERE feature_name = $feature_name AND org_id = $org_id`,
        { feature_name: feature.name, org_id: snapshot.org_id }
      );

      if (!existing || existing.length === 0) {
        await this.db.query(
          `CREATE state_feature_importance SET
            feature_name = $feature_name,
            feature_type = $feature_type,
            org_id = $org_id,
            observations = 1,
            success_when_present = $success,
            failure_when_present = $failure,
            correlation_score = $correlation`,
          {
            feature_name: feature.name,
            feature_type: feature.type,
            org_id: snapshot.org_id,
            success: success ? 1 : 0,
            failure: success ? 0 : 1,
            correlation: success ? 1.0 : 0.0
          }
        );
      } else {
        const feat = existing[0];
        const newObs = feat.observations + 1;
        const newSuccess = feat.success_when_present + (success ? 1 : 0);
        const newFailure = feat.failure_when_present + (success ? 0 : 1);
        const newCorrelation = newSuccess / newObs;

        await this.db.query(
          `UPDATE state_feature_importance SET
            observations = $observations,
            success_when_present = $success,
            failure_when_present = $failure,
            correlation_score = $correlation,
            updated_at = time::now()
          WHERE feature_name = $feature_name AND org_id = $org_id`,
          {
            feature_name: feature.name,
            org_id: snapshot.org_id,
            observations: newObs,
            success: newSuccess,
            failure: newFailure,
            correlation: newCorrelation
          }
        );
      }
    }
  }

  /**
   * Get patterns that match the current state
   */
  async matchPatterns(
    currentState: Omit<StateSnapshot, 'selected_activity_id' | 'selected_activity_name' | 'execution_id' | 'trace_id'>,
    orgId: string
  ): Promise<Array<DiscoveredPattern & { match_score: number }>> {
    // Get all enabled patterns for this org
    const patterns = await this.db.query<DiscoveredPattern[]>(
      `SELECT * FROM discovered_state_pattern
       WHERE org_id = $org_id AND enabled = true AND confidence > 0.3
       ORDER BY observations DESC`,
      { org_id: orgId }
    );

    if (!patterns || patterns.length === 0) {
      return [];
    }

    const matches: Array<DiscoveredPattern & { match_score: number }> = [];

    for (const pattern of patterns) {
      const score = this.calculatePatternMatchScore(currentState, pattern.state_signature);

      if (score > 0.5) {  // Only include strong matches
        matches.push({ ...pattern, match_score: score });
      }
    }

    // Sort by match score descending
    return matches.sort((a, b) => b.match_score - a.match_score);
  }

  /**
   * Calculate how well a pattern matches the current state
   */
  private calculatePatternMatchScore(
    currentState: Omit<StateSnapshot, 'selected_activity_id' | 'selected_activity_name' | 'execution_id' | 'trace_id'>,
    signature: StateSignature
  ): number {
    let score = 0;
    let totalConditions = 0;

    // Check impulse types (weighted by importance)
    if (signature.impulse_types_present && signature.impulse_types_present.length > 0) {
      totalConditions++;
      const currentTypes = Object.keys(currentState.impulse_state.impulse_types);
      const matchCount = signature.impulse_types_present.filter(t =>
        currentTypes.includes(t)
      ).length;
      score += matchCount / signature.impulse_types_present.length;
    }

    // Check recent activity (exact match)
    if (signature.last_activity_id) {
      totalConditions++;
      if (currentState.activity_history.last_activity_id === signature.last_activity_id) {
        score += 1.0;
      }
    }

    // Check git changes
    if (signature.has_git_changes !== undefined) {
      totalConditions++;
      const hasChanges = currentState.git_state.total_changes > 0;
      if (hasChanges === signature.has_git_changes) {
        score += 1.0;
      }
    }

    // Check time since last activity
    if (signature.minutes_since_last_min !== undefined || signature.minutes_since_last_max !== undefined) {
      totalConditions++;
      const minutes = currentState.activity_history.minutes_since_last || Infinity;

      if (
        (signature.minutes_since_last_min === undefined || minutes >= signature.minutes_since_last_min) &&
        (signature.minutes_since_last_max === undefined || minutes <= signature.minutes_since_last_max)
      ) {
        score += 1.0;
      }
    }

    // Check goal type
    if (signature.goal_type) {
      totalConditions++;
      if (currentState.goal_context.goal_type === signature.goal_type) {
        score += 1.0;
      }
    }

    return totalConditions > 0 ? score / totalConditions : 0;
  }
}
