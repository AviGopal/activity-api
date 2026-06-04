import { describe, expect, test } from 'bun:test';
import { classifyResolver, classifyTemplateTiers } from '../src/services/tier-classifier';

describe('classifyResolver', () => {
  test('known deterministic resolvers', () => {
    expect(classifyResolver('bash')).toBe('deterministic');
    expect(classifyResolver('file_read')).toBe('deterministic');
    expect(classifyResolver('iteration')).toBe('deterministic');
    expect(classifyResolver('validation')).toBe('deterministic');
  });
  test('known llm resolvers', () => {
    expect(classifyResolver('llm')).toBe('llm');
    expect(classifyResolver('llm-prompt')).toBe('llm');
  });
  test('unknown resolver → pattern (stochastic)', () => {
    expect(classifyResolver('some-vessel-resolver')).toBe('pattern');
  });
  test('missing resolver → llm (conservative)', () => {
    expect(classifyResolver(undefined)).toBe('llm');
    expect(classifyResolver(null as any)).toBe('llm');
    expect(classifyResolver('')).toBe('llm');
  });
});

describe('classifyTemplateTiers', () => {
  test('all deterministic tasks', () => {
    const t = { tasks: [{ resolver: 'bash' }, { resolver: 'file_read' }, { resolver: 'validation' }] };
    expect(classifyTemplateTiers(t)).toBe('all_deterministic');
  });
  test('all llm tasks', () => {
    const t = { tasks: [{ resolver: 'llm-prompt' }, { resolver: 'llm' }] };
    expect(classifyTemplateTiers(t)).toBe('all_stochastic');
  });
  test('mixed tasks', () => {
    const t = { tasks: [{ resolver: 'bash' }, { resolver: 'llm-prompt' }] };
    expect(classifyTemplateTiers(t)).toBe('mixed');
  });
  test('prompt-only task counts as stochastic', () => {
    const t = { tasks: [{ resolver: 'bash' }, { prompt: 'do thing' }] };
    expect(classifyTemplateTiers(t)).toBe('mixed');
  });
  test('no tasks → conservative stochastic', () => {
    expect(classifyTemplateTiers({})).toBe('all_stochastic');
    expect(classifyTemplateTiers({ tasks: [] })).toBe('all_stochastic');
    expect(classifyTemplateTiers({ tasks: null as any })).toBe('all_stochastic');
  });
  test('unknown resolver counts as stochastic (pattern tier)', () => {
    const t = { tasks: [{ resolver: 'bash' }, { resolver: 'mystery-resolver' }] };
    expect(classifyTemplateTiers(t)).toBe('mixed');
  });
});
