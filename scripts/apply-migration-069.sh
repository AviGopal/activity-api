#!/usr/bin/env bash
# =============================================================================
# Apply Migration 069: Fix JWT_SECRET in apikey_token ACCESS method
# =============================================================================
# Purpose: Replace the hardcoded JWT secret from migration 064 with the
#          actual JWT_SECRET from environment variables.
#
# IMPORTANT: This script substitutes __JWT_SECRET_PLACEHOLDER__ with the
#            value of JWT_SECRET environment variable before applying.
#
# Usage:
#   JWT_SECRET=<secret> SURREALDB_PASSWORD=<password> ./apply-migration-069.sh
#
# Or with SOPS:
#   export JWT_SECRET=$(sops -d secrets/production.secrets.yaml | yq '.activityApi.jwtSecret')
#   SURREALDB_PASSWORD=<password> ./apply-migration-069.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_FILE="$REPO_ROOT/sql/migrations/069-fix-apikey-token-jwt-secret.surql"

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
JWT_SECRET="${JWT_SECRET:-}"

# Validate required environment variables
if [[ -z "$JWT_SECRET" ]]; then
    echo -e "${RED}Error: JWT_SECRET environment variable not set${NC}"
    echo ""
    echo "The JWT_SECRET is required to configure the SurrealDB ACCESS method."
    echo "This secret must match the JWT_SECRET used by metabob-activity-api."
    echo ""
    echo "Usage:"
    echo "  JWT_SECRET=<secret> SURREALDB_PASSWORD=<password> $0"
    echo ""
    echo "Or using SOPS:"
    echo "  export JWT_SECRET=\$(sops -d secrets/production.secrets.yaml | yq '.activityApi.jwtSecret')"
    echo "  SURREALDB_PASSWORD=<password> $0"
    exit 1
fi

if [[ -z "$SURREALDB_PASSWORD" ]]; then
    echo -e "${RED}Error: SURREALDB_PASSWORD environment variable not set${NC}"
    echo "Usage: JWT_SECRET=<secret> SURREALDB_PASSWORD=<password> $0"
    exit 1
fi

# Check if migration file exists
if [[ ! -f "$MIGRATION_FILE" ]]; then
    echo -e "${RED}Error: Migration file not found: $MIGRATION_FILE${NC}"
    exit 1
fi

# Validate JWT_SECRET is not the placeholder
if [[ "$JWT_SECRET" == "__JWT_SECRET_PLACEHOLDER__" ]]; then
    echo -e "${RED}Error: JWT_SECRET cannot be the placeholder value${NC}"
    exit 1
fi

# Validate JWT_SECRET is not the insecure default
if [[ "$JWT_SECRET" == "dev-secret-change-in-production" ]]; then
    echo -e "${YELLOW}Warning: Using insecure dev secret. This should only be used for local development.${NC}"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Validate JWT_SECRET minimum length (256 bits = 32 bytes for HS512)
if [[ ${#JWT_SECRET} -lt 32 ]]; then
    echo -e "${YELLOW}Warning: JWT_SECRET is shorter than recommended (32+ characters for HS512)${NC}"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo -e "${BLUE}==============================================================================${NC}"
echo -e "${BLUE}Applying Migration 069: Fix JWT_SECRET in apikey_token ACCESS method${NC}"
echo -e "${BLUE}==============================================================================${NC}"
echo ""
echo -e "${YELLOW}Target Database:${NC}"
echo -e "  URL:       $SURREALDB_URL"
echo -e "  Namespace: $SURREALDB_NAMESPACE"
echo -e "  Database:  $SURREALDB_DATABASE"
echo -e "  JWT Secret: ${JWT_SECRET:0:4}...${JWT_SECRET: -4} (${#JWT_SECRET} chars)"
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

# Check current ACCESS method status
echo -e "${YELLOW}Step 1: Checking current apikey_token ACCESS method...${NC}"
DB_INFO=$(execute_surql "INFO FOR DB;")

if echo "$DB_INFO" | grep -q "apikey_token"; then
    echo -e "${GREEN}✓ apikey_token ACCESS method exists (will be overwritten)${NC}"
else
    echo -e "${YELLOW}⚠ apikey_token ACCESS method not found (will be created)${NC}"
fi
echo ""

# Substitute placeholder and apply migration
echo -e "${YELLOW}Step 2: Substituting JWT_SECRET placeholder...${NC}"

# Read migration file and substitute placeholder
# Use a temporary file to avoid exposing secret in process list
TEMP_FILE=$(mktemp)
trap "rm -f $TEMP_FILE" EXIT

# Escape special characters in JWT_SECRET for sed
# Using perl for safer substitution with special characters
perl -pe "s/__JWT_SECRET_PLACEHOLDER__/\Q$JWT_SECRET\E/g" "$MIGRATION_FILE" > "$TEMP_FILE"

# Verify substitution was successful
if grep -q "__JWT_SECRET_PLACEHOLDER__" "$TEMP_FILE"; then
    echo -e "${RED}✗ Failed to substitute placeholder${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Placeholder substituted${NC}"
echo ""

# Apply migration
echo -e "${YELLOW}Step 3: Applying migration...${NC}"
MIGRATION_CONTENT=$(cat "$TEMP_FILE")
RESULT=$(execute_surql "$MIGRATION_CONTENT")

if echo "$RESULT" | grep -q "error"; then
    echo -e "${RED}✗ Migration failed${NC}"
    echo "$RESULT" | jq . 2>/dev/null || echo "$RESULT"
    exit 1
fi

echo -e "${GREEN}✓ Migration applied successfully${NC}"
echo ""

# Verify ACCESS method is correctly configured
echo -e "${YELLOW}Step 4: Verifying apikey_token ACCESS method...${NC}"
DB_INFO=$(execute_surql "INFO FOR DB;")

if echo "$DB_INFO" | grep -q "apikey_token"; then
    echo -e "${GREEN}✓ apikey_token ACCESS method is configured${NC}"

    # Note: We cannot verify the actual KEY value for security reasons
    # The ACCESS method info doesn't expose the secret
    echo -e "${BLUE}  (KEY value is not exposed in INFO FOR DB for security)${NC}"
else
    echo -e "${RED}✗ apikey_token ACCESS method not found after migration${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}==============================================================================${NC}"
echo -e "${GREEN}Migration 069 Applied Successfully!${NC}"
echo -e "${GREEN}==============================================================================${NC}"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo -e "  1. Verify JWT authentication works by testing API key flow"
echo -e "  2. Check activity-api logs for successful JWT validation"
echo -e "  3. Test: curl -H 'Authorization: ApiKey <key>' https://activity.metabob.com/v2/activities/templates"
echo ""
echo -e "${YELLOW}Security reminder:${NC}"
echo -e "  - The JWT_SECRET in SurrealDB must match the JWT_SECRET in activity-api"
echo -e "  - Rotate secrets periodically (invalidates all existing tokens)"
echo -e "  - Use different secrets per environment"
echo ""
exit 0
