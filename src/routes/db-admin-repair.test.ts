import { describe, it, expect } from 'bun:test';
import { resolveRepairOrPrune } from './db-admin-repair';

/**
 * THIS FILE EXISTS BECAUSE THE COMPOSE GATE SAID IT DIDN'T.
 *
 * Every compose targeting db-admin-repair.ts logs:
 *
 *   "TARGET HAS NO TEST FILE — every gate below this point READS the diff; only a test RUNS it.
 *    A FAVORABLE verdict here means the change was reviewed, never executed."
 *
 * That is the session's central defect stated by the system about itself: a reviewed diff is not
 * an executed one. A repair catalogue is a particularly bad place for it, because a malformed
 * pattern is not caught by typecheck — `sql` is a string, and any string typechecks.
 *
 * What is asserted here is deliberately the RAILS, not the SQL semantics. The SQL is validated
 * against the live database separately (a query that parses and returns the pre-registered count
 * is the only thing that can prove that). What a unit test CAN prove is that the safety
 * properties hold for every pattern, including ones added later by someone who never read this
 * file.
 *
 * ON THE APPLY PATH, AND WHY THE OBVIOUS ASSERTION WAS REMOVED. The first draft of this file
 * asserted "no mutation query was issued" for the dry-run cases. A control showed those
 * assertions were VACUOUS: with a stubbed ctx, `apply:true` issues no mutation either, because
 * the snapshot writes to /workspace/db-backups and dies on ENOENT first. An assertion that
 * passes whether or not the rail works is worse than no assertion, because it reads as coverage.
 *
 * What IS discriminating is the query trace. The snapshot fires BEFORE the mutation and BEFORE
 * the ENOENT, so:
 *
 *     dry run  -> exactly one query, the pattern's count SELECT
 *     apply    -> a second SELECT, derived from the mutation predicate
 *
 * That second query is the reversibility rail, and it is the thing worth pinning: if a pattern's
 * mutateSql cannot be parsed by the backup derivation, the code returns "could not derive a
 * pre-mutation backup query" and NO second query appears. So this test fails for exactly the
 * defect a malformed pattern would introduce.
 */

type Captured = { sql: string; params: Record<string, unknown> | undefined };

function stubCtx(captured: Captured[], countValue = 7) {
  return {
    surrealDB: {
      async query<T = any>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
        captured.push({ sql, params });
        return [{ c: countValue }] as unknown as T[];
      },
    },
    writeAudit: async () => 'audit:1',
    rejectCatastrophicSql: () => null,
    REPAIR_TARGET_WHITELIST: {},
    PRUNE_TABLE_WHITELIST: new Set<string>(),
    DEFAULT_MAX_ROWS: 5000,
    safeCount: async () => 0,
  };
}


