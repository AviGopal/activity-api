/**
 * THE ARGUMENTS MUST SURVIVE THE WHOLE CHAIN — write boundary and read projection.
 *
 * MEASURED 2026-08-17. All 26 stored learned compositions carried tasks whose config was
 * exactly `{"type": "<resolver>"}` — 98 of 98 tasks, no arguments anywhere. Replaying them
 * produced, from the engine:
 *
 *     fs_read            The "paths[0]" property must be of type string, got undefined   (18x)
 *     http_fetch         invalid URL: undefined                                           (8x)
 *     json_path_extract  undefined is not an object (evaluating 'path.split')
 *
 * Those compositions completed 6 of 61 runs. A pathway that cannot be re-bound is not a
 * learned pathway; it is a replay of a shape sequence with the arguments amputated.
 *
 * The cause spanned FOUR layers, and this is the part worth remembering: three of them looked
 * correct in isolation.
 *
 *   1. ias-executor        never recorded resolvedConfig at all (no field on the type)
 *   2. normalizePersistedTask  whitelists a fixed field set — dropped it at the WRITE
 *   3. extractTasks        read only `tt.config`, never the key the write lands under
 *   4. ribosome-extract    prompt skeleton literally instructed `"config":{}`
 *
 * Fixing any one changes nothing observable, which is exactly the failure signature recorded
 * in `reference-built-but-not-resolved`: when every fix targets the path and nothing moves,
 * find the layer that BINDS — here, all four bound in series.
 *
 * These tests pin layers 2 and 3, the two that live in this repo. Layer 2 is the same defect
 * class as the per-task SHAPES fix of 2026-08-13 in the same whitelist, which is why the
 * whitelist itself is the thing under test rather than any single field.
 */

// Must precede the import: config.ts validates these at module load.
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

import { describe, test, expect } from 'bun:test';
import { normalizePersistedTask } from './execution-traces';
import { _internals as readInternals } from './execution-trace-with-signatures';

describe('write boundary — normalizePersistedTask preserves resolver arguments', () => {
  test('THE REGRESSION: a task\'s resolved arguments are no longer dropped', () => {
    const p = normalizePersistedTask({
      taskId: 't2',
      resolver_id: 'fs_read',
      resolvedConfig: { paths: ['/vessels/goal-host-vessel/src'] },
    });
    // Before the fix this key was absent entirely and the trace recorded only THAT
    // fs_read ran, never WHAT it read.
    expect(p.resolved_config).toEqual({ paths: ['/vessels/goal-host-vessel/src'] });
  });

  test('the three argument names whose absence broke replay survive byte-exact', () => {
    // Recording arguments that come back altered is worse than not recording them: the
    // replay would issue a subtly wrong call rather than an obviously broken one.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['fs_read', { paths: ['/a/b c/d.ts'] }],
      ['http_fetch', { url: 'https://ssd.jpl.nasa.gov/api/horizons.api?COMMAND=%27499%27' }],
      ['json_path_extract', { path: 'result.data[0].vectors' }],
    ];
    for (const [resolver, cfg] of cases) {
      const p = normalizePersistedTask({ taskId: 't', resolver_id: resolver, resolvedConfig: cfg });
      expect(p.resolved_config).toEqual(cfg);
    }
  });

  test('snake_case from a sink and camelCase from a raw trace are both accepted', () => {
    // The shapes field directly above this one in the whitelist needed exactly this, for
    // exactly this reason: two producers spell it two ways.
    expect(normalizePersistedTask({ taskId: 't', resolved_config: { url: 'u' } }).resolved_config)
      .toEqual({ url: 'u' });
    expect(normalizePersistedTask({ taskId: 't', resolvedConfig: { url: 'u' } }).resolved_config)
      .toEqual({ url: 'u' });
  });

  test('an oversize config is dropped WHOLE, never truncated', () => {
    // A half-serialized config replays as a wrong call. Absent is recoverable; wrong is not.
    const huge = { blob: 'x'.repeat(20000) };
    expect(normalizePersistedTask({ taskId: 't', resolvedConfig: huge }).resolved_config)
      .toBeUndefined();
  });

  test('a cyclic config does not break the write', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => normalizePersistedTask({ taskId: 't', resolvedConfig: cyclic })).not.toThrow();
    expect(normalizePersistedTask({ taskId: 't', resolvedConfig: cyclic }).resolved_config)
      .toBeUndefined();
  });

  test('non-object configs are refused rather than stored as junk', () => {
    for (const bad of ['a string', 42, ['an', 'array'], null]) {
      expect(normalizePersistedTask({ taskId: 't', resolvedConfig: bad }).resolved_config)
        .toBeUndefined();
    }
  });

  test('a task with no arguments is unchanged — no key invented', () => {
    const p = normalizePersistedTask({ taskId: 't', resolver_id: 'noop' });
    expect('resolved_config' in p).toBe(false);
  });
});

