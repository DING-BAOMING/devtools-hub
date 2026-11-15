#!/bin/bash
# EMERGENCY direct upload. The normal publish path is:
#
#   bash scripts/publish-github.sh origin   -> pushes the tree to GitHub
#   Cloudflare Pages (Git integration)       -> builds and deploys it
#
# Use this only when the Git path is broken and the site has to go live NOW.
# It uploads the repository root (so Pages picks up functions/ as Functions) and
# therefore skips dist/; the file set is the same one scripts/build.sh gates.
#
# Usage: bash scripts/pre-deploy.sh
# Requires: CLOUDFLARE_API_TOKEN in shell env (sourced from .env or ~/.bashrc)

set -euo pipefail

cd "$(dirname "$0")/.."

# Source .env if CLOUDFLARE_API_TOKEN not already in environment
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -f .env ]; then
  set -a; source .env; set +a
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "[pre-deploy] ERROR: CLOUDFLARE_API_TOKEN not set. Source .env first."
  exit 1
fi

# Replace .env with a redacted placeholder (the real .env stays parked outside
# the deploy root).
#
# BUG-301 (2026-10-01): the backup used to be .env.tmp INSIDE the deploy root, so
# wrangler uploaded the real token as /.env.tmp and leaked it. The backup must
# live outside the project dir.
if [ -f .env ]; then
  BACKUP="$(mktemp -t cf-env-backup.XXXXXX)"
  mv .env "$BACKUP"
  cat > .env <<'EOF'
# REDACTED — real CLOUDFLARE_API_TOKEN only in this developer's local shell.
# See scripts/pre-deploy.sh for the deploy-safe pattern.
EOF
  restore_env() { [ -f "$BACKUP" ] && mv "$BACKUP" .env; }
  trap restore_env EXIT
  echo "[pre-deploy] .env redacted; real token parked at $BACKUP (outside the deploy root)"
fi

# Move the Playwright harness out of the deploy root.
#
# BUG-309 (2026-10-05): `.gitignore` has listed `test-*.js` for months, and 68 of
# those scripts were being served in production with HTTP 200. `.gitignore` does
# not stop wrangler (same root cause as BUG-301), so the files shipped.
#
# BUG-360: functions/tools/__bug360-baseline.js is the pre-fix copy of the tool-page
# Function that the CPU gate imports to prove the fix is behaviour-preserving. It
# must stay in the project but must never deploy.
#
# BUG-482: the park list only covered harness scripts in the repo ROOT, so the
# tracked `test-scripts/` directory still shipped with HTTP 200.
#
# BUG-484: `functions/api/test-models.js` is gitignored but was uploaded by every
# LOCAL wrangler deploy, and it was live at /api/test-models — an unauthenticated
# endpoint that spends the site's own AI keys on request.
#
# BUG-487: the remaining test artifacts (test-deploy.txt, test-csp-page.html,
# test-results/) shipped with HTTP 200 too. Park them as well.
HARNESS=$(mktemp -d -t cf-harness-backup.XXXXXX)
# tools/_autonomous-resources is operator tooling (mailbox + signup automation), not a
# tool: it carries the mailbox address and reads the local credential store. It stays in
# the repo; it must not be published.
HARNESS_FILES=$(ls test-*.js test-*.html test-*.txt *-playwright-test.js *-local-test.js *-prod-test.js *-gate.js tools-auto-test.js functions/api/test.js functions/api/test-*.js functions/tools/__bug360-baseline.js 2>/dev/null; find test-scripts test-results tools/_autonomous-resources -type f 2>/dev/null || true)
if [ -n "$HARNESS_FILES" ]; then
  HARNESS_COUNT=$(echo "$HARNESS_FILES" | wc -l | tr -d ' ')
  # Preserve each file's relative path inside the park dir (`mv` alone would
  # flatten a nested path and the restore would drop the file).
  for f in $HARNESS_FILES; do
    [ -f "$f" ] || continue
    mkdir -p "$HARNESS/$(dirname "$f")"
    mv "$f" "$HARNESS/$f"
  done
  restore_harness() {
    for f in $HARNESS_FILES; do
      [ -f "$HARNESS/$f" ] && mkdir -p "$(dirname "$f")" && mv "$HARNESS/$f" "$f"
    done
    rm -rf "$HARNESS" 2>/dev/null || true
  }
  if [ -n "${BASH_VERSION:-}" ] && declare -f restore_env >/dev/null 2>&1; then
    trap 'restore_harness; restore_env' EXIT
  else
    trap restore_harness EXIT
  fi
  echo "[pre-deploy] $HARNESS_COUNT test-harness scripts parked at $HARNESS (outside the deploy root)"
else
  rmdir "$HARNESS" 2>/dev/null || true
fi

# Regenerate everything and run every gate — the same build the Git path runs.
echo "[pre-deploy] Building..."
bash scripts/build.sh

# dist/ is the output of the Git path; this path uploads the tree itself.
rm -rf dist

echo "[pre-deploy] Deploying..."
# NOT exec: the EXIT trap has to run so .env and the harness come back.
npx wrangler pages deploy . --project-name devtools-hub --branch main --skip-caching --commit-dirty=true
