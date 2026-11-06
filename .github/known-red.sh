#!/usr/bin/env bash
# Usage: known-red.sh <bun test log> <bun exit status>
# Exits 0 when the run failed only on cases listed in known-red.txt; otherwise
# passes the bun status through. A listed case that passes is a warning.
log=$1 rc=$2
list="$(dirname "$0")/known-red.txt"

failed=$(sed -n 's/^(fail) //p' "$log" | sed -E 's/ \[[0-9.]+m?s\]$//' | sort -u)
known=$(grep -vE '^(#|$)' "$list" | sort -u)
unlisted=$(comm -23 <(echo "$failed" | sed '/^$/d') <(echo "$known"))
fixed=$(comm -13 <(echo "$failed" | sed '/^$/d') <(echo "$known"))
nfail=$(grep -oP '^\s*\K[0-9]+(?= fail$)' "$log" | tail -1)
nlisted=$(echo "$failed" | sed '/^$/d' | wc -l)

while IFS= read -r t; do [ -n "$t" ] && echo "::warning::known-red case passes; remove it from known-red.txt: $t"; done <<< "$fixed"

[ "$rc" = 0 ] && exit 0
if [ -z "$unlisted" ] && [ "$nfail" = "$nlisted" ] && ! grep -qE '^\s*[0-9]+ errors?$' "$log"; then
  echo "::notice::$nlisted known-red cases fail as expected (source defects, see known-red.txt)"
  exit 0
fi
while IFS= read -r t; do [ -n "$t" ] && echo "::error::unlisted failure: $t"; done <<< "$unlisted"
exit "$rc"
