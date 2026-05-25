-- Migration 137: add tags field to activity_execution_traces
--
-- Enables boredom-vessel and other callers to classify executions with
-- intent tags (e.g. "intent:topology_discovery", "intent:boredom_source").
-- Tags default to an empty array so existing rows are unaffected.

DEFINE FIELD OVERWRITE tags ON activity_execution_traces
  TYPE array<string>
  DEFAULT [];
