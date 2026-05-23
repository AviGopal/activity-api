-- Migration 133: Substrate compatibility — make legacy ASSERT fields optional
-- The impulse.budget field has ASSERT $value >= 0 which fires before VALUE default
-- in SurrealDB 2.3.3, causing INSERT failures when budget is absent from payload.
-- This migration relaxes it to option<int> with a VALUE default of 10000.

DEFINE FIELD OVERWRITE budget ON impulse TYPE option<int>
  VALUE $value OR 10000
  COMMENT "Total resource budget (tokens, rows, bytes depending on resolver type)";

DEFINE FIELD OVERWRITE resources_consumed ON impulse TYPE option<int>
  VALUE $value OR 0
  COMMENT "Resources consumed from this impulse during resolution";

DEFINE FIELD OVERWRITE budget_exhausted ON impulse TYPE option<bool>
  VALUE $value OR false
  COMMENT "Whether budget was exceeded during resolution";

-- stored_at on activity_execution_traces — same issue (OVERWRITE needed)
DEFINE FIELD OVERWRITE stored_at ON activity_execution_traces TYPE option<datetime>
  VALUE $value OR time::now();
