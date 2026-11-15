#!/bin/bash
# Build the site into dist/ — the exact asset set that goes on the wire.
#
# This is the build step of the Cloudflare Pages Git integration:
#
#   GitHub (Evan-MJ/devtools-hub, main)
#     -> Cloudflare Pages build: `npm ci --omit=dev && bash scripts/build.sh`
#     -> uploads dist/ as the static assets, compiles functions/ from the repo root
#
# It never deploys and never touches the network. Every gate below exits non-zero
# on failure, and a non-zero build command means Cloudflare keeps the previous
# deployment live — so a broken build can never reach production.
#
# Usage: bash scripts/build.sh
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[build] Regenerating tool-dates.json from authored/git evidence..."
node scripts/gen-tool-dates.js

# The three static fallbacks (sitemap.xml / llms.txt / llms-full.txt) are served
# when a Function cannot answer. They are regenerated from the real Functions on
# every build so they can never describe half the site.
echo "[build] Regenerating static fallbacks (sitemap.xml / llms.txt / llms-full.txt)..."
node scripts/regen-static-fallbacks.js

# The manifest-derived head metadata inside every tool page file, using the real
# Function as the oracle. Idempotent; exits non-zero if a page still differs.
echo "[build] Regenerating the manifest-derived head metadata in every tool page..."
node scripts/gen-tool-meta.js

# .well-known/agent-skills/index.json + .well-known/mcp/server-card.json are
# generated from manifest.txt (the single source of truth).
echo "[build] Regenerating .well-known AI-discovery surfaces..."
bash scripts/regen-agent-skills.sh

# ------------------------------------------------------------------- gates ----
# The gates scan the working tree, which is what both publish paths upload:
# the Git path uploads dist/ (built from this tree below), the emergency direct
# path uploads the tree itself. dist/ is excluded so the build does not scan
# its own previous output.

# Live Cloudflare token in the upload set. BUG-301: .gitignore does not stop
# the upload, only redaction before the upload does.
# BUG-545: the pattern only matched the `cfat_` (scoped) prefix. The token in
# use since 2026-11-15 is a `cfut_` (user) token, so a leaked one sailed
# straight through this gate. Match both prefixes.
LEAKED=$(grep -rlE '(cfat|cfut)_[A-Za-z0-9_-]{20,}|CLOUDFLARE_API_TOKEN="[A-Za-z0-9_-]{20,}"' . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.wrangler \
  --exclude-dir=test-results --exclude-dir=test-scripts --exclude-dir=dist 2>/dev/null | grep -v '^\./\.env$' || true)
if [ -n "$LEAKED" ]; then
  echo "[build] ERROR: refusing to build, these files contain a live token:"
  echo "$LEAKED" | sed 's/^/    /'
  exit 1
fi
echo "[build] no live token in the upload set"

# A *.example / *.template / *.sample / *.dist file is a TEMPLATE, so every
# value in it must be EMPTY (or an obvious placeholder). BUG-425: six live
# third-party keys shipped inside .dev.vars.example that way.
TEMPLATE_LEAK=$(find . -path ./node_modules -prune -o -path ./.git -prune -o -path ./.wrangler -prune -o \
  -path ./dist -prune -o \
  \( -name '*.example' -o -name '*.template' -o -name '*.sample' -o -name '*.dist' \) -type f -print 2>/dev/null \
  | while read -r f; do
    awk -v file="$f" '
      /^[[:space:]]*#/ { next }
      {
        line = $0
        sub(/^[[:space:]]*(export[[:space:]]+)?/, "", line)
        # No {n,} interval here: mawk (the awk on the Cloudflare build image)
        # does not implement interval expressions, so the name check silently
        # never matched there and the whole template-secret rule was vacuous.
        # [A-Z][A-Z0-9_][A-Z0-9_]+ is the same shape (a name of 3+ chars).
        if (line !~ /^[A-Z][A-Z0-9_][A-Z0-9_]+[[:space:]]*=/) next
        sub(/^[^=]*=[[:space:]]*/, "", line)
        gsub(/[[:space:]"'"'"']+$/, "", line)
        if (line == "") next
        if (line ~ /^<.*>$/) next                 # "<your-token-here>"
        if (tolower(line) ~ /(your|placeholder|changeme|example|xxx)/) next
        print file ": " $0
      }' "$f"
    done || true)
if [ -n "$TEMPLATE_LEAK" ]; then
  echo "[build] ERROR: refusing to build, these template files have NON-EMPTY values:"
  echo "$TEMPLATE_LEAK" | sed 's/^/    /'
  echo "[build]   a template file must ship with every value EMPTY (BUG-425)"
  exit 1
fi
echo "[build] no template file carries a live value"

# manifest.txt is the tool source of truth; HTML entities in it ship literally.
if grep -qE '&amp;|&lt;|&gt;|&quot;' manifest.txt; then
  echo "[build] ERROR: refusing to build, manifest.txt contains HTML entities."
  grep -nE '&amp;|&lt;|&gt;|&quot;' manifest.txt | sed 's/^/    /'
  exit 1
