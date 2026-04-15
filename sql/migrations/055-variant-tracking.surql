-- Migration 055: Add variant tracking and retirement fields
-- Purpose: Enable automatic variant creation from failed executions
-- Date: 2026-04-15
-- Related: Automatic variant creation feature

-- Add variant tracking fields to activity table
DEFINE FIELD IF NOT EXISTS variant_generation ON activity TYPE int
  VALUE $value OR 0
  COMMENT "Generation number in variant lineage (0=original, 1=first variant, etc.)";

DEFINE FIELD IF NOT EXISTS variant_reason ON activity TYPE option<string>
  COMMENT "Reason this variant was created (e.g., 'consecutive_failures', 'manual_improvement')";

DEFINE FIELD IF NOT EXISTS retired ON activity TYPE bool
  VALUE $value OR false
  COMMENT "Whether this template is retired due to poor performance (<30% success rate over 20 executions)";

DEFINE FIELD IF NOT EXISTS retired_at ON activity TYPE option<datetime>
  COMMENT "When this template was retired";

DEFINE FIELD IF NOT EXISTS retired_reason ON activity TYPE option<string>
  COMMENT "Reason for retirement (e.g., 'poor_performance', 'superseded_by_variant')";

-- Add indexes for efficient querying
DEFINE INDEX IF NOT EXISTS idx_activity_retired ON activity FIELDS retired, variant_generation;
DEFINE INDEX IF NOT EXISTS idx_activity_generation ON activity FIELDS variant_of, variant_generation;

-- Create view for active (non-retired) templates
DEFINE TABLE IF NOT EXISTS v_active_activities AS
  SELECT
    id,
    name,
    description,
    tags,
    category,
    tasks,
    scope,
    org_id,
    project_id,
    input_shapes,
    output_shapes,
    execution_type,
    variant_of,
    variant_generation,
    variant_reason,
    created_at,
    updated_at
  FROM activity
  WHERE retired = false OR retired IS NONE;

-- Create view for variant families (all variants of a base activity)
DEFINE TABLE IF NOT EXISTS v_variant_families AS
  SELECT
    variant_of AS base_activity_id,
    count() AS variant_count,
    array::group(id) AS variant_ids,
    max(variant_generation) AS max_generation,
    min(created_at) AS first_variant_at,
    max(created_at) AS last_variant_at
  FROM activity
  WHERE variant_of IS NOT NONE
  GROUP BY variant_of;
