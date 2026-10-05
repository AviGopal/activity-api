/**
 * A THROWAWAY SurrealDB for DB-slice tests: this process's own engine, never a shared one.
 *
 * - binary: /usr/local/bin/surreal (the substrate image) or `surreal` on PATH;
 * - bound to 127.0.0.1 on a random 19xxx port, root password generated per run, memory storage;
 * - stopped by `stop()` (call it in afterAll) and by a hard timer, so a wedged run cannot leave it
 *   behind. Only the PID this helper spawned is ever signalled.
 *
 * `start()` never throws: it returns '' when the engine answers /health, otherwise the reason
 * ('cannot start engine: …'). Callers FAIL CLOSED on a non-empty reason — a test that skips when its
 * engine is missing reads as a pass.
 */
import { existsSync } from 'node:fs';
import { spawn, type Subprocess } from 'bun';

export interface ScratchSurreal {
  readonly url: string;
  readonly port: number;
  readonly pass: string;
  /** '' once running; the failure reason otherwise. */
  start(): Promise<string>;
  stop(): void;
}

export function surrealBinary(): string | null {
  if (existsSync('/usr/local/bin/surreal')) return '/usr/local/bin/surreal';
  return Bun.which('surreal') ?? null;
}

export function createScratchSurreal(opts: { hardStopMs?: number; readyMs?: number } = {}): ScratchSurreal {
  const port = 19_000 + Math.floor(Math.random() * 900);
  const url = `http://127.0.0.1:${port}`;
  const pass = crypto.randomUUID();
  let proc: Subprocess | null = null;
  const stop = () => { proc?.kill(); proc = null; };
  return {
    url, port, pass, stop,
    async start(): Promise<string> {
      const bin = surrealBinary();
      if (!bin) return 'cannot start engine: no surreal binary at /usr/local/bin/surreal or on PATH';
      const hardStop = setTimeout(stop, opts.hardStopMs ?? 180_000); // never outlive a wedged run
      (hardStop as { unref?: () => void }).unref?.();
      try {
        proc = spawn([bin, 'start', 'memory', '--bind', `127.0.0.1:${port}`, '--log', 'none'], { env: { ...process.env, SURREAL_USER: 'root', SURREAL_PASS: pass }, stdout: 'ignore', stderr: 'ignore' });
        const tries = Math.ceil((opts.readyMs ?? 6_000) / 100);
        let up = false;
        for (let i = 0; i < tries && !up; i++) {
          // Bun.fetch, not globalThis.fetch: other test files in the same process replace the global.
          try { up = (await Bun.fetch(`${url}/health`)).ok; } catch { /* not up yet */ }
          if (!up) await Bun.sleep(100);
        }
        if (!up) throw new Error(`surreal did not answer /health within ${tries * 100} ms`);
        return '';
      } catch (e) {
        stop();
        return `cannot start engine: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}
