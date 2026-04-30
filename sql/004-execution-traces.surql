-- ============================================================================
-- Migration 004: Execution Traces Storage
-- ============================================================================
-- Purpose: Store execution traces for debugging-as-activity workflow
--
-- This enables:
-- 1. Failed activity → stored trace → impulse → goal-seeking debug
-- 2. Successful execution → stored trace → ribosome → new template
-- 3. Metrics analysis → stored trace → optimization opportunities
-- ============================================================================

-- Define the execution_traces table
DEFINE TABLE execution_traces SCHEMAFULL;

-- Fields
DEFINE FIELD execution_id ON execution_traces TYPE string;
DEFINE FIELD template_id ON execution_traces TYPE string;
DEFINE FIELD status ON execution_traces TYPE string 
  ASSERT $value IN ["success", "failure", "partial"];
DEFINE FIELD duration_ms ON execution_traces TYPE number;
DEFINE FIELD cost_usd ON execution_traces TYPE number;
DEFINE FIELD execution_trace ON execution_traces TYPE object;
DEFINE FIELD stored_at ON execution_traces TYPE datetime DEFAULT time::now();
DEFINE FIELD created_at ON execution_traces TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON execution_traces TYPE datetime DEFAULT time::now();

-- Indexes
DEFINE INDEX idx_execution_id ON execution_traces FIELDS execution_id UNIQUE;
DEFINE INDEX idx_template_id ON execution_traces FIELDS template_id;
DEFINE INDEX idx_status ON execution_traces FIELDS status;
DEFINE INDEX idx_stored_at ON execution_traces FIELDS stored_at;

-- Query patterns:
-- 1. GET trace by execution_id: SELECT * FROM execution_traces WHERE execution_id = $id
-- 2. GET all traces for template: SELECT * FROM execution_traces WHERE template_id = $template_id
-- 3. GET failed executions: SELECT * FROM execution_traces WHERE status = 'failure'
-- 4. GET recent traces: SELECT * FROM execution_traces ORDER BY stored_at DESC LIMIT 10
