#!/bin/bash
# Verify a submitted PR's test claim independently. Exit 0 only when the claim holds:
#   - the named test PASSES with the fix, and
#   - the same test FAILS when only the fixed file is reverted to the base branch.
# Usage: verify-claim.sh <owner/repo> <pr-url> <test_path> <fixed_file> <base_branch>
#
# Exit codes: 0 verified | 1 claim did not reproduce | 2 arguments unreachable
#             3 environment could not be built (pytest collection error: proves nothing about the fix)
set -uo pipefail

REPO="${1:-}"; PR_URL="${2:-}"; TEST_PATH="${3:-}"; FIXED_FILE="${4:-}"; BASE="${5:-}"
[ -n "$REPO" ] && [ -n "$PR_URL" ] && [ -n "$TEST_PATH" ] && [ -n "$FIXED_FILE" ] || {
  echo "NOT-VERIFIED: missing arguments (repo, pr_url, test_path, fixed_file[, base])"; exit 2; }
[ -n "$BASE" ] || BASE=master

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK" || exit 2

BRANCH=$(gh pr view "$PR_URL" --json headRefName -q '.headRefName' 2>/dev/null)
if [ -z "$BRANCH" ]; then echo "NOT-VERIFIED: cannot read PR head branch (auth or PR gone)"; exit 2; fi
if ! git clone --quiet --branch "$BRANCH" "https://github.com/$REPO.git" repo 2>/dev/null; then
  echo "NOT-VERIFIED: clone of $REPO@$BRANCH failed"; exit 2
fi
cd repo || exit 2
echo "head: $(git rev-parse --short HEAD) branch: $BRANCH"

if [ ! -f "$TEST_PATH" ]; then echo "NOT-VERIFIED: test file $TEST_PATH does not exist on the branch"; exit 1; fi

if [ -f requirements.txt ] || [ -f pyproject.toml ]; then
  python3 -m venv .venv >/dev/null 2>&1 || { echo "NOT-VERIFIED: cannot create venv"; exit 3; }
  .venv/bin/pip install -q --upgrade pip >/dev/null 2>&1
  .venv/bin/pip install -q pytest >/dev/null 2>&1

  if [ -f requirements.txt ]; then
    if .venv/bin/pip install -q -r requirements.txt >/tmp/pip1.log 2>&1; then
      echo "deps: requirements.txt installed as pinned"
    else
      echo "deps: pinned install failed; retrying without pins"
      # Strip only version specifiers, keep every package (a pin can point at a version that does
      # not exist on the index; that must not hide a real test result).
      grep -v -E '^\s*(#|$|-|git\+|https?:)' requirements.txt \
        | sed -E 's/[[:space:]]*(==|>=|<=|~=|!=|>|<).*$//' \
        | grep -v -E '^\s*$' | sort -u > /tmp/req_names.txt
      if ! .venv/bin/pip install -q -r /tmp/req_names.txt >/tmp/pip2.log 2>&1; then
        echo "deps: unpinned install also failed"
        tail -5 /tmp/pip2.log 2>/dev/null
        echo "NOT-VERIFIED: environment could not be built from requirements.txt"; exit 3
      fi
    fi
  fi
  PY=".venv/bin/python"
elif [ -f package.json ]; then
  echo "NOT-VERIFIED: node project; verification needs an explicit runner"; exit 3
else
  echo "NOT-VERIFIED: unrecognised project type"; exit 3
fi

echo "--- positive: test must pass with the fix ---"
$PY -m pytest -q "$TEST_PATH" 2>&1 | tail -12
POS=${PIPESTATUS[0]}

if [ "$POS" -eq 2 ] || [ "$POS" -eq 3 ] || [ "$POS" -eq 4 ]; then
  echo "NOT-VERIFIED: pytest could not run the test (exit $POS: collection/usage error, not a result)"
  exit 3
fi

echo "--- negative: same test with $FIXED_FILE reverted to origin/$BASE ---"
git fetch --quiet origin "$BASE" 2>/dev/null
if ! git checkout "origin/$BASE" -- "$FIXED_FILE" 2>/dev/null; then
  echo "NOT-VERIFIED: cannot revert $FIXED_FILE from origin/$BASE"; exit 2
fi
$PY -m pytest -q "$TEST_PATH" 2>&1 | tail -12
NEG=${PIPESTATUS[0]}

if [ "$NEG" -eq 2 ] || [ "$NEG" -eq 3 ] || [ "$NEG" -eq 4 ]; then
  echo "NOT-VERIFIED: pytest could not run the test after the revert (exit $NEG)"; exit 3
fi

if [ "$POS" -ne 0 ]; then echo "NOT-VERIFIED: test fails WITH the fix (exit $POS)"; exit 1; fi
if [ "$NEG" -eq 0 ]; then echo "NOT-VERIFIED: test also passes WITHOUT the fix: it does not prove the defect"; exit 1; fi
echo "VERIFIED: test passes with the fix and fails without it"
exit 0
