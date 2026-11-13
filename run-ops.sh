#!/bin/bash
# Autonomous daily contributor loop. Works on a VPS or in a GitHub Codespace.
# Fixed start 01:00 UTC (06:30 IST). Up to 2 auto-submitted PRs/day, then sleep.
set -u

# ---- workspace + state (GitHub Actions, Codespace, or plain box) ----
if [ -n "${OSS_SCOUT_ROOT:-}" ]; then
  ROOT="$OSS_SCOUT_ROOT"
  IN_CODESPACE=0
elif [ -d /workspaces/oss-scout ]; then
  ROOT=/workspaces/oss-scout
  IN_CODESPACE=1
elif [ -n "${GITHUB_WORKSPACE:-}" ]; then
  ROOT="$GITHUB_WORKSPACE"      # GitHub Actions checkout
  IN_CODESPACE=0
else
  ROOT="$HOME/oss-scout"
  IN_CODESPACE=0
fi
if [ -n "${OSS_SCOUT_STATE_DIR:-}" ]; then
  STATE_DIR="$OSS_SCOUT_STATE_DIR"
elif [ -d /workspaces/oss-scout ]; then
  STATE_DIR=/workspaces/.oss-scout
else
  STATE_DIR="$HOME/.oss-scout"
fi
cd "$ROOT" || exit 1
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

# ---- tokens ----
# Box: ~/.oss-scout/env. Codespace: OSS_SCOUT_* secrets (GITHUB_TOKEN there is the
# codespace's own repo-scoped token and must never be used for upstream reads/writes).
if [ -f "$HOME/.oss-scout/env" ]; then
  set -a
  . "$HOME/.oss-scout/env"
  set +a
elif [ "$IN_CODESPACE" = "1" ] && [ -n "${OSS_SCOUT_GITHUB_TOKEN:-}" ]; then
  export GITHUB_TOKEN="$OSS_SCOUT_GITHUB_TOKEN"
  export OSS_SCOUT_WRITE_TOKEN="${OSS_SCOUT_WRITE_TOKEN:-}"
  if [ -n "${OSS_SCOUT_WRITE_TOKEN:-}" ]; then
    export GH_TOKEN="$OSS_SCOUT_WRITE_TOKEN"   # gh CLI: fork/push/PR need public_repo, not the codespace token
  else
    export GH_TOKEN="$OSS_SCOUT_GITHUB_TOKEN"
  fi
fi

# Overridable so one script serves a box, a codespace, and a single-run CI job.
START_HOUR_UTC=${START_HOUR_UTC:-1}
START_MIN_UTC=${START_MIN_UTC:-0}
MAX_SUBMITS_PER_DAY=${MAX_SUBMITS_PER_DAY:-2}
RUN_MINUTES=${RUN_MINUTES:-120}   # 2h/day fits the Codespaces free quota; CI runs one window then exits
RUN_ONCE=${RUN_ONCE:-0}           # 1 = exit when the window ends or the quota is met (GitHub Actions)
FORCE_WINDOW=${FORCE_WINDOW:-0}   # 1 = treat process start as the window start
MODEL="${MODEL:-opencode-go/deepseek-v4.1-flash#max}"

# GitHub's scheduler is routinely late (observed: 6.5h). A wall-clock window would therefore be
# already over when the job finally starts, so a single-run job always opens its own window.
if [ "$RUN_ONCE" = "1" ]; then
  FORCE_WINDOW=1
fi
LOG="docs/daily-24-7.log"
mkdir -p docs/daily "$STATE_DIR"

# Snapshot the brief BEFORE any branch switch: the daily branch can be older than main, and the
# agent must always receive the current rules, not whatever a stale branch still contains.
BRIEF_SNAPSHOT=$(mktemp)
cat VPS.md VPS_PLAN.md > "$BRIEF_SNAPSHOT" 2>/dev/null || true
trap 'rm -f "$BRIEF_SNAPSHOT"' EXIT

echo "[$(date -u +%FT%TZ)] ops boot root=$ROOT state=$STATE_DIR model=$MODEL window ${START_HOUR_UTC}:00 UTC +${RUN_MINUTES}min max ${MAX_SUBMITS_PER_DAY}/day run_once=$RUN_ONCE: $(git rev-parse --short HEAD 2>/dev/null)" >> "$LOG"

