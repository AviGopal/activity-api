#!/usr/bin/env bash
# =============================================================================
# Apply Migration 073: Add times_failed to tool_argument_pattern (Kubernetes Version)
# =============================================================================
# Purpose: Add missing times_failed field to tool_argument_pattern table
#
# Context:
# Application code tries to insert times_failed when recording tool argument patterns,
# but this field doesn't exist in the database, causing 500 errors:
# "Found field 'times_failed', but no such field exists for table 'tool_argument_pattern'"
#
# This migration adds:
# - times_failed (int) - counter for failed executions
# - validation_error (option<string>) - specific validation error if applicable
#
# Usage:
#   ./apply-migration-073-k8s.sh
#
# Requirements:
#   - kubectl configured with access to metabob-production cluster
#   - Port 8000 available locally (or set PORT variable)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_FILE="$REPO_ROOT/sql/migrations/073-add-times-failed-to-tool-argument-pattern.surql"

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
echo -e "${BLUE}Applying Migration 073: Add times_failed to tool_argument_pattern${NC}"
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

# Check current table schema
echo -e "${YELLOW}Step 3: Checking tool_argument_pattern table...${NC}"
TABLE_INFO=$(execute_surql "INFO FOR TABLE tool_argument_pattern;")

if echo "$TABLE_INFO" | grep -q "error"; then
    echo -e "${RED}✗ Failed to query tool_argument_pattern table${NC}"
    echo "$TABLE_INFO" | jq . 2>/dev/null || echo "$TABLE_INFO"
    exit 1
fi

echo -e "${GREEN}✓ tool_argument_pattern table exists${NC}"

# Check if times_failed already exists
if echo "$TABLE_INFO" | grep -q "times_failed"; then
    echo -e "${YELLOW}⚠ Field times_failed already exists - migration may be already applied${NC}"
    echo -e "${YELLOW}Proceeding anyway to ensure idempotency...${NC}"
fi
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

# Verify new fields exist
echo -e "${YELLOW}Step 5: Verifying new fields...${NC}"
TABLE_INFO=$(execute_surql "INFO FOR TABLE tool_argument_pattern;")

for field in times_failed validation_error; do
    if echo "$TABLE_INFO" | grep -q "$field"; then
        echo -e "${GREEN}✓ Field $field added${NC}"
    else
        echo -e "${RED}✗ Field $field not found${NC}"
        exit 1
    fi
done
echo ""

echo -e "${GREEN}==============================================================================${NC}"
echo -e "${GREEN}Migration 073 Applied Successfully!${NC}"
echo -e "${GREEN}==============================================================================${NC}"
echo ""
echo -e "${BLUE}What was changed:${NC}"
echo -e "  • Added times_failed field (int with default 0)"
echo -e "  • Added validation_error field (option<string>)"
echo ""
echo -e "${BLUE}Impact:${NC}"
echo -e "  • Fixes 500 errors when storing tool argument patterns"
echo -e "  • Enables failure tracking for tool usage patterns"
echo -e "  • MiniBob can now successfully store impulse usage data"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo -e "  1. Restart activity-api pods to clear any cached state"
echo -e "  2. Monitor MiniBob executions for successful impulse storage"
echo -e "  3. Verify tool argument patterns are being recorded"
echo ""
exit 0
