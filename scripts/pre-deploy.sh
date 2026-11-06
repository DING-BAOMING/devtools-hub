#!/bin/bash
# Pre-deploy hook: redact sensitive files before wrangler uploads them.
# Usage: ./scripts/pre-deploy.sh
# Requires: CLOUDFLARE_API_TOKEN in shell env (sourced from .env or ~/.bashrc)

set -e

cd "$(dirname "$0")/.."

echo "[pre-deploy] Stripping sensitive files from working tree..."

# Source .env if CLOUDFLARE_API_TOKEN not already in environment
if [ -z "$CLOUDFLARE_API_TOKEN" ] && [ -f .env ]; then
  set -a; source .env; set +a
fi

# Verify CLOUDFLARE_API_TOKEN is available BEFORE stripping
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "[pre-deploy] ERROR: CLOUDFLARE_API_TOKEN not set. Source .env first."
  exit 1
fi

# Replace .env with redacted placeholder (real .env stays in cwd but isn't deployed)
#
# BUG-301 (2026-10-01): the backup used to be .env.tmp INSIDE the deploy root, so
# wrangler uploaded the real token as /.env.tmp and leaked it while the /.env rule
# in _redirects kept looking fine. The backup must live outside the project dir.
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

# BUG-375: regenerate /tool-dates.json (real per-tool last-edit dates) so the deploy never
# carries a stale map. Linux mtime is sync noise here (not tracked), so this is evidence-based
# (authored JSON-LD date > git commit date); runs again on every deploy.
echo "[pre-deploy] Regenerating tool-dates.json from authored/git evidence..."
node scripts/gen-tool-dates.js

# Regenerate the three static fallbacks (sitemap.xml / llms.txt / llms-full.txt) from the
# real Functions on every deploy. They previously refreshed only by hand and sat at
# 2026-07-22 / 2026-10-01 while the site grew 208 → 357 tools — a broken Function deploy
# would have fallen back to a catalog covering half the site. Same mechanism as
# tool-dates.json: evidence-based regen, exits non-zero on any incomplete output.
echo "[pre-deploy] Regenerating static fallbacks (sitemap.xml / llms.txt / llms-full.txt) from the real Functions..."
node scripts/regen-static-fallbacks.js

# BUG-448: rewrite the manifest-derived head metadata inside every tool page file, using the
# real Function as the oracle. The Function overwrites those tags on every request, so the
# served bytes were never wrong — but nothing kept the FILE copies in step, and 358 of the
# 371 pages had drifted (visible in the repo and in the public GitHub mirror). Idempotent;
# exits non-zero if any page still differs after the rewrite.
echo "[pre-deploy] Regenerating the manifest-derived head metadata in every tool page..."
node scripts/gen-tool-meta.js

# Content check, not a filename check. .env.example is committed on purpose and
# must keep deploying; .env.backup held the same live token as .env and shipped it
# for weeks because .gitignore does not stop wrangler. Grep the upload set itself.
LEAKED=$(grep -rlE 'cfat_[A-Za-z0-9_-]{20,}|CLOUDFLARE_API_TOKEN="[A-Za-z0-9_-]{20,}"' . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.wrangler \
  --exclude-dir=test-results --exclude-dir=test-scripts 2>/dev/null | grep -v '^\./\.env$' || true)
if [ -n "$LEAKED" ]; then
  echo "[pre-deploy] ERROR: refusing to deploy, these files contain a live token:"
  echo "$LEAKED" | sed 's/^/    /'
  exit 1
fi
echo "[pre-deploy] no live token found in the upload set"

# BUG-425 (2026-11-04): the check above only knows the Cloudflare token's shape. The site
# also uses ~20 third-party API keys (17TRACK, Juhe, API-Football, Groq, ...), and
# `.dev.vars.example` — the template developers copy to `.dev.vars` — shipped SIX of them
# with live values: the file was published at https://tools.scoreroute.com/.dev.vars.example
# and the 17TRACK key was accepted by the vendor's live API.
#
# The rule that was missing is a shape, not a vendor list: a `*.example` / `*.template`
# file is a TEMPLATE, so every value in it must be EMPTY (or an obvious placeholder such
# as "<your-token-here>"). Any other value is a leak by definition, whatever the vendor.
# That check cannot go stale when a new API key is added.
#
# ponytail: one awk pass over the candidate files, no per-vendor pattern list.
TEMPLATE_LEAK=$(find . -path ./node_modules -prune -o -path ./.git -prune -o -path ./.wrangler -prune -o \
  \( -name '*.example' -o -name '*.template' -o -name '*.sample' -o -name '*.dist' \) -type f -print 2>/dev/null \
  | while read -r f; do
    awk -v file="$f" '
      /^[[:space:]]*#/ { next }
      {
        line = $0
        sub(/^[[:space:]]*(export[[:space:]]+)?/, "", line)
        if (line !~ /^[A-Z][A-Z0-9_]{2,}[[:space:]]*=/) next
        sub(/^[^=]*=[[:space:]]*/, "", line)
        gsub(/[[:space:]"'"'"']+$/, "", line)
        if (line == "") next
        if (line ~ /^<.*>$/) next                 # "<your-token-here>"
        if (tolower(line) ~ /(your|placeholder|changeme|example|xxx)/) next
        print file ": " $0
      }' "$f"
    done || true)
