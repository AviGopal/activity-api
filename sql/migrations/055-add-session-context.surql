-- ============================================================================
-- Migration 055: Add Session Context to Execution Traces
-- ============================================================================
-- Purpose: Enable within-session composition learning
--
-- Task #26: Add session context to execution traces
--
-- This adds a session_context field to the execution_traces table,
-- allowing learning systems to understand activity sequences within
-- a single session and learn composition patterns.
-- ============================================================================

-- Add session_context field to execution_traces table
-- This is a flexible object field that contains session-level metadata
DEFINE FIELD session_context ON execution_traces TYPE option<object> FLEXIBLE;

-- No index needed - session_context is used for learning analysis,
-- not for query filtering. Sessions are accessed via execution_id lookup.

-- Query patterns:
-- 1. GET trace with session context: SELECT * FROM execution_traces WHERE execution_id = $id
-- 2. Analyze session patterns: SELECT session_context.goal_chain FROM execution_traces WHERE session_context IS NOT NONE
-- 3. Composition learning: SELECT previous_activities FROM (SELECT session_context.previous_activities FROM execution_traces) FLATTEN
