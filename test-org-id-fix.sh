#!/usr/bin/env bash

# Test script to verify org_id VALUE clause fix
# Tests that MiniBob can create impulses without type coercion errors

set -e

SURREAL_HOST="${SURREALDB_URL:-http://localhost:8000}"
MINIBOB_API="${ACTIVITY_API_URL:-http://api.minibob.local}"

echo "==================================================================="
echo "Testing org_id VALUE clause fix"
echo "==================================================================="
echo ""

# Step 1: Set up API key authentication
echo "Step 1: Setting up API key authentication..."
API_KEY="${METABOB_API_KEY:-test-api-key-123}"
AUTH_HEADER="Authorization: ApiKey ${API_KEY}"

# For testing purposes, we'll use the default MiniBob org_id
# In production, the API key would determine the org_id
ORG_ID="minibob"

echo "✅ API key authentication configured"
echo "   Using API Key: ${API_KEY:0:20}..."
echo "   Org ID: $ORG_ID"
echo ""

# Step 2: Create an impulse (this would fail before the fix)
echo "Step 2: Creating impulse..."
IMPULSE_RESPONSE=$(curl -s -X POST "${MINIBOB_API}/v2/impulses" \
  -H "${AUTH_HEADER}" \
  -H "Content-Type: application/json" \
  -d '{
    "impulse_id": "test-org-id-fix",
    "pointer": {
      "type": "memo",
      "content": "Test impulse to verify org_id VALUE clause fix"
    },
    "shape": {
      "type": "text"
    },
    "priority": "medium"
  }')

# Check if creation succeeded
IMPULSE_ID=$(echo "$IMPULSE_RESPONSE" | jq -r '.id // .impulse_id // empty')

if [ -z "$IMPULSE_ID" ]; then
  # Check for error
  ERROR=$(echo "$IMPULSE_RESPONSE" | jq -r '.error // .message // empty')
  if echo "$ERROR" | grep -q "Expected.*string.*but found.*organizations:"; then
    echo "❌ FAILED: org_id type coercion error still present"
    echo "   Error: $ERROR"
    exit 1
  else
    echo "❌ FAILED: Impulse creation failed with unexpected error"
    echo "$IMPULSE_RESPONSE" | jq .
    exit 1
  fi
fi

echo "✅ Impulse created successfully"
echo "   Impulse ID: $IMPULSE_ID"
echo ""

# Step 3: Verify org_id is stored as string (not record ID)
echo "Step 3: Verifying org_id storage format..."
VERIFY_RESPONSE=$(curl -s -X POST "${SURREAL_HOST}/sql" \
  -u "root:${SURREALDB_PASSWORD:-root}" \
  -H "surreal-ns: ${SURREALDB_NAMESPACE:-activity-system}" \
  -H "surreal-db: ${SURREALDB_DATABASE:-learning_loop}" \
  -d "SELECT id, org_id, type::is::string(org_id) AS is_string FROM impulse_data WHERE impulse_id = 'test-org-id-fix' LIMIT 1")

STORED_ORG_ID=$(echo "$VERIFY_RESPONSE" | jq -r '.[0][0].org_id // empty')
IS_STRING=$(echo "$VERIFY_RESPONSE" | jq -r '.[0][0].is_string // empty')

if [ "$STORED_ORG_ID" != "$ORG_ID" ]; then
  echo "❌ FAILED: org_id mismatch"
  echo "   Expected: $ORG_ID"
  echo "   Stored: $STORED_ORG_ID"
  exit 1
fi

if [ "$IS_STRING" != "true" ]; then
  echo "❌ FAILED: org_id is not stored as string"
  echo "   Is string: $IS_STRING"
  exit 1
fi

echo "✅ org_id stored correctly as string"
echo "   org_id: $STORED_ORG_ID"
echo "   is_string: $IS_STRING"
echo ""

# Step 4: Cleanup test data
echo "Step 4: Cleaning up test data..."
curl -s -X POST "${SURREAL_HOST}/sql" \
  -u "root:${SURREALDB_PASSWORD:-root}" \
  -H "surreal-ns: ${SURREALDB_NAMESPACE:-activity-system}" \
  -H "surreal-db: ${SURREALDB_DATABASE:-learning_loop}" \
  -d "DELETE impulse_data WHERE impulse_id = 'test-org-id-fix'" > /dev/null

echo "✅ Cleanup complete"
echo ""

echo "==================================================================="
echo "✅ ALL TESTS PASSED"
echo "==================================================================="
echo ""
echo "The org_id VALUE clause fix is working correctly:"
echo "  - MiniBob authentication works"
echo "  - Impulse creation succeeds (no type coercion error)"
echo "  - org_id is stored as plain string (not record ID)"
