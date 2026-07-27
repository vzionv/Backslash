#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/local-runtime.sh
source "$SCRIPT_DIR/local-runtime.sh"
stop_backslash_services
