-- ============================================================================
-- Migration 044: Backfill Template Shapes
-- ============================================================================
-- Purpose: Add input_shapes and output_shapes to existing activity templates
-- that were created before the shape system was introduced.
--
-- Strategy:
-- 1. For templates with existing shapes, keep them
-- 2. For templates without shapes, apply category-based defaults
-- 3. The application will use shape-inference.ts for more precise inference
--
-- Note: This migration sets conservative defaults. The shape inference
-- utility in the application layer provides more precise analysis by
-- parsing task prompts and validation rules.
-- ============================================================================

-- ============================================================================
-- Step 1: Apply category-based input_shapes defaults
-- ============================================================================

-- Feature templates: input = [goal], output = [source_code, patch]
UPDATE activity SET
  input_shapes = ['goal'],
  output_shapes = ['patch', 'source_code']
WHERE execution_type = 'template'
  AND category = 'feature'
  AND (input_shapes IS NONE OR array::len(input_shapes) = 0);

-- Bugfix templates: input = [error, goal, source_code], output = [patch]
UPDATE activity SET
  input_shapes = ['error', 'goal', 'source_code'],
  output_shapes = ['patch']
WHERE execution_type = 'template'
  AND category = 'bugfix'
  AND (input_shapes IS NONE OR array::len(input_shapes) = 0);

-- Refactor templates: input = [goal, source_code], output = [patch, source_code]
UPDATE activity SET
  input_shapes = ['goal', 'source_code'],
  output_shapes = ['patch', 'source_code']
WHERE execution_type = 'template'
  AND category = 'refactor'
  AND (input_shapes IS NONE OR array::len(input_shapes) = 0);

-- Test templates: input = [goal, source_code], output = [test_suite]
UPDATE activity SET
  input_shapes = ['goal', 'source_code'],
  output_shapes = ['test_suite']
WHERE execution_type = 'template'
  AND category = 'test'
  AND (input_shapes IS NONE OR array::len(input_shapes) = 0);

-- Infrastructure templates: input = [goal], output = [config_file, source_code]
UPDATE activity SET
  input_shapes = ['goal'],
  output_shapes = ['config_file', 'source_code']
WHERE execution_type = 'template'
  AND category = 'infrastructure'
  AND (input_shapes IS NONE OR array::len(input_shapes) = 0);

-- ============================================================================
-- Step 2: Apply fallback defaults for templates without category
-- ============================================================================

-- Any template without shapes gets at least [goal]
UPDATE activity SET
  input_shapes = ['goal'],
  output_shapes = ['patch']
WHERE execution_type = 'template'
  AND (input_shapes IS NONE OR array::len(input_shapes) = 0);

-- ============================================================================
-- Step 3: Ensure output_shapes is not empty
-- ============================================================================

-- Templates need at least one output shape for learning
UPDATE activity SET
  output_shapes = ['patch']
WHERE execution_type = 'template'
  AND (output_shapes IS NONE OR array::len(output_shapes) = 0);

-- ============================================================================
-- Verification Query (run manually to confirm)
-- ============================================================================
-- SELECT
--   id,
--   name,
--   category,
--   input_shapes,
--   output_shapes
-- FROM activity
-- WHERE execution_type = 'template';
-- ============================================================================
