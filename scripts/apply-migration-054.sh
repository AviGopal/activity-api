#!/bin/bash
set -e

# =============================================================================
# Apply Migration 054: Fix Activity Flexible Schema
# =============================================================================
# This script applies the migration to allow generic resolvers (not just LLM)
# in activity task definitions
# =============================================================================

SURREALDB_URL="${SURREALDB_URL:-https://activity.metabob.com}"
SURREALDB_NAMESPACE="${SURREALDB_NAMESPACE:-activity-system}"
SURREALDB_DATABASE="${SURREALDB_DATABASE:-learning_loop}"

# Check for required environment variables
if [ -z "$SURREALDB_USERNAME" ] || [ -z "$SURREALDB_PASSWORD" ]; then
  echo "Error: SURREALDB_USERNAME and SURREALDB_PASSWORD must be set"
  echo ""
  echo "For canary deployment:"
  echo "  export SURREALDB_USERNAME=root"
  echo "  export SURREALDB_PASSWORD=<canary-password>"
  echo ""
  exit 1
fi

MIGRATION_FILE="$(dirname "$0")/../sql/migrations/054-fix-activity-flexible-schema.surql"

echo "========================================="
echo "Migration 054: Fix Activity Flexible Schema"
echo "========================================="
echo "Target: $SURREALDB_URL"
echo "Namespace: $SURREALDB_NAMESPACE"
echo "Database: $SURREALDB_DATABASE"
echo ""
echo "This migration will:"
echo "  1. Remove strict schema validation from tasks field"
echo "  2. Allow arbitrary nested structures (LLM and deterministic resolvers)"
echo "  3. Enable generic resolver support"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

echo ""
echo "Applying migration..."

# Apply migration
curl -X POST "$SURREALDB_URL/sql" \
  -H "Content-Type: application/surql" \
  -H "Accept: application/json" \
  -H "surreal-ns: $SURREALDB_NAMESPACE" \
  -H "surreal-db: $SURREALDB_DATABASE" \
  -u "$SURREALDB_USERNAME:$SURREALDB_PASSWORD" \
  --data-binary "@$MIGRATION_FILE"

echo ""
echo ""
echo "========================================="
echo "Verifying migration..."
echo "========================================="

# Test with a sample activity creation
echo "Testing activity creation with nested fields..."
curl -X POST "$SURREALDB_URL/sql" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "surreal-ns: $SURREALDB_NAMESPACE" \
  -H "surreal-db: $SURREALDB_DATABASE" \
  -u "$SURREALDB_USERNAME:$SURREALDB_PASSWORD" \
  -d 'CREATE activity:test_migration_054 CONTENT {
    id: "test-migration-054",
    name: "Test Activity",
    description: "Testing flexible schema",
    execution_type: "template",
    category: "test",
    scope: "global",
    public: false,
    org_id: "NONE",
    tasks: [
      {
        id: "task-1",
        prompt: {
          template: "Test",
          variables: [
            {
              name: "testVar",
              description: "This field should work now",
              type: "string"
            }
          ]
        }
      }
    ]
  }'

echo ""
echo ""
echo "Cleaning up test activity..."
curl -X POST "$SURREALDB_URL/sql" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "surreal-ns: $SURREALDB_NAMESPACE" \
  -H "surreal-db: $SURREALDB_DATABASE" \
  -u "$SURREALDB_USERNAME:$SURREALDB_PASSWORD" \
  -d 'DELETE activity:test_migration_054'

echo ""
echo ""
echo "========================================="
echo "✓ Migration 054 applied successfully"
echo "========================================="
echo ""
echo "Next steps:"
echo "  1. Test activity creation via API:"
echo "     curl -X POST https://activity.metabob.com/v2/activities/create-goal-seeking ..."
echo ""
echo "  2. Run minibob activities to verify:"
echo "     bun run index.ts --template .../ci-pipeline.json"
echo ""
