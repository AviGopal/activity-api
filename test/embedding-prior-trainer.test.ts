/**
 * Tests for the M1 continuous-training observer (concept_KKwxHmPfEMSY).
 *
 * The observer subscribes to broadcaster task.completed events, buffers
 * eligible (variant, signature) cells, and triggers a ridge re-fit on count
 * or time threshold. These tests pin: flag gating, eligibility filtering,
 * buffer eviction, count + time triggers, refit fan-out, and error isolation.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import {
  startEmbeddingPriorTrainer,
  type EmbeddingPriorTrainerDeps,
  type EmbeddingPriorTrainerConfig,
  type ContextScoreRow,
} from '../src/services/embedding-prior-trainer';
import type { WebSocketMessage } from '../src/websocket/types';

// ─── Test harness ────────────────────────────────────────────────────────────

interface FakeBroadcaster {
  emit: (msg: WebSocketMessage) => void;
  handlers: Array<(msg: WebSocketMessage) => void>;
  subscribe: (h: (msg: WebSocketMessage) => void) => () => void;
}

function makeFakeBroadcaster(): FakeBroadcaster {
  const handlers: Array<(msg: WebSocketMessage) => void> = [];
  return {
    handlers,
    subscribe(h) {
      handlers.push(h);
      return () => {
        const i = handlers.indexOf(h);
        if (i !== -1) handlers.splice(i, 1);
      };
    },
    emit(msg) {
      for (const h of handlers) h(msg);
    },
  };
}

function makeTaskCompleted(variantId: string, signature: string): WebSocketMessage {
  return {
    type: 'task.completed' as const,
    timestamp: new Date().toISOString(),
    data: {
      execution_id: `exec-${variantId}`,
      task_id: `task-${variantId}`,
      task_index: 0,
      success: true,
      duration_ms: 10,
      completed_at: new Date().toISOString(),
      input_impulse_ids: [],
      output_impulse_ids: [],
      // Spec-future fields:
      variant_id: variantId,
      signature,
    } as any,
  } as WebSocketMessage;
}

interface CapturedWrite {
  modelVersion: string;
  nTrainingSamples: number;
  featureDim: number;
  mseAlpha: number;
  mseBeta: number;
}

interface Harness {
  broadcaster: FakeBroadcaster;
  scores: Map<string, ContextScoreRow>;
  embeddings: Map<string, number[]>;
  writes: CapturedWrite[];
  loadEmbeddingCalls: number;
  loadScoreCalls: number;
  clock: { now: number };
  deps: EmbeddingPriorTrainerDeps;
}

// Synthetic ridge fit — deterministic, no DB. Produces a valid θ shape so
// writeWeights captures a row; numbers are not load-bearing for these tests.
function fakeFit(
  samples: { embedding: number[]; alpha: number; beta: number; total_executions: number }[],
  featureDim: number,
) {
  const p = featureDim + 1;
  const theta_alpha = new Array(p).fill(0);
  const theta_beta = new Array(p).fill(0);
  let sumA = 0;
  let sumB = 0;
  for (const s of samples) {
    sumA += s.alpha;
    sumB += s.beta;
  }
  theta_alpha[0] = sumA / Math.max(1, samples.length);
  theta_beta[0] = sumB / Math.max(1, samples.length);
  return { theta_alpha, theta_beta, mse_alpha: 0.001, mse_beta: 0.001 };
}

function makeHarness(opts: { featureDim?: number } = {}): Harness {
  const broadcaster = makeFakeBroadcaster();
  const scores = new Map<string, ContextScoreRow>();
  const embeddings = new Map<string, number[]>();
  const writes: CapturedWrite[] = [];
  const clock = { now: 1000 };
  const h: Harness = {
    broadcaster,
    scores,
    embeddings,
    writes,
    loadEmbeddingCalls: 0,
    loadScoreCalls: 0,
    clock,
    deps: {
      broadcaster,
      async loadContextScore(vid, sig) {
        h.loadScoreCalls += 1;
        return scores.get(`${vid}|${sig}`) ?? null;
      },
      async lookupEmbedding(sig) {
        h.loadEmbeddingCalls += 1;
        return embeddings.get(sig) ?? null;
      },
      async writeWeights(row) {
        writes.push({
          modelVersion: row.modelVersion,
          nTrainingSamples: row.nTrainingSamples,
          featureDim: row.featureDim,
          mseAlpha: row.mseAlpha,
          mseBeta: row.mseBeta,
        });
      },
      now: () => clock.now,
      fit: fakeFit as any,
    },
  };
  return h;
}

function makeEmbedding(dim: number, seed: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < dim; i++) out.push(Math.sin(seed + i * 0.01));
  return out;
}

function baseConfig(overrides: Partial<EmbeddingPriorTrainerConfig> = {}): EmbeddingPriorTrainerConfig {
  return {
    enabled: true,
    minObservations: 5,
    bufferCapacity: 100,
    refitTriggerCount: 3,
    refitIntervalMs: 60_000,
    featureDim: 4,
    lambda: 0.1,
    kappa: 10,
    orgId: 'test-org',
    ...overrides,
  };
}

function seedEligible(h: Harness, variantId: string, signature: string, totalExec = 10): void {
  h.scores.set(`${variantId}|${signature}`, {
    total_executions: totalExec,
    alpha: totalExec * 0.6,
    beta: totalExec * 0.4,
  });
  h.embeddings.set(signature, makeEmbedding(4, variantId.length));
}

// Small helper: wait for queued microtasks to flush.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('embedding-prior-trainer (M1 continuous-training observer)', () => {
  it('ignores events when flag disabled', async () => {
    const h = makeHarness();
    seedEligible(h, 'v1', 'sig1');
    const handle = startEmbeddingPriorTrainer(h.deps, baseConfig({ enabled: false }));
    h.broadcaster.emit(makeTaskCompleted('v1', 'sig1'));
    await flush();
    expect(h.loadScoreCalls).toBe(0);
    expect(h.loadEmbeddingCalls).toBe(0);
    expect(handle._state().bufferSize).toBe(0);
    handle.stop();
  });

  it('skips events with insufficient observations', async () => {
    const h = makeHarness();
    // total_executions=2 < minObservations=5
    h.scores.set('v1|sig1', { total_executions: 2, alpha: 1, beta: 1 });
    h.embeddings.set('sig1', makeEmbedding(4, 1));
    const handle = startEmbeddingPriorTrainer(h.deps, baseConfig());
    h.broadcaster.emit(makeTaskCompleted('v1', 'sig1'));
    await flush();
    expect(h.loadScoreCalls).toBe(1);
    expect(h.loadEmbeddingCalls).toBe(0); // never looked up embedding
    expect(handle._state().bufferSize).toBe(0);
    handle.stop();
  });

  it('skips events with no embedding available', async () => {
    const h = makeHarness();
    h.scores.set('v1|sig1', { total_executions: 10, alpha: 6, beta: 4 });
    // no embedding seeded
    const handle = startEmbeddingPriorTrainer(h.deps, baseConfig());
    h.broadcaster.emit(makeTaskCompleted('v1', 'sig1'));
    await flush();
    expect(handle._state().bufferSize).toBe(0);
    handle.stop();
  });

  it('pushes eligible events into the buffer', async () => {
    const h = makeHarness();
    seedEligible(h, 'v1', 'sig1');
    seedEligible(h, 'v2', 'sig2');
    const handle = startEmbeddingPriorTrainer(h.deps, baseConfig({ refitTriggerCount: 100 }));
    h.broadcaster.emit(makeTaskCompleted('v1', 'sig1'));
    h.broadcaster.emit(makeTaskCompleted('v2', 'sig2'));
    await flush();
    expect(handle._state().bufferSize).toBe(2);
    expect(handle._state().newSinceLastFit).toBe(2);
    handle.stop();
  });

  it('skips non-task.completed events', async () => {
    const h = makeHarness();
    seedEligible(h, 'v1', 'sig1');
    const handle = startEmbeddingPriorTrainer(h.deps, baseConfig());
    h.broadcaster.emit({
      type: 'tool.call' as const,
      timestamp: new Date().toISOString(),
      data: { variant_id: 'v1', signature: 'sig1' },
    } as unknown as WebSocketMessage);
    await flush();
    expect(h.loadScoreCalls).toBe(0);
    handle.stop();
  });

  it('skips events with missing variant_id or signature', async () => {
    const h = makeHarness();
    const handle = startEmbeddingPriorTrainer(h.deps, baseConfig());
    h.broadcaster.emit({
      type: 'task.completed' as const,
      timestamp: new Date().toISOString(),
      data: { execution_id: 'e1', task_id: 't1', success: true },
    } as unknown as WebSocketMessage);
    await flush();
    expect(h.loadScoreCalls).toBe(0);
    handle.stop();
  });

  it('triggers refit on count threshold and writes a new model_version row', async () => {
    const h = makeHarness();
    // 3 eligible variants — matches refitTriggerCount=3
    for (let i = 0; i < 3; i++) seedEligible(h, `v${i}`, `sig${i}`);
    const handle = startEmbeddingPriorTrainer(h.deps, baseConfig({ refitTriggerCount: 3 }));
    for (let i = 0; i < 3; i++) h.broadcaster.emit(makeTaskCompleted(`v${i}`, `sig${i}`));
    // microtask flush plus a small wait for the async refit chain
    await flush();
    await flush();
    await flush();
    expect(h.writes.length).toBe(1);
    expect(h.writes[0].nTrainingSamples).toBe(3);
    expect(h.writes[0].modelVersion).toContain('online-v1-');
    expect(h.writes[0].featureDim).toBe(4);
    expect(handle._state().newSinceLastFit).toBe(0);
    expect(handle._state().fitsCompleted).toBe(1);
    handle.stop();
  });

  it('triggers refit on time threshold when at least one new sample is buffered', async () => {
    const h = makeHarness();
    seedEligible(h, 'v1', 'sig1');
    const handle = startEmbeddingPriorTrainer(
      h.deps,
      baseConfig({ refitTriggerCount: 1000, refitIntervalMs: 5_000 }),
    );
    h.broadcaster.emit(makeTaskCompleted('v1', 'sig1'));
    await flush();
    expect(h.writes.length).toBe(0); // not enough new samples yet, no time elapsed

    // Advance clock past refitIntervalMs and emit again to trigger check.
    h.clock.now += 10_000;
    seedEligible(h, 'v2', 'sig2');
    h.broadcaster.emit(makeTaskCompleted('v2', 'sig2'));
    await flush();
    await flush();
    expect(h.writes.length).toBe(1);
    expect(h.writes[0].nTrainingSamples).toBe(2);
    handle.stop();
  });

  it('bounded buffer evicts oldest when capacity exceeded', async () => {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) seedEligible(h, `v${i}`, `sig${i}`);
    const handle = startEmbeddingPriorTrainer(
      h.deps,
      baseConfig({ bufferCapacity: 3, refitTriggerCount: 1000 }),
    );
    for (let i = 0; i < 5; i++) h.broadcaster.emit(makeTaskCompleted(`v${i}`, `sig${i}`));
    await flush();
    expect(handle._state().bufferSize).toBe(3);
    handle.stop();
  });

  it('catches errors in dependencies without throwing into the broadcaster', async () => {
    const h = makeHarness();
    seedEligible(h, 'v1', 'sig1');
    h.deps.loadContextScore = async () => {
      throw new Error('boom');
    };
    const handle = startEmbeddingPriorTrainer(h.deps, baseConfig());
    // emit() in the fake broadcaster calls handlers synchronously; the handler
    // wraps the async work in `void`, so this must not throw.
    expect(() => {
      h.broadcaster.emit(makeTaskCompleted('v1', 'sig1'));
    }).not.toThrow();
    await flush();
    expect(handle._state().bufferSize).toBe(0);
    handle.stop();
  });

  it('catches errors in writeWeights without disabling the observer', async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) seedEligible(h, `v${i}`, `sig${i}`);
    let writeCalls = 0;
    h.deps.writeWeights = async () => {
      writeCalls += 1;
      throw new Error('db unavailable');
    };
    const handle = startEmbeddingPriorTrainer(h.deps, baseConfig({ refitTriggerCount: 3 }));
    for (let i = 0; i < 3; i++) h.broadcaster.emit(makeTaskCompleted(`v${i}`, `sig${i}`));
    await flush();
    await flush();
    await flush();
    expect(writeCalls).toBe(1);
    // After a failed write, counters reset; observer is still alive.
    expect(handle._state().newSinceLastFit).toBe(0);
    // Add a new sample and confirm we still process it.
    seedEligible(h, 'v9', 'sig9');
    h.broadcaster.emit(makeTaskCompleted('v9', 'sig9'));
    await flush();
    expect(handle._state().newSinceLastFit).toBe(1);
    handle.stop();
  });

  it('stop() unsubscribes from broadcaster', async () => {
    const h = makeHarness();
    seedEligible(h, 'v1', 'sig1');
    const handle = startEmbeddingPriorTrainer(h.deps, baseConfig({ refitTriggerCount: 1000 }));
    handle.stop();
    h.broadcaster.emit(makeTaskCompleted('v1', 'sig1'));
    await flush();
    expect(h.loadScoreCalls).toBe(0);
    expect(handle._state().bufferSize).toBe(0);
  });
});
