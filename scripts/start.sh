#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=scripts/local-runtime.sh
source "$SCRIPT_DIR/local-runtime.sh"
load_environment_file ".env"

WEB_PORT="${WEB_PORT:-3000}"
WS_PORT="${WS_PORT:-3001}"
WEB_HOSTNAME="${WEB_HOSTNAME:-0.0.0.0}"
WEB_INTERNAL_PORT="${WEB_INTERNAL_PORT:-3010}"
WS_INTERNAL_PORT="${WS_INTERNAL_PORT:-3011}"
STORAGE_PATH="$(resolve_runtime_path "${STORAGE_PATH:-./data}")"
TEMPLATES_PATH="$(resolve_runtime_path "${TEMPLATES_PATH:-./templates}")"
BACKSLASH_MODE="${BACKSLASH_MODE:-production}"
export WEB_PORT WS_PORT WEB_HOSTNAME WEB_INTERNAL_PORT WS_INTERNAL_PORT
export STORAGE_PATH TEMPLATES_PATH BACKSLASH_MODE

info() { printf 'OK   %s\n' "$1"; }
error() { printf 'FAIL %s\n' "$1" >&2; }

validate_port() {
  [[ "$2" =~ ^[0-9]+$ ]] && [ "$2" -ge 1 ] && [ "$2" -le 65535 ] || {
    error "$1 must be an integer between 1 and 65535"; exit 1;
  }
}
validate_secret() {
  [ "${#2}" -ge 32 ] || { error "$1 must contain at least 32 characters"; exit 1; }
}
wait_for_web_internal_server() {
  local attempt=0 code
  while [ "$attempt" -lt 30 ]; do
    code="$(curl --silent --output /dev/null --write-out '%{http_code}' \
      "http://127.0.0.1:${WEB_INTERNAL_PORT}/authorize" || true)"
    if [[ "$code" =~ ^(400|401|404|405)$ ]]; then return 0; fi
    attempt=$((attempt + 1)); sleep 1
  done
  return 1
}
cleanup() { stop_backslash_services; }
trap cleanup EXIT INT TERM

command -v node >/dev/null 2>&1 || { error "Node.js is required"; exit 1; }
require_supported_node "22.5.0" || { error "Node.js 22.5.0 or newer is required (Node.js 24 LTS recommended)"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { error "pnpm is required"; exit 1; }
command -v curl >/dev/null 2>&1 || { error "curl is required"; exit 1; }
for pair in "WEB_PORT:$WEB_PORT" "WS_PORT:$WS_PORT" \
  "WEB_INTERNAL_PORT:$WEB_INTERNAL_PORT" "WS_INTERNAL_PORT:$WS_INTERNAL_PORT"; do
  validate_port "${pair%%:*}" "${pair#*:}"
done
validate_secret "SESSION_SECRET" "${SESSION_SECRET:-}"
validate_secret "BACKSLASH_INTERNAL_SERVICE_KEY" "${BACKSLASH_INTERNAL_SERVICE_KEY:-}"

if [ "${LATEX_ALLOW_SHELL_ESCAPE:-false}" = "true" ] && \
   [ "${LATEX_SHELL_ESCAPE_ACKNOWLEDGE_RISK:-false}" != "true" ]; then
  error "LATEX_ALLOW_SHELL_ESCAPE=true requires LATEX_SHELL_ESCAPE_ACKNOWLEDGE_RISK=true"
  exit 1
fi
if [ "${CORS_ORIGIN:-}" = "*" ] && \
   [ "${CORS_ALLOW_ANY_ORIGIN_ACKNOWLEDGE_RISK:-false}" != "true" ]; then
  error "CORS_ORIGIN=* requires CORS_ALLOW_ANY_ORIGIN_ACKNOWLEDGE_RISK=true"
  exit 1
fi

if [ -n "${LATEXMK_PATH:-}" ]; then
  [ -f "$LATEXMK_PATH" ] || { error "LATEXMK_PATH does not exist: $LATEXMK_PATH"; exit 1; }
else
  command -v latexmk >/dev/null 2>&1 || {
    error "latexmk is required; configure LATEXMK_PATH when it is not on PATH"; exit 1;
  }
fi

stop_backslash_services
for port in "$WEB_PORT" "$WS_PORT" "$WEB_INTERNAL_PORT" "$WS_INTERNAL_PORT"; do
  require_port_free "$port" || { error "Port $port is already in use"; exit 1; }
done
mkdir -p "$STORAGE_PATH/projects" "$STORAGE_PATH/compile-temp" "$STORAGE_PATH/compile-output"

if [ "$BACKSLASH_MODE" = "development" ]; then
  (cd apps/web && exec pnpm dev --hostname "$WEB_HOSTNAME" --port "$WEB_PORT") &
else
  [ -d apps/web/.next ] || { error "Missing apps/web/.next; run pnpm --filter @backslash/web build"; exit 1; }
  [ -f apps/ws/dist/index.js ] || { error "Missing apps/ws/dist/index.js; run pnpm --filter @backslash/ws build"; exit 1; }
  (cd apps/web && exec pnpm exec next start --hostname "$WEB_HOSTNAME" --port "$WEB_PORT") &
fi
WEB_PID=$!
printf '%s\n' "$WEB_PID" > "$WEB_PID_FILE"

if ! wait_for_web_internal_server; then
  error "Web internal authorization server did not start"
  exit 1
fi

if [ "$BACKSLASH_MODE" = "development" ]; then
  (cd apps/ws && exec pnpm dev) &
else
  (cd apps/ws && exec node dist/index.js) &
fi
WS_PID=$!
printf '%s\n' "$WS_PID" > "$WS_PID_FILE"

info "Web server started at http://${WEB_HOSTNAME}:${WEB_PORT}"
info "WebSocket server started on ${WS_HOST:-0.0.0.0}:${WS_PORT}"

while process_exists "$WEB_PID" && process_exists "$WS_PID"; do sleep 1; done
if ! process_exists "$WEB_PID"; then
  wait "$WEB_PID" || status=$?
  error "Web server exited unexpectedly"
else
  wait "$WS_PID" || status=$?
  error "WebSocket server exited unexpectedly"
fi
exit "${status:-1}"
