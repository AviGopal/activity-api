#!/bin/bash
# Apply migration 074 - Fix activity table PERMISSIONS for API key authentication
#
# This migration resolves the 500 error when using API keys with templates endpoint
# by adding explicit type casting to the PERMISSIONS clause.
#
# Usage:
#   ./scripts/apply-migration-074-k8s.sh [environment]
#
# Arguments:
#   environment - Optional: local, canary, or production (default: local)

set -euo pipefail

# Configuration
ENVIRONMENT="${1:-local}"
NAMESPACE="activity-system"
SURREALDB_SERVICE="surrealdb"
SURREALDB_PORT="8000"
MIGRATION_FILE="sql/migrations/074-fix-activity-permissions-auth.surql"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}[Migration 074] Fix activity PERMISSIONS for API key auth${NC}"
echo "Environment: $ENVIRONMENT"
echo "Namespace: $NAMESPACE"
echo ""

# Check if migration file exists
if [ ! -f "$MIGRATION_FILE" ]; then
  echo -e "${RED}Error: Migration file not found: $MIGRATION_FILE${NC}"
  exit 1
fi

# Get SurrealDB credentials from secrets
echo -e "${YELLOW}[1/4] Getting SurrealDB credentials from Kubernetes secrets...${NC}"

SURREALDB_USERNAME=$(kubectl get secret surrealdb-auth -n "$NAMESPACE" -o jsonpath='{.data.username}' | base64 -d)
SURREALDB_PASSWORD=$(kubectl get secret surrealdb-auth -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)

if [ -z "$SURREALDB_USERNAME" ] || [ -z "$SURREALDB_PASSWORD" ]; then
  echo -e "${RED}Error: Failed to retrieve SurrealDB credentials from secrets${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Credentials retrieved${NC}"

# Port forward to SurrealDB
echo -e "${YELLOW}[2/4] Setting up port forward to SurrealDB...${NC}"

# Kill any existing port-forward on 8000
lsof -ti:8000 | xargs kill -9 2>/dev/null || true

# Start port forward in background
kubectl port-forward -n "$NAMESPACE" "svc/$SURREALDB_SERVICE" 8000:8000 &
PORT_FORWARD_PID=$!

# Wait for port forward to be ready
echo "Waiting for port forward to be ready..."
sleep 3

# Ensure cleanup on exit
trap "kill $PORT_FORWARD_PID 2>/dev/null || true" EXIT

echo -e "${GREEN}✓ Port forward ready (PID: $PORT_FORWARD_PID)${NC}"

# Apply migration
echo -e "${YELLOW}[3/4] Applying migration 074...${NC}"

curl -X POST "http://localhost:8000/sql" \
  -u "$SURREALDB_USERNAME:$SURREALDB_PASSWORD" \
  -H "Accept: application/json" \
  -H "NS: activity-system" \
  -H "DB: learning_loop" \
  --data-binary "@$MIGRATION_FILE" \
  -w "\nHTTP Status: %{http_code}\n" \
  | tee /tmp/migration-074-result.txt

echo -e "${GREEN}✓ Migration executed${NC}"

# Verify migration
echo -e "${YELLOW}[4/4] Verifying migration...${NC}"

# Check if activity table has updated PERMISSIONS
VERIFY_QUERY="INFO FOR TABLE activity;"

PERMISSIONS_CHECK=$(curl -s -X POST "http://localhost:8000/sql" \
  -u "$SURREALDB_USERNAME:$SURREALDB_PASSWORD" \
  -H "Accept: application/json" \
  -H "NS: activity-system" \
  -H "DB: learning_loop" \
  -d "$VERIFY_QUERY")

echo "Activity table info:"
echo "$PERMISSIONS_CHECK" | jq '.'

# Check if PERMISSIONS clause contains the type casting
if echo "$PERMISSIONS_CHECK" | grep -q "<string>"; then
  echo -e "${GREEN}✓ Migration verified: Type casting present in PERMISSIONS${NC}"
else
  echo -e "${YELLOW}⚠ Warning: Could not verify type casting in PERMISSIONS${NC}"
  echo "Manual verification recommended"
fi

# Cleanup
echo ""
echo -e "${GREEN}Migration 074 complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Test templates endpoint: curl -H 'Authorization: ApiKey <key>' https://activity.metabob.com/v2/activities/templates"
echo "2. Verify no 500 errors in activity-api logs"
echo "3. Confirm dashboard shows template data"
echo ""
echo "Migration result saved to: /tmp/migration-074-result.txt"
