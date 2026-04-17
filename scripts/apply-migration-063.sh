#!/usr/bin/env bash
# ==============================================================================
# Apply Migration 063: Composition Edge Learning (Phase 3)
# ==============================================================================
# This script applies the composition_edge table schema to SurrealDB.
#
# Usage:
#   ./scripts/apply-migration-063.sh [--dry-run]
#
# Environment variables:
#   SURREALDB_URL       - SurrealDB connection URL (default: http://localhost:8000)
#   SURREALDB_NAMESPACE - Namespace (default: activity-system)
#   SURREALDB_DATABASE  - Database (default: learning_loop)
#   SURREALDB_USERNAME  - Username (default: root)
#   SURREALDB_PASSWORD  - Password (default: root)
# ==============================================================================

set -euo pipefail

# Configuration
SURREALDB_URL="${SURREALDB_URL:-http://localhost:8000}"
SURREALDB_NAMESPACE="${SURREALDB_NAMESPACE:-activity-system}"
SURREALDB_DATABASE="${SURREALDB_DATABASE:-learning_loop}"
SURREALDB_USERNAME="${SURREALDB_USERNAME:-root}"
SURREALDB_PASSWORD="${SURREALDB_PASSWORD:-root}"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_FILE="$SCRIPT_DIR/../sql/migrations/063-composition-edges.surql"

echo "=============================================================================="
echo "Apply Migration 063: Composition Edge Learning (Phase 3)"
echo "=============================================================================="
echo ""
echo "Database: $SURREALDB_URL/$SURREALDB_NAMESPACE/$SURREALDB_DATABASE"
echo "Migration: $MIGRATION_FILE"
echo ""

if [[ ! -f "$MIGRATION_FILE" ]]; then
  echo "❌ Error: Migration file not found: $MIGRATION_FILE"
  exit 1
fi

if $DRY_RUN; then
  echo "DRY RUN MODE - would execute:"
  echo ""
  cat "$MIGRATION_FILE"
  echo ""
  echo "=============================================================================="
  echo "DRY RUN completed (no changes made)"
  echo "=============================================================================="
  exit 0
fi

echo "Applying migration..."
echo ""

# Apply migration using SurrealDB CLI
# Note: Using stdin to avoid exposing password in process list
surreal sql \
  --endpoint "$SURREALDB_URL" \
  --namespace "$SURREALDB_NAMESPACE" \
  --database "$SURREALDB_DATABASE" \
  --username "$SURREALDB_USERNAME" \
  --password "$SURREALDB_PASSWORD" \
  < "$MIGRATION_FILE"

EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
  echo ""
  echo "=============================================================================="
  echo "✓ Migration 063 applied successfully"
  echo "=============================================================================="
  echo ""
  echo "Verification query:"
  echo "  INFO FOR TABLE composition_edge;"
  echo ""
else
  echo ""
  echo "=============================================================================="
  echo "❌ Migration 063 failed (exit code: $EXIT_CODE)"
  echo "=============================================================================="
  exit $EXIT_CODE
fi
