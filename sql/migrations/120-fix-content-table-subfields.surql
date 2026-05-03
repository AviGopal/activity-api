-- Migration 120: Fix FLEXIBLE on sub-field patterns in execution_trace_content and trace_digest.
--
-- Root cause: migration 115 defined tasks.*, impulse_resolutions.*, output_impulses.*
-- and task_summaries.* without OVERWRITE. SurrealDB auto-creates .*  entries as
-- TYPE object (non-FLEXIBLE) when the parent array<object> field is first defined.
-- Without OVERWRITE the explicit DEFINE FIELD for .* is silently treated as
-- AlreadyExists by the migration runner and the non-FLEXIBLE definition stays in place,
-- causing INSERT failures: "Found field 'tasks[0].status', but no such field exists".

USE NS `activity-system` DB `learning_loop`;

-- Fix execution_trace_content sub-fields
DEFINE FIELD OVERWRITE tasks.*               ON execution_trace_content TYPE object FLEXIBLE PERMISSIONS FULL;
DEFINE FIELD OVERWRITE impulse_resolutions.* ON execution_trace_content TYPE object FLEXIBLE PERMISSIONS FULL;
DEFINE FIELD OVERWRITE output_impulses.*     ON execution_trace_content TYPE object FLEXIBLE PERMISSIONS FULL;

-- Fix trace_digest sub-field (task_summaries objects must accept {id, status, duration_ms, resolver_tier})
DEFINE FIELD OVERWRITE task_summaries.*      ON trace_digest TYPE object FLEXIBLE PERMISSIONS FULL;
