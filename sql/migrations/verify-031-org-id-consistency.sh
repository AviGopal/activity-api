#!/usr/bin/env bash
# =============================================================================
# Verification script for migration 031: org_id string consistency
# =============================================================================
# Tests that all org_id fields are TYPE string, not TYPE record<organizations>
# =============================================================================

set -e

ENDPOINT="${SURREAL_ENDPOINT:-http://localhost:8000}"
NAMESPACE="${SURREAL_NAMESPACE:-activity-system}"
DATABASE="${SURREAL_DATABASE:-learning_loop}"
USER="${SURREAL_USER:-root}"
PASS="${SURREAL_PASS:-root}"

echo "Verifying org_id field types in SurrealDB..."
echo "Endpoint: $ENDPOINT"
echo "Namespace: $NAMESPACE"
echo "Database: $DATABASE"
echo ""

# Expected tables with org_id field
TABLES=(
  "impulse"
  "activity"
  "execution"
  "vessel"
  "activity_registry"
  "activity_execution_traces"
  "activity_composition_graph"
  "impulse_relevance_metrics"
  "tool_usage"
  "thompson_selection_log"
  "goal_execution_paths"
  "activity_dataflows"
  "activity_prerequisites"
  "prerequisite_patterns"
  "execution_sequences"
  "impulse_data"
  "impulse_usage_history"
  "ci_runs"
  "code_variants"
  "composite_sequence_patterns"
  "llm_resolution_log"
  "pattern"
)

PASSED=0
FAILED=0

echo "Checking ${#TABLES[@]} tables..."
echo ""

for table in "${TABLES[@]}"; do
  # Query table info and check org_id field type
  RESULT=$(curl -s -X POST "$ENDPOINT/sql" \
    -u "$USER:$PASS" \
    -H "surreal-ns: $NAMESPACE" \
    -H "surreal-db: $DATABASE" \
    -H "Accept: application/json" \
    -d "INFO FOR TABLE $table;" | jq -r '.result[0].result.fields.org_id.TYPE // empty')

  if [ -z "$RESULT" ]; then
    echo "❌ FAILED: $table - org_id field not found"
    ((FAILED++))
  elif [ "$RESULT" = "string" ]; then
    echo "✅ PASSED: $table - org_id is TYPE string"
    ((PASSED++))
  else
    echo "❌ FAILED: $table - org_id is TYPE $RESULT (expected string)"
    ((FAILED++))
  fi
done

echo ""
echo "==============================================="
echo "Results: $PASSED passed, $FAILED failed"
echo "==============================================="

if [ $FAILED -gt 0 ]; then
  echo "❌ Verification FAILED - some tables have incorrect org_id type"
  exit 1
else
  echo "✅ Verification PASSED - all org_id fields are TYPE string"
  exit 0
fi
