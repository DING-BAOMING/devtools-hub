#!/bin/bash
# IndexNow submission for DevTools Hub.
#
# Default mode is INCREMENTAL: it submits only the URLs that are not in the state
# file, then records them. That is what Bing asks for — its Webmaster Guidelines
# say "Avoid batch submissions when possible. Streaming submissions provide
# faster updates, reduce server load, and improve indexing accuracy."
# Re-pinging all 356 URLs on every deploy turns the freshness signal into noise.
#
#   ./indexnow-submit.sh          incremental (added/changed URLs only)
#   ./indexnow-submit.sh --all    force a full re-submission (first run, or
#                                 after rebuilding the sitemap from scratch)
#
# State file lives in devtools-hub-docs/ so it is never uploaded by wrangler
# (.gitignore does not stop an upload — see BUG-301/BUG-309).

set -u

KEY="f0ed603a5ff64d91903321956f48ceec"
KEY_LOCATION="https://tools.scoreroute.com/f0ed603a5ff64d91903321956f48ceec.txt"
HOST="tools.scoreroute.com"
SITEMAP_URL="https://tools.scoreroute.com/sitemap.xml"
STATE="/home/ubuntu/evan-ip-ddns-com/devtools-hub-docs/indexnow-submitted.txt"
MODE="${1:-incremental}"

echo "Fetching URLs from sitemap..."
SITEMAP=$(curl -s --max-time 60 "$SITEMAP_URL")
CURRENT=$(echo "$SITEMAP" | grep -o '<loc>[^<]*</loc>' | sed 's/<loc>//;s/<\/loc>//')

if [ -z "$CURRENT" ]; then
    echo "Error: no URLs found in $SITEMAP_URL (site down, or sitemap is not XML?)"
    exit 1
fi
TOTAL=$(echo "$CURRENT" | wc -l | tr -d ' ')
echo "Sitemap has $TOTAL URLs"

if [ "$MODE" = "--all" ]; then
    TO_SEND="$CURRENT"
    echo "Mode: full submission ($TOTAL URLs)"
elif [ -f "$STATE" ]; then
    TO_SEND=$(comm -23 <(echo "$CURRENT" | sort) <(sort "$STATE"))
    REMOVED=$(comm -13 <(echo "$CURRENT" | sort) <(sort "$STATE"))
    echo "Mode: incremental (state $(wc -l < "$STATE" | tr -d ' ') URLs)"
    if [ -n "$REMOVED" ]; then
        echo "Note: $(echo "$REMOVED" | wc -l | tr -d ' ') URL(s) left the sitemap and are not submitted:"; echo "$REMOVED" | sed 's/^/    /'
    fi
else
    TO_SEND="$CURRENT"
    echo "Mode: no state file at $STATE, doing a one-time baseline submission"
fi

COUNT=$(echo "$TO_SEND" | grep -c . || true)
if [ "$COUNT" -eq 0 ]; then
    echo "Nothing new to submit."
    exit 0
fi
echo "Submitting $COUNT URL(s)"

JSON_FILE="/tmp/indexnow-payload-$$.json"
{
    printf '{\n  "host": "%s",\n  "key": "%s",\n  "keyLocation": "%s",\n  "urlList": [\n' "$HOST" "$KEY" "$KEY_LOCATION"
    echo "$TO_SEND" | sort | grep . | while read -r url; do printf '    "%s",\n' "$url"; done | sed '$ s/,$//'
    printf '  ]\n}\n'
} > "$JSON_FILE"

RESPONSE=$(curl -s -w "\n%{http_code}" --max-time 120 -X POST "https://api.indexnow.org/indexnow" \
    -H "Content-Type: application/json; charset=utf-8" \
    -d @"$JSON_FILE")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
rm -f "$JSON_FILE"

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "202" ]; then
    echo "SUCCESS: IndexNow accepted $COUNT URL(s) (HTTP $HTTP_CODE)"
    echo "$CURRENT" | sort > "$STATE"
    echo "State updated: $STATE"
else
    echo "FAILED: HTTP $HTTP_CODE"
    echo "$RESPONSE"
    exit 1
fi