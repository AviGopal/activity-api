-- =============================================================================
-- Impulse Metadata Field Extension
-- =============================================================================
-- Adds explicit metadata field to impulse_data for structured pointer content info
-- This enables pointer-mode context formatting where LLMs see metadata instead of raw data
-- =============================================================================

-- Add metadata field for structured impulse content information
-- This is separate from impulse_data.impulse_data.metadata which is for arbitrary tags
DEFINE FIELD IF NOT EXISTS metadata ON impulse_data TYPE option<object> FLEXIBLE
  COMMENT "Structured metadata about impulse content (shape, rowCount, summary, etc.)";

-- Add index for querying impulses by metadata shape
DEFINE INDEX IF NOT EXISTS idx_impulse_data_metadata_shape
  ON impulse_data FIELDS metadata.shape;
