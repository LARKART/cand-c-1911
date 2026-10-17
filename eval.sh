#!/usr/bin/env bash
# Evaluate judged ranking, hard rules, live inventory prices, and latency.
set -euo pipefail
cd "$(dirname "$0")"
: "${SEARCH_URL:?Set SEARCH_URL, for example http://localhost:3000}"
node tools/eval.mjs
