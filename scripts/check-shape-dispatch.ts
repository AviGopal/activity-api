#!/usr/bin/env bun
import { resolve } from 'path';

const vesselRoot = resolve(import.meta.dir, '..');
const checkScript = resolve(vesselRoot, '../../packages/shape-dispatch-check/check.ts');

const proc = Bun.spawnSync(['bun', checkScript, vesselRoot], { stdout: 'inherit', stderr: 'inherit' });
process.exit(proc.exitCode ?? 1);