describe('read projection — extractTasks surfaces arguments over the {type} shim', () => {
  const extract = (task: Record<string, unknown>) =>
    readInternals.extractTasks({ tasks: [task] } as never)[0];

  test('THE JOINED SEAM: the projection reads the key the write boundary lands under', () => {
    // This is the end-to-end assertion that matters — the WRITE's output fed straight into
    // the READ, so a key-name drift between them fails here. Layer 3 read `tt.config` while
    // the write landed `resolved_config`: both sides were individually correct and the
    // conjunction was false.
    const persisted = normalizePersistedTask({
      taskId: 't2',
      resolver_id: 'fs_read',
      resolvedConfig: { paths: ['/vessels/goal-host-vessel/src'] },
    });
    const projected = extract(persisted as unknown as Record<string, unknown>);
    expect(projected?.config).toMatchObject({ paths: ['/vessels/goal-host-vessel/src'] });
  });

  test('for a SHAPE-ROUTED step the routing key survives alongside the arguments', () => {
    const projected = extract({
      id: 't1',
      resolver_id: 'fs_read',
      resolved_config: { paths: ['/a/b.ts'] },
    });
    expect(projected?.config?.paths).toEqual(['/a/b.ts']);
    // The shape-routing key is what makes the emitted composite dispatchable at all; the
    // arguments are what make it re-runnable. For a shape-routed step both are required,
    // so neither may displace the other.
    expect(projected?.config?.type).toBe('fs_read');
  });

  test('for a META resolver the arguments ride alone — no invented {type}', () => {
    // http_fetch, bash, git and the LLM dispatchers are meta-resolvers: the projection
    // deliberately does NOT synthesize a `{type}` shim for them, because their real config is
    // not the shape-routing form and a fabricated type would misroute the replay. Recording
    // their arguments must not smuggle one in through the merge.
    const projected = extract({
      id: 't1',
      resolver_id: 'http_fetch',
      resolved_config: { url: 'https://ssd.jpl.nasa.gov/api/horizons.api' },
    });
    expect(projected?.config).toEqual({ url: 'https://ssd.jpl.nasa.gov/api/horizons.api' });
    // These were the tasks failing with "invalid URL: undefined" — the meta path is exactly
    // where the arguments were most load-bearing and most absent.
    expect(projected?.config?.type).toBeUndefined();
  });

  test('historical traces with no arguments still get the dispatchable shim', () => {
    // The fallback must remain reachable: ~26 stored compositions predate the recording and
    // would otherwise become undispatchable as well as unreplayable — turning a partial
    // capability into a regression.
    const projected = extract({ id: 't1', resolver_id: 'fs_read' });
    expect(projected?.config).toEqual({ type: 'fs_read' });
  });

  test('an argument-carrying config never regresses to the bare shim', () => {
    // The measured symptom, stated as an invariant: no task that recorded arguments may
    // project as `{type}` alone.
    const projected = extract({
      id: 't1',
      resolver_id: 'json_path_extract',
      resolved_config: { path: 'result.data[0].vectors' },
    });
    expect(Object.keys(projected?.config ?? {})).not.toEqual(['type']);
  });
});
