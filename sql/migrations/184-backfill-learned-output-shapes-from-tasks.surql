-- 184: Backfill learned-* template output_shapes from their tasks' outputShapes.
--
-- 266 of ~425 extracted composites carried output_shapes:['tool_output'] (or a
-- placeholder mixed with real shapes) because they were written before the
-- write-path guard in src/routes/activities.ts (commit d1bb036) derived output
-- shapes from the tasks. The placeholder makes a composite shape-INELIGIBLE:
-- goal-host's advancesTarget() never matches 'tool_output' against a real goal
-- target, so the walk can never RETRIEVE the learned pathway as a candidate, it
-- never reaches the (already-rich) embedding/Thompson scorer, and it never earns
-- a posterior — the reuse hop sat at 0 executions across the whole population.
--
-- This is the historical-rows counterpart of that write-path guard: set
-- output_shapes to the placeholder-stripped union of the tasks' own declared
-- outputShapes — the authoritative produced shapes. After this the ~216 fixable
-- rows become shape-eligible and the existing embedding-conditioned priors
-- warm-start them (retrieval is by shape; scoring already exists).
--
-- NONE-safety: some learned rows have `tasks` absent entirely (projection ->
-- NONE) and others have tasks whose `outputShapes` are null (-> [null, ...]).
-- array::flatten(NONE) errors, and a null element would violate the SCHEMAFULL
-- array<string> assert on output_shapes. So coalesce the projection with `?? []`
-- (absent case) AND array::filter to type::is::string non-placeholder elements
-- (null / placeholder case). Rows whose real-shape set is empty are left as-is.
--
-- SAFE + IDEMPOTENT: only rows still carrying a placeholder AND whose tasks
-- declare >= 1 real (string, non-placeholder) shape are touched. Only the
-- output_shapes column is written — provenance (extracted_from / goalSignature /
-- metadata) and the separate posterior/metric tables are untouched. Re-running is
-- a no-op once the placeholder is gone (the array::any WHERE clause stops
-- matching). (2026-07-31, gap-ribosome-reuse-hop-cold-blocked)

UPDATE activity
  SET output_shapes = array::distinct(array::filter(
        array::flatten(tasks[*].outputShapes ?? []),
        |$s| type::is::string($s)
             AND !($s IN ['tool_output', 'tool_result', 'toolOutput', 'unknown_output'])
      ))
  WHERE string::starts_with(meta::id(id), 'learned-')
    AND array::any(output_shapes, |$s| $s IN ['tool_output', 'tool_result', 'toolOutput', 'unknown_output'])
    AND array::len(array::distinct(array::filter(
        array::flatten(tasks[*].outputShapes ?? []),
        |$s| type::is::string($s)
             AND !($s IN ['tool_output', 'tool_result', 'toolOutput', 'unknown_output'])
      ))) > 0;
