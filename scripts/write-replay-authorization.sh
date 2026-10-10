#!/bin/bash
# write-replay-authorization.sh — USER-RUN, once per node: authorize the β-leak replay's writes on this node.
#
# 1. Asks this node's activity-api for a posteriorCompensationReplay dry_run and takes the node identity and
#    the list / eligibility shas from its answer (refuses if the node is missing, or differs from NODE when given).
# 2. Writes the trust-root pool record posteriorReplayAuthorization via development-vessel's poolImpulse_write
#    with the OPERATOR (admin) key. dev-vessel stamps and signs it.
# 3. Reads back the NEWEST open row of the shape (exactly the row activity-api's writeGate selects) and prints
#    PASS only if it is the row just written, stamped attested.by=operator and attested_verified=true.
#
# usage: write-replay-authorization.sh "<reason>" [review_by ISO-8601] [NODE]
#        review_by (optional, default now + 7 days): activity-api refuses every write after it (authorization_expired).
#        NODE (optional): the node you expect; the script refuses if the dry_run reports a different one.
# env:   CONTAINER (default substrate-live)
#        ADMIN_KEY_FILE (default ~/.config/substrate/operator-admin-key.json, key at .body.data.key)
# The key goes to curl on stdin (-K -), never on a command line or into a file.
set -euo pipefail

reason="${1:?usage: $0 \"<reason>\" [review_by ISO-8601] [NODE]}"
review_by="${2:-$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)}"
expect_node="${3:-}"
[ "$(date -u -d "$review_by" +%s 2>/dev/null || echo 0)" -gt "$(date -u +%s)" ] || { echo "FAIL: review_by '$review_by' is not a future time"; exit 1; }
C="${CONTAINER:-substrate-live}"
KEYFILE="${ADMIN_KEY_FILE:-$HOME/.config/substrate/operator-admin-key.json}"

# POST a JSON body (stdin) to an in-container URL with the operator key; the key reaches curl only on stdin.
post_with_key() {
  local url="$1" n="replay-auth-$$-$RANDOM.json"
  docker exec -i "$C" sh -c "cat > /tmp/$n"
  local K; K=$(jq -r .body.data.key "$KEYFILE")
  printf 'header = "Authorization: ApiKey %s"\nheader = "content-type: application/json"\n' "$K" \
    | docker exec -i "$C" sh -c "curl -s -m120 -K - -X POST $url -d @/tmp/$n; rm -f /tmp/$n"
}

# 1. The node and pins, from the dry_run (no arms planned: arm_ids []).
plan=$(echo '{"impulse":{"pointer":{"type":"posteriorCompensationReplay","mode":"dry_run","arm_ids":[]}}}' | post_with_key 127.0.0.1:8080/v2/impulses/resolve)
NODE=$(jq -r '.body.node // empty' <<<"$plan")
LIST_SHA256=$(jq -r '.body.list_sha // empty' <<<"$plan")
ELIGIBILITY_SHA256=$(jq -r '.body.eligibility_sha // empty' <<<"$plan")
echo "dry_run: node=$NODE list=$(jq -r '.body.list // "-"' <<<"$plan") eligibility=$(jq -r '.body.eligibility // "-"' <<<"$plan")"
[ -n "$NODE" ] && [ -n "$LIST_SHA256" ] && [ -n "$ELIGIBILITY_SHA256" ] || { echo "FAIL: the dry_run named no node or pins: $(jq -c '{refused: .refused, detail: .detail}' <<<"$plan")"; exit 1; }
[ -z "$expect_node" ] || [ "$expect_node" = "$NODE" ] || { echo "FAIL: dry_run node '$NODE' is not the expected '$expect_node'"; exit 1; }
ID="posterior-replay-authorization-$NODE"
echo "review_by: $review_by (writes are refused after this)"

# 2. The write.
jq -n --arg id "$ID" --arg node "$NODE" --arg l "$LIST_SHA256" --arg e "$ELIGIBILITY_SHA256" \
  --arg by "operator:${USER:-unknown}" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg reason "$reason" --arg rb "$review_by" \
  '{impulse: {type: "poolImpulse_write", id: $id, shape: "posteriorReplayAuthorization", status: "open", source: "operator",
    body: {node: $node, list_sha256: $l, eligibility_sha256: $e, by: $by, at: $at, reason: $reason, review_by: $rb}}}' \
  | post_with_key 127.0.0.1:8090/v2/impulses/resolve | jq -c '{write: (.body // .)}'

# 3. Read back (pool reads are not credentialed): the newest open row of the shape, as activity-api selects it.
docker exec "$C" curl -s -m30 -X POST 127.0.0.1:8090/v2/impulses/resolve -H 'content-type: application/json' \
  -d '{"impulse":{"type":"poolImpulse","shape":"posteriorReplayAuthorization","status":"open"}}' \
  | jq -r --arg id "$ID" --arg node "$NODE" --arg l "$LIST_SHA256" --arg e "$ELIGIBILITY_SHA256" '
      [.body.impulses[]? | select(.shape == "posteriorReplayAuthorization" and .status == "open")] | sort_by(.updated_at) | last
      | ({id, attested_by: .attested.by, attested_verified, body} | tojson),
        (if . != null and .id == $id and .attested.by == "operator" and .attested_verified == true
            and .body.node == $node and .body.list_sha256 == $l and .body.eligibility_sha256 == $e then "PASS" else "FAIL" end)' \
  | tee /dev/stderr | tail -1 | grep -qx PASS