sleep_until_next_day() {
  NEXT_DAY=$(date -u -d "tomorrow" +%F)
  NEXT_START=$(date -u -d "$NEXT_DAY ${START_HOUR_UTC}:${START_MIN_UTC}:00" +%s)
  SLEEP_SEC=$((NEXT_START - NOW_EPOCH))
  if [ "$SLEEP_SEC" -lt 60 ]; then SLEEP_SEC=60; fi
  if [ "$SLEEP_SEC" -gt 600 ]; then SLEEP_SEC=600; fi
  echo "[$(date -u +%FT%TZ)] window done, next $NEXT_DAY ${START_HOUR_UTC}:00 UTC, sleep ${SLEEP_SEC}s" >> "$LOG"
  sleep "$SLEEP_SEC"
}

# One window per process for CI; forever-loop for a long-lived host.
CYCLES_RUN=0
QUOTA_MET_FLAG=0
window_done() {
  printf '{"cycles":%d,"quota_met":%d,"today":"%s","ended":"%s"}\n' \
    "$CYCLES_RUN" "$QUOTA_MET_FLAG" "$TODAY" "$(date -u +%FT%TZ)" > "$STATE_DIR/last-run.json" 2>/dev/null || true
  if [ "$RUN_ONCE" = "1" ]; then
    echo "[$(date -u +%FT%TZ)] window complete, RUN_ONCE set: exiting 0 (cycles=$CYCLES_RUN quota_met=$QUOTA_MET_FLAG)" >> "$LOG"
    exit 0
  fi
  sleep_until_next_day
}

# FORCE_WINDOW fixes the window start ONCE: recomputing it inside the loop would push the end
# forward on every iteration and the window would never close.
FORCED_START=""
if [ "$FORCE_WINDOW" = "1" ]; then
  FORCED_START=$(date -u +%s)
  echo "[$(date -u +%FT%TZ)] FORCE_WINDOW: treating now as window start, ${RUN_MINUTES}min window" >> "$LOG"
fi

