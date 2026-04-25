#!/bin/bash

# Test script for /v2/goal-paths/recommend endpoint
# This validates the endpoint is accessible and returns the expected structure

echo "Testing POST /v2/goal-paths/recommend endpoint"
echo "=============================================="
echo ""

# Test with a sample goal
curl -s -X POST http://localhost:8080/v2/goal-paths/recommend \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey test-key" \
  -d '{
    "goal_text": "fix authentication bug in login flow",
    "exploration_rate": 0.2,
    "top_k": 5
  }' | jq '.'

echo ""
echo "Expected response structure:"
echo "{"
echo "  \"goal_hash\": \"<hash>\","
echo "  \"recommended_paths\": ["
echo "    {"
echo "      \"path_activities\": [\"activity-id-1\", \"activity-id-2\"],"
echo "      \"confidence\": 0.85,"
echo "      \"success_rate\": 0.9,"
echo "      \"avg_duration_ms\": 1500,"
echo "      \"avg_cost_usd\": 0.05,"
echo "      \"total_executions\": 10,"
echo "      \"exploration_bonus\": 0.1 (optional)"
echo "    }"
echo "  ]"
echo "}"
