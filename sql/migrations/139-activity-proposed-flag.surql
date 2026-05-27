-- Migration 139: add `proposed` boolean field to activity table
--
-- Per audit investigation-028 recommendation A and openspec change
-- 2026-05-27-neutral-emitter-lifecycle-bus sibling work (capability generation
-- safety). Substrate-authored writes (ribosome, make-activity) set proposed=true
-- so templates land in the registry but are EXCLUDED from Thompson recommendation
-- candidate pools until an operator (or future autonomous promoter) calls
-- POST /v2/activities/templates/:id/promote.
--
-- Defaults to false for backward compatibility with all existing rows
-- (treated as already-promoted).

DEFINE FIELD OVERWRITE proposed ON activity TYPE bool VALUE $value OR false PERMISSIONS FULL;