while true; do
  NOW_EPOCH=$(date -u +%s)
  TODAY=$(date -u +%F)
  if [ "$FORCE_WINDOW" = "1" ]; then
    DAY_START=$FORCED_START
  else
    DAY_START=$(date -u -d "$TODAY ${START_HOUR_UTC}:${START_MIN_UTC}:00" +%s)
  fi
  if [ "$NOW_EPOCH" -lt "$DAY_START" ]; then
    SLEEP_SEC=$((DAY_START - NOW_EPOCH))
    if [ "$SLEEP_SEC" -lt 60 ]; then SLEEP_SEC=60; fi
    if [ "$SLEEP_SEC" -gt 600 ]; then SLEEP_SEC=600; fi
    echo "[$(date -u +%FT%TZ)] idle until ${START_HOUR_UTC}:00 UTC, sleep ${SLEEP_SEC}s" >> "$LOG"
    sleep "$SLEEP_SEC"
    continue
  fi
  WINDOW_END=$((DAY_START + RUN_MINUTES * 60))
  if [ "$NOW_EPOCH" -ge "$WINDOW_END" ]; then
    window_done
    continue
  fi

  SUBMIT_FILE="docs/daily/SUBMITTED-$TODAY.md"
  touch "$SUBMIT_FILE"
  SUBMITS=$(grep -c . "$SUBMIT_FILE" 2>/dev/null || true)
  if [ "${SUBMITS:-0}" -ge "$MAX_SUBMITS_PER_DAY" ]; then
    QUOTA_MET_FLAG=1
    window_done
    continue
  fi

  BRANCH="dev/vps-$TODAY"
  if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
    if git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
      git checkout -b "$BRANCH" "origin/$BRANCH" >> "$LOG" 2>&1   # continue the day's branch
    else
      git checkout -b "$BRANCH" >> "$LOG" 2>&1
    fi
  else
    git checkout "$BRANCH" >> "$LOG" 2>&1
  fi
  echo "[$(date -u +%FT%TZ)] ops cycle start branch=$BRANCH submits=$SUBMITS" >> "$LOG"
  CYCLES_RUN=$((CYCLES_RUN + 1))

  PROMPT_FILE=$(mktemp)
  cat "$BRIEF_SNAPSHOT" > "$PROMPT_FILE"
  {
    echo ""
    echo "Today is $TODAY. Repo root: $ROOT. Config: $STATE_DIR/oss-scout.config.json. Already submitted today: $SUBMITS (max $MAX_SUBMITS_PER_DAY). Branch $BRANCH is checked out."
    echo "ENVIRONMENT: $( [ "$IN_CODESPACE" = 1 ] && echo 'GitHub Codespace. Use OSS_SCOUT_GITHUB_TOKEN for reads and GH_TOKEN (write token) for gh CLI fork/push/PR. Never use the codespace GITHUB_TOKEN for upstream work.' || echo 'VPS box.')"
    echo "AUTONOMY RULES (no human will review; you are the approver, act conservatively):"
    echo "QUALITY BAR (GSoC-grade, enforced):"
    echo "a) NEVER file your own issues on allow-listed orgs. Work ONLY maintainer-filed issues carrying target labels (good first issue, help wanted, bug, confirmed, documentation, tests). No eligible labeled issue in an org = skip that org, log why, never invent work."
    echo "b) Docs-only PRs: max 1 per week across ALL orgs. The daily staple is code: bug fixes (failing test first) or small features."
    echo "c) Every code change must add or extend tests proving the fix; run the full relevant suite in the docker sandbox before and after."
    echo "d) First PR per org: keep it small and visibly follow that repo's CONTRIBUTING/PR template."
    echo "SELECTION (the funnel was starving: ~380 unassigned labeled issues exist, cycles kept finding none)"
    echo "s0) Read docs/ORG-FEASIBILITY.md first: it records each org's known gate (CLA, assignment, AI policy)."
    echo "    Do not re-derive a gate already recorded there; cite it. Update that file when you find a new one."
    echo "s0b) FIRST PR to any repo you have not contributed to before: read its AI policy before writing code -"
    echo "     CONTRIBUTING, AGENTS.md, and any policy page those link to. If it forbids unsolicited autonomous-agent"
    echo "     contributions (BeeWare and CircuitVerse both do), do not submit: record the gate and ask the owner to add"
    echo "     the repo to repos.deny. Being right about the bug does not excuse ignoring the policy."
    echo "s1) Pool: per org, query UP TO 100 open unassigned issues carrying a target label (good first issue, help wanted,"
    echo "    bug, confirmed, tests, documentation). Do not look only at the newest handful; build the pool, then choose."
    echo "s2) Blockers are ONLY these, each provable from the issue page: assigned to someone; linked to an open PR; a"
    echo "    commenter claimed it and a maintainer acknowledged or it shows a work-in-progress PR; stale with no maintainer"
    echo "    activity in 180 days; the repo's AI policy prohibits AI contributions or is unclear-and-restrictive."
    echo "    'Many people commented', 'looks contested', 'I am not sure' are NOT blockers. If none of the five blockers is"
    echo "    provable, the issue is ELIGIBLE."
    echo "s3) Rank eligible issues: prefer (a) small blast radius, (b) reproducible defect over feature, (c) file count the"
    echo "    repo's tests can cover, (d) maintainer-filed. Take the top one."
    echo "s4) Report: in docs/daily/$TODAY.md write the pool size per org and, for the top 3 candidates, the exact blocker"
    echo "    or the reason each was not chosen. A cycle may end with zero submissions ONLY when the pool was empty or every"
    echo "    candidate had a provable blocker from s2; state it in those words."
    echo "SCOPE (violations here are worse than submitting nothing):"
    echo "k1) Modify ONLY source, test and docs files that the chosen issue is about. Never create or edit agent"
    echo "    tooling or config in a target repo: no .claude/, .cursor/, .github/, AGENTS.md, CLAUDE.md, skills/,"
    echo "    pipeline scripts, or dotfiles. If you catch yourself building tooling inside the target repo, stop:"
    echo "    that is out of scope and must be reverted."
    echo "k2) Never force-push (no --force, no --force-with-lease). Never rewrite pushed history. Never open a branch"
    echo "    that is not needed for the one PR."
    echo "k3) Never work in a scratch directory belonging to an earlier cycle. Clone fresh under /tmp/<repo>-<date>."
    echo "k4) If the honest answer is that the issue is not fixable within these limits, submit nothing and say why."
    echo "1. Work only repos under repos.allow in $STATE_DIR/oss-scout.config.json. Never touch main directly."
    echo "2. Do the pipeline YOURSELF (the local scheduler has no LLM host, so ticks alone never start work; you are the worker): (a) check caps via status + today's SUBMITTED file, stop if quota met; (b) rotation: pick the next allow-listed org with no submission in the last 2 days; (c) run one scheduler tick for follow-ups only; (d) find ONE maintainer-filed issue with target labels via gh (verify labels, recent maintainer activity, CI, AI policy); none eligible = log the reason in docs/daily/$TODAY.md and end the cycle with zero submissions; (e) implement in a clean /tmp workspace + docker sandbox (baseline first, failing test first for bugs, minimal diff); (f) verify gate + critic self-review at 0.85 + strict security pass; one issue per cycle max."
    echo "3. Submit a PR ONLY if ALL hold: verification gate passes, critic approves, strict security review passes, repo AI policy is clear, disclosure line present, diff within limits, caps allow it."
    echo "4. Submit with gh using the write token only: fork, push the exact reviewed commit, open PR with disclosure. A candidate is skipped ONLY for a provable blocker from s2 or a mandatory upstream gate (CLA, assignment, AI policy); record which one."
    echo "5. Append one line per submitted PR to docs/daily/SUBMITTED-$TODAY.md, exactly these 7 fields:"
    echo "   '- <owner/repo> <PR-URL> <digest> <code+tests|docs-only> <maintainer-issue-URL> <fixed_file> <verify_cmd>'"
    echo "   fixed_file = the source file your fix changed. verify_cmd = the exact command that proves the fix in a"
    echo "   fresh clone (e.g. 'pytest tests/test_x.py -q', 'mvn -B -Dtest=FooTest test', 'npm test -- src/x.test.ts')."
    echo "   Everything after field 6 is the command, spaces included. Omit them and the submission is recorded unverified."
    echo "   Never write a test result you did not obtain by running that exact command: the harness re-runs it, and a"
    echo "   mismatch closes the PR automatically."
    echo "6. Stop after $MAX_SUBMITS_PER_DAY submissions. Update docs/daily/$TODAY.md with what ran, skipped, and why."
    echo "7. Rotate orgs across days: do not submit twice to the same org on consecutive days unless a maintainer asked for a follow-up."
    echo "8. Every cycle, check your previously submitted OPEN PRs for maintainer comments; address actionable feedback within 24h by updating the PR. Responsiveness is part of the quality bar."
    echo "9. First cycle of the day: read yesterday's docs/daily log and note any quality drift (nit-class PRs, weak tests, slow follow-ups); correct course before new work."
  } >> "$PROMPT_FILE"
  if [ -s "docs/daily/VIOLATION-$TODAY.md" ]; then
    {
      echo ""
      echo "QUALITY VIOLATION PENDING - resolve before any new submission:"
      cat "docs/daily/VIOLATION-$TODAY.md"
      echo "Resolution = close the offending PR with a brief note, or fix the gap and document it. Record the resolution in docs/daily/$TODAY.md and clear by emptying VIOLATION-$TODAY.md (keep the file, : > it)."
    } >> "$PROMPT_FILE"
  fi

  MSG="Today is $TODAY. Run one autonomous contributor cycle under the autonomy rules."
  # Bound one cycle: a hung agent must not hold the job until the 6h runner limit.
  timeout --signal=TERM "${CYCLE_TIMEOUT_MIN:-45}m" \
    opencode run --model "$MODEL" -f "$PROMPT_FILE" "$MSG" >> "$LOG" 2>&1
  rm -f "$PROMPT_FILE"
  echo "[$(date -u +%FT%TZ)] ops cycle exit=$? daily-push" >> "$LOG"

  # ---- post-cycle quality audit: verify every submission, block next cycle on violation ----
  : > docs/daily/VIOLATION-"$TODAY".md
  if [ -s "$SUBMIT_FILE" ]; then
    touch docs/daily/AUDIT-"$TODAY".md
    while IFS= read -r line || [ -n "$line" ]; do
      PR_URL=$(echo "$line" | awk '{print $3}')
      TAG=$(echo "$line" | awk '{print $5}')
      ISSUE_URL=$(echo "$line" | awk '{print $6}')
      case "$PR_URL" in http*) ;; *) continue;; esac
      # Re-audit when the ledger line itself changes (format migration, edited claim), not just
      # on first sight: otherwise a stale verdict sits in the file contradicting reality.
      if grep -qxF "ledger: $line" docs/daily/AUDIT-"$TODAY".md 2>/dev/null; then continue; fi
      if grep -qF "$PR_URL" docs/daily/AUDIT-"$TODAY".md 2>/dev/null && \
         grep -qF "ledger: $line" docs/daily/AUDIT-"$TODAY".md 2>/dev/null; then continue; fi
      {
        echo "ledger: $line"
        echo "## audit $PR_URL"
        BODY=$(gh pr view "$PR_URL" --json body -q '.body' 2>/dev/null || true)
        case "$BODY" in
          *"Prepared with AI assistance"*) echo "disclosure: OK";;
          *) echo "disclosure: VIOLATION (missing)";;
        esac
        FILES=$(gh pr view "$PR_URL" --json files -q '[.files[].path] | join(" ")' 2>/dev/null || true)
        echo "files: $FILES"
        if echo "$FILES" | grep -Eq '(^| )(\.claude/|\.cursor/|\.github/|skills/|AGENTS\.md|CLAUDE\.md)'; then
          echo "scope: VIOLATION (touches agent tooling/config instead of the issue's code)"
        else
          echo "scope: OK"
        fi
        if echo "$FILES" | grep -Eq '(^| )(.*/)?tests?/[^ ]*|(^| )test_[^ ]*\.py|(^| )[^ ]*[_-]test\.[^ ]*|(^| )[^ ]*\.(test|spec)\.[^ ]*'; then
          echo "tests: OK (test files touched)"
        else
          echo "tests: NONE (no test files in diff)"
        fi
        if [ -n "$ISSUE_URL" ]; then
          OWNER=$(echo "$line" | awk '{print $2}' | cut -d/ -f1)
          AUTHOR=$(gh issue view "$ISSUE_URL" --json author -q '.author.login' 2>/dev/null || true)
          if [ -n "$AUTHOR" ] && [ "$AUTHOR" = "$OWNER" ]; then
            echo "issue: VIOLATION (self-filed by $AUTHOR)"
          else
            echo "issue: OK (filed by ${AUTHOR:-unknown})"
          fi
        else
          echo "issue: VIOLATION (no linked maintainer issue)"
        fi
        if [ "$TAG" = "docs-only" ]; then
          DOCS_WEEK=$(grep -h "docs-only" docs/daily/SUBMITTED-*.md 2>/dev/null | wc -l)
          if [ "$DOCS_WEEK" -gt 1 ]; then
            echo "docs-quota: VIOLATION ($DOCS_WEEK docs-only, max 1/week)"
          else
            echo "docs-quota: OK"
          fi
        fi
        # Independent re-run of the claimed command. Runs here, by the harness, not the agent.
        REPO_SLUG=$(echo "$line" | awk '{print $2}')
        # The ledger line starts with "- ", so owner/repo is field 2 and the
        # command starts at field 8. Field 1 is the list marker.
        FIXED_FILE_PATH=$(echo "$line" | awk '{print $7}')
        VERIFY_CMD=$(echo "$line" | awk '{for (i=8; i<=NF; i++) printf "%s%s", $i, (i<NF ? " " : "")}')
        PR_BASE=$(gh pr view "$PR_URL" --json baseRefName -q '.baseRefName' 2>/dev/null)
        VERIFIER="${VERIFIER_PATH:-$ROOT/ops/verify-claim.sh}"
        FIELD_COUNT=$(echo "$line" | awk '{print NF}')
        LAST_FIELD=$(echo "$line" | awk '{print $NF}')
        if [ "$FIELD_COUNT" -ge 8 ] && { [ "$LAST_FIELD" = "main" ] || [ "$LAST_FIELD" = "master" ]; }; then
          # Old 8-field ledger line (test_path, fixed_file, base). Its fields 6-7 are not a command:
          # verifying it would run nonsense. Left open, flagged, never auto-closed.
          echo "claim: LEGACY-FORMAT (pre-verify_cmd ledger line; not re-run, PR left open for manual check)"
        elif [ ! -f "$VERIFIER" ]; then
          echo "claim: VIOLATION (verifier not found at $VERIFIER; nothing was checked)"
          echo "action: treat every submission this cycle as unverified"
        elif [ -n "$FIXED_FILE_PATH" ] && [ -n "$VERIFY_CMD" ]; then
          VERIFY_OUT=$(bash "$VERIFIER" "$REPO_SLUG" "$PR_URL" "$FIXED_FILE_PATH" "${PR_BASE:-master}" "$VERIFY_CMD" 2>&1)
          VERIFY_RC=$?
          echo "claim-check:"
          echo "$VERIFY_OUT" | tail -25
          if [ "$VERIFY_RC" -eq 0 ]; then
            echo "claim: VERIFIED (the command passes with the fix and fails without it)"
          elif [ "$VERIFY_RC" -eq 1 ]; then
            echo "claim: first run failed to reproduce; re-running before closing"
            sleep 10
            VERIFY_OUT2=$(bash "$VERIFIER" "$REPO_SLUG" "$PR_URL" "$FIXED_FILE_PATH" "${PR_BASE:-master}" "$VERIFY_CMD" 2>&1)
            VERIFY_RC2=$?
            echo "$VERIFY_OUT2" | tail -12
            if [ "$VERIFY_RC2" -eq 1 ]; then
              echo "claim: VIOLATION (two independent runs could not reproduce the claim)"
              gh pr close "$PR_URL" --comment "Automated verification could not reproduce this change's test evidence on two independent clean checkouts, so it is being closed rather than left for maintainers to review. The claim, as written, did not hold." >/dev/null 2>&1 || true
              echo "action: PR closed pending a reproducible fix"
            else
              echo "claim: INCONCLUSIVE (first run failed, second exited $VERIFY_RC2); PR left open"
            fi
          elif [ "$VERIFY_RC" -eq 3 ]; then
            echo "claim: UNVERIFIED-ENV (our tooling could not run this claim; PR left open)"
          else
            echo "claim: NOT-VERIFIED (verifier exit $VERIFY_RC); PR left open"
          fi
        else
          echo "claim: VIOLATION (no fixed_file/verify_cmd recorded, so nothing could be re-run)"
        fi
      } >> docs/daily/AUDIT-"$TODAY".md
    done < "$SUBMIT_FILE"
    if grep -q "VIOLATION" docs/daily/AUDIT-"$TODAY".md 2>/dev/null; then
      grep -B1 "VIOLATION" docs/daily/AUDIT-"$TODAY".md > docs/daily/VIOLATION-"$TODAY".md
      echo "[$(date -u +%FT%TZ)] QUALITY VIOLATION recorded, next cycle must resolve first" >> "$LOG"
    fi
  fi

  # The agent may have left the checkout on another branch or in a detached state; the daily log
  # commit must land on the daily branch, not wherever the session ended up.
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "detached")
  if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
    echo "[$(date -u +%FT%TZ)] checkout was on '$CURRENT_BRANCH', returning to $BRANCH" >> "$LOG"
    git stash push -u -m "ops-autosave-$TODAY" >> "$LOG" 2>&1 || true
    git checkout "$BRANCH" >> "$LOG" 2>&1 || git checkout -b "$BRANCH" >> "$LOG" 2>&1 || true
    git stash pop >> "$LOG" 2>&1 || true
  fi

  git add docs/daily/"$TODAY".md docs/daily/SUBMITTED-"$TODAY".md docs/daily/AUDIT-"$TODAY".md docs/daily/VIOLATION-"$TODAY".md VPS_PLAN.md 2>/dev/null || true
  git diff --cached --quiet || git commit -qm "ops: $TODAY cycle"
  git push -u origin "$BRANCH" >> "$LOG" 2>&1 || echo "[$(date -u +%FT%TZ)] WARNING daily push failed" >> "$LOG"
  sleep 120
done
