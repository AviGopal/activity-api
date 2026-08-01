-- 185: Backfill EXISTING learned-* composites' per-task config for shape-routed steps.
--
-- Migration 184 fixed the top-level output_shapes placeholder; this fixes the deeper
-- HOLLOW-SHELL defect: every composite step is authored as {resolver: <shape>, config:{}}
-- with no executable body (goal-host buildCompositeTraceFromChain never set config; the
-- persistence layer strips it further). A shape-routed step is executable ONLY when paired
-- with config.type = <shape> — the mintResolverWrapper form the engine pre-registers a
-- discovery VesselResolver for (see commit 3ccc65f, which reconstructs this at trace-SIGNATURE
-- read time for the ribosome, but does not touch already-STORED composite rows).
--
-- This session's teach-and-observe runs (2026-08-01) proved end-to-end that the reuse
-- SEARCH machinery (retrieval + target-inference + selection, B1-B4) reliably finds and
-- SELECTS these existing composites for matching goals across multiple distinct shape
-- families (orphaned_capability_scan->substrateGap_write, ...->unknown_shape_report, ...).
-- Every one of them then failed to EXECUTE for exactly this reason — confirmed via live
-- execution trace: compose-step-1 (orphaned_capability_scan) succeeds, compose-step-2
-- (substrateGap_write, config:{}) fails with no output. Backfilling config here — mirroring
-- the exact reconstruction 3ccc65f applies for NEW extractions — unlocks the entire
-- already-taught, already-searchable population for REAL reuse without waiting on new
-- extractions to accumulate one at a time.
--
-- SAFE + IDEMPOTENT + SCOPED: only touches tasks whose resolver is set, whose config is
-- absent/empty, AND whose resolver is NOT a meta-resolver (llm_completion_dispatch,
-- http_fetch, bash, file, git, noop, impulse-resolve/impulse_resolve, validation,
-- iteration) — a meta-resolver's real config (e.g. an LLM prompt) was never persisted and
-- must not be faked with a bare {type}; those tasks are left untouched exactly as before
-- (no regression). Also backfills empty per-task outputShapes to [resolver] to match. Only
-- the `tasks` column is written — provenance, posterior/metric columns, and top-level
-- output_shapes (already fixed by 184) are untouched. Re-running is a no-op once every
-- shape-routed task has a non-empty config (the WHERE clause stops matching).
-- (2026-08-01, gap-ribosome-reuse-hop-cold-blocked)

UPDATE activity
  SET tasks = array::map(tasks ?? [], |$t|
        IF $t.resolver != NONE
           AND (($t.config == NONE) OR ($t.config == {}))
           AND !($t.resolver IN ['llm_completion_dispatch', 'http_fetch', 'bash', 'file', 'git',
                                  'noop', 'impulse-resolve', 'impulse_resolve', 'validation', 'iteration'])
        THEN {
          id: $t.id,
          description: $t.description,
          resolver: $t.resolver,
          config: { type: $t.resolver },
          inputShapes: $t.inputShapes,
          outputShapes: IF array::len($t.outputShapes ?? []) > 0 THEN $t.outputShapes ELSE [$t.resolver] END
        }
        ELSE $t END)
  WHERE string::starts_with(meta::id(id), 'learned-')
    AND array::any(tasks ?? [], |$t|
          $t.resolver != NONE
          AND (($t.config == NONE) OR ($t.config == {}))
          AND !($t.resolver IN ['llm_completion_dispatch', 'http_fetch', 'bash', 'file', 'git',
                                 'noop', 'impulse-resolve', 'impulse_resolve', 'validation', 'iteration']));
