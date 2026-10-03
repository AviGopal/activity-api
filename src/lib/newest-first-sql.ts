/**
 * Newest-first SELECT that stays correct on SurrealDB 2.3.10.
 *
 * On SurrealDB 2.3.10 (also 2.4.1 and 2.5.0; 2.3.3 is correct) a range predicate on an indexed
 * field plus ORDER BY that field DESC plus LIMIT returns the LOWEST n rows of the range: the limit
 * stops the ascending index scan before the sort. The verified-correct form filters inside a
 * subquery and sorts / limits / pages outside it, so the index still serves the range and the sort
 * sees every row of it. Cost is O(rows in the range), the same order the correct engine paid for the
 * unwrapped form.
 *
 * The wrap is applied only when a condition is a range on the order field: without one the plain
 * form plans a scan with a bounded top-k collector, and wrapping it would materialise every
 * matching row instead.
 *
 * Gap: surrealdb-2-3-10-returns-the-lowest-rows-for-an-indexed-range-ordered-desc-with-a-limit.
 * Pinned generically by test/newest-first-sql.test.ts (NOINDEX equivalence on a real engine).
 */
export interface NewestFirstSqlOptions {
  /** Projection; its output must carry `orderBy` under that name (the outer sort reads the inner rows). */
  fields: string;
  /** Table (or view) name. */
  from: string;
  /** Conditions, joined with AND. Empty means no WHERE. */
  where: string[];
  /** The field sorted DESC. */
  orderBy: string;
  /** LIMIT operand, e.g. `$limit` or a literal. */
  limit: string | number;
  /** Optional START operand. */
  start?: string | number;
}

/** True when some condition is a range comparison on `field`. */
export function hasRangeOn(field: string, where: string[]): boolean {
  const f = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\w.])${f}\\s*(>=|<=|>|<)`);
  return where.some((c) => re.test(c));
}

export function newestFirstSql(o: NewestFirstSqlOptions): string {
  const where = o.where.length > 0 ? `WHERE ${o.where.join(' AND ')}` : '';
  const tail = `ORDER BY ${o.orderBy} DESC LIMIT ${o.limit}${o.start !== undefined ? ` START ${o.start}` : ''}`;
  if (!hasRangeOn(o.orderBy, o.where)) {
    return `SELECT ${o.fields} FROM ${o.from} ${where} ${tail}`;
  }
  return `SELECT * FROM (SELECT ${o.fields} FROM ${o.from} ${where}) ${tail}`;
}
