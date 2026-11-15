#!/bin/bash
# Roll the live site back to the previous good deployment.
#
#   bash scripts/rollback.sh              (pick the target automatically)
#   bash scripts/rollback.sh <deploy-id>  (roll back to this deployment)
#   bash scripts/rollback.sh --list       (show the candidates, change nothing)
#
# What it does:
#
#   1. pick the target: from the production deployments, the most recent one
#      that is a github:push (a direct upload is not the GitHub content and is
#      not a valid rollback baseline), succeeded, and is not the current
#      canonical.
#   2. roll back: POST .../deployments/<target-id>/rollback. This is the
#      endpoint that swaps the canonical deployment; /promote is a different
#      thing and does NOT roll back.
#   3. revert main: the snapshot commit that is live is reverted on origin/main
#      so the next publish does not immediately put the bad tree back.
#   4. verify: the live site answers again.
#
# Exit code: 0 = rolled back and verified, 1 = failed (the old deployment stays
# live and main is NOT reverted, because a failed rollback must not also lose
# the record of what went wrong).
set -euo pipefail

cd "$(dirname "$0")/.."

ACCOUNT_ID_FALLBACK="dfd1444566cc6b76eda1c8a9fabbb6f9"
REMOTE="${PUBLISH_REMOTE:-origin}"
PROJECT="${ROLLBACK_PROJECT:-devtools-hub}"   # set to devtools-hub-rehearsal to rehearse
BASE="${ROLLBACK_BASE:-https://tools.scoreroute.com}"

say() { printf '%s\n' "$*"; }
die() { printf 'rollback: %s\n' "$*" >&2; exit 1; }

TOKEN="${CLOUDFLARE_API_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f .env ]; then
  TOKEN=$(sed -n 's/^CLOUDFLARE_API_TOKEN=//p' .env | head -1)
fi
[ -n "$TOKEN" ] || die "no CLOUDFLARE_API_TOKEN (env or .env)"

ACCOUNT_ID="${CF_ACCOUNT_ID:-}"
if [ -z "$ACCOUNT_ID" ] && [ -f .env ]; then
  ACCOUNT_ID=$(sed -n 's/^CF_ACCOUNT_ID=//p' .env | head -1)
fi
ACCOUNT_ID="${ACCOUNT_ID:-$ACCOUNT_ID_FALLBACK}"

list_deployments() {
  curl -s --max-time 30 \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT/deployments?env=production&per_page=20" \
    -H "Authorization: Bearer $TOKEN"
}

DEPLOYMENTS=$(list_deployments)

# id | status | trigger type | commit sha | created | is-canonical
parse_deployments() {
  printf '%s' "$DEPLOYMENTS" | CANONICAL="$CANONICAL" python3 -c '
import json, os, sys
d = json.load(sys.stdin).get("result") or []
canon = os.environ.get("CANONICAL", "")
for x in d:
    trig = x.get("deployment_trigger") or {}
    meta = trig.get("metadata") or {}
    print("|".join([
        x.get("id", ""),
        (x.get("latest_stage") or {}).get("status", ""),
        trig.get("type", ""),
        meta.get("commit_hash", "") or (x.get("source") or {}).get("commit_hash", "") or "",
        x.get("created_on", "") or "",
        "canonical" if x.get("id") == canon else "",
    ]))
'
}

