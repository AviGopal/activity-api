#!/usr/bin/env bun
/**
 * Vessel-side entry for the evidence-aliasing lint.
 *
 * Mirrors scripts/check-shape-dispatch.ts: the logic lives in the super-repo
 * package so every vessel runs the same rules, and this file only points at it.
 *
 * A field consumed as evidence by an elapsed-time or accumulation computation
 * must have exactly one writer. See packages/evidence-aliasing-check/check.ts
 * for the measured instances this exists to prevent recurring.
 */
import { resolve } from 'path';
import { existsSync } from 'fs';

const vesselRoot = resolve(import.meta.dir, '..');
const checkScript = resolve(vesselRoot, '../../packages/evidence-aliasing-check/check.ts');

// A vessel may be checked out without the super-repo around it (CI builds the
// vessel alone). Skipping is correct there: absence of the shared package is
// not a lint failure, and failing would make the check look flaky rather than
// informative — which is how checks get disabled.
if (!existsSync(checkScript)) {
  console.log('skip  evidence-aliasing: shared package not present (standalone checkout)');
  process.exit(0);
}

const proc = Bun.spawnSync(['bun', checkScript, vesselRoot], {
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(proc.exitCode ?? 1);
