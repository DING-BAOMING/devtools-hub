#!/bin/bash
# Read-only health check of the live site.
#
# It only ever GETs. It never writes, never deploys, never touches a secret.
#
#   bash scripts/health-check.sh            (full: every URL in the sitemap)
#   bash scripts/health-check.sh --quick    (a small set of key URLs only)
#
# Rules that keep it from being a problem itself:
#
#   - it hits the PRODUCTION domain only (never a preview alias: an alias is a
#     separate deployment, so a green alias says nothing about production)
#   - URLs that must answer 200 are fetched with a ?cb=<random> so the edge
#     cache cannot hide a broken page behind a cached copy
#   - URLs that must answer 404 are fetched WITHOUT ?cb=, because the point is
#     to let the edge answer from cache (the 404 is already decided upstream)
#   - one failure is not a failure: the same URL is retried once, and only two
#     failures in a row count as red
#
# Exit code: 0 = green, 1 = red.
set -uo pipefail

BASE="${HEALTH_BASE:-https://tools.scoreroute.com}"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

PASS=0
FAIL=0
FAILED_URLS=()

# A URL that has to be there.
check_200() {
  local url="$1" code="" attempt
  for attempt in 1 2; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${url}?cb=$RANDOM$RANDOM" || echo 000)
    [ "$code" = "200" ] && break
  done
  if [ "$code" = "200" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED_URLS+=("$url -> $code")
    echo "  RED  $url -> $code"
  fi
}

# A URL that must NOT be there.
check_404() {
  local url="$1" code="" attempt
  for attempt in 1 2; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$url" || echo 000)
    [ "$code" = "404" ] && break
  done
  if [ "$code" = "404" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED_URLS+=("$url -> $code (expected 404)")
    echo "  RED  $url -> $code (expected 404)"
  fi
}

echo "[health] base = $BASE"

echo "[health] key pages"
check_200 "$BASE/"
check_200 "$BASE/sitemap.xml"
check_200 "$BASE/robots.txt"
check_200 "$BASE/manifest.txt"
check_200 "$BASE/llms.txt"
check_200 "$BASE/llms-full.txt"
check_200 "$BASE/about/"
check_200 "$BASE/privacy/"
check_200 "$BASE/tools/"
check_200 "$BASE/tools/feedback/"

echo "[health] key APIs"
check_200 "$BASE/api/tools"

if [ "$QUICK" = "1" ]; then
  echo "[health] quick mode: skipping the per-tool sweep"
else
  echo "[health] every tool page (from the live sitemap)"
  SITEMAP=$(curl -s --max-time 60 "$BASE/sitemap.xml?cb=$RANDOM" || echo "")
  URLS=$(printf '%s' "$SITEMAP" | grep -oE '<loc>[^<]+</loc>' | sed 's|</\?loc>||g')
  if [ -z "$URLS" ]; then
    FAIL=$((FAIL + 1))
    FAILED_URLS+=("sitemap.xml -> could not be read")
    echo "  RED  could not read the sitemap; the tool sweep was skipped"
  else
    COUNT=0
    while IFS= read -r u; do
      [ -z "$u" ] && continue
      COUNT=$((COUNT + 1))
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${u}?cb=$RANDOM$RANDOM" || echo 000)
      if [ "$code" != "200" ]; then
        # one retry before it counts
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${u}?cb=$RANDOM$RANDOM" || echo 000)
      fi
      if [ "$code" = "200" ]; then
        PASS=$((PASS + 1))
      else
        FAIL=$((FAIL + 1))
        FAILED_URLS+=("$u -> $code")
        echo "  RED  $u -> $code"
      fi
    done <<< "$URLS"
    echo "[health] $COUNT URLs from the sitemap"
  fi
fi

echo "[health] paths that must stay shut"
check_404 "$BASE/api/test"
check_404 "$BASE/.env"
check_404 "$BASE/scripts/"
check_404 "$BASE/libs/"

echo ""
echo "[health] $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "[health] red URLs:"
  for u in "${FAILED_URLS[@]}"; do echo "    $u"; done
  exit 1
fi
exit 0
