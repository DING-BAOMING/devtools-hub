#!/bin/bash
# Publish the current local main as a content snapshot to the GitHub mirror.
#
# Why a snapshot and not a normal push: the local history still contains the
# old `.dev.vars.example` with six live third-party keys (that is what
# GitHub's secret-scanning push protection rejects). Rewriting that history
# would rewrite other people's commits, so instead we publish the *tree* of
# local main as a fresh commit on top of whatever the mirror already has.
#
# The result: GitHub holds the current source of the live site (and, because
# the mirror is a public repository, its GitHub Actions minutes are free and
# unlimited), while the full history stays local where it belongs.
#
# Usage: ./scripts/publish-github.sh [remote-name]     (default: mirror)

set -euo pipefail

REMOTE="${1:-mirror}"
MSG="publish: snapshot of local main $(git rev-parse --short HEAD)"

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
    echo "no remote named '$REMOTE'"; exit 1
fi

export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-opencode}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-opencode@local}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

git fetch --quiet "$REMOTE" main || true
PARENT=$(git rev-parse --verify --quiet "refs/remotes/$REMOTE/main" || echo "")

TREE=$(git rev-parse HEAD^{tree})
if [ -n "$PARENT" ]; then
    NEW=$(git commit-tree "$TREE" -p "$PARENT" -m "$MSG")
else
    NEW=$(git commit-tree "$TREE" -m "$MSG")
fi

git push "$REMOTE" "$NEW:refs/heads/main"
echo "published $NEW ($(git rev-parse --short HEAD) -> $REMOTE/main)"
