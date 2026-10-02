/**
 * A CLIENT-side deadline for one awaited call. A SurrealQL `TIMEOUT` clause bounds only the
 * statement it is attached to, once it is running: it cannot bound the wait for a slot in the
 * client's query semaphore (db/surreal.ts), a statement without the clause, or a socket that never
 * answers. A background job that holds a module-level "in flight" flag (trace retention) must never
 * await forever, so it races each call against this. The underlying query is NOT cancelled (its
 * semaphore slot is released when it returns); the caller is freed, logs, and abandons that unit of
 * work. Kept out of db/surreal.ts on purpose: dozens of tests mock that module wholesale.
 */
export class DeadlineExceededError extends Error {
  constructor(label: string, ms: number) {
    super(`deadline exceeded after ${ms}ms: ${label}`);
    this.name = 'DeadlineExceededError';
  }
}

export function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(label, ms)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}
