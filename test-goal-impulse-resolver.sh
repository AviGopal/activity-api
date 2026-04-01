#!/usr/bin/env bash
#
# Test script for goal impulse resolver
# Tests POST /v2/impulses/resolve with pointer type 'goal'
#

set -euo pipefail

API_URL="${API_URL:-http://api.minibob.local}"
JWT_TOKEN="${JWT_TOKEN:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=================================="
echo "Goal Impulse Resolver Tests"
echo "=================================="
echo ""
echo "API URL: $API_URL"
echo ""

# Helper function to make requests
test_request() {
  local test_name="$1"
  local payload="$2"
  local expect_success="${3:-true}"

  echo "Test: $test_name"
  echo "----------------------------------------"

  local response
  local http_code

  response=$(curl -s -w "\n%{http_code}" \
    -X POST "$API_URL/v2/impulses/resolve" \
    -H "Content-Type: application/json" \
    ${JWT_TOKEN:+-H "Authorization: Bearer $JWT_TOKEN"} \
    -d "$payload")

  http_code=$(echo "$response" | tail -n1)
  local body=$(echo "$response" | head -n-1)

  if [[ "$expect_success" == "true" ]]; then
    if [[ "$http_code" == "200" ]]; then
      echo -e "${GREEN}✓ PASS${NC} (HTTP $http_code)"
      echo "Response:"
      echo "$body" | jq '.' 2>/dev/null || echo "$body"
    else
      echo -e "${RED}✗ FAIL${NC} (Expected 200, got $http_code)"
      echo "Response:"
      echo "$body" | jq '.' 2>/dev/null || echo "$body"
    fi
  else
    if [[ "$http_code" == "400" ]] || [[ "$http_code" == "500" ]]; then
      echo -e "${GREEN}✓ PASS${NC} (Expected error, got HTTP $http_code)"
      echo "Response:"
      echo "$body" | jq '.' 2>/dev/null || echo "$body"
    else
      echo -e "${RED}✗ FAIL${NC} (Expected error, got $http_code)"
      echo "Response:"
      echo "$body" | jq '.' 2>/dev/null || echo "$body"
    fi
  fi

  echo ""
  echo ""
}

# Test 1: Basic goal resolution
test_request \
  "Basic goal impulse resolution" \
  '{
    "pointer": {
      "type": "goal",
      "content": "Add user authentication to the dashboard"
    }
  }'

# Test 2: With limit parameter
test_request \
  "Goal with limit=2" \
  '{
    "pointer": {
      "type": "goal",
      "content": "Fix login bug",
      "limit": 2
    }
  }'

# Test 3: With category filter
test_request \
  "Goal with category filter" \
  '{
    "pointer": {
      "type": "goal",
      "content": "Add new feature",
      "category": "feature",
      "limit": 3
    }
  }'

# Test 4: With impulse context
test_request \
  "Goal with impulse context" \
  '{
    "pointer": {
      "type": "goal",
      "content": "Fix authentication bug",
      "impulseRefs": ["file-src-auth.ts", "memo-bug-report"],
      "limit": 3
    }
  }'

# Test 5: With exclude activities
test_request \
  "Goal with exclude activities" \
  '{
    "pointer": {
      "type": "goal",
      "content": "Test goal",
      "limit": 5,
      "excludeActivities": ["some-activity-id-1", "some-activity-id-2"]
    }
  }'

# Test 6: Error - missing content
test_request \
  "Error case: Missing content field" \
  '{
    "pointer": {
      "type": "goal"
    }
  }' \
  false

# Test 7: Error - empty content
test_request \
  "Error case: Empty content field" \
  '{
    "pointer": {
      "type": "goal",
      "content": ""
    }
  }' \
  false

echo "=================================="
echo "Tests complete!"
echo "=================================="
