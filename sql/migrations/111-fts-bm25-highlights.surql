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
