#!/bin/bash
set -euo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
RUN_TEX_INTEGRATION="${RUN_TEX_INTEGRATION:-true}"
TEST_ID="$(date +%s)"
TEST_EMAIL="backslash-test-${TEST_ID}@local.invalid"
TEST_PROJECT="Backslash Integration ${TEST_ID}"
PASS=0
FAIL=0
RESULTS=""
PROJECT_ID=""

cleanup() {
  if [ -n "$PROJECT_ID" ] && [ -n "${COOKIE:-}" ]; then
    curl -s -o /dev/null -X DELETE -b "session=$COOKIE" "$BASE/api/projects/$PROJECT_ID" || true
  fi
}
trap cleanup EXIT

test_result() {
  local name="$1"; shift
  if "$@"; then
    echo "  PASS: $name"
    PASS=$((PASS + 1))
    RESULTS+="PASS $name\n"
  else
    echo "  FAIL: $name"
    FAIL=$((FAIL + 1))
    RESULTS+="FAIL $name\n"
  fi
}

echo "=============================================="
echo " Backslash Integration Tests"
echo "=============================================="
echo ""

# 0. Health check
echo "--- 0. Health Check ---"
HEALTH=$(curl -s "$BASE/api/health")
echo "$HEALTH" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"healthy"' && echo "  Server is healthy" || { echo "  Server not healthy"; exit 1; }

# 1. Register user
echo ""
echo "--- 1. Register ---"
REG=$(curl -s -X POST "$BASE/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"name\":\"Test User\",\"password\":\"test1234\"}")
echo "  Register: $REG"

# 2. Login
echo ""
echo "--- 2. Login ---"
LOGIN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"test1234\"}" \
  -c "/tmp/bs-cookies.txt" -D "/tmp/bs-headers.txt")
echo "  Login: $(echo "$LOGIN" | head -c 100)"

# Extract cookie for subsequent API calls
COOKIE=$(grep "session" /tmp/bs-cookies.txt | awk '{print $NF}')
if [ -z "$COOKIE" ]; then
  echo "  FAIL: Could not get session cookie"
  exit 1
fi

# Helper for authenticated API calls
api() {
  curl -s -b "session=$COOKIE" "$@"
}

AUTH_ME_FILE="/tmp/bs-auth-me.json"
api "$BASE/api/auth/me" > "$AUTH_ME_FILE"
test_result "Valid session accepted" grep -q '"user"' "$AUTH_ME_FILE"

# 2b. Invalid session rejection
printf '\n--- 2b. Invalid Session ---\n'
INVALID_HEADERS="/tmp/bs-invalid-session-headers.txt"
curl -s -D "$INVALID_HEADERS" -o /dev/null -H "Cookie: session=stale-token" "$BASE/api/auth/me"
test_result "Invalid session rejected" grep -q "401" "$INVALID_HEADERS"
test_result "Invalid session cookie cleared" grep -qi "^set-cookie: session=;" "$INVALID_HEADERS"

# 3. Create a LaTeX project
echo ""
echo "--- 3. Create Project ---"
PROJ=$(api -X POST "$BASE/api/projects" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$TEST_PROJECT\",\"engine\":\"xelatex\",\"template\":\"blank\"}")
echo "  Project: $PROJ"
PROJECT_ID=$(echo "$PROJ" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$PROJECT_ID" ]; then
  echo "  FAIL: Could not create project"
  exit 1
fi
echo "  Project ID: $PROJECT_ID"

# 4. Get project details
echo ""
echo "--- 4. Project Files ---"
FILES=$(api "$BASE/api/projects/$PROJECT_ID")
echo "  Files: $(echo "$FILES" | head -c 200)"

# 5. Upload dedicated entrypoint
TEST_MAIN_FILE="integration.tex"
echo ""
echo "--- 5. Upload $TEST_MAIN_FILE ---"
cat > "/tmp/$TEST_MAIN_FILE" << 'LATEX'
\documentclass{article}
\begin{document}
Hello, world!
\end{document}
LATEX
UPLOAD_RESPONSE=$(api -X POST "$BASE/api/projects/$PROJECT_ID/files/upload" \
  -F "files=@/tmp/$TEST_MAIN_FILE" \
  -F "paths=$TEST_MAIN_FILE")
FILE_ID=$(echo "$UPLOAD_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
echo "  File ID: $FILE_ID"
test_result "Upload .tex file" [ -n "$FILE_ID" ]

# 6. Set entrypoint
echo ""
echo "--- 6. Set Entrypoint ---"
api -X PUT "$BASE/api/projects/$PROJECT_ID/entrypoint" \
  -H "Content-Type: application/json" \
  -d "{\"mainFile\":\"$TEST_MAIN_FILE\"}"

if [ "$RUN_TEX_INTEGRATION" = "true" ]; then
  # 7. Compile
  echo ""
  echo "--- 7. Compile ---"
  COMPILE=$(api -X POST "$BASE/api/projects/$PROJECT_ID/compile" \
    -H "Content-Type: application/json")
  echo "  Compile response: $COMPILE"
  BUILD_ID=$(echo "$COMPILE" | grep -o '"buildId":"[^"]*"' | cut -d'"' -f4)

  test_result "Compile triggered" [ -n "$BUILD_ID" ]

  # 8. Poll for completion
  echo ""
  echo "--- 8. Wait for Completion ---"
  STATUS="queued"
  for i in $(seq 1 60); do
    sleep 2
    LOGS=$(api "$BASE/api/projects/$PROJECT_ID/logs")
    STATUS=$(echo "$LOGS" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
    echo "  [$i] Status: $STATUS"
    if [ "$STATUS" = "success" ] || [ "$STATUS" = "error" ] || [ "$STATUS" = "timeout" ]; then
      break
    fi
  done

  test_result "Build completed" [ "$STATUS" = "success" ]

  # 9. Check PDF
  echo ""
  echo "--- 9. PDF ---"
  PDF_STATUS=$(api -o /dev/null -w "%{http_code}" "$BASE/api/projects/$PROJECT_ID/pdf")
  test_result "PDF accessible (HTTP $PDF_STATUS)" [ "$PDF_STATUS" = "200" ]

  # 10. Check logs
  echo ""
  echo "--- 10. Logs ---"
  LOGS=$(api "$BASE/api/projects/$PROJECT_ID/logs")
  ERROR_COUNT=$(printf '%s' "$LOGS" | grep -o '"type":"error"' | wc -l || true)
  echo "  Error count in logs: $ERROR_COUNT"
  test_result "No errors in build" [ "$ERROR_COUNT" -eq 0 ]
else
  echo "SKIP: TeX compile and PDF checks (RUN_TEX_INTEGRATION=false)."
fi

echo ""
echo "=============================================="
echo " Results: $PASS passed, $FAIL failed"
echo "=============================================="

[ "$FAIL" -eq 0 ]
