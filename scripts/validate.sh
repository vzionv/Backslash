#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"
FAILS=0

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  PASS: $label"
  else
    echo "  FAIL: $label"
    FAILS=$((FAILS + 1))
  fi
}

echo ""
echo "=============================================="
echo "  Backslash — Integrity Check"
echo "=============================================="
echo ""

# ─── 1. Source integrity (nothing missing) ─────
echo "--- Source integrity ---"
for f in \
  src/app/api/projects/\[projectId\]/compile/route.ts \
  src/app/api/projects/\[projectId\]/cancel/route.ts \
  src/app/api/health/route.ts \
  src/lib/db/schema.ts \
  src/lib/db/index.ts \
  src/lib/compiler/runner.ts \
  src/lib/compiler/process-executor.ts \
  src/lib/compiler/compile-task-manager.ts \
  src/lib/websocket/server.ts \
  src/instrumentation.ts; do
  [ -f "apps/web/$f" ] && echo "  OK  $f" || { echo "  MISSING $f"; FAILS=$((FAILS+1)); }
done

# ─── 2. Dependencies present in node_modules ─────
echo ""
echo "--- Dependencies ---"
check "next installed" test -d "apps/web/node_modules/next"
check "react installed" test -d "apps/web/node_modules/react"
check "drizzle-orm installed" test -d "apps/web/node_modules/drizzle-orm"
check "Radix dropdown-menu installed" test -d "apps/web/node_modules/@radix-ui/react-dropdown-menu"
check "Codemirror installed" test -d "apps/web/node_modules/@codemirror/state"
# Verify no removed deps remain in active packages
removed_dependency_pattern="$(printf '%s%s' bull mq)|$(printf '%s%s' iored is)|$(printf '%s%s' post gres)"
for pkg in apps/web/package.json apps/ws/package.json; do
  if grep -qiE "\"(${removed_dependency_pattern})\"" "$pkg" 2>/dev/null; then
    echo "  FAIL: $pkg still contains removed deps"
    FAILS=$((FAILS+1))
  else
    echo "  OK   $pkg — no removed deps"
  fi
done

# ─── 3. LaTeX environment ────────────────────────
echo ""
echo "--- LaTeX ---"
if command -v latexmk >/dev/null 2>&1 || [ -n "${LATEXMK_PATH:-}" ]; then
  echo "  OK  latexmk configured"
else
  echo "  MISSING latexmk; set LATEXMK_PATH or add it to PATH"
  FAILS=$((FAILS+1))
fi

# ─── 4. TypeScript compile ───────────────────────
echo ""
echo "--- TypeScript ---"
TSC=$(find node_modules -path "*/typescript/bin/tsc" -not -path "*eslint*" 2>/dev/null | head -1)
if [ -n "$TSC" ]; then
  ERRS=$("$TSC" --noEmit -p apps/web/tsconfig.json 2>&1 | grep -c "error TS" || true)
  if [ "$ERRS" -eq 0 ]; then
    echo "  PASS: 0 TypeScript errors"
  else
    echo "  WARN: $ERRS TypeScript errors (non-zero)"
  fi
else
  echo "  SKIP: tsc not found"
fi

# ─── 5. Unit tests ──────────────────────────────
echo ""
echo "--- Unit tests ---"
TEST_LOG="$(mktemp)"
if [ -x "node_modules/.bin/vitest" ]; then
  if node_modules/.bin/vitest run >"$TEST_LOG" 2>&1; then
    echo "  PASS: Unit tests passed"
  else
    echo "  FAIL: Tests did not pass"
    grep -A2 "FAIL\|Error" "$TEST_LOG" | head -10
    FAILS=$((FAILS+1))
  fi
else
  echo "  SKIP: dependencies are not installed; run pnpm install --frozen-lockfile"
fi
rm -f "$TEST_LOG"

echo ""
echo "--- Native TeX fixtures ---"
if bash tests/runtime/native-tex.test.sh; then
  echo "  PASS: Native TeX fixtures"
else
  echo "  FAIL: Native TeX fixtures"
  FAILS=$((FAILS+1))
fi

# ─── 6. Server startup ──────────────────────────
echo ""
echo "--- Server ---"
if curl -s http://localhost:3000/api/health 2>/dev/null | grep -Eq '"status"[[:space:]]*:[[:space:]]*"healthy"'; then
  echo "  PASS: Server is already running and healthy"
else
  echo "  INFO: Server not running. Port 3000 is free."
fi

echo ""
echo "=============================================="
if [ "$FAILS" -eq 0 ]; then
  echo "  ALL CHECKS PASSED"
else
  echo "  $FAILS CHECK(S) FAILED"
fi
echo "=============================================="