describe('resolveRepairOrPrune — the rails hold regardless of which pattern is added', () => {
  it('refuses a pattern that is not in the vetted catalogue', async () => {
    const captured: Captured[] = [];
    const r = await resolveRepairOrPrune('repair', { pattern: 'drop_everything' }, 'test', stubCtx(captured) as any);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain('not in the vetted catalogue');
  });

  it('names the allowed patterns when it refuses, so the catalogue is discoverable', async () => {
    const captured: Captured[] = [];
    const r = await resolveRepairOrPrune('repair', { pattern: 'nope' }, 'test', stubCtx(captured) as any);
    expect(String(r.body.error)).toContain('delete_none_fk');
  });

  it('runs no query at all for an unwhitelisted pattern — refused before it touches the db', async () => {
    const captured: Captured[] = [];
    await resolveRepairOrPrune('repair', { pattern: 'drop_everything' }, 'test', stubCtx(captured) as any);
    expect(captured).toEqual([]);
  });

  it('DEFAULTS TO DRY RUN — a caller who forgets `apply` issues only the count query', async () => {
    // The rail that matters most: `apply` defaults false, so the dangerous path requires an
    // explicit opt-in. Asserted on the query COUNT, because "no mutation ran" is vacuous here.
    const captured: Captured[] = [];
    const r = await resolveRepairOrPrune('repair', { pattern: 'delete_none_fk' }, 'test', stubCtx(captured) as any);
    expect(r.status).toBe(200);
    expect(r.body.content).toContain('dry_run');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toMatch(/^\s*SELECT/i);
  });

  it('apply DERIVES A BACKUP SELECT before mutating — the reversibility rail', async () => {
    // A pattern whose mutateSql the derivation cannot parse returns "could not derive a
    // pre-mutation backup query" and issues no second query. This is the assertion that would
    // catch a malformed pattern added later.
    const captured: Captured[] = [];
    const r = await resolveRepairOrPrune('repair', { pattern: 'delete_none_fk', apply: true }, 'test', stubCtx(captured) as any);
    expect(String(r.body.error ?? '')).not.toContain('could not derive');
    expect(captured.length).toBeGreaterThan(1);
    expect(captured[1]!.sql).toMatch(/^\s*SELECT\s+\*\s+FROM\s+\S+\s+WHERE\s+/i);
  });

  it('the backup query targets the same rows the mutation would touch', async () => {
    const captured: Captured[] = [];
    await resolveRepairOrPrune('repair', { pattern: 'delete_none_fk', apply: true }, 'test', stubCtx(captured) as any);
    // delete_none_fk targets activity_composition_graph on NONE endpoints; the snapshot must
    // select that same table, or the "backup" would restore something else entirely.
    expect(captured[1]!.sql).toContain('activity_composition_graph');
    expect(captured[1]!.sql).toContain('child_activity_id');
  });

  it('recover_endpoint_output_shapes is reachable by name and counts before it writes', async () => {
    const captured: Captured[] = [];
    const r = await resolveRepairOrPrune('repair', { pattern: 'recover_endpoint_output_shapes' }, 'test', stubCtx(captured, 1644) as any);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.content).affected_count).toBe(1644);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain('goal_execution_paths');
    // The guard must be the array::len form. `= []` matches nothing in SurrealDB, so a guard
    // written that way would silently never fire and the recovery would report success having
    // touched zero rows.
    expect(captured[0]!.sql).toContain('array::len(endpoint_output_shapes ?? []) = 0');
    expect(captured[0]!.sql).not.toMatch(/endpoint_output_shapes\s*=\s*\[\]/);
  });

  it('recover_endpoint_output_shapes survives the backup derivation — it is revertible', async () => {
    // An UPDATE the derivation regex cannot parse aborts with "could not derive"; this pins that
    // the new pattern's SQL is shaped so the snapshot rail can capture the rows it will change.
    const captured: Captured[] = [];
    const r = await resolveRepairOrPrune('repair', { pattern: 'recover_endpoint_output_shapes', apply: true }, 'test', stubCtx(captured) as any);
    expect(String(r.body.error ?? '')).not.toContain('could not derive');
    expect(captured.length).toBeGreaterThan(1);
    expect(captured[1]!.sql).toMatch(/^\s*SELECT\s+\*\s+FROM\s+goal_execution_paths\s+WHERE\s+/i);
  });

  it('reports the impact count from the pattern own count query before anything is applied', async () => {
    const captured: Captured[] = [];
    const r = await resolveRepairOrPrune('repair', { pattern: 'delete_none_fk' }, 'test', stubCtx(captured, 42) as any);
    expect(JSON.parse(r.body.content).affected_count).toBe(42);
    // and the query it counted with was a SELECT, not a mutation
    expect(captured[0]!.sql).toMatch(/^\s*SELECT/i);
  });

  it("an explicit apply:false is still a dry run", async () => {
    const captured: Captured[] = [];
    const r = await resolveRepairOrPrune('repair', { pattern: 'delete_none_fk', apply: false }, 'test', stubCtx(captured) as any);
    expect(r.body.content).toContain('dry_run');
  });

  it('a truthy-but-not-true apply value does NOT trigger a mutation', async () => {
    // `apply === true` is a strict check. A caller passing the string "true" (a query param, say)
    // must not silently mutate, so this pins the strictness rather than the loose coercion.
    const captured: Captured[] = [];
    const r = await resolveRepairOrPrune('repair', { pattern: 'delete_none_fk', apply: 'true' }, 'test', stubCtx(captured) as any);
    expect(r.body.content).toContain('dry_run');
  });
});
