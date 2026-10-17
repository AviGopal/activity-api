// A light-dispatched LLM task is learned from; a deterministic tool task still skips the tier-restricted bandit update.
// Gap: light-dispatch-stamps-every-task-deterministic-so-the-posterior-update-skips-them-and-selection-never-learns-from-
// light-dispatched-work. light-dispatch stops stamping resolver_tier "deterministic" on every task and records only
// resolver_id ("<vessel>:<shape>" or "<shape>"); the trace store classifies it here, with its existing tier-classifier.
// MUST-FAIL on the parent: classifyTraceTiers does not exist, and a task carrying only resolver_id classified as 'llm'
// whatever ran (the parent read `t.resolver`, which a persisted light-dispatch task never has).
import { describe, expect, test } from 'bun:test';
import { classifyTraceTiers } from './posterior-update';

describe('classifyTraceTiers: the resolver that ran decides a task without a stated tier', () => {
  test('[MUST-FAIL] an llm_completion_dispatch task recorded by light-dispatch (resolver_id only) is NOT all_deterministic, so it learns', () => {
    expect(classifyTraceTiers([{ id: 't1', resolver_id: 'llm-resolver-vessel:llm_completion_dispatch' }])).not.toBe('all_deterministic');
    expect(classifyTraceTiers([{ id: 't1', resolver_id: 'llm_completion_dispatch' }])).not.toBe('all_deterministic');
  });

  test('[CONTROL] a deterministic tool task recorded by light-dispatch (resolver_id only) still classifies all_deterministic, so it still skips', () => {
    expect(classifyTraceTiers([{ id: 't1', resolver_id: 'local-tools-vessel:bash' }])).toBe('all_deterministic');
    expect(classifyTraceTiers([{ id: 't1', resolver_id: 'git_status' }])).toBe('all_deterministic');
  });

  test('[CONTROL] a mixed trace (a tool then an llm call) is mixed, not skipped', () => {
    expect(classifyTraceTiers([{ resolver_id: 'x:bash' }, { resolver_id: 'y:llm_completion_dispatch' }])).toBe('mixed');
  });

  test('a stated tier still wins, as before (unchanged behaviour for callers that send one)', () => {
    expect(classifyTraceTiers([{ resolver_tier: 'deterministic', resolver_id: 'y:llm_completion_dispatch' }])).toBe('all_deterministic');
    expect(classifyTraceTiers([{ resolver_tier: 'llm' }])).toBe('all_stochastic');
    expect(classifyTraceTiers([{ resolver: 'bash' }])).toBe('all_deterministic');
  });

  test('an unknown resolver falls to a stochastic tier (it learns: the conservative direction)', () => {
    expect(classifyTraceTiers([{ resolver_id: 'some-vessel:never_heard_of_it' }])).toBe('all_stochastic');
    expect(classifyTraceTiers([{}])).toBe('all_stochastic');
  });
});
