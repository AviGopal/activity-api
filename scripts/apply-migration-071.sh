#!/usr/bin/env bash
# =============================================================================
# Apply Migration 071: Fix Paradigm Tables Root Access
# =============================================================================
# Purpose: Update PERMISSIONS on paradigm core tables (impulse, activity,
#          execution) to allow root access by changing the create permission
#          from "$auth.org_id != NONE" to "$auth != NONE"
#
# This fixes HTTP 500 errors when storing impulses with root credentials.
#
# Usage:
#   SURREALDB_PASSWORD=<password> ./apply-migration-071.sh
#
# Or with explicit URL:
#   SURREALDB_URL=https://activity.metabob.com \
#   SURREALDB_PASSWORD=<password> \
#   ./apply-migration-071.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_FILE="$REPO_ROOT/sql/migrations/071-fix-paradigm-tables-root-access.surql"

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

# Validate required environment variables
if [[ -z "$SURREALDB_PASSWORD" ]]; then
    echo -e "${RED}Error: SURREALDB_PASSWORD environment variable not set${NC}"
    echo "Usage: SURREALDB_PASSWORD=<password> $0"
    exit 1
fi

# Check if migration file exists
if [[ ! -f "$MIGRATION_FILE" ]]; then
    echo -e "${RED}Error: Migration file not found: $MIGRATION_FILE${NC}"
    exit 1
fi

echo -e "${BLUE}==============================================================================${NC}"
echo -e "${BLUE}Applying Migration 071: Fix Paradigm Tables Root Access${NC}"
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

# Check current table PERMISSIONS
echo -e "${YELLOW}Step 1: Checking current table PERMISSIONS...${NC}"
for table in impulse activity execution; do
    echo -e "${BLUE}Checking $table table...${NC}"
    TABLE_INFO=$(execute_surql "INFO FOR TABLE $table;")

    if echo "$TABLE_INFO" | grep -q "error"; then
        echo -e "${RED}✗ Failed to query $table table${NC}"
        echo "$TABLE_INFO" | jq . 2>/dev/null || echo "$TABLE_INFO"
        exit 1
    fi

    echo -e "${GREEN}✓ $table table exists${NC}"
done
echo ""

# Apply migration
echo -e "${YELLOW}Step 2: Applying migration...${NC}"
MIGRATION_CONTENT=$(cat "$MIGRATION_FILE")
RESULT=$(execute_surql "$MIGRATION_CONTENT")

if echo "$RESULT" | grep -q "error"; then
    echo -e "${RED}✗ Migration failed${NC}"
    echo "$RESULT" | jq . 2>/dev/null || echo "$RESULT"
    exit 1
fi

echo -e "${GREEN}✓ Migration applied successfully${NC}"
echo ""

# Verify updated PERMISSIONS
echo -e "${YELLOW}Step 3: Verifying updated PERMISSIONS...${NC}"
for table in impulse activity execution; do
    echo -e "${BLUE}Verifying $table table...${NC}"
    TABLE_INFO=$(execute_surql "INFO FOR TABLE $table;")

    # Check if FOR create WHERE clause mentions $auth != NONE (new pattern)
    if echo "$TABLE_INFO" | grep -q "\$auth != NONE"; then
        echo -e "${GREEN}✓ $table table updated to allow root access${NC}"
    else
        echo -e "${YELLOW}⚠ $table table PERMISSIONS format may differ (check manually)${NC}"
    fi
done
echo ""

# Test impulse creation with root credentials
echo -e "${YELLOW}Step 4: Testing impulse creation with root credentials...${NC}"
TEST_IMPULSE_ID="test-migration-071-$(date +%s)"
TEST_QUERY="CREATE impulse:${TEST_IMPULSE_ID} CONTENT {
    id: '${TEST_IMPULSE_ID}',
    pointer: { type: 'memo', content: 'test after migration 071' },
    shape: 'test',
    org_id: 'metabob_internal',
    created_at: time::now(),
    created_by: 'migration-script'
};"

TEST_RESULT=$(execute_surql "$TEST_QUERY")

if echo "$TEST_RESULT" | grep -q "error"; then
    echo -e "${RED}✗ Test impulse creation failed${NC}"
    echo "$TEST_RESULT" | jq . 2>/dev/null || echo "$TEST_RESULT"
    echo ""
    echo -e "${YELLOW}This may indicate PERMISSIONS are still not allowing root access.${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Test impulse created successfully${NC}"

# Clean up test impulse
execute_surql "DELETE impulse:${TEST_IMPULSE_ID};" > /dev/null 2>&1
echo -e "${BLUE}  (test impulse cleaned up)${NC}"
echo ""

echo -e "${GREEN}==============================================================================${NC}"
echo -e "${GREEN}Migration 071 Applied Successfully!${NC}"
echo -e "${GREEN}==============================================================================${NC}"
echo ""
echo -e "${BLUE}What was changed:${NC}"
echo -e "  • impulse table: FOR create WHERE changed to \$auth != NONE"
echo -e "  • activity table: FOR create WHERE changed to \$auth != NONE"
echo -e "  • execution table: FOR create WHERE changed to \$auth != NONE"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo -e "  1. Test impulse storage via API endpoint:"
echo -e "     curl -X POST https://activity.metabob.com/v2/impulses \\"
echo -e "       -H 'Authorization: ApiKey <your-key>' \\"
echo -e "       -H 'Content-Type: application/json' \\"
echo -e "       -d '{\"impulse_id\":\"test\",\"impulse_data\":{\"type\":\"memo\"}}'"
echo ""
echo -e "  2. Monitor MiniBob execution for successful impulse storage"
echo ""
echo -e "  3. Check activity-api logs for any remaining PERMISSIONS errors"
echo ""
echo -e "${YELLOW}Note:${NC}"
echo -e "  • Multi-tenant isolation still enforced via ASSERT on org_id field"
echo -e "  • SELECT/UPDATE/DELETE PERMISSIONS still check org_id = \$auth.org_id"
echo -e "  • Root users can create records for any org (acceptable for admin)"
echo ""
exit 0
