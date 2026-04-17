#!/usr/bin/env bash
# =============================================================================
# Apply Migration 065: Impulse Budget Tracking
# =============================================================================
# Purpose: Add budget tracking fields to impulse table and create budget log
# Related: Sequence 2 impulse resolution requirements
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_FILE="$REPO_ROOT/sql/migrations/065-impulse-budget-tracking.surql"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SURREALDB_URL="${SURREALDB_URL:-https://activity.metabob.com}"
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
echo -e "${BLUE}Applying Migration 065: Impulse Budget Tracking${NC}"
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

# Check if impulse table exists
echo -e "${YELLOW}Step 1: Verifying impulse table exists...${NC}"
TABLE_INFO=$(execute_surql "INFO FOR TABLE impulse;")

if echo "$TABLE_INFO" | grep -q "error"; then
    echo -e "${RED}Error: impulse table not found${NC}"
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
    echo -e "${RED}✗ Migration failed${NC}"
    echo "$RESULT" | jq .
    exit 1
fi

echo -e "${GREEN}✓ Migration applied successfully${NC}"
echo ""

# Verify new fields exist
echo -e "${YELLOW}Step 3: Verifying new fields...${NC}"
FIELD_CHECK=$(execute_surql "INFO FOR TABLE impulse;")

FIELDS_TO_CHECK=("budget" "resources_consumed" "budget_exhausted")
ALL_FIELDS_EXIST=true

for field in "${FIELDS_TO_CHECK[@]}"; do
    if echo "$FIELD_CHECK" | grep -q "\"$field\""; then
        echo -e "${GREEN}  ✓ Field '$field' exists${NC}"
    else
        echo -e "${RED}  ✗ Field '$field' not found${NC}"
        ALL_FIELDS_EXIST=false
    fi
done

# Check if impulse_budget_log table was created
echo -e "${YELLOW}Step 4: Verifying impulse_budget_log table...${NC}"
LOG_TABLE_INFO=$(execute_surql "INFO FOR TABLE impulse_budget_log;")

if echo "$LOG_TABLE_INFO" | grep -q "error"; then
    echo -e "${RED}✗ impulse_budget_log table not created${NC}"
    ALL_FIELDS_EXIST=false
else
    echo -e "${GREEN}  ✓ impulse_budget_log table exists${NC}"
fi

echo ""

if [ "$ALL_FIELDS_EXIST" = true ]; then
    echo -e "${GREEN}==============================================================================${NC}"
    echo -e "${GREEN}Migration 065 Applied Successfully!${NC}"
    echo -e "${GREEN}==============================================================================${NC}"
    echo ""
    echo -e "${BLUE}Next steps:${NC}"
    echo -e "  1. Run verification: ./scripts/verify-065-impulse-budget-tracking.sh"
    echo -e "  2. Test impulse creation with budget tracking"
    echo -e "  3. Monitor budget_exhausted events in logs"
    echo ""
    exit 0
else
    echo -e "${RED}==============================================================================${NC}"
    echo -e "${RED}Migration Incomplete - Some fields missing${NC}"
    echo -e "${RED}==============================================================================${NC}"
    exit 1
fi
