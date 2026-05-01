/**
 * Phase 12 — Per-process LRU pool of authenticated SurrealDB sessions.
 *
 * Reuses sessions across `queryWithAuth` calls so the connect/use/
 * authenticate handshake amortises across the lifetime of a JWT instead
 * of recurring per query. Spec: openspec/changes/2026-04-26-impulse-
 * activity-loop/specs/activity-api-connection-pooling/spec.md.
 *
 * Cache key: SHA-256 hash of `${jwt.slice(0,32)}:${namespace}:${database}`.
 * The 32-char prefix is stable across requests using the same token but
 * doesn't expose the secret in error logs.
 */
import { Surreal } from 'surrealdb';
import { createHash } from 'node:crypto';
import { config } from '../config';
import { logger } from '../utils/logger';

const DEFAULT_MAX = 32;
const JWT_REFRESH_MARGIN_MS = 60_000;

export class PoolAcquireError extends Error {
  constructor(public readonly cause: Error) {
    super(`PoolAcquireError: ${cause.message}`);
    this.name = 'PoolAcquireError';
  }
}
export class PoolDrainingError extends Error {
  constructor() {
    super('PoolDrainingError: pool is draining');
    this.name = 'PoolDrainingError';
  }
}
export class SessionForceClosedError extends Error {
  constructor(public readonly elapsedMs: number) {
    super(`SessionForceClosedError: drain timeout exceeded after ${elapsedMs}ms`);
    this.name = 'SessionForceClosedError';
  }
}

export interface AcquiredSession {
  readonly db: Surreal;
  readonly key: string;
  readonly jwtExp: number;
}

export interface PoolStats {
  size: number;
  max_size: number;
  acquire_hits: number;
  acquire_misses: number;
  evictions: { expired: number; lru: number; drain: number };
  wait_queue_depth: number;
  in_flight: number;
}

interface CachedSession {
  db: Surreal;
  key: string;
  ns: string;
  database: string;
  jwtExp: number;
  createdAt: number;
  lastUsedAt: number;
  inFlight: boolean;
  evictOnRelease: boolean;
}

interface Waiter {
  key: string;
  jwt: string;
  ns: string;
  database: string;
  resolve: (s: AcquiredSession) => void;
  reject: (e: Error) => void;
}

function deriveKey(jwt: string, ns: string, db: string): string {
  return createHash('sha256').update(`${jwt.slice(0, 32)}:${ns}:${db}`).digest('hex').slice(0, 24);
}

function parseJwtExp(jwt: string): number {
  // JWT format: header.payload.signature; payload is base64url JSON.
  // exp is in seconds; we return ms.
  const parts = jwt.split('.');
  if (parts.length < 2) throw new Error('jwt missing payload');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (typeof payload.exp !== 'number') throw new Error('jwt missing exp claim');
  return payload.exp * 1000;
}

class AuthSessionPool {
  private cache = new Map<string, CachedSession>();
  private waitQueue: Waiter[] = [];
  private draining = false;
  private maxSize: number;
  private hits = 0;
  private misses = 0;
  private evictions = { expired: 0, lru: 0, drain: 0 };

  constructor() {
    this.maxSize = Number(process.env.DB_POOL_MAX) || DEFAULT_MAX;
  }

  enabled(): boolean {
    // Spec: default false until canary validation flips it to true.
    // Operators set DB_POOL_ENABLED=true on the canary env to opt in.
    return process.env.DB_POOL_ENABLED === 'true';
  }

  async acquire(jwt: string, ns: string, database: string): Promise<AcquiredSession> {
    if (this.draining) throw new PoolDrainingError();

    const key = deriveKey(jwt, ns, database);
    const cached = this.cache.get(key);
    const now = Date.now();

    // Hit path: cached, not in-flight, JWT not within refresh margin.
    if (cached && !cached.inFlight && now < cached.jwtExp - JWT_REFRESH_MARGIN_MS) {
      cached.inFlight = true;
      cached.lastUsedAt = now;
      this.hits++;
      return { db: cached.db, key, jwtExp: cached.jwtExp };
    }

    // Stale-jwt eviction: cached but within refresh margin or expired.
    if (cached && now >= cached.jwtExp - JWT_REFRESH_MARGIN_MS) {
      this.evictions.expired++;
      logger.info('[auth-pool] evicting session: jwt within refresh margin', { key, jwtExp: cached.jwtExp });
      if (cached.inFlight) {
        cached.evictOnRelease = true;
      } else {
        await safeClose(cached.db);
        this.cache.delete(key);
      }
    }

    // In-flight on the same key — wait for release rather than open a duplicate.
    if (cached && cached.inFlight && !cached.evictOnRelease) {
      return await this.enqueueWaiter(key, jwt, ns, database);
    }

    // Cache full of distinct keys: try LRU eviction or wait.
    if (this.cache.size >= this.maxSize) {
      const evicted = this.evictLRU();
      if (!evicted) {
        return await this.enqueueWaiter(key, jwt, ns, database);
      }
    }

    return await this.openNew(key, jwt, ns, database);
  }

