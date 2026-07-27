#!/bin/bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
TEST_EMAIL="${BACKSLASH_E2E_EMAIL:-}"
TEST_PASSWORD="${BACKSLASH_E2E_PASSWORD:-}"
PROJECT_ID="${BACKSLASH_E2E_PROJECT_ID:-}"
TEXT_FILE="${BACKSLASH_E2E_TEXT_FILE:-main.tex}"
IMAGE_FILE="${BACKSLASH_E2E_IMAGE_FILE:-}"
SESSION="backslash-smoke"
STALE_SESSION="backslash-smoke-stale"

if ! command -v playwright-cli >/dev/null 2>&1; then
  echo "SKIP: playwright-cli is not installed."
  exit 0
fi

if [ -z "$TEST_EMAIL" ] || [ -z "$TEST_PASSWORD" ] || [ -z "$PROJECT_ID" ] || [ -z "$IMAGE_FILE" ]; then
  echo "SKIP: set BACKSLASH_E2E_EMAIL, BACKSLASH_E2E_PASSWORD, BACKSLASH_E2E_PROJECT_ID, and BACKSLASH_E2E_IMAGE_FILE."
  exit 0
fi

cleanup() {
  playwright-cli -s="$SESSION" close >/dev/null 2>&1 || true
  playwright-cli -s="$STALE_SESSION" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

playwright-cli -s="$STALE_SESSION" open "$BASE_URL/dashboard" >/dev/null
playwright-cli -s="$STALE_SESSION" run-code 'async page => { await page.context().addCookies([{ name: "session", value: "stale-token", url: page.url() }]); await page.goto(new URL("/dashboard", page.url()).href); await page.waitForTimeout(3500); if (!page.url().includes("/login?redirect=%2Fdashboard")) throw new Error(`stale session was not redirected: ${page.url()}`); if ((await page.context().cookies(page.url())).some(cookie => cookie.name === "session")) throw new Error("stale session cookie was not cleared"); }' >/dev/null

playwright-cli -s="$SESSION" open "$BASE_URL/login" >/dev/null
playwright-cli -s="$SESSION" fill "getByRole('textbox', { name: 'Email' })" "$TEST_EMAIL" >/dev/null
playwright-cli -s="$SESSION" fill "getByRole('textbox', { name: 'Password' })" "$TEST_PASSWORD" >/dev/null
playwright-cli -s="$SESSION" click "getByRole('button', { name: 'Sign in' })" >/dev/null
playwright-cli -s="$SESSION" goto "$BASE_URL/editor/$PROJECT_ID" >/dev/null
playwright-cli -s="$SESSION" run-code "async page => { await page.waitForTimeout(650); const editors = page.locator('.cm-editor'); if (await editors.count() !== 1) throw new Error(\`expected one CodeMirror editor, found \${await editors.count()}\`); const textFile = page.getByRole('button', {name: '$TEXT_FILE'}); await textFile.click(); await page.waitForTimeout(200); if (await editors.count() !== 1) throw new Error('text-file selection created duplicate editors'); const imageFile = page.getByRole('button', {name: '$IMAGE_FILE'}); await imageFile.click(); await page.waitForTimeout(150); if (await page.locator('img[alt=\"$IMAGE_FILE\"]').count() !== 1) throw new Error('image preview did not open'); await textFile.click(); await page.waitForTimeout(200); if (await editors.count() !== 1) throw new Error('image-to-text switch created duplicate editors'); }" >/dev/null

echo "PASS: stale sessions redirect to login and the editor retains one CodeMirror instance across text-image-text switching."
