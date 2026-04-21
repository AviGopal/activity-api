-- Migration 073: Add times_failed field to tool_argument_pattern
--
-- Purpose: Add missing times_failed counter field that's referenced in the application code
--
-- Context:
-- The application code tries to insert times_failed when recording tool argument patterns,
-- but this field was defined in schema 048 without a corresponding migration.
-- This causes 500 errors when storing tool usage patterns.
--
-- Error: "Found field 'times_failed', but no such field exists for table 'tool_argument_pattern'"

-- Add times_failed counter field
DEFINE FIELD IF NOT EXISTS times_failed ON tool_argument_pattern TYPE int
  VALUE $value OR 0
  COMMENT "Number of failed executions using this pattern";

-- Also add validation_error field if missing (from schema 048)
DEFINE FIELD IF NOT EXISTS validation_error ON tool_argument_pattern TYPE option<string>
  COMMENT "Specific validation rule that failed. NULL if validation passed or not a validation failure.";
