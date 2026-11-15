#!/bin/bash
# Open (or reuse) a pull request for the published snapshot and merge it once
# the gates are green.
#
# Why this exists: the site is built by Cloudflare Pages straight from
# origin/main, so whatever lands on origin/main goes live. Pushing the snapshot
# straight to main means every publish is an unreviewed write to the live
# branch. Going through a pull request instead means:
#
#   - the gate list runs as a check on the PR (GitHub Actions, job "gates")
#   - the diff of the publish is visible before it goes live
#   - once branch protection requires that check, main cannot be written
#     without it
#
# The snapshot commit is created by scripts/publish-github.sh and is already a
# child of origin/main, so the PR diff is exactly "what changed on the site".
#
# Usage: publish-pr.sh <branch> <head-sha> <title>
#   prints the PR number and the merge result on stdout

set -euo pipefail

BRANCH="${1:?branch name required}"
HEAD_SHA="${2:?head sha required}"
TITLE="${3:-publish: snapshot of the deployed tree}"

REPO="${PUBLISH_REPO:-Evan-MJ/devtools-hub}"
API="https://api.github.com/repos/$REPO"

TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$HOME/.secrets/github-admin-token.txt" ]; then
  TOKEN=$(tr -d '[:space:]' < "$HOME/.secrets/github-admin-token.txt")
fi
[ -n "$TOKEN" ] || { echo "no GITHUB_TOKEN (env or ~/.secrets/github-admin-token.txt)" >&2; exit 1; }

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s --max-time 60 -X "$method" "$API$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/json" \
      -d "$body"
  else
    curl -s --max-time 60 -X "$method" "$API$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json"
  fi
}

# --- 1. find an open PR for this branch, or open one -------------------------
# The head filter is `owner:branch`, NOT `owner/repo:branch`. With the repo in it
# GitHub answers 200 with an empty list, so this always looked like "no open PR",
# the script POSTed a new one and died on "A pull request already exists" — which
# broke the documented "re-running publish.sh reuses the same PR" path.
PR=$(api GET "/pulls?state=open&head=${REPO%%/*}:$BRANCH" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d[0]["number"] if isinstance(d, list) and d else "")
')

if [ -z "$PR" ]; then
  PR=$(api POST "/pulls" "$(python3 - "$TITLE" "$BRANCH" "$HEAD_SHA" <<'PY'
import json, sys
title, branch, sha = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
    "title": title,
    "head": branch,
    "base": "main",
    "body": "Automated publish: the tree that is going live.\n\n"
            "The gate list runs on this PR; the merge happens only when it is green.",
}))
PY
)" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d.get("number", "") if "number" in d else "")
')
  [ -n "$PR" ] || { echo "could not open the pull request" >&2; exit 1; }
  echo "opened PR #$PR for $BRANCH"
else
  echo "reusing PR #$PR for $BRANCH"
fi

# --- 2. wait for the gate check ---------------------------------------------
# The required check is the "gates" job of .github/workflows/gates.yml. It has
# to have RUN on this head commit: a check that never ran is not a pass.
WAIT_SECONDS="${PUBLISH_PR_WAIT:-900}"
DEADLINE=$(( $(date +%s) + WAIT_SECONDS ))
STATE=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  STATE=$(api GET "/commits/$HEAD_SHA/check-runs" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("pending"); raise SystemExit
runs = [c for c in d.get("check_runs", []) if c.get("name") == "gates"]
if not runs:
    print("pending"); raise SystemExit
r = runs[0]
print(r.get("status") or "pending")
')
  if [ "$STATE" = "completed" ]; then
    CONCLUSION=$(api GET "/commits/$HEAD_SHA/check-runs" | python3 -c '
import json, sys
d = json.load(sys.stdin)
runs = [c for c in d.get("check_runs", []) if c.get("name") == "gates"]
print((runs[0].get("conclusion") or "") if runs else "")
')
    if [ "$CONCLUSION" = "success" ]; then
      echo "gates: success"
      break
    fi
    echo "gates: $CONCLUSION" >&2
    exit 1
  fi
  sleep 15
done

if [ "$STATE" != "completed" ]; then
  echo "the gates check did not finish within ${WAIT_SECONDS}s" >&2
  exit 1
fi

# --- 3. merge ----------------------------------------------------------------
# The merge method is squash: origin/main is a chain of snapshots, and a squash
# keeps one commit per publish so the history stays readable.
RESULT=$(api PUT "/pulls/$PR/merge" "$(python3 -c '
import json
print(json.dumps({"merge_method": "squash", "commit_title": "publish: snapshot of the deployed tree"}))
')")
echo "$RESULT" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if d.get("merged"):
    print("MERGED " + d.get("sha", ""))
elif d.get("message"):
    print("NOT-MERGED " + d["message"])
else:
    print("NOT-MERGED " + json.dumps(d))
'
echo "$RESULT" | grep -q '"merged": *true' || exit 1
echo "PR #$PR merged"
