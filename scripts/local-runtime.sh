#!/usr/bin/env bash

RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_PID_FILE="$RUNTIME_ROOT/.backslash-web.pid"
WS_PID_FILE="$RUNTIME_ROOT/.backslash-ws.pid"

load_environment_file() {
  local environment_file="$1"
  local line key value
  [ -f "$environment_file" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    if [ -z "$line" ] || [[ "$line" == \#* ]]; then
      continue
    fi
    if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      printf 'Invalid environment entry in %s\n' "$environment_file" >&2
      return 1
    fi

    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi

    case "$key" in
      BASHOPTS|BASH_ENV|CDPATH|ENV|IFS|LD_PRELOAD|NODE_OPTIONS|NODE_PATH|PATH|SHELLOPTS)
        printf 'Unsupported environment key in %s: %s\n' "$environment_file" "$key" >&2
        return 1
        ;;
    esac
    export "$key=$value"
  done < "$environment_file"
}

is_windows_shell() {
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

process_exists() {
  kill -0 "$1" >/dev/null 2>&1
}

terminate_posix_tree() {
  local pid="$1" child
  if command -v pgrep >/dev/null 2>&1; then
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
      terminate_posix_tree "$child"
    done
  fi
  kill -TERM "$pid" >/dev/null 2>&1 || true
}

stop_managed_process() {
  local pid_file="$1"
  local service_name="$2"
  [ -f "$pid_file" ] || return 0

  local pid
  pid="$(tr -d '[:space:]' < "$pid_file")"
  rm -f "$pid_file"
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    printf 'WARN Invalid %s PID file ignored\n' "$service_name" >&2
    return 0
  fi
  if ! process_exists "$pid"; then
    return 0
  fi

  printf 'Stopping %s (PID %s)...\n' "$service_name" "$pid"
  if is_windows_shell && command -v taskkill >/dev/null 2>&1; then
    taskkill //PID "$pid" //T //F >/dev/null 2>&1 || true
    return 0
  fi

  terminate_posix_tree "$pid"
  local attempt=0
  while process_exists "$pid" && [ "$attempt" -lt 50 ]; do
    sleep 0.1
    attempt=$((attempt + 1))
  done
  if process_exists "$pid"; then
    kill -KILL "$pid" >/dev/null 2>&1 || true
  fi
}

stop_backslash_services() {
  stop_managed_process "$WEB_PID_FILE" "web server"
  stop_managed_process "$WS_PID_FILE" "WebSocket server"
}

require_port_free() {
  local port="$1"
  node - "$port" <<'NODE'
const net = require("node:net");
const port = Number(process.argv[2]);
const server = net.createServer();
server.unref();
server.once("error", () => process.exit(1));
server.listen({ host: "0.0.0.0", port, exclusive: true }, () => {
  server.close(() => process.exit(0));
});
NODE
}

require_supported_node() {
  local minimum_version="${1:-22.5.0}"
  node - "$minimum_version" <<'NODE'
const minimum = process.argv[2].split(".").map(Number);
const current = process.versions.node.split(".").map(Number);
for (let index = 0; index < 3; index += 1) {
  const delta = (current[index] ?? 0) - (minimum[index] ?? 0);
  if (delta > 0) process.exit(0);
  if (delta < 0) process.exit(1);
}
process.exit(0);
NODE
}

resolve_runtime_path() {
  node -e 'const path=require("node:path");process.stdout.write(path.resolve(process.argv[1]))' "$1"
}
