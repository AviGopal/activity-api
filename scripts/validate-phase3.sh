#!/usr/bin/env bash
# ==============================================================================
# Phase 3 Validation Script
# ==============================================================================
# Validates that Phase 3 composition learning is correctly implemented.
#
# Checks:
# 1. Migration file exists
# 2. Endpoints are defined in activities.ts
# 3. MiniBob integration exists
# 4. MCP client method exists
# 5. Tests exist
#
# Usage:
#   ./scripts/validate-phase3.sh
# ==============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=============================================================================="
echo "Phase 3 Composition Learning - Validation"
echo "=============================================================================="
echo ""

PASS_COUNT=0
FAIL_COUNT=0

# Helper function for checks
check() {
  local name="$1"
  local command="$2"

  if eval "$command" >/dev/null 2>&1; then
    echo "✅ PASS: $name"
    ((PASS_COUNT++))
  else
    echo "❌ FAIL: $name"
    ((FAIL_COUNT++))
  fi
}

echo "Checking Phase 3 Implementation..."
echo ""

# 1. Migration file exists
check "Migration file exists" \
  "test -f '$REPO_ROOT/sql/migrations/063-composition-edges.surql'"

# 2. Migration script exists
check "Migration script exists" \
  "test -x '$REPO_ROOT/scripts/apply-migration-063.sh'"

# 3. Edge recording endpoint exists
check "Edge recording endpoint defined" \
  "grep -q 'POST /v2/activities/composition/edges' '$REPO_ROOT/src/routes/activities.ts'"

# 4. Successor query endpoint exists
check "Successor query endpoint defined" \
  "grep -q 'GET /v2/activities/composition/edges/successors' '$REPO_ROOT/src/routes/activities.ts'"

# 5. MiniBob integration exists
MINIBOB_PATH="$REPO_ROOT/../../repos/minibob"
if [[ -d "$MINIBOB_PATH" ]]; then
  check "MiniBob edge recording integration" \
    "grep -q 'recordCompositionEdge' '$MINIBOB_PATH/src/activity.ts'"

  check "MiniBob MCP client method" \
    "grep -q 'async recordCompositionEdge' '$MINIBOB_PATH/src/mcp.ts'"
else
  echo "⚠️  SKIP: MiniBob path not found (expected at ../../repos/minibob)"
fi

# 6. Tests exist
check "Composition edge tests exist" \
  "test -f '$REPO_ROOT/src/routes/composition-edges.test.ts'"

# 7. Report exists
check "Implementation report exists" \
  "test -f '$REPO_ROOT/PHASE_3_COMPOSITION_LEARNING_REPORT.md'"

# 8. Schema defines composition_edge table
check "Schema defines composition_edge table" \
  "grep -q 'DEFINE TABLE.*composition_edge' '$REPO_ROOT/sql/migrations/063-composition-edges.surql'"

# 9. Schema has required fields
check "Schema has parent_activity_id field" \
  "grep -q 'parent_activity_id' '$REPO_ROOT/sql/migrations/063-composition-edges.surql'"

check "Schema has child_activity_id field" \
  "grep -q 'child_activity_id' '$REPO_ROOT/sql/migrations/063-composition-edges.surql'"

check "Schema has state_signature_before field" \
  "grep -q 'state_signature_before' '$REPO_ROOT/sql/migrations/063-composition-edges.surql'"

check "Schema has state_signature_after field" \
  "grep -q 'state_signature_after' '$REPO_ROOT/sql/migrations/063-composition-edges.surql'"

# 10. Schema has indexes
check "Schema has parent activity index" \
  "grep -q 'idx_composition_edge_parent' '$REPO_ROOT/sql/migrations/063-composition-edges.surql'"

check "Schema has state signature index" \
  "grep -q 'idx_composition_edge_state_before' '$REPO_ROOT/sql/migrations/063-composition-edges.surql'"

# 11. Schema has permissions
check "Schema has SELECT permission" \
  "grep -q 'FOR select WHERE' '$REPO_ROOT/sql/migrations/063-composition-edges.surql'"

echo ""
echo "=============================================================================="
echo "Validation Summary"
echo "=============================================================================="
echo ""
echo "Passed: $PASS_COUNT"
echo "Failed: $FAIL_COUNT"
echo ""

if [[ $FAIL_COUNT -eq 0 ]]; then
  echo "✅ All checks passed! Phase 3 implementation is complete."
  echo ""
  echo "Next steps:"
  echo "  1. Apply migration: ./scripts/apply-migration-063.sh"
  echo "  2. Run tests: bun test src/routes/composition-edges.test.ts"
  echo "  3. Verify with: surreal sql 'INFO FOR TABLE composition_edge;'"
  exit 0
else
  echo "❌ Some checks failed. Review the implementation."
  exit 1
fi
