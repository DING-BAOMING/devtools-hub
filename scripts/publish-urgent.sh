#!/bin/bash
# Emergency channel: change the live site WITHOUT waiting for the CI gates.
#
# When this is the right thing: the live site is broken and the fix cannot
# wait for a CI run (a gate is red for a reason that has nothing to do with
# the fix, or the runner is down, or the tree that is broken is the tree the
# gates are failing on).
#
# What it does, in order:
#   1. turns the branch protection's admin exemption ON, so the owner account
#      may write to main even though the required check has not passed
#   2. pushes the given commit to main
#   3. turns the admin exemption back OFF, whatever happened in step 2
#
# Step 3 runs even when step 2 fails, because a protection rule left open is
# worse than a publish that did not happen.
#
# The protection rule itself stays on the whole time: the required check
# ("gates") is still required, force pushes are still forbidden, and the
# branch still cannot be deleted. Only the admin exemption is toggled, and
# only for the seconds the push takes.
#
# If even this is not enough (the tree is so broken that a build cannot
# succeed), the other emergency path is scripts/rollback.sh: it asks
# Cloudflare to serve a previous good deployment and never touches GitHub.
#
# Usage: bash scripts/publish-urgent.sh <commit-sha>
#   the commit to push (must already exist in the local repo)

set -euo pipefail

SHA="${1:?commit sha required}"
REPO="${PUBLISH_REPO:-Evan-MJ/devtools-hub}"
API="https://api.github.com/repos/$REPO"
REMOTE="${PUBLISH_REMOTE:-origin}"

TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$HOME/.secrets/github-admin-token.txt" ]; then
  TOKEN=$(tr -d '[:space:]' < "$HOME/.secrets/github-admin-token.txt")
fi
[ -n "$TOKEN" ] || { echo "no GITHUB_TOKEN (env or ~/.secrets/github-admin-token.txt)" >&2; exit 1; }

git cat-file -e "$SHA^{commit}" 2>/dev/null || { echo "no such commit: $SHA" >&2; exit 1; }

protection() {
  local enforce="$1"
  curl -s --max-time 60 -X PUT "$API/branches/main/protection" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json" \
    -d "{
      \"required_status_checks\": {\"strict\": false, \"contexts\": [\"gates\"]},
      \"enforce_admins\": $enforce,
      \"required_pull_request_reviews\": null,
      \"restrictions\": null,
      \"required_linear_history\": false,
      \"allow_force_pushes\": false,
      \"allow_deletions\": false,
      \"required_conversation_resolution\": false,
      \"block_creations\": false,
      \"lock_branch\": false,
      \"allow_fork_syncing\": true
    }"
}

restore() {
  echo "[urgent] putting the admin exemption back off"
  protection true >/dev/null || echo "[urgent] WARNING: could not restore the protection rule -- fix it by hand" >&2
}
trap restore EXIT

echo "[urgent] opening the admin exemption"
protection false >/dev/null

echo "[urgent] pushing $SHA to $REMOTE/main"
git push "$REMOTE" "$SHA:refs/heads/main"

echo "[urgent] done -- $SHA is on main, the protection rule is being restored"
