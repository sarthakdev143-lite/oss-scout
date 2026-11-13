#!/bin/bash
# Verify a submitted PR's claim independently.
#
# Usage: verify-claim.sh <owner/repo> <pr-url> <fixed_file> <base_branch> <verify_cmd>
#
#   fixed_file  : the source file the fix changed (reverted for the negative check)
#   verify_cmd  : the exact command that proves the fix, run inside the repo.
#                 Examples: "pytest tests/test_x.py -q"
#                           "mvn -B -Dtest=FooTest test"
#                           "npm test -- src/foo.test.ts"
#
# Exit codes: 0 verified | 1 claim did not reproduce | 2 unreachable
#             3 environment could not be built (proves nothing about the fix)
#
# VERIFY_BASELINE=1 additionally compares whole-suite results on the branch and on the base
# and reports REGRESSION when the branch has fewer passing tests. Off by default: slow, and
# many repos have environment-dependent suites.
set -uo pipefail

REPO="${1:-}"; PR_URL="${2:-}"; FIXED_FILE="${3:-}"; BASE="${4:-}"; VERIFY_CMD="${5:-}"
[ -n "$REPO" ] && [ -n "$PR_URL" ] && [ -n "$FIXED_FILE" ] && [ -n "$VERIFY_CMD" ] || {
  echo "NOT-VERIFIED: missing arguments (repo, pr_url, fixed_file, base, verify_cmd)"; exit 2; }
[ -n "$BASE" ] || BASE=master

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK" || exit 2

if ! gh repo clone "$REPO" repo -- --quiet >/dev/null 2>&1; then
  echo "NOT-VERIFIED: clone of $REPO failed"; exit 2
fi
cd repo || exit 2
if ! gh pr checkout "$PR_URL" --branch prhead --force >/dev/null 2>&1; then
  echo "NOT-VERIFIED: could not check out PR $PR_URL (fork PR or auth problem)"; exit 2
fi
echo "head: $(git rev-parse --short HEAD) branch: $(git rev-parse --abbrev-ref HEAD)"

# --- dependency setup, best effort, language-agnostic ---
if [ -f requirements.txt ]; then
  python3 -m venv .venv >/dev/null 2>&1 || { echo "NOT-VERIFIED: venv failed"; exit 3; }
  .venv/bin/pip install -q --upgrade pip >/dev/null 2>&1
  if .venv/bin/pip install -q -r requirements.txt >/tmp/pip1.log 2>&1; then
    echo "deps: requirements.txt as pinned"
  else
    echo "deps: pinned install failed; retrying without pins"
    grep -v -E '^\s*(#|$|-|git\+|https?:)' requirements.txt \
      | sed -E 's/[[:space:]]*(==|>=|<=|~=|!=|>|<).*$//' \
      | grep -v -E '^\s*$' | sort -u > /tmp/req_names.txt
    .venv/bin/pip install -q -r /tmp/req_names.txt >/tmp/pip2.log 2>&1 || {
      echo "NOT-VERIFIED: could not install dependencies"; tail -5 /tmp/pip2.log; exit 3; }
  fi
  export PATH="$PWD/.venv/bin:$PATH"
elif [ -f pyproject.toml ]; then
  python3 -m venv .venv >/dev/null 2>&1 || { echo "NOT-VERIFIED: venv failed"; exit 3; }
  .venv/bin/pip install -q --upgrade pip >/dev/null 2>&1
  .venv/bin/pip install -q -e . >/tmp/pip3.log 2>&1 || .venv/bin/pip install -q pytest >/dev/null 2>&1
  export PATH="$PWD/.venv/bin:$PATH"
fi

if [ -f package.json ] && [ ! -d node_modules ]; then
  if [ -f package-lock.json ]; then npm ci --silent >/tmp/npm.log 2>&1 || echo "deps: npm ci failed (continuing)"
  else npm install --silent >/tmp/npm.log 2>&1 || echo "deps: npm install failed (continuing)"; fi
fi

# No manifest at all (script-style repos): still give the command a pytest to run, or a bare
# "pytest ..." verify_cmd fails with 127 and looks like a bad fix instead of missing tooling.
if [ ! -d .venv ] && [ ! -f package.json ] && [ ! -f pom.xml ]; then
  if python3 -m venv .venv >/dev/null 2>&1; then
    .venv/bin/pip install -q --upgrade pip >/dev/null 2>&1
    .venv/bin/pip install -q pytest >/dev/null 2>&1 || echo "deps: pytest install failed"
    export PATH="$PWD/.venv/bin:$PATH"
    echo "deps: no manifest; pytest provided in .venv"
  else
    echo "deps: no manifest and no venv; the command must bring its own tooling"
  fi
fi

echo "--- positive: \$ $VERIFY_CMD ---"
sh -c "$VERIFY_CMD" 2>&1 | tail -18
POS=${PIPESTATUS[0]}
echo "positive exit: $POS"

if [ "$POS" -ne 0 ]; then
  echo "NOT-VERIFIED: the verification command does not pass WITH the fix (exit $POS)"
  exit 1
fi

echo "--- negative: same command with $FIXED_FILE reverted to origin/$BASE ---"
git fetch --quiet origin "$BASE" >/dev/null 2>&1
if ! git checkout "origin/$BASE" -- "$FIXED_FILE" >/dev/null 2>&1; then
  echo "NOT-VERIFIED: cannot revert $FIXED_FILE from origin/$BASE"; exit 2
fi
echo "--- negative: \$ $VERIFY_CMD with $FIXED_FILE reverted ---"
sh -c "$VERIFY_CMD" 2>&1 | tail -18
NEG=${PIPESTATUS[0]}
echo "negative exit: $NEG"

if [ "$NEG" -eq 0 ]; then
  echo "NOT-VERIFIED: the command also passes WITHOUT the fix: it does not prove the defect"
  exit 1
fi

# --- optional regression check: whole suite, branch vs base ---
if [ "${VERIFY_BASELINE:-0}" = "1" ] && [ -f requirements.txt ]; then
  echo "--- baseline: full suite on the branch ---"
  BRANCH_OUT=$(.venv/bin/python -m pytest -q 2>&1 | tail -3)
  echo "$BRANCH_OUT"
  BRANCH_PASSED=$(echo "$BRANCH_OUT" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' | head -1)
  git checkout -- . >/dev/null 2>&1
  git checkout "origin/$BASE" -- . >/dev/null 2>&1
  echo "--- baseline: full suite on origin/$BASE ---"
  BASE_OUT=$(.venv/bin/python -m pytest -q 2>&1 | tail -3)
  echo "$BASE_OUT"
  BASE_PASSED=$(echo "$BASE_OUT" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' | head -1)
  if [ -n "${BRANCH_PASSED:-}" ] && [ -n "${BASE_PASSED:-}" ] && [ "$BRANCH_PASSED" -lt "$BASE_PASSED" ]; then
    echo "REGRESSION: branch passes $BRANCH_PASSED, base passes $BASE_PASSED"
    exit 1
  fi
  echo "baseline: branch ${BRANCH_PASSED:-?} vs base ${BASE_PASSED:-?} (no regression)"
fi

echo "VERIFIED: the command passes with the fix and fails without it"
exit 0
