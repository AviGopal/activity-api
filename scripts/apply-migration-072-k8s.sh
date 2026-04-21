#!/usr/bin/env bash
# =============================================================================
# Apply Migration 072: Add Resolver Tracking to Impulse Relevance (Kubernetes Version)
# =============================================================================
# Purpose: Add resolver tier tracking fields to impulse_relevance_metrics table
#          to enable learning which resolvers work best for which impulse shapes.
#
# This adds fields for:
# - resolver_tier (LOCAL, CUSTOM, DISCOVERY, MCP, FALLBACK, ERROR)
# - resolver_name (memo, file, directoryTree, gitDiff, VesselClient, mcp, etc.)
# - avg_resolution_latency_ms (average resolution time)
# - resolver_success_count (number of successful resolutions)
# - resolver_failure_count (number of failed resolutions)
#
# This script:
# 1. Retrieves SurrealDB password from Kubernetes secret
# 2. Sets up port-forward to SurrealDB pod
# 3. Applies migration via HTTP API
# 4. Cleans up port-forward
#
# Usage:
#   ./apply-migration-072-k8s.sh
#
# Requirements:
#   - kubectl configured with access to metabob-production cluster
#   - Port 8000 available locally (or set PORT variable)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_FILE="$REPO_ROOT/sql/migrations/072-add-resolver-tracking-to-impulse-relevance.surql"

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
echo -e "${BLUE}Applying Migration 072: Add Resolver Tracking to Impulse Relevance${NC}"
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
echo -e "${YELLOW}Step 3: Checking impulse_relevance_metrics table...${NC}"
TABLE_INFO=$(execute_surql "INFO FOR TABLE impulse_relevance_metrics;")

if echo "$TABLE_INFO" | grep -q "error"; then
    echo -e "${RED}✗ Failed to query impulse_relevance_metrics table${NC}"
    echo "$TABLE_INFO" | jq . 2>/dev/null || echo "$TABLE_INFO"
    exit 1
fi

echo -e "${GREEN}✓ impulse_relevance_metrics table exists${NC}"
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
TABLE_INFO=$(execute_surql "INFO FOR TABLE impulse_relevance_metrics;")

for field in resolver_tier resolver_name avg_resolution_latency_ms resolver_success_count resolver_failure_count; do
    if echo "$TABLE_INFO" | grep -q "$field"; then
        echo -e "${GREEN}✓ Field $field added${NC}"
    else
        echo -e "${RED}✗ Field $field not found${NC}"
        exit 1
    fi
done
echo ""

# Verify indexes created
echo -e "${YELLOW}Step 6: Verifying indexes...${NC}"
for index in idx_impulse_relevance_resolver idx_impulse_relevance_shape_resolver; do
    if echo "$TABLE_INFO" | grep -q "$index"; then
        echo -e "${GREEN}✓ Index $index created${NC}"
    else
        echo -e "${YELLOW}⚠ Index $index not found (may require separate definition)${NC}"
    fi
done
echo ""

echo -e "${GREEN}==============================================================================${NC}"
echo -e "${GREEN}Migration 072 Applied Successfully!${NC}"
echo -e "${GREEN}==============================================================================${NC}"
echo ""
echo -e "${BLUE}What was changed:${NC}"
echo -e "  • Added resolver_tier field (LOCAL, CUSTOM, DISCOVERY, MCP, FALLBACK, ERROR)"
echo -e "  • Added resolver_name field (memo, file, gitDiff, VesselClient, mcp, etc.)"
echo -e "  • Added avg_resolution_latency_ms field"
echo -e "  • Added resolver_success_count field"
echo -e "  • Added resolver_failure_count field"
echo -e "  • Created idx_impulse_relevance_resolver index"
echo -e "  • Created idx_impulse_relevance_shape_resolver index"
echo ""
echo -e "${BLUE}Learning Applications:${NC}"
echo -e "  1. Resolver Selection: Track success rate per resolver per shape"
echo -e "  2. Vessel Performance: Measure latency per vessel, detect degradation"
echo -e "  3. Cost Optimization: Identify expensive patterns, prefer deterministic resolvers"
echo -e "  4. Pattern Recognition: Learn which resolvers work together"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo -e "  1. Deploy updated MiniBob (includes resolver tracking)"
echo -e "  2. Deploy updated Activity-API (accepts new fields)"
echo -e "  3. Monitor learning loop improvements via dashboard"
echo ""
exit 0
