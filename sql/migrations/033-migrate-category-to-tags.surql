-- =============================================================================
-- Migration: Populate tags from category field
-- =============================================================================
-- Migrates existing activity_template records to use hierarchical tags
-- Safe to re-run (idempotent)
-- =============================================================================

-- Migrate activity_template: set tags = [category] where tags is empty
-- Must set both tags and tag_prefixes together to avoid NONE coercion errors
UPDATE activity_template
SET tags = [category], tag_prefixes = [category]
WHERE (tags IS NONE OR array::len(tags) = 0)
  AND category IS NOT NONE;

-- For activity_registry table (if it exists and has data)
UPDATE activity_registry
SET tags = [category], tag_prefixes = [category]
WHERE (tags IS NONE OR array::len(tags) = 0)
  AND category IS NOT NONE;

-- Verify migration
-- SELECT count() FROM activity_template WHERE (tags IS NONE OR array::len(tags) = 0) GROUP ALL;
-- Expected: 0
