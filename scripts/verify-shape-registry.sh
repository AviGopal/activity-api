#!/bin/bash
#
# Verify Shape Registry Deployment
#
# Tests that shape registry endpoints are working correctly after deployment.
# Run against canary or production environment.
#
# Usage:
#   ./scripts/verify-shape-registry.sh https://activity.metabob.com <api-key>

set -e

ENDPOINT="${1:-http://localhost:8080}"
API_KEY="${2:-}"

if [ -z "$API_KEY" ]; then
  echo "Usage: $0 <endpoint> <api-key>"
  echo "Example: $0 https://activity.metabob.com sk-ant-..."
  exit 1
fi

echo "Verifying Shape Registry at $ENDPOINT"
echo "======================================"

# Color output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

test_passed() {
  echo -e "${GREEN}✓${NC} $1"
}

test_failed() {
  echo -e "${RED}✗${NC} $1"
  exit 1
}

# Test 1: Health check
echo ""
echo "Test 1: Health check"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$ENDPOINT/health")
if [ "$HTTP_CODE" == "200" ]; then
  test_passed "Health check returned 200"
else
  test_failed "Health check returned $HTTP_CODE (expected 200)"
fi

# Test 2: List shapes (should include bootstrap shapes)
echo ""
echo "Test 2: List bootstrap shapes"
RESPONSE=$(curl -s -H "Authorization: Bearer $API_KEY" "$ENDPOINT/v2/shapes")
if echo "$RESPONSE" | jq -e '.shapes | length > 0' > /dev/null; then
  SHAPE_COUNT=$(echo "$RESPONSE" | jq '.shapes | length')
  test_passed "Found $SHAPE_COUNT shapes"

  # Check for specific bootstrap shapes
  if echo "$RESPONSE" | jq -e '.shapes[] | select(.name == "memo")' > /dev/null; then
    test_passed "Bootstrap shape 'memo' exists"
  else
    test_failed "Bootstrap shape 'memo' not found"
  fi

  if echo "$RESPONSE" | jq -e '.shapes[] | select(.name == "file")' > /dev/null; then
    test_passed "Bootstrap shape 'file' exists"
  else
    test_failed "Bootstrap shape 'file' not found"
  fi
else
  test_failed "No shapes found (expected bootstrap shapes)"
fi

# Test 3: Get specific shape
echo ""
echo "Test 3: Get specific shape by name"
RESPONSE=$(curl -s -H "Authorization: Bearer $API_KEY" "$ENDPOINT/v2/shapes/memo")
if echo "$RESPONSE" | jq -e '.name == "memo"' > /dev/null; then
  VERSION=$(echo "$RESPONSE" | jq -r '.version')
  test_passed "Retrieved 'memo' shape version $VERSION"
else
  test_failed "Failed to retrieve 'memo' shape"
fi

# Test 4: Get shape versions
echo ""
echo "Test 4: List shape versions"
RESPONSE=$(curl -s -H "Authorization: Bearer $API_KEY" "$ENDPOINT/v2/shapes/memo/versions")
if echo "$RESPONSE" | jq -e '.versions | length > 0' > /dev/null; then
  VERSION_COUNT=$(echo "$RESPONSE" | jq '.versions | length')
  test_passed "Found $VERSION_COUNT version(s) of 'memo' shape"
else
  test_failed "No versions found for 'memo' shape"
fi

# Test 5: Register new test shape
echo ""
echo "Test 5: Register new test shape"
TEST_SHAPE_NAME="test_shape_$(date +%s)"
RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"$TEST_SHAPE_NAME\",
    \"version\": \"1.0.0\",
    \"schema\": {
      \"type\": \"object\",
      \"required\": [\"test_field\"],
      \"properties\": {
        \"test_field\": {\"type\": \"string\"}
      }
    },
    \"description\": \"Test shape for verification\",
    \"example\": {\"test_field\": \"test value\"},
    \"tags\": [\"test\"],
    \"public\": false
  }" \
  "$ENDPOINT/v2/shapes")

if echo "$RESPONSE" | jq -e '.id' > /dev/null; then
  SHAPE_ID=$(echo "$RESPONSE" | jq -r '.id')
  test_passed "Registered test shape: $SHAPE_ID"
else
  echo "Response: $RESPONSE"
  test_failed "Failed to register test shape"
fi

# Test 6: Retrieve registered shape
echo ""
echo "Test 6: Retrieve registered test shape"
RESPONSE=$(curl -s -H "Authorization: Bearer $API_KEY" "$ENDPOINT/v2/shapes/$TEST_SHAPE_NAME")
if echo "$RESPONSE" | jq -e ".name == \"$TEST_SHAPE_NAME\"" > /dev/null; then
  test_passed "Retrieved test shape successfully"
else
  test_failed "Failed to retrieve test shape"
fi

# Test 7: Vessel discovery (should work even with no vessels)
echo ""
echo "Test 7: Vessel discovery with shape validation"
RESPONSE=$(curl -s -H "Authorization: Bearer $API_KEY" "$ENDPOINT/v2/vessels/discover?shape=memo")
# Either finds vessels or returns 404 with proper error
if echo "$RESPONSE" | jq -e '.vessels' > /dev/null; then
  VESSEL_COUNT=$(echo "$RESPONSE" | jq '.vessels | length')
  test_passed "Vessel discovery returned $VESSEL_COUNT vessel(s)"
elif echo "$RESPONSE" | jq -e '.error' > /dev/null; then
  ERROR=$(echo "$RESPONSE" | jq -r '.error')
  if [[ "$ERROR" == *"No vessels found"* ]]; then
    test_passed "Vessel discovery properly reports no vessels"
  else
    echo "Response: $RESPONSE"
    test_failed "Unexpected error from vessel discovery: $ERROR"
  fi
else
  echo "Response: $RESPONSE"
  test_failed "Invalid response from vessel discovery"
fi

# Test 8: Version constraint matching
echo ""
echo "Test 8: Version constraint matching"
RESPONSE=$(curl -s -H "Authorization: Bearer $API_KEY" "$ENDPOINT/v2/shapes/memo?version=^1.0.0")
if echo "$RESPONSE" | jq -e '.name == "memo"' > /dev/null; then
  VERSION=$(echo "$RESPONSE" | jq -r '.version')
  test_passed "Version constraint ^1.0.0 resolved to $VERSION"
else
  test_failed "Version constraint matching failed"
fi

# Test 9: Organization health (should work even with no vessels)
echo ""
echo "Test 9: Organization vessel health"
RESPONSE=$(curl -s -H "Authorization: Bearer $API_KEY" "$ENDPOINT/v2/vessels/health/organization")
if echo "$RESPONSE" | jq -e '.summary' > /dev/null; then
  TOTAL=$(echo "$RESPONSE" | jq -r '.summary.total')
  test_passed "Organization health returned summary (total: $TOTAL vessels)"
else
  echo "Response: $RESPONSE"
  test_failed "Organization health endpoint failed"
fi

echo ""
echo "======================================"
echo -e "${GREEN}All tests passed!${NC}"
echo ""
echo "Shape Registry is deployed and working correctly."