  release(session: AcquiredSession): void {
    const cached = this.cache.get(session.key);
    if (!cached) return;
    cached.inFlight = false;
    cached.lastUsedAt = Date.now();

    if (cached.evictOnRelease) {
      void safeClose(cached.db);
      this.cache.delete(session.key);
    }

    // Wake one waiter — prefer same-key waiter for hit reuse.
    const sameKeyIdx = this.waitQueue.findIndex(w => w.key === session.key);
    const idx = sameKeyIdx >= 0 ? sameKeyIdx : 0;
    if (this.waitQueue.length === 0) return;
    const w = this.waitQueue.splice(idx, 1)[0]!;
    if (sameKeyIdx >= 0 && this.cache.has(session.key)) {
      // Reuse: same-key hit
      const reused = this.cache.get(session.key)!;
      reused.inFlight = true;
      reused.lastUsedAt = Date.now();
      this.hits++;
      w.resolve({ db: reused.db, key: session.key, jwtExp: reused.jwtExp });
      return;
    }
    // Different key: evict LRU if needed, then open fresh for the waiter.
    if (this.cache.size >= this.maxSize) this.evictLRU();
    this.openNew(w.key, w.jwt, w.ns, w.database).then(w.resolve, w.reject);
  }

  async drain(timeoutMs: number): Promise<void> {
    this.draining = true;
    // Reject all queued waiters.
    while (this.waitQueue.length > 0) {
      this.waitQueue.shift()!.reject(new PoolDrainingError());
    }
    const deadline = Date.now() + timeoutMs;
    // Wait for in-flight to drain via polling — sessions are released by their owners.
    while (Date.now() < deadline) {
      if (![...this.cache.values()].some(s => s.inFlight)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    let forceClosed = 0;
    for (const [key, s] of this.cache) {
      if (s.inFlight) {
        forceClosed++;
        await safeClose(s.db);
        this.cache.delete(key);
        this.evictions.drain++;
      } else {
        await safeClose(s.db);
        this.cache.delete(key);
        this.evictions.drain++;
      }
    }
    if (forceClosed > 0) {
      logger.warn('[auth-pool] drain timeout: force-closed sessions', { count: forceClosed });
    }
  }

  poolStats(): PoolStats {
    return {
      size: this.cache.size,
      max_size: this.maxSize,
      acquire_hits: this.hits,
      acquire_misses: this.misses,
      evictions: { ...this.evictions },
      wait_queue_depth: this.waitQueue.length,
      in_flight: [...this.cache.values()].filter(s => s.inFlight).length,
    };
  }

  private evictLRU(): boolean {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, s] of this.cache) {
      if (!s.inFlight && s.lastUsedAt < oldestTs) {
        oldestTs = s.lastUsedAt;
        oldestKey = k;
      }
    }
    if (!oldestKey) return false;
    const victim = this.cache.get(oldestKey)!;
    void safeClose(victim.db);
    this.cache.delete(oldestKey);
    this.evictions.lru++;
    return true;
  }

  private async openNew(key: string, jwt: string, ns: string, database: string): Promise<AcquiredSession> {
    let jwtExp: number;
    try {
      jwtExp = parseJwtExp(jwt);
    } catch (e) {
      throw new PoolAcquireError(e as Error);
    }
    const db = new Surreal();
    try {
      await db.connect(config.surrealdb.url);
      await db.use({ namespace: ns, database });
      await db.authenticate(jwt);
    } catch (e) {
      try { await db.close(); } catch {}
      this.misses++;
      throw new PoolAcquireError(e as Error);
    }
    const now = Date.now();
    const entry: CachedSession = {
      db, key, ns, database, jwtExp,
      createdAt: now, lastUsedAt: now,
      inFlight: true, evictOnRelease: false,
    };
    this.cache.set(key, entry);
    this.misses++;
    if (this.waitQueue.length > 4) {
      logger.warn('[auth-pool] saturation: waiting requests', { depth: this.waitQueue.length });
    }
    logger.info('[auth-pool] opening new session', { key, ns, database });
    return { db, key, jwtExp };
  }

  private enqueueWaiter(key: string, jwt: string, ns: string, database: string): Promise<AcquiredSession> {
    return new Promise<AcquiredSession>((resolve, reject) => {
      this.waitQueue.push({ key, jwt, ns, database, resolve, reject });
    });
  }
}

async function safeClose(db: Surreal): Promise<void> {
  try { await db.close(); } catch (e) {
    logger.debug('[auth-pool] safeClose error (ignored)', { error: e instanceof Error ? e.message : String(e) });
  }
}

export const authSessionPool = new AuthSessionPool();