# The canonical deployment is NOT the first entry of the deployment list: the
# list is ordered by created_on and does not move when a rollback happens.
# The truth is the project endpoint's canonical_deployment.id. Picking the
# wrong one makes Cloudflare answer 8000039 ("you cannot rollback to the
# deployment that is currently in production").
CANONICAL=$(curl -s --max-time 30 \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT" \
  -H "Authorization: Bearer $TOKEN" | python3 -c '
import json, sys
try:
    r = json.load(sys.stdin).get("result") or {}
except Exception:
    r = {}
print((r.get("canonical_deployment") or {}).get("id", ""))
')
[ -n "$CANONICAL" ] || die "could not read the canonical deployment from the project endpoint"

if [ "${1:-}" = "--list" ]; then
  say "id | status | trigger | commit | created"
  parse_deployments | while IFS='|' read -r id status trig sha created canon; do
    say "$id | $status | $trig | ${sha:0:8} | ${created:0:19} $canon"
  done
  exit 0
fi

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  # Most recent github:push deployment that is not the current canonical.
  TARGET=$(parse_deployments | while IFS='|' read -r id status trig sha created canon; do
    if [ "$id" = "$CANONICAL" ]; then continue; fi
    [ "$status" = "success" ] || continue
    [ "$trig" = "github:push" ] || continue
    echo "$id"
    break
  done)
  [ -n "$TARGET" ] || die "no rollback target found (need a successful github:push deployment that is not the current one)"
fi

say "[rollback] canonical deployment = $CANONICAL"
say "[rollback] target deployment    = $TARGET"

# The commit the rolled-back deployment was built from: its tree is what
# origin/main has to hold again.
LIVE_SHA=""
LIVE_SHA_SHORT=""
while IFS='|' read -r id status trig sha created canon; do
  if [ "$id" = "$TARGET" ]; then
    LIVE_SHA="$sha"
    LIVE_SHA_SHORT="${sha:0:8}"
    break
  fi
done < <(parse_deployments)
[ -n "$LIVE_SHA" ] && git fetch --quiet "$REMOTE" "$LIVE_SHA" 2>/dev/null || true

# ------------------------------------------------------------------ 1. roll ----
RESP=$(curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT/deployments/$TARGET/rollback" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' || true)

if ! printf '%s' "$RESP" | grep -q '"success": *true'; then
  say "$RESP" | head -c 400
  die "rollback failed -- the current deployment is still live and main was NOT reverted"
fi
say "[rollback] canonical switched to $TARGET"

# ------------------------------------------------------------ 2. restore main ----
# The bad snapshot is still the tip of origin/main. If it stays there, the next
# publish starts from the bad tree again.
#
# Under the snapshot chain a plain `git revert` does not work: the snapshot is a
# single commit whose tree is the whole site, and reverting it would produce a
# tree that never existed. What is wanted is simpler -- make origin/main hold
# the same TREE as the deployment we rolled back to, as a fresh commit on top.
# The bad snapshot stays in the history, marked by the message.
#
# Only for the production project: on the rehearsal project this would push a
# rollback commit to the real origin/main.
TARGET_TREE=""
if [ "$PROJECT" = "devtools-hub" ] && [ -n "$LIVE_SHA" ] && git cat-file -e "$LIVE_SHA^{commit}" 2>/dev/null; then
  TARGET_TREE=$(git rev-parse "$LIVE_SHA^{tree}")
fi
if [ "$PROJECT" != "devtools-hub" ]; then
  say "[rollback] rehearsal project: origin/main is left alone"
elif [ -n "$TARGET_TREE" ]; then
  git fetch --quiet "$REMOTE" main || true
  PARENT=$(git rev-parse --verify --quiet "refs/remotes/$REMOTE/main" || echo "")
  MSG="rollback: restore the tree of $LIVE_SHA_SHORT (rolled back to deployment $TARGET)"
  if [ -n "$PARENT" ]; then
    NEW=$(git commit-tree "$TARGET_TREE" -p "$PARENT" -m "$MSG")
  else
    NEW=$(git commit-tree "$TARGET_TREE" -m "$MSG")
  fi
  git push "$REMOTE" "$NEW:refs/heads/main" >/dev/null
  say "[rollback] origin/main now holds the tree of the rolled-back deployment ($TARGET_TREE)"
else
  say "[rollback] could not read the rolled-back tree; origin/main still points at the bad snapshot"
fi

# --------------------------------------------------------------- 3. verify ----
say "[rollback] verifying the live site"
sleep 5
if HEALTH_BASE="$BASE" bash scripts/health-check.sh --quick; then
  say ""
  say "  rolled back to $TARGET"
  say "  live = $BASE"
  exit 0
fi
say ""
say "  the canonical deployment was switched, but the site still does not answer cleanly"
say "  open the issue by hand: the rollback itself did not fix the page"
exit 1
