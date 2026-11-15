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
MSG="publish: snapshot of the deployed tree (local main $(git rev-parse --short HEAD))"

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
    echo "no remote named '$REMOTE'"; exit 1
fi

export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-opencode}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-opencode@local}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

# Where the snapshot goes.
#
# Default: a branch, not main. The snapshot is then opened as a pull request
# (scripts/publish-pr.sh) and merged once the gate list is green, so main is
# never written without the gates having run on that exact tree. That is also
# what makes branch protection possible: "main may only change through a PR
# whose gates check passed" is a rule GitHub can enforce.
#
# PUBLISH_DIRECT=1 pushes straight to main. main is protected, so this only
# works if the protection's admin exemption is momentarily off. For a real
# emergency use scripts/publish-urgent.sh, which turns that exemption on, pushes
# and turns it back off.
BRANCH="${PUBLISH_BRANCH:-publish/snapshot}"
DIRECT="${PUBLISH_DIRECT:-0}"

# The published tree must be the tree that goes LIVE, not the committed HEAD.
#
# The build machine deploys the working tree (wrangler uploads the directory as it is),
# and the deploy gate rewrites files in place while it runs: tool-dates.json,
# sitemap.xml, llms.txt, llms-full.txt and the head metadata of every tool page. So
# "HEAD" and "what is deployed" are two different things, and publishing HEAD would
# publish a tree that differs from production — which, with the auto-deploy workflow
# (push to main -> deploy), rolls the live site back to the last commit.
#
# A temporary index gives the working tree's content without touching the real index
# and without committing anything: .gitignore still decides what is left out (.env,
# node_modules, the root harness scripts).
publish_tree() {
    local idx
    idx="$(mktemp -t publish-index.XXXXXX)"
    rm -f "$idx"                       # git wants the index file to not exist yet
    GIT_INDEX_FILE="$idx" git read-tree HEAD
    GIT_INDEX_FILE="$idx" git add -A
    local tree
    tree="$(GIT_INDEX_FILE="$idx" git write-tree)"
    rm -f "$idx"
    echo "$tree"
}

git fetch --quiet "$REMOTE" main || true
PARENT=$(git rev-parse --verify --quiet "refs/remotes/$REMOTE/main" || echo "")

# Recompute tool-dates.json from the LOCAL full history before snapshotting.
#
# The deploy workflow checks out with fetch-depth 1, so scripts/gen-tool-dates.js there
# has no history to diff and (by design) carries the dates from the committed map
# instead of guessing. The committed map is therefore the only channel through which a
# real body edit reaches the live <lastmod> — it has to be written here, from a checkout
# that still has the history.
#
# BUG-469: sitemap.xml's tool <lastmod> comes from that same map (BUG-375), so the
# sitemap has to be regenerated from it too. Recomputing only the map published a tree
# whose two surfaces disagreed ("the sitemap says 2026-11-10, tool-dates.json says
# 2026-11-11") — the lastmod honesty gate caught it on the published tree.
# Only sitemap.xml is regenerated here: llms.txt / llms-full.txt carry a "Last updated:
# <today>" stamp, and rewriting them on every publish would make the published tree
# change every single day for no content change.
if command -v node >/dev/null 2>&1; then
  node scripts/gen-tool-dates.js
  node scripts/regen-static-fallbacks.js sitemap
else
  echo "WARNING: node not found — tool-dates.json is published as committed" >&2
fi

TREE=$(publish_tree)
if [ -n "$PARENT" ]; then
    NEW=$(git commit-tree "$TREE" -p "$PARENT" -m "$MSG")
else
    NEW=$(git commit-tree "$TREE" -m "$MSG")
fi

if [ "$DIRECT" = "1" ]; then
  git push "$REMOTE" "$NEW:refs/heads/main"
  echo "published $NEW ($(git rev-parse --short HEAD) -> $REMOTE/main)"
else
  # Force: this branch is ours and only ever holds the latest snapshot.
  git push --force "$REMOTE" "$NEW:refs/heads/$BRANCH"
  echo "published $NEW ($(git rev-parse --short HEAD) -> $REMOTE/$BRANCH)"
fi

# The two files regenerated above are build artifacts: the published snapshot holds the
# fresh bytes, but the working tree must go back to what the author had committed, or
# the next publish's "clean tree" check trips over leftovers nobody edited.
git checkout -- tool-dates.json sitemap.xml 2>/dev/null || true
