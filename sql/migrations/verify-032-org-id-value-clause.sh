#!/usr/bin/env bash

# Verification script for migration 032: org_id VALUE clause fix
# Checks that all org_id VALUE clauses use <string> cast

set -e

SCHEMA_DIR="$(dirname "$0")/../schemas"

echo "==================================================================="
echo "Verification: org_id VALUE clause uses <string> cast"
echo "==================================================================="
echo ""

echo "Checking schema files for org_id VALUE clauses..."
echo ""

# Find all VALUE clauses with $auth.org_id
grep -rn "VALUE.*\$auth\.org_id" "$SCHEMA_DIR" || true

echo ""
echo "-------------------------------------------------------------------"
echo "Expected: All lines should contain 'VALUE \$value OR <string>\$auth.org_id'"
echo "NOT: 'VALUE \$value OR \$auth.org_id' (without <string> cast)"
echo "-------------------------------------------------------------------"
echo ""

# Check for any VALUE clauses WITHOUT <string> cast
echo "Checking for missing <string> cast..."
BAD_LINES=$(grep -rn "VALUE.*\$auth\.org_id" "$SCHEMA_DIR" | grep -v "<string>" || true)

if [ -n "$BAD_LINES" ]; then
  echo "❌ FAILED: Found org_id VALUE clauses without <string> cast:"
  echo "$BAD_LINES"
  exit 1
else
  echo "✅ PASSED: All org_id VALUE clauses use <string> cast"
fi

echo ""
echo "==================================================================="
echo "Verification complete!"
echo "==================================================================="
