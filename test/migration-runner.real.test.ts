/**
 * A MIGRATION THE ENGINE REJECTS IS NAMED, RECORDED FAILED, AND FILED — never recorded applied.
 *
 * Measured on a fresh SurrealDB 2.3.10: scripts/init-database.ts applied 209 of 238 files and
 * finished with "Migration complete: 209/238 succeeded", naming none of the files that failed.
 * Twelve permission migrations use `DEFINE TABLE <name> OVERWRITE`, which 2.3.10 rejects as a
 * parse error, so none of their statements apply. Worse, a file whose tables already existed was
 * recorded APPLIED on the next start without running (the convergence pass), so the failure
 * vanished from the ledger for good.
 *
 * These checks run the repo's own runner, copied next to a fixture sql/ tree (its SQL_DIR is
 * relative to the script), against a real throwaway engine.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { startRealSurreal, NS, type RealSurreal } from './support/real-surreal';

const ROOT = new URL('../', import.meta.url).pathname;
const nativeFetch = Bun.fetch as unknown as typeof fetch;

let engine: RealSurreal;
let pass = '';
const dirs: string[] = [];

beforeAll(async () => {
  engine = await startRealSurreal({ schema: false });
  // The harness keeps root's password private; read it back from the env connectModuleClient sets.
  await engine.connectModuleClient();
  pass = process.env.SURREALDB_PASSWORD ?? '';
}, 120_000);

afterAll(async () => {
  await engine?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'aa-migrunner-'));
  dirs.push(d);
  mkdirSync(join(d, 'scripts'), { recursive: true });
  copyFileSync(join(ROOT, 'scripts/init-database.ts'), join(d, 'scripts/init-database.ts'));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(d, 'sql', rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return d;
}

async function runRunner(dir: string, db: string, jwt: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', join(dir, 'scripts/init-database.ts')], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      SURREALDB_URL: engine.url,
      SURREALDB_NAMESPACE: NS,
      SURREALDB_DATABASE: db,
      SURREALDB_USERNAME: 'root',
      SURREALDB_PASSWORD: pass,
      JWT_SECRET: jwt,
      NODE_ENV: 'test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out: o + e };
}

async function q(db: string, text: string): Promise<any[]> {
  const r = await nativeFetch(`${engine.url}/sql`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'surreal-ns': NS, 'surreal-db': db, Authorization: 'Basic ' + btoa(`root:${pass}`) },
    body: text,
  });
  const j = (await r.json()) as any[];
  return Array.isArray(j) ? j : [];
}

async function ledger(db: string): Promise<Record<string, any>> {
  const res = await q(db, 'SELECT filename, status, error, applied_at FROM init_migrations;');
  const rows: any[] = res[0]?.result ?? [];
  return Object.fromEntries(rows.map((r) => [r.filename, r]));
}

const newDb = (tag: string) => `${tag}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;

describe('migration runner — a rejected file is FAILED by name, recorded, and filed', () => {
  it('MF: DEFINE TABLE x OVERWRITE is reported FAILED by name with the engine text, recorded failed (never applied), and signalled as a gap — on both starts', async () => {
    const db = newDb('mf');
    const jwt = crypto.randomUUID();
    const dir = fixture({
      '001-define-x.surql': 'DEFINE TABLE x SCHEMALESS;\n',
      // Top-level: the old convergence pass recorded this applied on the 2nd start (x exists).
      '002-overwrite-x.surql': 'DEFINE TABLE x OVERWRITE SCHEMAFULL PERMISSIONS NONE;\n',
      // Where the twelve live.
      'migrations/003-overwrite-y.surql': 'DEFINE TABLE y SCHEMALESS;\nDEFINE TABLE y OVERWRITE SCHEMAFULL;\n',
      // A later valid file still applies after a failure.
      'migrations/004-define-z.surql': 'DEFINE TABLE z SCHEMALESS;\n',
    });

    for (const start of [1, 2]) {
      const { code, out } = await runRunner(dir, db, jwt);
      // The vessel still starts: the runner does not exit non-zero for a failed migration.
      expect({ start, code }).toEqual({ start, code: 0 });
      // Named in the summary, and on one line with the engine's own text.
      const summary = out.split('\n').find((l) => l.includes('[Init] FAILED:')) ?? '';
      expect(summary).toContain('002-overwrite-x.surql');
      expect(summary).toContain('003-overwrite-y.surql');
      expect(summary).not.toContain('004-define-z.surql');
      expect(out.split('\n').some((l) => l.includes('002-overwrite-x.surql') && l.includes('OVERWRITE') && /Parse error/i.test(l))).toBe(true);
      // The gap signal, with a stable id.
      expect(out).toContain('[SubstrateGap] migration-apply-failed-002-overwrite-x ');
      expect(out).toContain('[SubstrateGap] migration-apply-failed-003-overwrite-y ');

      const rows = await ledger(db);
      for (const f of ['002-overwrite-x.surql', '003-overwrite-y.surql']) {
        // Never an applied row for a file whose statements errored.
        expect({ start, f, status: rows[f]?.status ?? 'NO ROW' }).toEqual({ start, f, status: 'failed' });
        expect(rows[f].applied_at ?? null).toBeNull();
        expect(String(rows[f].error)).toMatch(/OVERWRITE/);
      }
      expect(rows['004-define-z.surql']?.status).toBe('applied');
      expect(rows['001-define-x.surql']?.status).toBe('applied');
    }

    // The server side reads the same rows: /health degraded, naming the files.
    const { migrationHealth, resetMigrationHealthCache, fileMigrationGaps, resetFiledGaps } = await import('../src/lib/migration-status');
    await engine.sdk.use({ namespace: NS, database: db });
    resetMigrationHealthCache();
    const h = await migrationHealth();
    expect(h.status).toBe('degraded');
    expect(h.failed.map((f) => f.filename)).toEqual(['002-overwrite-x.surql', '003-overwrite-y.surql']);

    // One gap per failed file through the existing substrateGap_write path.
    const bodies: any[] = [];
    const sink = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { bodies.push(await req.json()); return Response.json({ ok: true }); } });
    try {
      resetFiledGaps();
      const posted = await fileMigrationGaps({ url: `http://127.0.0.1:${sink.port}/v2/impulses/resolve`, apiKey: '' });
      expect(posted).toEqual(['migration-apply-failed-002-overwrite-x', 'migration-apply-failed-003-overwrite-y']);
      expect(bodies.map((b) => b.impulse.type)).toEqual(['substrateGap_write', 'substrateGap_write']);
      expect(bodies[0].impulse.gap.status).toBe('open');
      expect(bodies[0].impulse.gap.summary).toContain('002-overwrite-x.surql');
      expect(bodies[0].impulse.gap.summary).toMatch(/OVERWRITE/);
      // Filed once per process: a second pass posts nothing new.
      expect(await fileMigrationGaps({ url: `http://127.0.0.1:${sink.port}/v2/impulses/resolve`, apiKey: '' })).toEqual([]);
    } finally {
      sink.stop(true);
    }
  }, 120_000);

  it('the JWT secret never reaches the log or the ledger when a secret-bearing file fails', async () => {
    const db = newDb('secret');
    const jwt = `s3cret-${crypto.randomUUID()}`;
    const dir = fixture({
      '001-access.surql': "DEFINE ACCESS OVERWRITE a ON DATABASE TYPE JWT ALGORITHM HS512 KEY '__JWT_SECRET__' BOGUS;\n",
    });
    const { code, out } = await runRunner(dir, db, jwt);
    expect(code).toBe(0);
    expect(out).toContain('001-access.surql');
    expect(out).not.toContain(jwt);
    const rows = await ledger(db);
    expect(rows['001-access.surql']?.status).toBe('failed');
    expect(String(rows['001-access.surql']?.error)).not.toContain(jwt);
  }, 60_000);

  it('a ledger row from before per-file status is kept as it is (history not rewritten)', async () => {
    const db = newDb('legacy');
    await q(db, `DEFINE TABLE init_migrations SCHEMAFULL PERMISSIONS FOR select, create FULL;
      DEFINE FIELD filename ON init_migrations TYPE string;
      DEFINE FIELD applied_at ON init_migrations TYPE datetime DEFAULT time::now();
      DEFINE INDEX idx_init_migrations_filename ON init_migrations FIELDS filename UNIQUE;
      INSERT INTO init_migrations (filename) VALUES ('002-overwrite-x.surql');`);
    const dir = fixture({
      '001-define-x.surql': 'DEFINE TABLE x SCHEMALESS;\n',
      '002-overwrite-x.surql': 'DEFINE TABLE x OVERWRITE SCHEMAFULL;\n',
    });
    const { code } = await runRunner(dir, db, crypto.randomUUID());
    expect(code).toBe(0);
    const rows = await ledger(db);
    expect(rows['002-overwrite-x.surql']?.status ?? null).toBeNull();
    expect(rows['002-overwrite-x.surql']?.applied_at).toBeTruthy();
    expect(rows['001-define-x.surql']?.status).toBe('applied');
  }, 60_000);

  it('a ledger row whose file no longer exists is ignored: no error, no gap, no status write, health ok', async () => {
    const db = newDb('ghost');
    await q(db, `DEFINE TABLE init_migrations SCHEMAFULL PERMISSIONS FOR select, create FULL;
      DEFINE FIELD filename ON init_migrations TYPE string;
      DEFINE FIELD applied_at ON init_migrations TYPE datetime DEFAULT time::now();
      DEFINE INDEX idx_init_migrations_filename ON init_migrations FIELDS filename UNIQUE;
      INSERT INTO init_migrations (filename) VALUES ('143-gone-from-disk.surql'), ('001-api-keys.surql');`);
    const dir = fixture({ '001-define-x.surql': 'DEFINE TABLE x SCHEMALESS;\n' });
    const { code, out } = await runRunner(dir, db, crypto.randomUUID());
    expect(code).toBe(0);
    expect(out).not.toContain('[Init] FAILED');
    expect(out).not.toContain('[SubstrateGap]');
    expect(out).not.toContain('gone-from-disk');
    const rows = await ledger(db);
    for (const f of ['143-gone-from-disk.surql', '001-api-keys.surql']) {
      expect({ f, status: rows[f]?.status ?? null, error: rows[f]?.error ?? null }).toEqual({ f, status: null, error: null });
      expect(rows[f]?.applied_at).toBeTruthy();
    }
    expect(rows['001-define-x.surql']?.status).toBe('applied');
    const { migrationHealth, resetMigrationHealthCache } = await import('../src/lib/migration-status');
    await engine.sdk.use({ namespace: NS, database: db });
    resetMigrationHealthCache();
    expect(await migrationHealth()).toEqual({ status: 'healthy', failed_count: 0, failed: [] });
  }, 60_000);

  it('a live DB with an empty ledger is marked bootstrapped, not applied', async () => {
    const db = newDb('boot');
    await q(db, "CREATE activity_execution_traces SET note = 'live';");
    const dir = fixture({ '001-define-x.surql': 'DEFINE TABLE x SCHEMALESS;\n' });
    const { code } = await runRunner(dir, db, crypto.randomUUID());
    expect(code).toBe(0);
    expect((await ledger(db))['001-define-x.surql']?.status).toBe('bootstrapped');

    // A ledger holding only FAILED rows is not empty: no bootstrap marks over it.
    const db2 = newDb('boot2');
    await q(db2, "CREATE activity_execution_traces SET note = 'live';");
    const dir2 = fixture({ '001-bad.surql': 'DEFINE TABLE x OVERWRITE SCHEMAFULL;\n', '002-good.surql': 'DEFINE TABLE y SCHEMALESS;\n' });
    await q(db2, "DEFINE TABLE init_migrations SCHEMAFULL; DEFINE FIELD filename ON init_migrations TYPE string; DEFINE FIELD status ON init_migrations TYPE option<string>; DEFINE FIELD error ON init_migrations TYPE option<string>; DEFINE FIELD failed_at ON init_migrations TYPE option<datetime>; DEFINE FIELD applied_at ON init_migrations TYPE option<datetime>; CREATE init_migrations SET filename = '001-bad.surql', status = 'failed', error = 'earlier';");
    const r2 = await runRunner(dir2, db2, crypto.randomUUID());
    expect(r2.code).toBe(0);
    expect(r2.out).not.toContain('bootstrapped');
    const rows2 = await ledger(db2);
    expect(rows2['001-bad.surql']?.status).toBe('failed');
    expect(String(rows2['001-bad.surql']?.error)).toMatch(/OVERWRITE/);
    expect(rows2['002-good.surql']?.status).toBe('applied');
  }, 60_000);
});

describe('migration runner — controls', () => {
  it('CONTROL: an all-valid set reports 0 failed, records every file applied, and health is ok', async () => {
    const db = newDb('ok');
    const dir = fixture({
      '001-define-x.surql': 'DEFINE TABLE x SCHEMALESS;\n',
      'schemas/002-define-y.surql': 'DEFINE TABLE y SCHEMALESS;\n',
      'migrations/003-define-z.surql': 'DEFINE TABLE IF NOT EXISTS z SCHEMALESS;\nDEFINE FIELD IF NOT EXISTS n ON z TYPE option<int>;\n',
    });
    const { code, out } = await runRunner(dir, db, crypto.randomUUID());
    expect(code).toBe(0);
    expect(out).not.toContain('[Init] FAILED');
    expect(out).toContain('0 migrations failed');
    expect(out).not.toContain('[SubstrateGap]');
    const rows = await ledger(db);
    for (const f of ['001-define-x.surql', '002-define-y.surql', '003-define-z.surql']) {
      expect({ f, status: rows[f]?.status }).toEqual({ f, status: 'applied' });
      expect(rows[f].applied_at).toBeTruthy();
    }
    const { migrationHealth, resetMigrationHealthCache } = await import('../src/lib/migration-status');
    await engine.sdk.use({ namespace: NS, database: db });
    resetMigrationHealthCache();
    const h = await migrationHealth();
    expect(h).toEqual({ status: 'healthy', failed_count: 0, failed: [] });
  }, 60_000);

  it('CONTROL: with one failing file the runner still exits 0, so the unit goes on to start the vessel', async () => {
    const db = newDb('start');
    const dir = fixture({
      '001-bad.surql': 'DEFINE TABLE x OVERWRITE SCHEMAFULL;\n',
      '002-good.surql': 'DEFINE TABLE y SCHEMALESS;\n',
    });
    const { code, out } = await runRunner(dir, db, crypto.randomUUID());
    expect(code).toBe(0);
    expect(out).toContain('applied successfully');
    expect((await ledger(db))['002-good.surql']?.status).toBe('applied');
  }, 60_000);
});
