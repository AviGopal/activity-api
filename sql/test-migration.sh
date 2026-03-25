#!/bin/bash
# Test migration script for Phase 2 RBAC migration
# This script tests the migration in a safe environment

set -e

echo "========================================="
echo "Testing Phase 2 RBAC Migration"
echo "========================================="
echo ""

# Check if SurrealDB is running
if ! curl -s http://localhost:8000/health > /dev/null 2>&1; then
    echo "❌ SurrealDB is not running on localhost:8000"
    echo "Please start SurrealDB first:"
    echo "  surreal start --bind 0.0.0.0:8000 --user root --pass root memory"
    exit 1
fi

echo "✓ SurrealDB is running"
echo ""

# Set environment variables for migration
export SURREALDB_URL="http://localhost:8000"
export SURREALDB_NAMESPACE="activity-system-test"
export SURREALDB_DATABASE="learning_loop_test"
export SURREALDB_USERNAME="root"
export SURREALDB_PASSWORD="root"
export METABOB_PROTO_PATH="$(pwd)/../../metabob-proto/surrealdb/core"

echo "Configuration:"
echo "  URL: $SURREALDB_URL"
echo "  Namespace: $SURREALDB_NAMESPACE"
echo "  Database: $SURREALDB_DATABASE"
echo "  Proto path: $METABOB_PROTO_PATH"
echo ""

# Run dry-run first
echo "========================================="
echo "Step 1: Dry-run migration"
echo "========================================="
echo ""

cd "$(dirname "$0")/.."
bun run sql/migrate.ts --dry-run --verbose

echo ""
echo "========================================="
echo "Step 2: Apply migration"
echo "========================================="
echo ""

read -p "Proceed with actual migration? (y/N) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    bun run sql/migrate.ts --verbose

    echo ""
    echo "========================================="
    echo "Step 3: Verify migration"
    echo "========================================="
    echo ""

    # Query schema_version table
    echo "Checking schema version..."
    surreal sql --endpoint http://localhost:8000 \
        --namespace "$SURREALDB_NAMESPACE" \
        --database "$SURREALDB_DATABASE" \
        --username root \
        --password root \
        --pretty \
        "SELECT * FROM schema_version ORDER BY applied_at DESC LIMIT 5;"

    echo ""
    echo "Checking for default organization..."
    surreal sql --endpoint http://localhost:8000 \
        --namespace "$SURREALDB_NAMESPACE" \
        --database "$SURREALDB_DATABASE" \
        --username root \
        --password root \
        --pretty \
        "SELECT * FROM organizations WHERE id = organization:metabob_internal;"

    echo ""
    echo "✓ Migration completed successfully!"
    echo ""
    echo "To clean up test data:"
    echo "  surreal sql --endpoint http://localhost:8000 --username root --password root"
    echo "  REMOVE DATABASE $SURREALDB_DATABASE;"
else
    echo "Migration cancelled"
fi
