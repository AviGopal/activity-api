-- Migration 138: Make execution_trace_content.created_at optional
-- VALUE default does not fire on INSERT INTO in this SurrealDB version,
-- causing "Found NONE for field `created_at`" when the caller omits the field.
-- Mirror the fix applied to stored_at in migration 133.

DEFINE FIELD OVERWRITE created_at ON execution_trace_content TYPE option<datetime>
  VALUE $value OR time::now();
