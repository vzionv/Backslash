#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BACKSLASH_MODE=production
export WEB_PORT="${WEB_PORT:-3000}"
export WEB_HOSTNAME="${WEB_HOSTNAME:-0.0.0.0}"
exec bash "$SCRIPT_DIR/start.sh"
