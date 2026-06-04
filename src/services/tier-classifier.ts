/**
 * Tier classifier for templates (2026-06-04 tier-restricted-bandit).
 *
 * Maps a template's `tasks[].resolver` strings to a tier classification.
 * Used to skip Thompson Sampling posterior maintenance on all-deterministic
 * templates (deterministic cells have degenerate transition kernels and a
 * Beta posterior on them captures propagated upstream uncertainty rather
 * than cell-local signal).
 *
 * The deterministic-resolver set mirrors the built-in resolver inventory
 * in `src/routes/activities.ts:3708-3723`. Unknown / missing resolvers
 * fall through to the stochastic path (conservative).
 */

const DETERMINISTIC_RESOLVERS: ReadonlySet<string> = new Set([
  // ias-executor-ts deterministic resolvers
  'compose',
  'activity',
  'iteration',
  'impulse-resolve',
  'validation',
  'impulse_pool_selection',
  'producer_selection',
  'impulse_preparation',
  'wire_discovery_registration',
  'wire_auth_blueprint',
  'learning_signal_writer',
  'verify_three_invariants',
  // goal-host / drafter prompt rules — these are the substrate's primary
  // deterministic resolver names per draft-gap-closing-activity.ts
  // RESOLVER RULE 1 ("Use ONLY these resolver names").
  'fs_read',
  'fs_write',
  'file_read',
  'http_fetch',
  'json_path_extract',
  'bash',
  // git resolvers (per dev-vessel scaffold)
  'git_status',
  'git_diff',
  'git_log',
  'git_add',
  'git_commit',
  // activity-api built-ins seen in seed templates
  'activity_fetch',
  'activity_create_variant',
  'activity_recommendation',
  'impulse_cooccurrence',
  // resolver-tier-named deterministic substrate resolvers
  'systemd_restart',
  'docker_cp',
]);

const LLM_RESOLVERS: ReadonlySet<string> = new Set([
  'llm',
  'llm-prompt',
]);

export type TierClass = 'all_deterministic' | 'mixed' | 'all_stochastic';

export type ResolverTier = 'deterministic' | 'pattern' | 'llm';

export function classifyResolver(resolver: string | undefined | null): ResolverTier {
  if (!resolver || typeof resolver !== 'string') return 'llm';
  if (DETERMINISTIC_RESOLVERS.has(resolver)) return 'deterministic';
  if (LLM_RESOLVERS.has(resolver)) return 'llm';
  // Unknown registered resolver — treat as pattern (still stochastic).
  return 'pattern';
}

export interface TemplateLike {
  tasks?: Array<{
    resolver?: string;
    prompt?: unknown;
  }> | null;
}

export function classifyTemplateTiers(template: TemplateLike): TierClass {
  const tasks = template?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    // No tasks declared → conservative stochastic.
    return 'all_stochastic';
  }
  let detCount = 0;
  let stochCount = 0;
  for (const task of tasks) {
    // A task with a `prompt` and no `resolver` is an LLM-prompt task.
    if (!task?.resolver && task?.prompt) {
      stochCount++;
      continue;
    }
    const tier = classifyResolver(task?.resolver);
    if (tier === 'deterministic') detCount++;
    else stochCount++;
  }
  if (stochCount === 0) return 'all_deterministic';
  if (detCount === 0) return 'all_stochastic';
  return 'mixed';
}
