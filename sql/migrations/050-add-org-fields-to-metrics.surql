-- Migration: Add org_id and project_id fields to variant_performance_metrics
-- Created: 2026-03-30
-- Purpose: Support multi-tenant metrics tracking

-- Add org_id field
DEFINE FIELD org_id ON variant_performance_metrics TYPE option<string>
  COMMENT "Organization ID for multi-tenant isolation (optional for global templates)";

-- Add project_id field
DEFINE FIELD project_id ON variant_performance_metrics TYPE option<string>
  COMMENT "Project ID for project-scoped templates (optional)";

-- Add index for org_id queries
DEFINE INDEX idx_metrics_org_id ON variant_performance_metrics FIELDS org_id;

-- Add index for project_id queries
DEFINE INDEX idx_metrics_project_id ON variant_performance_metrics FIELDS project_id;