fi
echo "[build] manifest.txt entity check OK"

# A static HTML page cannot know the tool count, and hardcoded counts on 139
# pages contradicted each other. Wording that cannot be wrong replaces the number.
STALE_COUNT=$(grep -rnE '\b[0-9]{2,3}\+?[[:space:]]+free[[:space:]]+(online[[:space:]]+)?(developer[[:space:]]+)?tools' \
  --include='*.html' . --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null || true)
if [ -n "$STALE_COUNT" ]; then
  echo "[build] FAIL: static HTML hardcodes a tool count"
  echo "$STALE_COUNT" | head -20 | sed 's/^/    /'
  exit 1
fi
echo "[build] no hardcoded tool count in static HTML"

# The gate list in scripts/gates.json is the SAME list the GitHub Actions job
# (.github/workflows/gates.yml) runs. One list, two runners: CI cannot be green
# about a gate that the build would fail on, and the build cannot fail on a gate
# nobody checks. scripts/verify-gates.js also refuses to run the list if a gate
# file was edited without re-stamping the manifest.
#
# A non-zero exit here stops the build, and a stopped build means Cloudflare
# keeps the previous deployment live.
echo "[build] Running the gate list from scripts/gates.json..."
node scripts/verify-gates.js

# ---------------------------------------------------------------- asset set ----
# dist/ is the upload set of the Git path: the working tree minus the things
# that must never be published:
#   functions/  -> compiled by Pages as Functions, never a static asset
#   dist/       -> this build's own output
#   .git .wrangler node_modules .env .dev.vars -> never published
#   the test harness -> same list as the old direct-upload gate
echo "[build] Assembling dist/ ..."
rm -rf dist
mkdir -p dist
tar -cf - \
  --exclude=./.git --exclude=./.wrangler --exclude=./node_modules \
  --exclude=./functions --exclude=./dist \
  --exclude=./.env --exclude=./.dev.vars \
  . | tar -xf - -C dist

# The harness (BUG-309 / BUG-482 / BUG-484 / BUG-487): 68+ root-level test
# scripts, the tracked test-scripts/ directory and the test-results/ artifacts
# were all published with HTTP 200. Crawl-budget waste, and /api/test was an
# unauthenticated route. They stay in the repo (the gates need them) and stay
# out of dist/.
rm -rf dist/test-scripts dist/test-results
rm -f dist/test-*.js dist/test-*.html dist/test-*.txt \
      dist/*-playwright-test.js dist/*-local-test.js dist/*-prod-test.js \
      dist/*-gate.js dist/tools-auto-test.js

# The autonomous-signup helpers are operator tooling (mailbox IMAP/SMTP, Playwright
# signup). They live under tools/ but are not tools: they are not in manifest.txt,
# they carry the mailbox address, and they read the local credential store. They
# stayed in the repo because the operator still uses them; they must not ship.
rm -rf dist/tools/_autonomous-resources

# src/ is the source of a SEPARATE Worker (devtools-hub-api-proxy) that is deployed
# on its own; it is not a page of this site. squirrel.toml is the crawler's local
# config, README.md is the repository readme. None of them is site content — they
# shipped only because the upload set is the working tree.
rm -rf dist/src
rm -f dist/squirrel.toml dist/README.md dist/wrangler.worker.toml

# ------------------------------------------------------------- assertions ----
# The build succeeded but the site is broken is the failure mode that hurts, so
# the shapes that matter are asserted here instead of being noticed by a visitor.
for f in index.html sitemap.xml llms.txt llms-full.txt tool-dates.json robots.txt manifest.txt \
         .well-known/agent-skills/index.json .well-known/mcp/server-card.json; do
  if [ ! -s "dist/$f" ]; then
    echo "[build] FAIL: dist/$f is missing or empty"
    exit 1
  fi
done

MANIFEST_TOOLS=$(grep -cE '^[a-z0-9-]+\|' dist/manifest.txt | tr -d ' ')
BUILT_TOOLS=$(find dist/tools -mindepth 2 -maxdepth 2 -name index.html 2>/dev/null | wc -l | tr -d ' ')
if [ "$MANIFEST_TOOLS" != "$BUILT_TOOLS" ]; then
  echo "[build] FAIL: manifest.txt lists $MANIFEST_TOOLS tools but dist/ has $BUILT_TOOLS tool pages"
  exit 1
fi

# The Function source must still be at the repo root — Pages compiles it there,
# it is not a static asset.
if [ ! -d functions ] || [ ! -f functions/_middleware.js ]; then
  echo "[build] FAIL: functions/ is missing at the repo root — Pages would deploy without the Functions"
  exit 1
fi

echo "[build] OK: $(find dist -type f | wc -l | tr -d ' ') files, $BUILT_TOOLS tools"
