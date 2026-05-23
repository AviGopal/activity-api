-- Migration 134: Make activity table fields optional for SurrealDB 2.3.3 compat
-- SurrealDB 2.3.3 enforces TYPE constraints before VALUE defaults fire,
-- so TYPE int/float/string/bool rejects NONE even when VALUE $value OR <default>
-- is specified. Fix: use option<T> so absent fields pass type validation,
-- then VALUE supplies the default. Also drops ASSERT on learning_track since
-- ASSERT fires before VALUE — NONE fails the enum check before the default lands.
-- Companion to migration 133 (impulse + activity_execution_traces fields).

-- Thompson Sampling counters
DEFINE FIELD OVERWRITE total_executions ON activity
  TYPE option<int>
  VALUE $value OR 0;

DEFINE FIELD OVERWRITE successful_executions ON activity
  TYPE option<int>
  VALUE $value OR 0;

DEFINE FIELD OVERWRITE failed_executions ON activity
  TYPE option<int>
  VALUE $value OR 0;

-- Thompson Sampling posteriors
DEFINE FIELD OVERWRITE thompson_alpha ON activity
  TYPE option<float>
  VALUE $value OR 1.0;

DEFINE FIELD OVERWRITE thompson_beta ON activity
  TYPE option<float>
  VALUE $value OR 1.0;

-- Variant tracking (migration 055)
DEFINE FIELD OVERWRITE variant_generation ON activity
  TYPE option<int>
  VALUE $value OR 0;

DEFINE FIELD OVERWRITE retired ON activity
  TYPE option<bool>
  VALUE $value OR false;

-- Learning track (migration 119) — remove ASSERT so absent field doesn't fail;
-- VALUE provides the 'unclassified' default. Application layer enforces enum.
DEFINE FIELD OVERWRITE learning_track ON activity
  TYPE option<string>
  VALUE $value OR 'unclassified';
