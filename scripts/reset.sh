#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=scripts/local-runtime.sh
source "$SCRIPT_DIR/local-runtime.sh"

if [ "${1:-}" != "--yes" ]; then
  echo "This permanently deletes the configured SQLite database, projects, compile files, and Next.js cache."
  read -r -p "Type RESET to continue: " confirmation
  [ "$confirmation" = "RESET" ] || { echo "Reset cancelled."; exit 0; }
fi

stop_backslash_services
load_environment_file ".env"
STORAGE_PATH="$(resolve_runtime_path "${STORAGE_PATH:-./data}")"
SQLITE_PATH="$(resolve_runtime_path "${SQLITE_PATH:-$STORAGE_PATH/backslash.db}")"
LATEX_TEMP_ROOT="$(resolve_runtime_path "${LATEX_TEMP_ROOT:-$STORAGE_PATH/compile-temp}")"
LATEX_OUTPUT_ROOT="$(resolve_runtime_path "${LATEX_OUTPUT_ROOT:-$STORAGE_PATH/compile-output}")"

rm -f -- "$SQLITE_PATH"
rm -rf -- "$STORAGE_PATH/projects" "$STORAGE_PATH/async-compiles" "$STORAGE_PATH/builds"
rm -rf -- "$LATEX_TEMP_ROOT" "$LATEX_OUTPUT_ROOT" apps/web/.next

echo "Local Backslash data has been reset."
exec bash "$SCRIPT_DIR/start.sh"
