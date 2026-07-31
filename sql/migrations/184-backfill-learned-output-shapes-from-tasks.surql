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
-- outputShapes — the authoritative produced shapes. After this, the 218 fixable
-- rows become shape-eligible and the existing embedding-conditioned priors
-- warm-start them (retrieval is by shape; scoring already exists).
--
-- SAFE + IDEMPOTENT: only rows still carrying a placeholder AND whose tasks
-- declare >= 1 real shape are touched. The 48 rows whose tasks declare no real
-- shape are left untouched (nothing to derive). Only the output_shapes column is
-- written — provenance (extracted_from / goalSignature / metadata) and the
-- separate posterior/metric tables are untouched. Re-running is a no-op once the
-- placeholder is gone (the array::any WHERE clause stops matching).
-- (2026-07-31, gap-ribosome-reuse-hop-cold-blocked)

UPDATE activity
  SET output_shapes = array::distinct(array::complement(
        array::flatten(tasks[*].outputShapes ?? []),
        ['tool_output', 'tool_result', 'toolOutput', 'unknown_output']
      ))
  WHERE string::starts_with(meta::id(id), 'learned-')
    AND array::any(output_shapes, |$s| $s IN ['tool_output', 'tool_result', 'toolOutput', 'unknown_output'])
    AND array::len(array::distinct(array::complement(
        array::flatten(tasks[*].outputShapes ?? []),
        ['tool_output', 'tool_result', 'toolOutput', 'unknown_output']
      ))) > 0;
