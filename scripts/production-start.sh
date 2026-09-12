#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BACKSLASH_MODE=production
export CADDY_CONFIG="${CADDY_CONFIG:-$SCRIPT_DIR/../.backslash-caddy.json}"
export CADDY_ADAPTER="${CADDY_ADAPTER:-json}"
exec bash "$SCRIPT_DIR/start.sh"
