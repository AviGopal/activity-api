// The set-based range drain must stay INDEX-ORDERED. Measured 2026-10-16 (node 1's first live valve run after the
// retention hold lifted, reproduced on a 400k-row scratch store, 54% protected, 18.5k label ids): when the protected
// filter sat inside the $ts SELECT, its LIMIT no longer returned the oldest rows, the boundary landed ~100k rows ahead,
// and every batch ran past its 20 s TIMEOUT (the valve fell back to the 25-row id loop). The fixed batch reads the
// oldest $n timestamps off the index, reads the range once, and filters protection IN MEMORY (array::complement):
// ~0.33 s for a 2000-row batch on the same store. Source-level, so it fails on the defective form for that reason alone.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

const src = readFileSync(new URL('./trace-retention.ts', import.meta.url), 'utf8');
const batch = src.slice(src.indexOf('const DRAIN_BATCH_SQL'), src.indexOf('COMMIT TRANSACTION;`;', src.indexOf('const DRAIN_BATCH_SQL')));
const tsLine = batch.split('\n').find((l) => l.startsWith('LET $ts ')) ?? '';

describe('[MUST-FAIL] the range drain batch stays index-ordered; protection is filtered in memory', () => {
  test('the $ts SELECT carries no protection predicate (a residual filter loses the index order)', () => {
    expect(tsLine).toContain('SELECT VALUE executed_at FROM');
    expect(tsLine).not.toContain('type::is::bool');
    expect(tsLine).not.toContain('NOTINSIDE');
    expect(tsLine).not.toContain('UNPROTECTED_WHERE');
  });
  test('protection is applied to the batch\'s rows as a set difference against the protected list', () => {
    expect(batch).toContain('array::complement($__cheap, $__prot)');
  });
  test('the batch starts at the drain\'s own lower bound and reports its boundary (protected ranges are stepped over)', () => {
    expect(tsLine).toContain('executed_at >= type::datetime($lo)');
    expect(batch).toMatch(/boundary: \$b/);
    expect(src).toMatch(/counted === 0 && scanned > 0 && boundary && boundary > lo/);
  });
});
