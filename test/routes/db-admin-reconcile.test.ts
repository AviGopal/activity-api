/**
 * db_admin `reconcile_trace_store` — lease-gate + dry-run-default tests.
 *
 * Part of openspec/changes/2026-07-08-substrate-self-managed-db-reconciliation.
 * Scope: the pure lease-validation function (no I/O beyond a temp file) and
 * the resolver's dry-run-by-default contract against a stubbed surrealDB
 * client (no real SurrealDB in tests — matches the existing db-admin test
 * pattern of mocking the DB client rather than hitting a live instance).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateMaintenanceLease,
  resolveReconcileTraceStore,
} from '../../src/routes/db-admin-reconcile';

describe('validateMaintenanceLease', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lease-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses when the lease file is missing', () => {
    const result = validateMaintenanceLease(join(dir, 'nope.json'), 'tok');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('refuses when the lease file is unparsable JSON', () => {
    const p = join(dir, 'maintenance.json');
    writeFileSync(p, '{ not json', 'utf-8');
    const result = validateMaintenanceLease(p, 'tok');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not valid JSON/i);
  });

  it('refuses when the lease is expired', () => {
    const p = join(dir, 'maintenance.json');
    const past = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(p, JSON.stringify({ holder: 'op', token: 'tok', acquired_at: past, expires_at: past }), 'utf-8');
    const result = validateMaintenanceLease(p, 'tok');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/expired/i);
  });

  it('refuses on token mismatch', () => {
    const p = join(dir, 'maintenance.json');
    const future = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(p, JSON.stringify({ holder: 'op', token: 'right-token', acquired_at: new Date().toISOString(), expires_at: future }), 'utf-8');
    const result = validateMaintenanceLease(p, 'wrong-token');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mismatch/i);
  });

  it('refuses when no token is supplied', () => {
    const p = join(dir, 'maintenance.json');
    const future = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(p, JSON.stringify({ holder: 'op', token: 'right-token', acquired_at: new Date().toISOString(), expires_at: future }), 'utf-8');
    const result = validateMaintenanceLease(p, undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/required/i);
  });

  it('accepts a valid, unexpired, matching lease', () => {
    const p = join(dir, 'maintenance.json');
    const future = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(p, JSON.stringify({ holder: 'op', token: 'right-token', acquired_at: new Date().toISOString(), expires_at: future }), 'utf-8');
    const result = validateMaintenanceLease(p, 'right-token');
    expect(result.ok).toBe(true);
    expect(result.lease?.token).toBe('right-token');
  });

  it('honors an explicit `now` for deterministic expiry checks', () => {
    const p = join(dir, 'maintenance.json');
    writeFileSync(
      p,
      JSON.stringify({ holder: 'op', token: 'tok', acquired_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-01T00:15:00.000Z' }),
      'utf-8',
    );
    const before = validateMaintenanceLease(p, 'tok', new Date('2026-01-01T00:10:00.000Z'));
    expect(before.ok).toBe(true);
    const after = validateMaintenanceLease(p, 'tok', new Date('2026-01-01T00:20:00.000Z'));
    expect(after.ok).toBe(false);
  });
});

describe('resolveReconcileTraceStore', () => {
  let dir: string;
  let leasePath: string;
  const originalEnv = process.env.MAINTENANCE_LEASE_PATH;

  function makeCtx(queryImpl?: (sql: string, params?: Record<string, unknown>) => Promise<any[]>) {
    const calls: { sql: string; params?: Record<string, unknown> }[] = [];
    const audits: any[] = [];
    return {
      calls,
      audits,
      ctx: {
        surrealDB: {
          query: async (sql: string, params?: Record<string, unknown>) => {
            calls.push({ sql, params });
            if (queryImpl) return queryImpl(sql, params);
            return [];
          },
        },
        writeAudit: async (entry: any) => {
          audits.push(entry);
          return 'db_admin_audit:fake';
        },
      },
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reconcile-test-'));
    leasePath = join(dir, 'maintenance.json');
    const future = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(
      leasePath,
      JSON.stringify({ holder: 'operator', token: 'valid-token', acquired_at: new Date().toISOString(), expires_at: future }),
      'utf-8',
    );
    process.env.MAINTENANCE_LEASE_PATH = leasePath;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.MAINTENANCE_LEASE_PATH;
    else process.env.MAINTENANCE_LEASE_PATH = originalEnv;
  });

  it('refuses without a lease_token, without touching the DB', async () => {
    const { ctx, calls, audits } = makeCtx();
    const result = await resolveReconcileTraceStore({ dry_run: true }, 'test-actor', ctx as any);
    expect(result.status).toBe(403);
    expect(calls.length).toBe(0);
    expect(audits[0]?.detail?.refused).toBe(true);
  });

  it('refuses with a wrong lease_token', async () => {
    const { ctx } = makeCtx();
    const result = await resolveReconcileTraceStore({ dry_run: true, lease_token: 'wrong' }, 'test-actor', ctx as any);
    expect(result.status).toBe(403);
    expect(result.body.success).toBe(false);
  });

  it('defaults to dry_run:true when the param is omitted, and produces a plan without mutating', async () => {
    const { ctx, calls } = makeCtx(async (sql) => {
      if (sql.includes('trace_store_counters')) return [{ row_count: 100, cap: 50000, table_name: 'activity_execution_traces' }];
      return [];
    });
    const result = await resolveReconcileTraceStore({ lease_token: 'valid-token' }, 'test-actor', ctx as any);
    expect(result.status).toBe(200);
    const content = JSON.parse(result.body.content);
    expect(content.dry_run).toBe(true);
    expect(content.row_count).toBe(100);
    expect(content.over_cap).toBe(false);
    expect(Array.isArray(content.plan)).toBe(true);
    expect(content.plan.length).toBeGreaterThan(0);
    // Dry-run must never REMOVE/INSERT — only the read-only counters SELECT.
    expect(calls.every((c) => !/REMOVE TABLE|INSERT INTO activity_execution_traces/.test(c.sql))).toBe(true);
  });

  it('reports over_cap:true when row_count exceeds cap', async () => {
    const { ctx } = makeCtx(async (sql) => {
      if (sql.includes('trace_store_counters')) return [{ row_count: 60000, cap: 50000 }];
      return [];
    });
    const result = await resolveReconcileTraceStore({ dry_run: true, lease_token: 'valid-token' }, 'test-actor', ctx as any);
    const content = JSON.parse(result.body.content);
    expect(content.over_cap).toBe(true);
  });

  it('live run aborts before touching AET if the keep-set copy is empty', async () => {
    const { ctx, calls } = makeCtx(async (sql) => {
      if (sql.includes('SELECT count() AS c FROM activity_execution_traces_next')) return [{ c: 0 }];
      if (sql.includes('INFO FOR TABLE')) return [{ fields: {}, indexes: {} }];
      if (sql.includes('INFO FOR DB')) return [{ tables: {} }];
      if (sql.includes('trace_store_counters')) return [{ row_count: 100, cap: 50000 }];
      return [];
    });
    const result = await resolveReconcileTraceStore({ dry_run: false, lease_token: 'valid-token' }, 'test-actor', ctx as any);
    expect(result.status).toBe(500);
    // Must never have reached REMOVE TABLE activity_execution_traces (the
    // destructive step) once the keep-set was found empty.
    expect(calls.some((c) => /^REMOVE TABLE activity_execution_traces$/.test(c.sql.trim()))).toBe(false);
  });
});
