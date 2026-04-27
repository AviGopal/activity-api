-- Migration 094: F-51 follow-up — DEFINE FIELD OVERWRITE for impulse_resolutions.*
--
-- Migration 093's REMOVE+DEFINE pattern (matching 045's precedent for tasks.*)
-- proved insufficient on SurrealDB 3.0 in production. Verified 2026-04-27 via
-- direct INFO query inside canary pod after deploying 1.13.0-b4e528f:
--
--   impulse_resolutions:    TYPE none | array<object> FLEXIBLE   ← OK
--   impulse_resolutions.*:  TYPE object                          ← missing FLEXIBLE
--
-- Statement 3 of migration 093 (`DEFINE FIELD impulse_resolutions.* ... TYPE
-- object FLEXIBLE`) returned `ERR: The field 'impulse_resolutions.*' already
-- exists` — the parent's FLEXIBLE auto-creates an implicit `.*` subfield, and
-- the explicit DEFINE collides. init-db's "already exists" filter swallows it
-- as non-critical, but this is the statement that closes F-51.
--
-- Fix: DEFINE FIELD OVERWRITE — SurrealDB 3.0 syntax that doesn't conflict
-- with auto-created subfields.

DEFINE FIELD OVERWRITE impulse_resolutions.* ON TABLE activity_execution_traces
  TYPE object
  FLEXIBLE;

-- Defensively re-OVERWRITE the parent too in case prior state diverged.
DEFINE FIELD OVERWRITE impulse_resolutions ON TABLE activity_execution_traces
  TYPE option<array<object>>
  FLEXIBLE;
