-- Phase 10 P3 follow-up #4: re-define the FTS indexes with HIGHLIGHTS so
-- BM25 scoring actually computes a non-zero value per match.
--
-- 10.7 acceptance probe (after migrations 109/110): WHERE clauses match
-- correctly via the @N@ operator (10.S5 verified), but search::score(0)
-- and search::score(1) returned 0 for every row — including obvious
-- matches like "Execute A Bash Command…" against the literal 'bash'.
-- search::highlight() also returned the unhighlighted source string,
-- confirming the index lacked the per-document term-position metadata
-- that both score and highlight depend on.
--
-- Root cause: the original schema (sql/schemas/040-fts-recommendation.surql)
-- defined the indexes with `BM25(1.2, 0.75)` but no `HIGHLIGHTS` clause.
-- In SurrealDB 2.x, FULLTEXT indexes only store position information
-- when HIGHLIGHTS is set; without it, BM25 score requests fall through
-- to a degenerate constant. Same fix concept-db landed earlier this
-- iteration but on the wrong operator form (@N@@ → @N@); that change
-- is necessary but not sufficient — without HIGHLIGHTS, score is still
-- structurally zero.
--
-- DEFINE INDEX OVERWRITE forces re-creation; SurrealDB will rebuild the
-- index against the existing rows, populating the position info needed
-- for BM25.
--
-- Idempotent: re-running just rebuilds the index against current data.

DEFINE INDEX OVERWRITE idx_activity_name_fts
  ON activity
  FIELDS name
  FULLTEXT ANALYZER activity_analyzer BM25(1.2, 0.75) HIGHLIGHTS;

DEFINE INDEX OVERWRITE idx_activity_description_fts
  ON activity
  FIELDS description
  FULLTEXT ANALYZER activity_analyzer BM25(1.2, 0.75) HIGHLIGHTS;

-- 2026-05-01 follow-up: DEFINE INDEX OVERWRITE updates the schema but
-- does NOT reindex existing rows in SurrealDB 3.x. After OVERWRITE the
-- index is empty until either (a) every row gets touched by an UPDATE
-- (fires the FTS index hook) or (b) REBUILD INDEX is run. Without this,
-- search::score(N) returns 0 even though search::highlight() shows the
-- term-position info is structurally correct on new writes.
--
-- REBUILD INDEX is slow (~10s per index against the current ~3k row
-- corpus) but idempotent and only runs on first migration application.
-- Production-scale corpora may want to run this off-band.

REBUILD INDEX idx_activity_name_fts ON activity;
REBUILD INDEX idx_activity_description_fts ON activity;
