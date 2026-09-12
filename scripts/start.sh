#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=scripts/local-runtime.sh
source "$SCRIPT_DIR/local-runtime.sh"
load_environment_file ".env"

info() { printf 'OK   %s\n' "$1"; }
error() { printf 'FAIL %s\n' "$1" >&2; }

BACKSLASH_MODE="${BACKSLASH_MODE:-production}"
BACKSLASH_PROTOCOL="${BACKSLASH_PROTOCOL:-http}"
case "$BACKSLASH_PROTOCOL" in
  http|https) ;;
  *) error "BACKSLASH_PROTOCOL must be http or https"; exit 1 ;;
esac

BACKSLASH_USE_HTTPS=false
BACKSLASH_HOST="${BACKSLASH_HOST:-localhost}"
CADDY_PATH="${CADDY_PATH:-}"
CADDY_CONFIG_IS_DEFAULT=false
if [ -n "${CADDY_CONFIG:-}" ]; then
  CADDY_CONFIG="$(resolve_runtime_path "$CADDY_CONFIG")"
else
  CADDY_CONFIG="$ROOT_DIR/.backslash-caddy.json"
  CADDY_CONFIG_IS_DEFAULT=true
fi
CADDY_ADAPTER="${CADDY_ADAPTER:-json}"
CERTIFICATE_FILE="${CERTIFICATE_FILE:-}"
PRIVATE_KEY_FILE="${PRIVATE_KEY_FILE:-}"
WEB_UPSTREAM_HOST="${WEB_UPSTREAM_HOST:-127.0.0.1}"
WEB_UPSTREAM_PORT="${WEB_UPSTREAM_PORT:-3000}"
WS_UPSTREAM_HOST="${WS_UPSTREAM_HOST:-127.0.0.1}"
WS_UPSTREAM_PORT="${WS_UPSTREAM_PORT:-3001}"
HTTPS_PORT="${HTTPS_PORT:-443}"
if [ "$BACKSLASH_PROTOCOL" = "https" ]; then
  if [ -z "$CADDY_PATH" ]; then
    CADDY_PATH="$(command -v caddy 2>/dev/null || true)"
  elif [[ "$CADDY_PATH" == ./* ]]; then
    CADDY_PATH="$(resolve_runtime_path "$CADDY_PATH")"
  elif [ ! -f "$CADDY_PATH" ]; then
    CADDY_PATH="$(command -v "$CADDY_PATH" 2>/dev/null || true)"
  fi
  CADDY_CONFIG="$(resolve_runtime_path "$CADDY_CONFIG")"
  if [ -n "$CERTIFICATE_FILE" ]; then
    CERTIFICATE_FILE="$(resolve_runtime_path "$CERTIFICATE_FILE")"
  fi
  if [ -n "$PRIVATE_KEY_FILE" ]; then
    PRIVATE_KEY_FILE="$(resolve_runtime_path "$PRIVATE_KEY_FILE")"
  fi
  if [ -z "$CADDY_PATH" ] || [ ! -f "$CADDY_PATH" ]; then
    printf 'WARN HTTPS requested but Caddy was not found; falling back to HTTP\n' >&2
  elif [ "$CADDY_CONFIG_IS_DEFAULT" != true ] && [ ! -f "$CADDY_CONFIG" ]; then
    printf 'WARN HTTPS requested but Caddy configuration was not found; falling back to HTTP\n' >&2
  elif [ -z "$CERTIFICATE_FILE" ] || [ ! -f "$CERTIFICATE_FILE" ]; then
    printf 'WARN HTTPS requested but a certificate chain was not configured; falling back to HTTP\n' >&2
  elif [ -z "$PRIVATE_KEY_FILE" ] || [ ! -f "$PRIVATE_KEY_FILE" ]; then
    printf 'WARN HTTPS requested but a private key was not configured; falling back to HTTP\n' >&2
  else
    BACKSLASH_USE_HTTPS=true
  fi
fi
if [ "$BACKSLASH_USE_HTTPS" != true ]; then
  BACKSLASH_PROTOCOL=http
fi

HTTP_WEB_PORT="${WEB_PORT:-3000}"
HTTP_WS_PORT="${WS_PORT:-3001}"
HTTP_WEB_HOSTNAME="${WEB_HOSTNAME:-0.0.0.0}"
HTTP_WS_HOST="${WS_HOST:-0.0.0.0}"
if [ "$BACKSLASH_MODE" = "production" ] && [ "$BACKSLASH_USE_HTTPS" = true ]; then
  WEB_PORT="$WEB_UPSTREAM_PORT"
  WEB_HOSTNAME="${WEB_UPSTREAM_HOST:-127.0.0.1}"
  WS_PORT="${WS_UPSTREAM_PORT:-3001}"
  WS_HOST="${WS_HOST:-127.0.0.1}"
  HTTPS_PORT="${HTTPS_PORT:-443}"
else
  WEB_PORT="$HTTP_WEB_PORT"
  WEB_HOSTNAME="$HTTP_WEB_HOSTNAME"
  WS_PORT="$HTTP_WS_PORT"
  WS_HOST="$HTTP_WS_HOST"
fi
WEB_INTERNAL_PORT="${WEB_INTERNAL_PORT:-3010}"
WS_INTERNAL_PORT="${WS_INTERNAL_PORT:-3011}"
STORAGE_PATH="$(resolve_runtime_path "${STORAGE_PATH:-./data}")"
TEMPLATES_PATH="$(resolve_runtime_path "${TEMPLATES_PATH:-./templates}")"
export WEB_PORT WS_PORT WEB_HOSTNAME WS_HOST HTTPS_PORT BACKSLASH_HOST CADDY_PATH CADDY_CONFIG CADDY_ADAPTER CERTIFICATE_FILE PRIVATE_KEY_FILE WEB_UPSTREAM_HOST WEB_UPSTREAM_PORT WS_UPSTREAM_HOST WS_UPSTREAM_PORT BACKSLASH_PROTOCOL
export CERTIFICATE_FILE PRIVATE_KEY_FILE WEB_INTERNAL_PORT WS_INTERNAL_PORT
export STORAGE_PATH TEMPLATES_PATH BACKSLASH_MODE BACKSLASH_USE_HTTPS

if [ "$BACKSLASH_USE_HTTPS" = true ] && [ "$CADDY_CONFIG_IS_DEFAULT" = true ]; then
  if ! node "$ROOT_DIR/scripts/create-caddy-config.mjs" "$CADDY_CONFIG"; then
    printf 'WARN HTTPS requested but Caddy configuration could not be generated; falling back to HTTP\n' >&2
    BACKSLASH_USE_HTTPS=false
    BACKSLASH_PROTOCOL=http
    WEB_PORT="$HTTP_WEB_PORT"
    WEB_HOSTNAME="$HTTP_WEB_HOSTNAME"
    WS_PORT="$HTTP_WS_PORT"
    WS_HOST="$HTTP_WS_HOST"
    export WEB_PORT WS_PORT WEB_HOSTNAME WS_HOST BACKSLASH_PROTOCOL BACKSLASH_USE_HTTPS
  fi
fi

if [ "$BACKSLASH_USE_HTTPS" = true ]; then
  if [ "$CADDY_ADAPTER" = "json" ] || [ -z "$CADDY_ADAPTER" ]; then
    if ! "$CADDY_PATH" validate --config "$CADDY_CONFIG"; then
      printf 'WARN HTTPS requested but Caddy configuration is invalid; falling back to HTTP\n' >&2
      BACKSLASH_USE_HTTPS=false
      BACKSLASH_PROTOCOL=http
      WEB_PORT="$HTTP_WEB_PORT"
      WEB_HOSTNAME="$HTTP_WEB_HOSTNAME"
      WS_PORT="$HTTP_WS_PORT"
      WS_HOST="$HTTP_WS_HOST"
    fi
  elif ! "$CADDY_PATH" validate --config "$CADDY_CONFIG" --adapter "$CADDY_ADAPTER"; then
    printf 'WARN HTTPS requested but Caddy configuration is invalid; falling back to HTTP\n' >&2
    BACKSLASH_USE_HTTPS=false
    BACKSLASH_PROTOCOL=http
    WEB_PORT="$HTTP_WEB_PORT"
    WEB_HOSTNAME="$HTTP_WEB_HOSTNAME"
    WS_PORT="$HTTP_WS_PORT"
    WS_HOST="$HTTP_WS_HOST"
  fi
  export WEB_PORT WS_PORT WEB_HOSTNAME WS_HOST BACKSLASH_PROTOCOL BACKSLASH_USE_HTTPS
fi

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
if [ "$BACKSLASH_USE_HTTPS" = true ]; then
  validate_port "HTTPS_PORT" "$HTTPS_PORT"
fi

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
if [ "$BACKSLASH_USE_HTTPS" = true ]; then
  require_port_free "$HTTPS_PORT" || { error "Port $HTTPS_PORT is already in use"; exit 1; }
fi
mkdir -p "$STORAGE_PATH/projects" "$STORAGE_PATH/compile-temp" "$STORAGE_PATH/compile-output"

if [ "$BACKSLASH_MODE" = "development" ]; then
  (cd apps/web && exec pnpm dev --hostname "$WEB_HOSTNAME" --port "$WEB_PORT") &
else
  [ -d apps/web/.next ] || { error "Missing apps/web/.next; run pnpm --filter @backslash/web build"; exit 1; }
  [ -f apps/ws/dist/index.js ] || { error "Missing apps/ws/dist/index.js; run pnpm --filter @backslash/ws build"; exit 1; }
  (cd apps/web && exec node node_modules/next/dist/bin/next start --hostname "$WEB_HOSTNAME" --port "$WEB_PORT") &
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

if [ "$BACKSLASH_USE_HTTPS" = true ]; then
  export WEB_UPSTREAM_PORT="$WEB_PORT"
  export WS_UPSTREAM_PORT="$WS_PORT"
  export CADDY_ADMIN="${CADDY_ADMIN:-127.0.0.1:2019}"
  if [ "$CADDY_ADAPTER" = "json" ] || [ -z "$CADDY_ADAPTER" ]; then
    "$CADDY_PATH" run --config "$CADDY_CONFIG" &
  else
    "$CADDY_PATH" run --config "$CADDY_CONFIG" --adapter "$CADDY_ADAPTER" &
  fi
  CADDY_PID=$!
  printf '%s\n' "$CADDY_PID" > "$CADDY_PID_FILE"
  info "HTTPS proxy started at https://${BACKSLASH_HOST}:${HTTPS_PORT}"
fi

info "Web server started at ${BACKSLASH_PROTOCOL}://${WEB_HOSTNAME}:${WEB_PORT}"
info "WebSocket server started on ${WS_HOST}:${WS_PORT}"

while process_exists "$WEB_PID" && process_exists "$WS_PID"; do
  if [ "$BACKSLASH_USE_HTTPS" = true ] && ! process_exists "$CADDY_PID"; then
    wait "$CADDY_PID" || status=$?
    error "HTTPS proxy exited unexpectedly"
    exit "${status:-1}"
  fi
  sleep 1
done
if ! process_exists "$WEB_PID"; then
  wait "$WEB_PID" || status=$?
  error "Web server exited unexpectedly"
else
  wait "$WS_PID" || status=$?
  error "WebSocket server exited unexpectedly"
fi
exit "${status:-1}"
