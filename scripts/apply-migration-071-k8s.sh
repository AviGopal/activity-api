#!/usr/bin/env bash
# =============================================================================
# Apply Migration 071: Fix Paradigm Tables Root Access (Kubernetes Version)
# =============================================================================
# Purpose: Update PERMISSIONS on paradigm core tables (impulse, activity,
#          execution) to allow root access by changing the create permission
#          from "$auth.org_id != NONE" to "$auth != NONE"
#
# This fixes HTTP 500 errors when storing impulses with root credentials.
#
# This script:
# 1. Retrieves SurrealDB password from Kubernetes secret
# 2. Sets up port-forward to SurrealDB pod
# 3. Applies migration via HTTP API
# 4. Cleans up port-forward
#
# Usage:
#   ./apply-migration-071-k8s.sh
#
# Requirements:
#   - kubectl configured with access to metabob-production cluster
#   - Port 8000 available locally (or set PORT variable)
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
K8S_NAMESPACE="activity-system"
K8S_POD="surrealdb-0"
K8S_SECRET="surrealdb-credentials"
LOCAL_PORT="${LOCAL_PORT:-8000}"
SURREALDB_URL="http://localhost:${LOCAL_PORT}"
SURREALDB_NAMESPACE="activity-system"
SURREALDB_DATABASE="learning_loop"
SURREALDB_USERNAME="root"

# Validate kubectl access
if ! kubectl cluster-info &>/dev/null; then
    echo -e "${RED}Error: kubectl not configured or cluster not accessible${NC}"
    echo "Current context: $(kubectl config current-context 2>/dev/null || echo 'none')"
    exit 1
fi

# Check if migration file exists
if [[ ! -f "$MIGRATION_FILE" ]]; then
    echo -e "${RED}Error: Migration file not found: $MIGRATION_FILE${NC}"
    exit 1
fi

echo -e "${BLUE}==============================================================================${NC}"
echo -e "${BLUE}Applying Migration 071: Fix Paradigm Tables Root Access (Kubernetes)${NC}"
echo -e "${BLUE}==============================================================================${NC}"
echo ""
echo -e "${YELLOW}Kubernetes Configuration:${NC}"
echo -e "  Context:   $(kubectl config current-context)"
echo -e "  Namespace: $K8S_NAMESPACE"
echo -e "  Pod:       $K8S_POD"
echo ""

# Retrieve SurrealDB password from Kubernetes secret
echo -e "${YELLOW}Step 1: Retrieving SurrealDB credentials from Kubernetes...${NC}"
SURREALDB_PASSWORD=$(kubectl get secret "$K8S_SECRET" -n "$K8S_NAMESPACE" -o jsonpath='{.data.password}' 2>/dev/null | base64 -d)

if [[ -z "$SURREALDB_PASSWORD" ]]; then
    echo -e "${RED}✗ Failed to retrieve SurrealDB password from secret${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Credentials retrieved from secret${NC}"
echo -e "  Secret: $K8S_SECRET"
echo -e "  Password: ${SURREALDB_PASSWORD:0:4}...${SURREALDB_PASSWORD: -4} (${#SURREALDB_PASSWORD} chars)"
echo ""

# Check if port is already in use
if lsof -Pi :${LOCAL_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${RED}✗ Port ${LOCAL_PORT} is already in use${NC}"
    echo -e "  Use: LOCAL_PORT=8001 $0"
    echo -e "  Or kill the process using port ${LOCAL_PORT}"
    exit 1
fi

# Set up port-forward
echo -e "${YELLOW}Step 2: Setting up port-forward to SurrealDB pod...${NC}"
kubectl port-forward -n "$K8S_NAMESPACE" "$K8S_POD" "${LOCAL_PORT}:8000" >/dev/null 2>&1 &
PORT_FORWARD_PID=$!

# Ensure cleanup on exit
cleanup() {
    if [[ -n "${PORT_FORWARD_PID:-}" ]]; then
        echo ""
        echo -e "${BLUE}Cleaning up port-forward (PID: $PORT_FORWARD_PID)...${NC}"
        kill "$PORT_FORWARD_PID" 2>/dev/null || true
        wait "$PORT_FORWARD_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Wait for port-forward to be ready
echo -e "${BLUE}Waiting for port-forward to be ready...${NC}"
for i in {1..10}; do
    if curl -s -f "http://localhost:${LOCAL_PORT}/health" >/dev/null 2>&1; then
        echo -e "${GREEN}✓ Port-forward ready (http://localhost:${LOCAL_PORT})${NC}"
        break
    fi
    sleep 1
    if [[ $i -eq 10 ]]; then
        echo -e "${RED}✗ Port-forward failed to establish${NC}"
        exit 1
    fi
done
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
echo -e "${YELLOW}Step 3: Checking current table PERMISSIONS...${NC}"
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
echo -e "${YELLOW}Step 4: Applying migration...${NC}"
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
echo -e "${YELLOW}Step 5: Verifying updated PERMISSIONS...${NC}"
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
echo -e "${YELLOW}Step 6: Testing impulse creation with root credentials...${NC}"
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
echo -e "       -H 'Authorization: ApiKey mb-bWV0YWJvYi1taW5pYm9iLXNlcnZpY2Uta2V5X3VkMVhORUFUVEVVZ1kzTHEtaHR0cHM6Ly9pZGVudGl0eS5tZXRhYm9iLmNvbQ-f92a497a9baef17a6d4e497d6f76d211' \\"
echo -e "       -H 'Content-Type: application/json' \\"
echo -e "       -d '{\"impulse_id\":\"test\",\"impulse_data\":{\"type\":\"memo\",\"pointer\":{\"content\":\"test\"}}}'"
echo ""
echo -e "  2. Monitor MiniBob execution for successful impulse storage:"
echo -e "     kubectl logs -n activity-system -l app.kubernetes.io/name=minibob -f | grep impulse"
echo ""
echo -e "  3. Check activity-api logs for any remaining PERMISSIONS errors:"
echo -e "     kubectl logs -n activity-system -l app.kubernetes.io/name=metabob-activity-api -f | grep -i permission"
echo ""
echo -e "${YELLOW}Note:${NC}"
echo -e "  • Multi-tenant isolation still enforced via ASSERT on org_id field"
echo -e "  • SELECT/UPDATE/DELETE PERMISSIONS still check org_id = \$auth.org_id"
echo -e "  • Root users can create records for any org (acceptable for admin)"
echo ""
exit 0
