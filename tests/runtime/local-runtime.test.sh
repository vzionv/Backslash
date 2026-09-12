#!/bin/bash
set -euo pipefail

RUNTIME_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$RUNTIME_ROOT/scripts/local-runtime.sh"

for script in \
  start.sh stop.sh restart.sh reset.sh validate.sh \
  production-start.sh production-stop.sh production-restart.sh \
  request-certificate.ps1 reload-caddy.ps1; do
  [ -f "$RUNTIME_ROOT/scripts/$script" ] || {
    printf 'missing runtime script: scripts/%s\n' "$script" >&2
    exit 1
  }
done

if find "$RUNTIME_ROOT" -maxdepth 1 -type f -name '*.sh' | grep -q .; then
  printf 'runtime scripts must not remain in the repository root\n' >&2
  exit 1
fi

TEMPORARY_DIRECTORY="$(mktemp -d)"
trap 'rm -rf "$TEMPORARY_DIRECTORY"' EXIT

cat > "$TEMPORARY_DIRECTORY/.env" <<'EOF'
PLAIN_VALUE=plain
QUOTED_VALUE="quoted value"
STORAGE_PATH=plain
TEMPLATES_PATH="quoted value"
SESSION_SECRET='single quoted value'
COMMAND_VALUE=$(touch should-not-exist)
# Comment
EOF

(
  cd "$TEMPORARY_DIRECTORY"
  load_environment_file ".env"
  [ "$STORAGE_PATH" = "plain" ]
  [ "$TEMPLATES_PATH" = "quoted value" ]
  [ "$SESSION_SECRET" = "single quoted value" ]
  [ "$COMMAND_VALUE" = '$(touch should-not-exist)' ]
  [ ! -e "should-not-exist" ]
)

cat > "$TEMPORARY_DIRECTORY/unsafe.env" <<'EOF'
PATH=/tmp
EOF

if load_environment_file "$TEMPORARY_DIRECTORY/unsafe.env"; then
  printf 'unsafe environment key was accepted\n' >&2
  exit 1
fi

grep -q 'load_environment_file ".env"' "$RUNTIME_ROOT/scripts/start.sh"
grep -q 'load_environment_file ".env"' "$RUNTIME_ROOT/scripts/reset.sh"
for template in .env.example .env.windows.example config/acme.example.json; do
  [ -f "$RUNTIME_ROOT/$template" ] || {
    printf 'missing configuration template: %s\n' "$template" >&2
    exit 1
  }
done
[ -f "$RUNTIME_ROOT/scripts/create-caddy-config.mjs" ] || {
  printf 'missing Caddy configuration generator\n' >&2
  exit 1
}
grep -q '^BACKSLASH_PROTOCOL=http$' "$RUNTIME_ROOT/.env.example"
grep -q 'falling back to HTTP' "$RUNTIME_ROOT/scripts/start.sh"
if grep -q 'source ".env"' "$RUNTIME_ROOT/scripts/start.sh" "$RUNTIME_ROOT/scripts/reset.sh"; then
  printf 'runtime script executes .env\n' >&2
  exit 1
fi

printf 'local-runtime environment parser passed\n'
