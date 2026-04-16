-- =============================================================================
-- Migration 054: Fix Activity Table to Support Generic Resolvers
-- =============================================================================
-- Date: 2026-04-09
-- Purpose: Make activity table truly flexible to support both LLM and
--          deterministic resolvers without deep nesting validation
--
-- Problem: The current schema defines tasks as FLEXIBLE but SurrealDB still
--          validates deeply nested fields like tasks[0].prompt.variables[0].description
--
-- Solution: Remove SCHEMAFULL constraint from activity table to allow truly
--           flexible task definitions that support:
--           - LLM resolvers with prompt/variables
--           - Deterministic resolvers with resolver/config
--           - Any future resolver types
--
-- Impact: Allows activities to be created with arbitrary nested task structures
--         without schema validation errors
-- =============================================================================

-- Remove existing field definitions for tasks to avoid conflicts
-- SurrealDB will keep the data but remove the schema constraints
REMOVE FIELD IF EXISTS tasks ON activity;
REMOVE FIELD IF EXISTS tasks.* ON activity;

-- Redefine tasks field as completely FLEXIBLE without nested validation
-- This allows any structure: LLM prompts, deterministic resolvers, etc.
DEFINE FIELD IF NOT EXISTS tasks ON activity TYPE option<array> FLEXIBLE
  COMMENT "Task steps array - supports any resolver type (LLM, deterministic, tool, etc.)";

-- Note: With FLEXIBLE, we don't define tasks.* or any deeper nesting
-- This allows activities to use:
--   - tasks[0].prompt.template (LLM resolver)
--   - tasks[0].prompt.variables[0].description (LLM with vars)
--   - tasks[0].resolver.type (deterministic resolver)
--   - tasks[0].resolver.config (deterministic config)
--   - Any future resolver patterns

-- Verify the change
-- Example activities can now use:
-- {
--   "tasks": [
--     {
--       "id": "task-1",
--       "prompt": {
--         "template": "...",
--         "variables": [
--           { "name": "x", "description": "...", "type": "string" }
--         ]
--       }
--     },
--     {
--       "id": "task-2",
--       "resolver": {
--         "type": "bash",
--         "command": "npm test"
--       }
--     }
--   ]
-- }
