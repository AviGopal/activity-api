/**
 * Template Audit Report Tests
 *
 * Unit tests for the `templateAuditReport` resolver. Exercise the pure audit
 * logic with hand-crafted in-memory template rows — no real DB. The `db`
 * argument to `runTemplateAuditReport` is a minimal mock whose `query()`
 * returns canned rows per table.
 *
 * Coverage targets (from the commit spec):
 *   - Template with all deficiencies
 *   - Well-formed template
 *   - Alias detection integration
 *   - Hardcoded URL detection
 *   - Proposals populated from analyzeTaskSemantics
 *   - De-duplication between `activity` and `activity_template` tables
 *   - Default-shape (migration-044) recognition
 */

import { describe, test, expect } from 'bun:test';
import type { Surreal } from 'surrealdb';

import {
  runTemplateAuditReport,
  _internals,
  type TemplateAuditInput,
  type AuditAuthContext,
} from './template-audit';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Build a fake Surreal client that returns canned rows keyed by table name.
 * The audit resolver runs `SELECT ... FROM activity` and `SELECT ... FROM
 * activity_template` (and also `observeShapes` does two queries on the same
 * tables). We return the same canned rows for both tables per test unless
 * the test opts for different overrides.
 */
function makeDb(rowsByTable: Record<string, unknown[]>): Surreal {
  return {
    query: async (sql: string) => {
      // Very small SQL sniffer: pick the first table name after FROM.
      const m = sql.match(/\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
      const table = m ? m[1] : '';
      const rows = rowsByTable[table] ?? [];
      return [rows];
    },
  } as unknown as Surreal;
}

const defaultAuth: AuditAuthContext = {
  orgId: 'test-org',
  authType: 'apikey',
};

function emptyInput(overrides: Partial<TemplateAuditInput> = {}): TemplateAuditInput {
  return {
    includeProposals: false,
    includeAliasWarnings: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fullyDeficientTemplate = {
  id: 'activity:bad-template',
  name: 'bad',
  scope: 'global',
  description: 'short', // < 50 chars -> weak_description
  tags: [],
  input_shapes: [],
  output_shapes: [],
  tasks: [
    {
      id: 'step-1',
      description: 'do an LLM thing',
      prompt: {
        template: 'Call the service at https://api.metabob.local/v2/hardcoded and do stuff',
      },
      // no outputShapes, no outputImpulses, no resolver
    },
    {
      id: 'step-2',
      description: 'another LLM thing',
      prompt: { template: 'More LLM reasoning referencing http://internal.metabob.local' },
    },
  ],
};

const wellFormedTemplate = {
  id: 'activity:good-template',
  name: 'good',
  scope: 'org',
  description:
    'A thoroughly documented template that fixes failing tests in the activity-api by running jest and patching the offending source file.',
  tags: ['bugfix', 'development.testing', 'tool.code.test'],
  input_shapes: ['error', 'source_code', 'test_suite'],
  output_shapes: ['patch', 'test_suite'],
  tasks: [
    {
      id: 'resolver-step',
      description: 'Run tests',
      resolver: { id: 'bash', config: { command: 'bun test' } },
      outputShapes: ['test_suite'],
    },
    {
      id: 'llm-step',
      description: 'Patch failing source file',
      prompt: { template: 'Fix the failing test in {{file}}' },
      outputImpulses: ['patch'],
    },
  ],
};

const defaultShapesTemplate = {
  // Matches migration-044 default combinations: input ['goal'], output ['patch'].
  id: 'activity:default-shapes',
  name: 'defaults',
  scope: 'global',
  description:
    'Template whose shapes were auto-filled by migration 044 and never curated by an author with specific intent.',
  tags: ['meta'],
  input_shapes: ['goal'],
  output_shapes: ['patch'],
  tasks: [
    {
      id: 'step',
      description: 'do the thing',
      resolver: { id: 'bash', config: { command: 'echo ok' } },
      outputShapes: ['patch'],
    },
  ],
};

// ---------------------------------------------------------------------------
// Audit row computation (via internals for focused assertions)
// ---------------------------------------------------------------------------

describe('auditRow (internal)', () => {
  test('fully deficient template flags every boolean marker', () => {
    const row = _internals.auditRow(fullyDeficientTemplate as any, false);
    expect(row.id).toBe('bad-template');
    expect(row.deficiencies.missing_input_shapes).toBe(true);
    expect(row.deficiencies.missing_output_shapes).toBe(true);
    expect(row.deficiencies.missing_tags).toBe(true);
    expect(row.deficiencies.weak_description).toBe(true);
    expect(row.deficiencies.all_llm_tasks).toBe(true);
    expect(row.deficiencies.no_task_outputs).toBe(true);
    expect(row.deficiencies.hardcoded_urls.length).toBeGreaterThan(0);
    // default_shapes should be false (nothing to match the default combos against)
    expect(row.deficiencies.default_shapes).toBe(false);
    // completeness: 7 flags bad (urls add 1 to a max of 7), clamped to 0.
    expect(row.completeness_score).toBe(0);
    expect(row.current.task_count).toBe(2);
    expect(row.current.llm_task_count).toBe(2);
    expect(row.current.resolver_task_count).toBe(0);
  });

  test('well-formed template has no deficiencies', () => {
    const row = _internals.auditRow(wellFormedTemplate as any, false);
    expect(row.id).toBe('good-template');
    expect(row.deficiencies.missing_input_shapes).toBe(false);
    expect(row.deficiencies.missing_output_shapes).toBe(false);
    expect(row.deficiencies.missing_tags).toBe(false);
    expect(row.deficiencies.weak_description).toBe(false);
    expect(row.deficiencies.all_llm_tasks).toBe(false);
    expect(row.deficiencies.no_task_outputs).toBe(false);
    expect(row.deficiencies.hardcoded_urls.length).toBe(0);
    expect(row.deficiencies.default_shapes).toBe(false);
    expect(row.completeness_score).toBe(1);
    expect(row.current.resolver_task_count).toBe(1);
    expect(row.current.llm_task_count).toBe(1);
  });

  test('migration-044 default shape combination is flagged', () => {
    const row = _internals.auditRow(defaultShapesTemplate as any, false);
    expect(row.deficiencies.default_shapes).toBe(true);
    expect(row.deficiencies.missing_input_shapes).toBe(false);
    expect(row.deficiencies.missing_output_shapes).toBe(false);
  });

  test('proposals populated from analyzeTaskSemantics when description present', () => {
    const row = _internals.auditRow(wellFormedTemplate as any, true);
    expect(row.proposals).toBeDefined();
    expect(Array.isArray(row.proposals!.suggested_tags)).toBe(true);
    expect(row.proposals!.suggested_tags!.length).toBeGreaterThan(0);
    expect(Array.isArray(row.proposals!.suggested_input_shapes)).toBe(true);
    // Description mentions "tests"/"source" -> implied shapes should include test_suite or source_code
    const inShapes = row.proposals!.suggested_input_shapes || [];
    expect(inShapes.length).toBeGreaterThan(0);
  });

  test('proposals empty object when description empty', () => {
    const noDesc = { ...fullyDeficientTemplate, description: '' };
    const row = _internals.auditRow(noDesc as any, true);
    expect(row.proposals).toBeDefined();
    expect(Object.keys(row.proposals!).length).toBe(0);
  });

  test('hardcoded URL regex finds URLs in prompts and resolver configs', () => {
    const urls = _internals.extractHardcodedUrls([
      {
        prompt: { template: 'See https://example.com/foo and http://other.example/bar' },
      },
      {
        resolver: { config: { command: 'curl https://third.example/baz' } },
      },
      {
        config: { command: 'echo "http://inline.example/qux"' },
      },
    ] as any);
    expect(urls).toContain('https://example.com/foo');
    expect(urls).toContain('http://other.example/bar');
    expect(urls).toContain('https://third.example/baz');
    // strips closing quote via the character class
    expect(urls.some((u) => u.startsWith('http://inline.example'))).toBe(true);
  });

  test('template without tasks is not wrongly flagged as all_llm_tasks', () => {
    const noTasks = {
      id: 'activity:empty',
      name: 'empty',
      scope: 'global',
      description: fullyDeficientTemplate.description,
      tags: [],
      input_shapes: [],
      output_shapes: [],
      tasks: [],
    };
    const row = _internals.auditRow(noTasks as any, false);
    expect(row.deficiencies.all_llm_tasks).toBe(false);
    // but no_task_outputs should be true
    expect(row.deficiencies.no_task_outputs).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchesAnyDefault (internal, edge cases)
// ---------------------------------------------------------------------------

describe('matchesAnyDefault (internal)', () => {
  test('matches on exact set equality, order-insensitive', () => {
    expect(_internals.matchesAnyDefault(['goal'], _internals.DEFAULT_INPUT_COMBINATIONS)).toBe(true);
    expect(
      _internals.matchesAnyDefault(
        ['source_code', 'goal', 'error'],
        _internals.DEFAULT_INPUT_COMBINATIONS,
      ),
    ).toBe(true);
    expect(
      _internals.matchesAnyDefault(['source_code', 'config_file'], _internals.DEFAULT_OUTPUT_COMBINATIONS),
    ).toBe(true);
  });

  test('does not match a superset or subset', () => {
    expect(
      _internals.matchesAnyDefault(['goal', 'extra'], _internals.DEFAULT_INPUT_COMBINATIONS),
    ).toBe(false);
    expect(_internals.matchesAnyDefault([], _internals.DEFAULT_INPUT_COMBINATIONS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// De-duplication
// ---------------------------------------------------------------------------

describe('dedupeTemplates (internal)', () => {
  test('collapses same-id rows, preferring the one with `tasks`', () => {
    const legacy = {
      id: 'activity:foo',
      name: 'foo',
      task_steps: [{ id: 's1' }],
    };
    const paradigm = {
      id: 'activity:foo',
      name: 'foo',
      tasks: [{ id: 't1', description: 'modern' }],
    };
    const out = _internals.dedupeTemplates([legacy, paradigm] as any);
    expect(out.length).toBe(1);
    // The paradigm row (has tasks) should win regardless of input order.
    expect((out[0] as any).tasks).toBeDefined();
  });

  test('preserves rows with distinct ids', () => {
    const a = { id: 'activity:a' };
    const b = { id: 'activity:b' };
    const out = _internals.dedupeTemplates([a, b] as any);
    expect(out.length).toBe(2);
  });

  test('handles bare string ids alongside record-id composites', () => {
    const recordIdForm = { id: 'activity:shared' };
    const bareForm = { id: 'shared', tasks: [{ id: 'only-in-bare' }] };
    const out = _internals.dedupeTemplates([recordIdForm, bareForm] as any);
    expect(out.length).toBe(1);
    // Bare form had tasks, so it should win.
    expect((out[0] as any).tasks?.[0]?.id).toBe('only-in-bare');
  });
});

// ---------------------------------------------------------------------------
// End-to-end via runTemplateAuditReport (with mock db)
// ---------------------------------------------------------------------------

describe('runTemplateAuditReport', () => {
  test('returns report covering all templates with stable ordering', async () => {
    const db = makeDb({
      activity: [fullyDeficientTemplate, wellFormedTemplate, defaultShapesTemplate],
      activity_template: [],
    });

    const report = await runTemplateAuditReport(db, emptyInput(), defaultAuth);
    expect(report.total_scanned).toBe(3);
    expect(report.templates.length).toBe(3);
    // Worst-first ordering: fully-deficient should appear before well-formed.
    const ids = report.templates.map((r) => r.id);
    expect(ids.indexOf('bad-template')).toBeLessThan(ids.indexOf('good-template'));
    expect(report.total_with_deficiencies).toBeGreaterThanOrEqual(2);
  });

  test('de-duplicates templates that appear in both `activity` and `activity_template`', async () => {
    // Same template id showing up in both tables — simulating a view.
    const legacyView = { ...fullyDeficientTemplate, task_steps: fullyDeficientTemplate.tasks, tasks: undefined };
    const db = makeDb({
      activity: [fullyDeficientTemplate],
      activity_template: [legacyView],
    });

    const report = await runTemplateAuditReport(db, emptyInput(), defaultAuth);
    expect(report.total_scanned).toBe(1);
    expect(report.templates[0].id).toBe('bad-template');
  });

  test('filter.missingMarkers narrows the result set', async () => {
    const db = makeDb({
      activity: [fullyDeficientTemplate, wellFormedTemplate, defaultShapesTemplate],
      activity_template: [],
    });

    const report = await runTemplateAuditReport(
      db,
      emptyInput({ filter: { missingMarkers: ['hardcoded_urls'] } }),
      defaultAuth,
    );
    // Only the fully-deficient template has hardcoded URLs.
    expect(report.templates.length).toBe(1);
    expect(report.templates[0].id).toBe('bad-template');
    // total_scanned reflects the full corpus pre-filter.
    expect(report.total_scanned).toBe(3);
  });

  test('filter.taskFormat=all_llm matches LLM-only templates', async () => {
    const db = makeDb({
      activity: [fullyDeficientTemplate, wellFormedTemplate, defaultShapesTemplate],
      activity_template: [],
    });

    const report = await runTemplateAuditReport(
      db,
      emptyInput({ filter: { taskFormat: 'all_llm' } }),
      defaultAuth,
    );
    expect(report.templates.length).toBe(1);
    expect(report.templates[0].id).toBe('bad-template');
  });

  test('includeAliasWarnings integrates findAliasClusters', async () => {
    // Two templates whose shape sets would yield alias candidates once observed.
    const t1 = {
      id: 'activity:one',
      name: 'one',
      scope: 'global',
      description: wellFormedTemplate.description,
      tags: ['x'],
      input_shapes: ['execution_trace'],
      output_shapes: [],
      tasks: [
        {
          id: 's',
          description: 'd',
          resolver: { id: 'bash' },
          outputShapes: ['executionTrace'],
        },
      ],
    };
    const db = makeDb({ activity: [t1], activity_template: [] });

    const report = await runTemplateAuditReport(
      db,
      emptyInput({ includeAliasWarnings: true }),
      defaultAuth,
    );
    expect(report.alias_warnings).toBeDefined();
    // `execution_trace` vs `executionTrace` should be flagged as normalized-equal.
    const flagged = (report.alias_warnings || []).some((c) =>
      c.candidates.some((x) => x.reason === 'normalized-equal'),
    );
    expect(flagged).toBe(true);
    expect(report.observed_shape_summary).toBeDefined();
    expect(report.observed_shape_summary!.total_unique_shapes).toBeGreaterThanOrEqual(2);
  });

  test('includeProposals=true attaches semantic-tags-derived suggestions', async () => {
    const db = makeDb({ activity: [wellFormedTemplate], activity_template: [] });
    const report = await runTemplateAuditReport(
      db,
      emptyInput({ includeProposals: true }),
      defaultAuth,
    );
    expect(report.templates.length).toBe(1);
    expect(report.templates[0].proposals).toBeDefined();
    expect((report.templates[0].proposals!.suggested_tags || []).length).toBeGreaterThan(0);
  });

  test('limit and offset paginate the filtered list', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `activity:t-${i}`,
      name: `t-${i}`,
      scope: 'global',
      description: '',
      tags: [],
      input_shapes: [],
      output_shapes: [],
      tasks: [],
    }));
    const db = makeDb({ activity: many, activity_template: [] });

    const page1 = await runTemplateAuditReport(
      db,
      emptyInput({ filter: { limit: 3, offset: 0 } }),
      defaultAuth,
    );
    expect(page1.templates.length).toBe(3);
    expect(page1.total_scanned).toBe(10);

    const page2 = await runTemplateAuditReport(
      db,
      emptyInput({ filter: { limit: 3, offset: 3 } }),
      defaultAuth,
    );
    expect(page2.templates.length).toBe(3);
    expect(page2.templates[0].id).not.toBe(page1.templates[0].id);
  });

  test('gracefully handles DB errors per-table (returns partial report)', async () => {
    const db: Surreal = {
      query: async (sql: string) => {
        if (/FROM\s+activity\b/.test(sql) && !/FROM\s+activity_template/.test(sql)) {
          return [[wellFormedTemplate]];
        }
        throw new Error('simulated view failure');
      },
    } as unknown as Surreal;
    const report = await runTemplateAuditReport(db, emptyInput(), defaultAuth);
    expect(report.total_scanned).toBe(1);
    expect(report.templates[0].id).toBe('good-template');
  });
});
