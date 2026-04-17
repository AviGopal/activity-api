#!/usr/bin/env bash
# =============================================================================
# Validate Migration 066: Sequence 4 Alignment Check
# =============================================================================
# Purpose: Verify migration aligns with Sequence 4 trailblazing requirements
# Related: docs/architecture/sequences/04-improvisation-trailblazing.md
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_FILE="$REPO_ROOT/sql/migrations/066-variant-confidence.surql"
SEQUENCE_DOC="$REPO_ROOT/../../docs/architecture/sequences/04-improvisation-trailblazing.md"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}==============================================================================${NC}"
echo -e "${BLUE}Migration 066: Sequence 4 Alignment Validation${NC}"
echo -e "${BLUE}==============================================================================${NC}"
echo ""

# Check if files exist
if [[ ! -f "$MIGRATION_FILE" ]]; then
    echo -e "${RED}Error: Migration file not found: $MIGRATION_FILE${NC}"
    exit 1
fi

if [[ ! -f "$SEQUENCE_DOC" ]]; then
    echo -e "${YELLOW}Warning: Sequence 4 documentation not found${NC}"
    echo -e "${YELLOW}Expected: $SEQUENCE_DOC${NC}"
fi

# Validation checks
CHECKS_PASSED=0
CHECKS_TOTAL=0

# Helper function for checks
check() {
    local name="$1"
    local pattern="$2"
    local file="${3:-$MIGRATION_FILE}"

    ((CHECKS_TOTAL++))

    if grep -q "$pattern" "$file"; then
        echo -e "${GREEN}✓ $name${NC}"
        ((CHECKS_PASSED++))
        return 0
    else
        echo -e "${RED}✗ $name${NC}"
        return 1
    fi
}

echo -e "${YELLOW}Requirement 1: Confidence Interval Field${NC}"
check "Field defined" "DEFINE FIELD.*confidence_interval"
check "Type is float" "confidence_interval.*TYPE float"
check "Range constraint (0.0-1.0)" "confidence_interval.*ASSERT.*>= 0.0.*<= 1.0"
check "Default value 0.0" "confidence_interval.*VALUE.*0.0"
check "Comment explains purpose" "confidence_interval.*COMMENT"
echo ""

echo -e "${YELLOW}Requirement 2: Sample Size Field${NC}"
check "Field defined" "DEFINE FIELD.*sample_size"
check "Type is int" "sample_size.*TYPE int"
check "Non-negative constraint" "sample_size.*ASSERT.*>= 0"
check "Default value 0" "sample_size.*VALUE.*0"
check "Comment mentions statistical significance" "sample_size.*COMMENT.*statistical"
echo ""

echo -e "${YELLOW}Requirement 3: Deprecation Flag${NC}"
check "Field defined" "DEFINE FIELD.*is_deprecated"
check "Type is bool" "is_deprecated.*TYPE bool"
check "Default value false" "is_deprecated.*VALUE.*false"
check "Comment explains retirement" "is_deprecated.*COMMENT"
echo ""

echo -e "${YELLOW}Requirement 4: Deprecation Reason${NC}"
check "Field defined" "DEFINE FIELD.*deprecation_reason"
check "Type is optional string" "deprecation_reason.*TYPE option<string>"
check "Comment with examples" "deprecation_reason.*COMMENT.*Examples"
echo ""

echo -e "${YELLOW}Requirement 5: Deprecation Timestamp${NC}"
check "Field defined" "DEFINE FIELD.*deprecated_at"
check "Type is optional datetime" "deprecated_at.*TYPE option<datetime>"
check "Comment explains lifecycle" "deprecated_at.*COMMENT"
echo ""

echo -e "${YELLOW}Requirement 6: Indexes for Filtering${NC}"
check "Index on is_deprecated" "DEFINE INDEX.*idx_variant_performance_is_deprecated"
check "Index on last_executed_at" "DEFINE INDEX.*idx_variant_performance_last_executed"
check "Index on confidence_interval" "DEFINE INDEX.*idx_variant_performance_confidence"
check "Composite index for active selection" "DEFINE INDEX.*idx_variant_performance_active_selection"
echo ""

echo -e "${YELLOW}Requirement 7: Documentation${NC}"
check "Migration header with purpose" "Purpose:.*variant.*confidence"
check "Related to Sequence 4" "Related:.*04-improvisation"
check "Deprecation criteria documented" "Deprecation Criteria"
check "Usage examples provided" "USAGE EXAMPLES"
check "Wilson score interval mentioned" "Wilson score"
check "Verification queries included" "VERIFICATION QUERIES"
echo ""

echo -e "${YELLOW}Requirement 8: ALTER TABLE Pattern${NC}"
check "Uses DEFINE FIELD IF NOT EXISTS" "DEFINE FIELD IF NOT EXISTS"
check "Follows existing patterns" "variant_performance_metrics"
echo ""

# Check for common pitfalls
echo -e "${YELLOW}Anti-patterns Check (should NOT be present):${NC}"
ANTIPATTERN_CHECKS_PASSED=0
ANTIPATTERN_CHECKS_TOTAL=0

antipattern_check() {
    local name="$1"
    local pattern="$2"

    ((ANTIPATTERN_CHECKS_TOTAL++))

    if ! grep -q "$pattern" "$MIGRATION_FILE"; then
        echo -e "${GREEN}✓ $name (correctly absent)${NC}"
        ((ANTIPATTERN_CHECKS_PASSED++))
        return 0
    else
        echo -e "${RED}✗ $name (should not be present)${NC}"
        return 1
    fi
}

antipattern_check "No DROP statements" "DROP"
antipattern_check "No DELETE statements" "DELETE FROM"
antipattern_check "No ALTER TABLE syntax" "ALTER TABLE"
echo ""

# Calculate results
TOTAL_CHECKS=$((CHECKS_TOTAL + ANTIPATTERN_CHECKS_TOTAL))
TOTAL_PASSED=$((CHECKS_PASSED + ANTIPATTERN_CHECKS_PASSED))
PASS_PERCENTAGE=$((TOTAL_PASSED * 100 / TOTAL_CHECKS))

echo -e "${BLUE}==============================================================================${NC}"
echo -e "${BLUE}Validation Results${NC}"
echo -e "${BLUE}==============================================================================${NC}"
echo ""
echo -e "Requirements Checks:    ${GREEN}$CHECKS_PASSED${NC}/${CHECKS_TOTAL}"
echo -e "Anti-pattern Checks:    ${GREEN}$ANTIPATTERN_CHECKS_PASSED${NC}/${ANTIPATTERN_CHECKS_TOTAL}"
echo -e "Total:                  ${GREEN}$TOTAL_PASSED${NC}/${TOTAL_CHECKS} (${PASS_PERCENTAGE}%)"
echo ""

if [[ "$TOTAL_PASSED" -eq "$TOTAL_CHECKS" ]]; then
    echo -e "${GREEN}✓ All validation checks passed!${NC}"
    echo ""
    echo -e "${BLUE}Migration 066 fully aligns with Sequence 4 requirements.${NC}"
    echo ""
    exit 0
elif [[ "$PASS_PERCENTAGE" -ge 80 ]]; then
    echo -e "${YELLOW}⚠ Most validation checks passed (${PASS_PERCENTAGE}%)${NC}"
    echo -e "${YELLOW}Review failed checks above and update migration if needed.${NC}"
    echo ""
    exit 0
else
    echo -e "${RED}✗ Validation failed (${PASS_PERCENTAGE}%)${NC}"
    echo -e "${RED}Migration does not meet Sequence 4 requirements.${NC}"
    echo ""
    exit 1
fi
