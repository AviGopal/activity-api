#!/bin/bash
# write-replay-authorization.sh — USER-RUN, once, on node1's host: authorize the β-leak replay's writes.
#
# Writes the trust-root pool record posteriorReplayAuthorization through development-vessel's
# poolImpulse_write with the OPERATOR (admin) key, then reads it back. dev-vessel stamps and signs it
# (attested.by = operator); activity-api's writeGate (src/lib/posterior-compensation.ts) accepts it only
# when this node's dev-vessel reports attested_verified: true and the body names exactly this node and
# the shipped pins below. activity-api never holds the attestation key.
#
# Before running: run posteriorCompensationReplay dry_run and confirm its `node`, `list` and
# `eligibility` match NODE, LIST_SHA256 and ELIGIBILITY_SHA256 here.
#
# usage: write-replay-authorization.sh "<reason>" <review_by ISO-8601>
# env:   CONTAINER (default substrate-live)
#        ADMIN_KEY_FILE (default ~/.config/substrate/operator-admin-key.json, key at .body.data.key)
# The key goes to curl on stdin (-K -), never on a command line or into a file.
set -euo pipefail

NODE="local-dev-spoke"   # node1's FED_SUBSTRATE_ID (the dry_run's `node`)
LIST_SHA256="30e475036ecd95426dff1cfccf3b970e4fc2dd4f503318838a42ac8bd333dc8a"
ELIGIBILITY_SHA256="3e1ccc1014d14fa3701e9bb6c6d273314ed7c758003dc9a225b14d2e6b9bfbce"
ID="posterior-replay-authorization-$NODE"

reason="${1:?usage: $0 \"<reason>\" <review_by ISO-8601>}"
review_by="${2:?usage: $0 \"<reason>\" <review_by ISO-8601>}"
C="${CONTAINER:-substrate-live}"
KEYFILE="${ADMIN_KEY_FILE:-$HOME/.config/substrate/operator-admin-key.json}"

body=$(jq -n --arg id "$ID" --arg node "$NODE" --arg l "$LIST_SHA256" --arg e "$ELIGIBILITY_SHA256" \
  --arg by "operator:${USER:-unknown}" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg reason "$reason" --arg rb "$review_by" \
  '{impulse: {type: "poolImpulse_write", id: $id, shape: "posteriorReplayAuthorization", status: "open", source: "operator",
    body: {node: $node, list_sha256: $l, eligibility_sha256: $e, by: $by, at: $at, reason: $reason, review_by: $rb}}}')
n="replay-auth-$$-$RANDOM.json"
printf '%s' "$body" | docker exec -i "$C" sh -c "cat > /tmp/$n"

K=$(jq -r .body.data.key "$KEYFILE")
printf 'header = "Authorization: ApiKey %s"\nheader = "content-type: application/json"\n' "$K" \
  | docker exec -i "$C" sh -c "curl -s -m60 -K - -X POST 127.0.0.1:8090/v2/impulses/resolve -d @/tmp/$n; rm -f /tmp/$n" \
  | jq -c '{write: (.body // .)}'
unset K

# Read back (reads are not credentialed): PASS only if the newest open row is operator-attested AND verified.
docker exec "$C" curl -s -m30 -X POST 127.0.0.1:8090/v2/impulses/resolve -H 'content-type: application/json' \
  -d '{"impulse":{"type":"poolImpulse","shape":"posteriorReplayAuthorization","status":"open"}}' \
  | jq -e --arg id "$ID" --arg node "$NODE" --arg l "$LIST_SHA256" --arg e "$ELIGIBILITY_SHA256" '
      [.body.impulses[] | select(.id == $id)] | sort_by(.updated_at) | last
      | {id, attested_by: .attested.by, attested_verified, body}
      | ., (if .attested_by == "operator" and .attested_verified == true and .body.node == $node
              and .body.list_sha256 == $l and .body.eligibility_sha256 == $e then "PASS" else error("FAIL") end)'