if [ -n "$TEMPLATE_LEAK" ]; then
  echo "[pre-deploy] ERROR: refusing to deploy, these template files have NON-EMPTY values:"
  echo "$TEMPLATE_LEAK" | sed 's/^/    /'
  echo "[pre-deploy]   a template file must ship with every value EMPTY (BUG-425)"
  exit 1
fi
echo "[pre-deploy] no template file carries a live value"

# Move the Playwright harness out of the deploy root.
#
# BUG-309 (2026-10-05): `.gitignore` has listed `test-*.js` for months, and 68 of
# those scripts were being served in production as https://tools.scoreroute.com/test-*.js
# with HTTP 200. `.gitignore` does not stop wrangler (same root cause as BUG-301), so
# the files shipped. No token was in them, but every one is crawlable junk: a search
# engine indexing 68 near-duplicate .js documents on a tool site is a scaled-content
# signal and pure crawl-budget waste.
#
# Fixed at the deploy gate rather than in functions/_middleware.js on purpose: the
# middleware guard uses an explicit name set because a *pattern* there would also 404
# real paths, and 68 explicit names is worse than deleting the files. Same mechanism
# as .env above — park them outside the project, restore on exit.
HARNESS=$(mktemp -d -t cf-harness-backup.XXXXXX)
# BUG-360: functions/tools/__bug360-baseline.js is the pre-fix copy of the tool-page Function that
# test-scripts/bug360-tool-cpu-gate.js imports to prove the CPU fix is byte-for-byte behaviour
# preserving. It must stay in the project (its `../../libs/*.js` imports only resolve at that
# depth) but must never deploy: it would add 187 KB of dead code AND create a public route at
# /tools/__bug360-baseline. Same park-and-restore mechanism as the harness scripts.
HARNESS_FILES=$(ls test-*.js *-playwright-test.js *-local-test.js *-prod-test.js tools-auto-test.js functions/tools/__bug360-baseline.js 2>/dev/null || true)
if [ -n "$HARNESS_FILES" ]; then
  HARNESS_COUNT=$(echo "$HARNESS_FILES" | wc -l | tr -d ' ')
  # Preserve each file's relative path inside the park dir. `mv "$f" "$HARNESS/"` flattens a
  # nested path (`functions/tools/__bug360-baseline.js` -> `$HARNESS/__bug360-baseline.js`), and
  # the restore then looks for `$HARNESS/functions/tools/...`, never finds it, and silently drops
  # the file. That is why BUG-361 found the CPU gate's baseline missing from the working tree:
  # every deploy parked it and never restored it.
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
  # chain onto any trap already set by the .env block rather than replacing it
  if [ -n "${BASH_VERSION:-}" ] && declare -f restore_env >/dev/null 2>&1; then
    trap 'restore_harness; restore_env' EXIT
  else
    trap restore_harness EXIT
  fi
  echo "[pre-deploy] $HARNESS_COUNT test-harness scripts parked at $HARNESS (outside the deploy root)"
else
  rmdir "$HARNESS" 2>/dev/null || true
fi

# Manifest hygiene (BUG-131 / BUG-297 re-struck): HTML entities in manifest.txt
# ship as literal "&amp;" to users and to the SERP because consumers esc() once.
if grep -qE '&amp;|&lt;|&gt;|&quot;' manifest.txt; then
  echo "[pre-deploy] ERROR: refusing to deploy, manifest.txt contains HTML entities."
  echo "[pre-deploy]        Use a literal & < > — see MANIFEST-SOURCE-OF-TRUTH.md L46-52."
  grep -nE '&amp;|&lt;|&gt;|&quot;' manifest.txt | sed 's/^/    /'
  exit 1
fi
echo "[pre-deploy] manifest.txt entity check OK"

# A static HTML page cannot know the tool count. Every page that shipped one
# was wrong the moment the next tool landed: 139 pages carried 27 different
# values (89, 225, 242, 314, "100+", ...) against a real 337. Contradictory
# counts across the same site are exactly the "unreliable content" signal
# Google's spam policies describe, and it drifts silently forever.
# Wording that cannot be wrong replaces the number; this gate keeps it out.
STALE_COUNT=$(grep -rnE '\b[0-9]{2,3}\+?[[:space:]]+free[[:space:]]+(online[[:space:]]+)?(developer[[:space:]]+)?tools' \
  --include='*.html' . 2>/dev/null | grep -v node_modules || true)
if [ -n "$STALE_COUNT" ]; then
  echo "[pre-deploy] FAIL: static HTML hardcodes a tool count"
  echo "$STALE_COUNT" | head -20 | sed 's/^/    /'
  echo "[pre-deploy]        Say 'hundreds of free browser-based developer tools' instead."
  exit 1
fi
echo "[pre-deploy] no hardcoded tool count in static HTML"

# Regenerate .well-known/agent-skills/index.json + .well-known/mcp/server-card.json from
# manifest.txt so the AI-discovery surfaces stay in sync with the source of truth.
# (These used to be hand-maintained static files with tool_count: 135 while the real
# count was 333 — a static-vs-manifest drift that /llms.txt advertised as the
# "machine-readable tool catalog" to every AI agent.)
if [ -f scripts/regen-agent-skills.sh ]; then
  bash scripts/regen-agent-skills.sh
fi

echo "[pre-deploy] Deploying..."
set +e
npx wrangler pages deploy . --project-name devtools-hub --branch main --skip-caching --commit-dirty=true
EXIT_CODE=$?
set -e

exit $EXIT_CODE
