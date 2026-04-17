#!/usr/bin/env bash
# =============================================================================
# Apply Migration 066: Variant Confidence Tracking
# =============================================================================
# Purpose: Add statistical confidence fields to variant_performance_metrics
# Related: Sequence 4 trailblazing requirements
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_FILE="$REPO_ROOT/sql/migrations/066-variant-confidence.surql"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SURREALDB_URL="${SURREALDB_URL:-http://localhost:8000}"
SURREALDB_NAMESPACE="${SURREALDB_NAMESPACE:-activity-system}"
SURREALDB_DATABASE="${SURREALDB_DATABASE:-learning_loop}"
SURREALDB_USERNAME="${SURREALDB_USERNAME:-root}"
SURREALDB_PASSWORD="${SURREALDB_PASSWORD:-}"

# Check if password is set
if [[ -z "$SURREALDB_PASSWORD" ]]; then
    echo -e "${RED}Error: SURREALDB_PASSWORD environment variable not set${NC}"
    echo "Usage: SURREALDB_PASSWORD=your-password $0"
    exit 1
fi

# Check if migration file exists
if [[ ! -f "$MIGRATION_FILE" ]]; then
    echo -e "${RED}Error: Migration file not found: $MIGRATION_FILE${NC}"
    exit 1
fi

echo -e "${BLUE}==============================================================================${NC}"
echo -e "${BLUE}Applying Migration 066: Variant Confidence Tracking${NC}"
echo -e "${BLUE}==============================================================================${NC}"
echo ""
echo -e "${YELLOW}Target Database:${NC}"
echo -e "  URL:       $SURREALDB_URL"
echo -e "  Namespace: $SURREALDB_NAMESPACE"
echo -e "  Database:  $SURREALDB_DATABASE"
echo ""

# Function to execute SurrealQL
execute_surql() {
    local query="$1"
    curl -s -X POST "$SURREALDB_URL/sql" \
        -u "$SURREALDB_USERNAME:$SURREALDB_PASSWORD" \
        -H "Accept: application/json" \
        -H "surreal-ns: $SURREALDB_NAMESPACE" \
        -H "surreal-db: $SURREALDB_DATABASE" \
        -d "$query"
}

# Check if variant_performance_metrics table exists
echo -e "${YELLOW}Step 1: Verifying variant_performance_metrics table exists...${NC}"
TABLE_INFO=$(execute_surql "INFO FOR TABLE variant_performance_metrics;")

if echo "$TABLE_INFO" | grep -q "error"; then
    echo -e "${RED}Error: variant_performance_metrics table not found${NC}"
    echo "$TABLE_INFO"
    exit 1
fi

echo -e "${GREEN}✓ Table exists${NC}"
echo ""

# Apply migration
echo -e "${YELLOW}Step 2: Applying migration...${NC}"
MIGRATION_CONTENT=$(cat "$MIGRATION_FILE")
RESULT=$(execute_surql "$MIGRATION_CONTENT")

if echo "$RESULT" | grep -q "error"; then
    echo -e "${RED}Error: Migration failed${NC}"
    echo "$RESULT" | jq '.' || echo "$RESULT"
    exit 1
fi

echo -e "${GREEN}✓ Migration applied successfully${NC}"
echo ""

# Verify fields were added
echo -e "${YELLOW}Step 3: Verifying new fields...${NC}"

FIELDS_TO_CHECK=(
    "confidence_interval"
    "sample_size"
    "is_deprecated"
    "deprecation_reason"
    "deprecated_at"
)

VERIFY_QUERY="INFO FOR TABLE variant_performance_metrics;"
FIELD_INFO=$(execute_surql "$VERIFY_QUERY")

ALL_FIELDS_PRESENT=true
for field in "${FIELDS_TO_CHECK[@]}"; do
    if echo "$FIELD_INFO" | grep -q "\"$field\""; then
        echo -e "${GREEN}  ✓ $field${NC}"
    else
        echo -e "${RED}  ✗ $field NOT FOUND${NC}"
        ALL_FIELDS_PRESENT=false
    fi
done

if [[ "$ALL_FIELDS_PRESENT" != "true" ]]; then
    echo -e "${RED}Error: Some fields were not created${NC}"
    exit 1
fi

echo ""

# Verify indexes were added
echo -e "${YELLOW}Step 4: Verifying new indexes...${NC}"

INDEXES_TO_CHECK=(
    "idx_variant_performance_is_deprecated"
    "idx_variant_performance_last_executed"
    "idx_variant_performance_confidence"
    "idx_variant_performance_active_selection"
)

ALL_INDEXES_PRESENT=true
for index in "${INDEXES_TO_CHECK[@]}"; do
    INDEX_INFO=$(execute_surql "INFO FOR INDEX $index ON variant_performance_metrics;")

    if echo "$INDEX_INFO" | grep -q "\"$index\"" || echo "$INDEX_INFO" | grep -q "\"FIELDS\""; then
        echo -e "${GREEN}  ✓ $index${NC}"
    else
        echo -e "${RED}  ✗ $index NOT FOUND${NC}"
        ALL_INDEXES_PRESENT=false
    fi
done

if [[ "$ALL_INDEXES_PRESENT" != "true" ]]; then
    echo -e "${YELLOW}Warning: Some indexes may not have been created${NC}"
    echo -e "${YELLOW}This may be expected if indexes already exist${NC}"
fi

echo ""

# Test query: Check existing records have default values
echo -e "${YELLOW}Step 5: Checking default values on existing records...${NC}"

TEST_QUERY="SELECT variant_id, confidence_interval, sample_size, is_deprecated
FROM variant_performance_metrics
LIMIT 5;"

TEST_RESULT=$(execute_surql "$TEST_QUERY")

if echo "$TEST_RESULT" | grep -q "\"confidence_interval\""; then
    echo -e "${GREEN}✓ Fields are queryable${NC}"
    echo ""
    echo -e "${BLUE}Sample records:${NC}"
    echo "$TEST_RESULT" | jq '.[0].result' || echo "$TEST_RESULT"
else
    echo -e "${YELLOW}Warning: No records found to verify${NC}"
fi

echo ""
echo -e "${BLUE}==============================================================================${NC}"
echo -e "${GREEN}Migration 066 completed successfully!${NC}"
echo -e "${BLUE}==============================================================================${NC}"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo "1. Update application code to compute confidence intervals"
echo "2. Implement variant deprecation logic"
echo "3. Update Thompson Sampling to filter deprecated variants"
echo "4. Run integration tests to verify behavior"
echo ""
echo -e "${BLUE}Example Queries:${NC}"
echo ""
echo "# Find all active variants:"
echo "SELECT * FROM variant_performance_metrics WHERE is_deprecated = false;"
echo ""
echo "# Find variants with low confidence:"
echo "SELECT * FROM variant_performance_metrics"
echo "WHERE confidence_interval < 0.5 AND sample_size < 10;"
echo ""
echo "# Deprecate low-performing variant:"
echo "UPDATE variant_performance_metrics"
echo "SET is_deprecated = true,"
echo "    deprecation_reason = 'poor_performance',"
echo "    deprecated_at = time::now()"
echo "WHERE variant_id = 'your-variant-id';"
echo ""
