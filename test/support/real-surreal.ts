/**
 * A real SurrealDB with this repo's real schema, for checks on code that issues a query.
 *
 * Why this exists: a check that runs a query-building change against a fake DB proves only that
 * the SQL text contains what the check looks for. activity-api a79e70c passed its check that way
 * while filtering on `failure_class` and `reason`, columns the SCHEMAFULL `execution` table does
 * not have: in production the filter matched nothing and the grouping collapsed to NONE. A field
 * that does not exist cannot survive this harness, because the query runs against the schema that
 * init-database.ts builds on every unit start.
 *
 * What it does:
 *  - spawns `surreal` from PATH (present in the substrate image). If it is missing, start() throws:
 *    callers record the error and FAIL, never skip, because a skipped check reads as a pass.
 *  - applies every schema file in init-database.ts order (sql/*, sql/schemas/*, sql/migrations/*)
 *    to NS `activity-system` DB `learning_loop`, the namespace the files name in their USE lines.
 *    Some statements fail on an in-memory engine (PERMISSIONS on $token, ACCESS definitions); that
 *    happens on a fresh database too and does not affect the tables the checks read.
 *  - points src/config at it and routes the module client (`src/db/surreal`) through a REAL client
 *    loaded under a distinct specifier: ~40 files mock.module('…/db/surreal') and Bun keeps a module
 *    mock for the rest of the process, so in a full-suite run the held client may be a stub.
 *    query, queryAll AND queryRaw are all routed, so no client method escapes the real engine.
 *  - records every statement at the SDK layer (the Surreal instance's own query()), so a recount
 *    cannot be evaded by switching between query/queryAll/queryRaw.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { spawn, type Subprocess } from 'bun';

export const NS = 'activity-system';
export const DB = 'learning_loop';
const ROOT = new URL('../../', import.meta.url).pathname;

export interface SdkCall { sql: string; params: Record<string, unknown> | undefined }

export interface RealSurreal {
  url: string;
  /** Run SurrealQL over HTTP as root (fixture setup and ground truth). Throws on a non-OK statement. */
  sql(text: string): Promise<any[]>;
  /** Every statement the code under test sent through the SDK since the last reset. */
  calls: SdkCall[];
  /** The recorded SDK connection (a `Surreal`), set by connectModuleClient(): what routes hand a pure query builder. */
  sdk: any;
  /** Load `src/db/surreal`, point it at this engine and record it. Returns the module client. */
  connectModuleClient(): Promise<any>;
  stop(): Promise<void>;
}

/** The files init-database.ts applies, in its order. */
export function schemaFiles(): string[] {
  const list = (dir: string) => readdirSync(ROOT + dir).filter((f) => f.endsWith('.surql') || f.endsWith('.sql')).sort().map((f) => dir + f);
  return [...list('sql/'), ...list('sql/schemas/'), ...list('sql/migrations/')];
}

export async function startRealSurreal(): Promise<RealSurreal> {
  const port = 19_000 + Math.floor(Math.random() * 900);
  const url = `http://127.0.0.1:${port}`;
  const pass = crypto.randomUUID();
  let proc: Subprocess | null = null;
  const restores: Array<() => void> = [];
  let realClient: any = null;

  const raw = async (text: string): Promise<any[]> => {
    const r = await fetch(`${url}/sql`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'surreal-ns': NS, 'surreal-db': DB, Authorization: 'Basic ' + btoa(`root:${pass}`) },
      body: text,
    });
    return (await r.json()) as any[];
  };

  try {
    proc = spawn(['surreal', 'start', 'memory', '--bind', `127.0.0.1:${port}`, '--user', 'root', '--pass', pass, '--log', 'none'], { stdout: 'ignore', stderr: 'ignore' });
  } catch (e) {
    throw new Error(`the surreal binary is not on PATH: ${e instanceof Error ? e.message : String(e)}`);
  }
  const hardStop = setTimeout(() => proc?.kill(), 600_000);
  (hardStop as any).unref?.();
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await fetch(`${url}/health`)).ok; } catch { /* not up yet */ }
    if (!up) await Bun.sleep(100);
  }
  if (!up) { proc.kill(); throw new Error('surreal did not answer /health within 8 s'); }

  const jwt = crypto.randomUUID();
  for (const f of schemaFiles()) {
    const text = readFileSync(ROOT + f, 'utf8').replaceAll('__JWT_SECRET__', jwt).replaceAll("'dev-secret-change-in-production'", `'${jwt}'`);
    await raw(text);
  }

  const calls: SdkCall[] = [];
  const handle: RealSurreal = {
    url,
    calls,
    sdk: null,
    async sql(text: string) {
      const res = await raw(text);
      if (!Array.isArray(res)) throw new Error(`sql failed: ${JSON.stringify(res).slice(0, 300)}`);
      const bad = res.find((s) => s.status !== 'OK');
      if (bad) throw new Error(`sql failed: ${JSON.stringify(bad.result).slice(0, 300)}`);
      return res;
    },
    async connectModuleClient() {
      process.env.SURREALDB_URL = url;
      process.env.SURREALDB_NAMESPACE = NS;
      process.env.SURREALDB_DATABASE = DB;
      process.env.SURREALDB_USERNAME = 'root';
      process.env.SURREALDB_PASSWORD = pass;
      const { config } = await import('../../src/config');
      const saved = { ...config.surrealdb };
      restores.push(() => Object.assign(config.surrealdb, saved));
      Object.assign(config.surrealdb, { url, namespace: NS, database: DB, username: 'root', password: pass, authEnabled: true });
      const real = await import('../../src/db/surreal.ts?real-surreal-harness');
      realClient = real.surrealDB;
      await realClient.close?.();
      await realClient.connect();
      const sdk = realClient.db;
      if (!sdk || typeof sdk.query !== 'function') throw new Error('real client did not expose its SDK connection');
      const sdkQuery = sdk.query.bind(sdk);
      sdk.query = (sql: string, params?: Record<string, unknown>) => {
        if (!/^\s*INFO FOR NS\s*;?\s*$/i.test(sql)) calls.push({ sql, params });
        return sdkQuery(sql, params);
      };
      handle.sdk = sdk;
      const held = (await import('../../src/db/surreal')).surrealDB as any;
      if (held !== realClient) {
        for (const m of ['query', 'queryAll', 'queryRaw'] as const) {
          const orig = held[m];
          held[m] = (...args: any[]) => realClient[m](...args);
          restores.push(() => { held[m] = orig; });
        }
      }
      return held;
    },
    async stop() {
      try { await realClient?.close?.(); } catch { /* ignore */ }
      for (const r of restores.reverse()) r();
      proc?.kill();
    },
  };
  return handle;
}
