// RECOMMEND'S CANDIDATE READ IS SERVED FROM THE TEMPLATE CATALOGUE CACHE (CHANGE DB3).
//
//   [MUST-FAIL] two recommend candidate reads with the same inputs make ONE database read (today: one per call).
//   [CONTROL]   a template write (invalidateTemplateCache) makes the next read go to the database: visible next read.
//   [CONTROL]   an RBAC JWT query is never cached; an EMPTY result is never cached and is not read twice.
//   [CONTROL]   a hit is a deep copy: a caller mutating its rows does not change the next caller's.
//   [CONTROL]   wiring: the tiered fallback's tier 1 and tier 2 use the cached read.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { queryActivitiesByShapesCached } from './activities.get-activities-with-tiered-fallback';
import { clearTemplateCatalogue, invalidateTemplateCache } from '../utils/template-cache';
import { __clearTuningParamCache } from '../lib/tuning-params';

let reads = 0;
const rows = () => [{ id: 'activity:a', name: 'a', input_shapes: ['x'], metrics: { n: 1 } }];
const q = (async () => { reads += 1; return { data: rows(), path: 'new', latency_ms: 1 }; }) as never;
const qEmpty = (async () => { reads += 1; return { data: [], path: 'new', latency_ms: 1 }; }) as never;
beforeEach(() => { reads = 0; clearTemplateCatalogue(); (__clearTuningParamCache as (() => void) | undefined)?.(); });

describe('recommend candidate cache', () => {
  it('[MUST-FAIL] the same candidate read twice is ONE database read', async () => {
    const a = await queryActivitiesByShapesCached(['x'], 'org-1', null, null, 30, null, q);
    const b = await queryActivitiesByShapesCached(['x'], 'org-1', null, null, 30, null, q);
    expect(a.data.length).toBe(1); expect(b.data.length).toBe(1);
    expect(reads).toBe(1);
  });

  it('[CONTROL] a template write is visible on the next read', async () => {
    await queryActivitiesByShapesCached(['x'], 'org-1', null, null, 30, null, q);
    // its in-process clear runs synchronously first; the Redis half is not under test (no Redis here)
    void invalidateTemplateCache('a').catch(() => undefined);
    await queryActivitiesByShapesCached(['x'], 'org-1', null, null, 30, null, q);
    expect(reads).toBe(2);
  });

  it('[CONTROL] a JWT query is never cached; an empty result is never cached and read once', async () => {
    await queryActivitiesByShapesCached(['x'], 'org-1', null, null, 30, 'jwt-token', q);
    await queryActivitiesByShapesCached(['x'], 'org-1', null, null, 30, 'jwt-token', q);
    expect(reads).toBe(2);
    reads = 0;
    const e1 = await queryActivitiesByShapesCached(['y'], 'org-1', null, null, 30, null, qEmpty);
    expect(e1.data).toEqual([]);
    expect(reads).toBe(1);
  });

  it('[CONTROL] a hit is a deep copy', async () => {
    const a = await queryActivitiesByShapesCached(['x'], 'org-1', null, null, 30, null, q);
    (a.data[0] as any).metrics.n = 999;
    const b = await queryActivitiesByShapesCached(['x'], 'org-1', null, null, 30, null, q);
    expect((b.data[0] as any).metrics.n).toBe(1);
  });

  it('[CONTROL] wiring: tiers 1 and 2 read through the cache', () => {
    const src = readFileSync(new URL('./activities.get-activities-with-tiered-fallback.ts', import.meta.url), 'utf8');
    expect(src.split('await queryActivitiesByShapesCached(').length - 1).toBe(2);
    expect(src).not.toMatch(/await queryActivitiesByShapes\(/);
  });
});
