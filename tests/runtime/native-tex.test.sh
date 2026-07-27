#!/usr/bin/env bash
set -euo pipefail

command -v latexmk >/dev/null 2>&1 || {
  echo "SKIP: latexmk is not installed or not on PATH."
  exit 0
}
command -v node >/dev/null 2>&1 || {
  echo "SKIP: Node.js is required for portable timing."
  exit 0
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_ROOT="$(mktemp -d)"
trap 'rm -rf "$WORK_ROOT"' EXIT
PASS=0
SKIP=0

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

run_case() {
  local fixture="$1" engine_flag="$2" expected="$3"
  local name
  name="$(basename "$fixture")"
  cp -a "$REPO_ROOT/$fixture" "$WORK_ROOT/$name"
  local start end code pdf rss
  start="$(now_ms)"
  set +e
  (
    cd "$WORK_ROOT/$name"
    if [[ -x /usr/bin/time ]]; then
      /usr/bin/time -f 'MAX_RSS_KB=%M' -o .time \
        env HOME="$PWD" TEXMFOUTPUT="$PWD" openin_any=p openout_any=p shell_escape=f \
        latexmk -norc "$engine_flag" -synctex=1 \
        -interaction=nonstopmode -latexoption=-file-line-error \
        -halt-on-error -no-shell-escape main.tex >.stdout 2>.stderr
    else
      env HOME="$PWD" TEXMFOUTPUT="$PWD" openin_any=p openout_any=p shell_escape=f \
        latexmk -norc "$engine_flag" -synctex=1 \
        -interaction=nonstopmode -latexoption=-file-line-error \
        -halt-on-error -no-shell-escape main.tex >.stdout 2>.stderr
    fi
  )
  code=$?
  set -e
  end="$(now_ms)"
  pdf=no
  [[ -s "$WORK_ROOT/$name/main.pdf" ]] && pdf=yes
  rss=unknown
  if [[ -f "$WORK_ROOT/$name/.time" ]]; then
    rss="$(sed -n 's/^MAX_RSS_KB=//p' "$WORK_ROOT/$name/.time" | tail -1)"
    rss="${rss:-unknown}"
  fi
  printf '%-22s exit=%-3s pdf=%-3s ms=%-5s rss_kb=%s\n' \
    "$name" "$code" "$pdf" "$((end-start))" "$rss"

  if [[ "$expected" == success ]]; then
    [[ "$code" -eq 0 && "$pdf" == yes ]] || {
      tail -40 "$WORK_ROOT/$name/.stderr"
      return 1
    }
  else
    [[ "$code" -ne 0 && "$pdf" == no ]] || return 1
  fi
  PASS=$((PASS + 1))
}

run_case tests/fixtures/minimal-pdflatex -pdf success
run_case tests/fixtures/multi-file-input -pdf success
run_case tests/fixtures/xelatex-chinese -xelatex success
run_case tests/fixtures/custom-cls-sty -pdf success
run_case tests/fixtures/security-no-shell -pdf success
[[ ! -e "$WORK_ROOT/security-no-shell/latexmkrc_marker" ]]
[[ ! -e "$WORK_ROOT/security-no-shell/shell_escape_marker" ]]
run_case tests/fixtures/compile-error -pdf failure

# TeX primitives must not read or write outside the isolated build directory.
SECURITY_DIR="$WORK_ROOT/security-filesystem"
mkdir -p "$SECURITY_DIR"
SECRET_FILE="$WORK_ROOT/server-secret.txt"
OUTSIDE_FILE="$WORK_ROOT/outside-write.txt"
SECRET_MARKER="BACKSLASH_SERVER_SECRET_4c237b"
printf '%s\n' "$SECRET_MARKER" > "$SECRET_FILE"
cat > "$SECURITY_DIR/main.tex" <<EOF
\\documentclass{article}
\\usepackage{verbatim}
\\newwrite\\evil
\\begin{document}
\\immediate\\openout\\evil=$OUTSIDE_FILE
\\immediate\\write\\evil{WRITE_ESCAPED}
\\immediate\\closeout\\evil
\\verbatiminput{$SECRET_FILE}
\\end{document}
EOF
set +e
(
  cd "$SECURITY_DIR"
  env HOME="$PWD" TEXMFOUTPUT="$PWD" openin_any=p openout_any=p shell_escape=f \
    latexmk -norc -pdf -interaction=nonstopmode -halt-on-error \
    -no-shell-escape main.tex >.stdout 2>.stderr
)
SECURITY_EXIT=$?
set -e
[[ "$SECURITY_EXIT" -ne 0 ]]
[[ ! -e "$OUTSIDE_FILE" ]]
! grep -R -F "$SECRET_MARKER" "$SECURITY_DIR" >/dev/null 2>&1
printf '%-22s exit=%-3s outside_write=no secret_leak=no\n' \
  "security-filesystem" "$SECURITY_EXIT"
PASS=$((PASS + 1))

if command -v bibtex >/dev/null 2>&1 && bibtex --version >/dev/null 2>&1; then
  run_case tests/fixtures/bibtex -pdf success
else
  echo "SKIP: BibTeX fixture (bibtex executable is unavailable or broken)."
  SKIP=$((SKIP + 1))
fi

if command -v biber >/dev/null 2>&1 && biber --version >/dev/null 2>&1; then
  run_case tests/fixtures/biber -pdf success
else
  echo "SKIP: Biber fixture (biber executable is unavailable or broken)."
  SKIP=$((SKIP + 1))
fi

echo "PASS: $PASS native TeX cases; SKIP: $SKIP"
