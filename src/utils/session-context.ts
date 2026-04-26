import { createHash } from 'crypto';
import { analyzeTaskSemantics } from './semantic-tags';

export interface SessionContext {
  loaded_shapes: string[];
  loaded_pointer_paths: string[];
  load_timestamps_ms: number[];
}

const TOKEN_STOP_LIST = new Set([
  'src', 'ts', 'js', 'tsx', 'jsx', 'py', 'go', 'rs', 'java',
  'json', 'yaml', 'yml', 'md', 'the', 'and', 'for', 'in', 'of',
]);

function tokenize(s: string): string[] {
  return s
    .split(/[_\-./\s]+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 2 && !TOKEN_STOP_LIST.has(t));
}

export function extractContextTokens(
  sessionContext: SessionContext,
  hotCount: number = 3,
): string[] {
  const { loaded_shapes, loaded_pointer_paths, load_timestamps_ms } = sessionContext;
  const n = loaded_shapes.length;

  const indexed = Array.from({ length: n }, (_, i) => ({
    shape: loaded_shapes[i],
    path: loaded_pointer_paths[i] ?? '',
    ts: load_timestamps_ms[i] ?? 0,
  }));

  const sortedByTs = [...indexed].sort((a, b) => b.ts - a.ts);
  const hotSet = new Set(sortedByTs.slice(0, hotCount).map((_, i) => {
    const orig = indexed.indexOf(sortedByTs[i]);
    return orig;
  }));

  const hotIndices = new Set(
    sortedByTs.slice(0, hotCount).map(entry => indexed.indexOf(entry)),
  );

  const seen = new Set<string>();
  const result: string[] = [];

  const add = (t: string) => {
    if (!seen.has(t)) { seen.add(t); result.push(t); }
  };

  for (let i = 0; i < n; i++) {
    const isHot = hotIndices.has(i);
    for (const t of tokenize(loaded_shapes[i])) add(t);
    if (isHot && loaded_pointer_paths[i]) {
      for (const t of tokenize(loaded_pointer_paths[i])) add(t);
    }
  }

  return result;
}

const HALF_LIFE_S = parseInt(process.env.IMPULSE_DECAY_HALF_LIFE_SECONDS ?? '600', 10);
const LAMBDA = Math.LN2 / HALF_LIFE_S;

export function decayWeight(loaded_at_ms: number, now_ms: number): number {
  const age_s = Math.max(0, (now_ms - loaded_at_ms) / 1000);
  return Math.min(1, Math.exp(-LAMBDA * age_s));
}

export function extractContextTokensWithDecay(
  sessionContext: SessionContext,
  hotCount: number = 3,
  nowMs: number = Date.now(),
): { tokens: string[]; decayWeightsByShape: Map<string, number> } {
  const { loaded_shapes, loaded_pointer_paths, load_timestamps_ms } = sessionContext;
  const n = loaded_shapes.length;

  const indexed = Array.from({ length: n }, (_, i) => ({
    shape: loaded_shapes[i],
    path: loaded_pointer_paths[i] ?? '',
    ts: load_timestamps_ms[i] ?? 0,
    weight: decayWeight(load_timestamps_ms[i] ?? 0, nowMs),
  }));

  const sortedByTs = [...indexed].sort((a, b) => b.ts - a.ts);
  const hotIndices = new Set(
    sortedByTs.slice(0, hotCount).map(entry => indexed.indexOf(entry)),
  );

  const seen = new Set<string>();
  const result: string[] = [];
  const decayWeightsByShape = new Map<string, number>();

  const add = (t: string) => {
    if (!seen.has(t)) { seen.add(t); result.push(t); }
  };

  for (let i = 0; i < n; i++) {
    const { shape, path, weight } = indexed[i];
    const isHot = hotIndices.has(i);

    decayWeightsByShape.set(shape, Math.max(decayWeightsByShape.get(shape) ?? 0, weight));

    const fullWeight = weight >= 0.3;
    for (const t of tokenize(shape)) add(t);
    if ((isHot || fullWeight) && path) {
      for (const t of tokenize(path)) add(t);
    }
  }

  return { tokens: result, decayWeightsByShape };
}

export function computeContextBucket(
  taskDescription: string,
  impulseShapes: string[],
  orgId: string,
): string {
  const tagPrefixes = analyzeTaskSemantics(taskDescription).tagPrefixes.slice(0, 3).sort();
  const goalClusterByte = createHash('sha256')
    .update(tagPrefixes.join(','))
    .digest()[0];
  const goal_cluster_id = goalClusterByte % 20;

  const shapeKey = [...impulseShapes].sort().join(',');
  const raw = `${shapeKey}|${orgId}|${goal_cluster_id}`;
  return createHash('sha256').update(raw).digest().slice(0, 4).toString('hex');
}
