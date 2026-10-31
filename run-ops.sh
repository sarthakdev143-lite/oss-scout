#!/bin/bash
# Autonomous daily contributor loop for ~/oss-scout on box sarthak.
# Fixed start 01:00 UTC (06:30 IST). Up to 2 auto-submitted PRs/day, then sleep.
set -u
if [ -f "$HOME/.oss-scout/env" ]; then
  set -a
  . "$HOME/.oss-scout/env"
  set +a
fi
cd "$HOME/oss-scout"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
mkdir -p docs/daily
START_HOUR_UTC=1
START_MIN_UTC=0
MAX_SUBMITS_PER_DAY=2
WINDOW_MINUTES=300
LOG="docs/daily-24-7.log"
echo "[$(date -u +%FT%TZ)] ops boot daily 01:00 UTC, max ${MAX_SUBMITS_PER_DAY}/day: $(git rev-parse --short HEAD)" >> "$LOG"
while true; do
  NOW_EPOCH=$(date -u +%s)
  TODAY=$(date -u +%F)
  DAY_START=$(date -u -d "$TODAY ${START_HOUR_UTC}:${START_MIN_UTC}:00" +%s)
  if [ "$NOW_EPOCH" -lt "$DAY_START" ]; then
    SLEEP_SEC=$((DAY_START - NOW_EPOCH))
    if [ "$SLEEP_SEC" -lt 60 ]; then SLEEP_SEC=60; fi
    if [ "$SLEEP_SEC" -gt 600 ]; then SLEEP_SEC=600; fi
    echo "[$(date -u +%FT%TZ)] idle until 01:00 UTC, sleep ${SLEEP_SEC}s" >> "$LOG"
    sleep "$SLEEP_SEC"
    continue
  fi
  WINDOW_END=$((DAY_START + WINDOW_MINUTES * 60))
  if [ "$NOW_EPOCH" -ge "$WINDOW_END" ]; then
    NEXT_DAY=$(date -u -d "tomorrow" +%F)
    NEXT_START=$(date -u -d "$NEXT_DAY ${START_HOUR_UTC}:${START_MIN_UTC}:00" +%s)
    SLEEP_SEC=$((NEXT_START - NOW_EPOCH))
    if [ "$SLEEP_SEC" -lt 60 ]; then SLEEP_SEC=60; fi
    if [ "$SLEEP_SEC" -gt 600 ]; then SLEEP_SEC=600; fi
    echo "[$(date -u +%FT%TZ)] window done, next $NEXT_DAY 01:00 UTC, sleep ${SLEEP_SEC}s" >> "$LOG"
    sleep "$SLEEP_SEC"
    continue
  fi
  SUBMIT_FILE="docs/daily/SUBMITTED-$TODAY.md"
  touch "$SUBMIT_FILE"
  SUBMITS=$(grep -c . "$SUBMIT_FILE" 2>/dev/null || true)
  if [ "${SUBMITS:-0}" -ge "$MAX_SUBMITS_PER_DAY" ]; then
    NEXT_DAY=$(date -u -d "tomorrow" +%F)
    NEXT_START=$(date -u -d "$NEXT_DAY ${START_HOUR_UTC}:${START_MIN_UTC}:00" +%s)
    SLEEP_SEC=$((NEXT_START - NOW_EPOCH))
    if [ "$SLEEP_SEC" -lt 60 ]; then SLEEP_SEC=60; fi
    if [ "$SLEEP_SEC" -gt 600 ]; then SLEEP_SEC=600; fi
    echo "[$(date -u +%FT%TZ)] quota met ($SUBMITS/$MAX_SUBMITS_PER_DAY), sleep ${SLEEP_SEC}s" >> "$LOG"
    sleep "$SLEEP_SEC"
    continue
  fi
  BRANCH="dev/vps-$TODAY"
  if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
    git checkout -b "$BRANCH" >> "$LOG" 2>&1
  else
    git checkout "$BRANCH" >> "$LOG" 2>&1
  fi
  echo "[$(date -u +%FT%TZ)] ops cycle start branch=$BRANCH submits=$SUBMITS" >> "$LOG"
  PROMPT_FILE=$(mktemp)
  cat VPS.md VPS_PLAN.md > "$PROMPT_FILE"
  {
    echo ""
    echo "Today is $TODAY. Already submitted today: $SUBMITS (max $MAX_SUBMITS_PER_DAY). Already on branch $BRANCH."
    echo "AUTONOMY RULES (no human will review; you are the approver, act conservatively):"
    echo "QUALITY BAR (GSoC-grade, enforced):"
    echo "a) NEVER file your own issues on allow-listed orgs. Work ONLY maintainer-filed issues carrying target labels (good first issue, help wanted, bug, confirmed, documentation, tests). No eligible labeled issue in an org = skip that org, log why, never invent work."
    echo "b) Docs-only PRs: max 1 per week across ALL orgs. The daily staple is code: bug fixes (failing test first) or small features."
    echo "c) Every code change must add or extend tests proving the fix; run the full relevant suite in the docker sandbox before and after."
    echo "d) First PR per org: keep it small and visibly follow that repo's CONTRIBUTING/PR template."
    echo "1. Work only repos under repos.allow in ~/.oss-scout/oss-scout.config.json. Never touch main directly."
    echo "2. Do the pipeline YOURSELF this cycle (the local scheduler has no LLM host, so ticks alone never start work; you are the worker): (a) check caps via status + today's SUBMITTED file, stop if quota met; (b) rotation: pick the next allow-listed org with no submission in the last 2 days; (c) run one scheduler tick for follow-ups only; (d) find ONE maintainer-filed issue with target labels via gh (verify labels, recent maintainer activity, CI, AI policy); none eligible = log the reason in docs/daily/$TODAY.md and end the cycle with zero submissions; (e) implement in a clean /tmp workspace + docker sandbox (baseline first, failing test first for bugs, minimal diff); (f) verify gate + critic self-review at 0.85 + strict security pass; one issue per cycle max."
    echo "3. Submit a PR ONLY if ALL hold: verification gate passes, critic approves, ravan security review passes, repo AI policy is clear, disclosure line present, diff within limits, caps allow it."
    echo "4. Submit with gh using OSS_SCOUT_WRITE_TOKEN only: fork, push the exact reviewed commit, open PR with disclosure. Any doubt = skip, record reason in docs/daily/$TODAY.md."
    echo "5. Append one line per submitted PR to docs/daily/SUBMITTED-$TODAY.md: '- <repo> <PR-URL> <digest> <code+tests|docs-only> <maintainer-issue-URL>'. No line without a real maintainer-issue URL."
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
      echo "Resolution = close the offending PR with a brief note, or fix the gap and document it. Then delete NO files; record the resolution in docs/daily/$TODAY.md and clear by emptying VIOLATION-$TODAY.md (keep the file, : > it)."
    } >> "$PROMPT_FILE"
  fi
  MSG="Today is $TODAY. Run one autonomous contributor cycle under the autonomy rules."
  opencode run --model opencode-go/muse-spark-1.3-contributor -f "$PROMPT_FILE" "$MSG" >> "$LOG" 2>&1
  rm -f "$PROMPT_FILE"
  echo "[$(date -u +%FT%TZ)] ops cycle exit=$? daily-push" >> "$LOG"
  # ---- post-cycle quality audit: verify every submission, block next cycle on violation ----
  : > docs/daily/VIOLATION-"$TODAY".md
  if [ -s "$SUBMIT_FILE" ]; then
    touch docs/daily/AUDIT-"$TODAY".md
    while IFS= read -r line || [ -n "$line" ]; do
      PR_URL=$(echo "$line" | awk '{print $3}');
      TAG=$(echo "$line" | awk '{print $5}');
      ISSUE_URL=$(echo "$line" | awk '{print $6}');
      case "$PR_URL" in http*) ;; *) continue;; esac
      grep -qF "$PR_URL" docs/daily/AUDIT-"$TODAY".md 2>/dev/null && continue
      {
        echo "## audit $PR_URL"
        BODY=$(gh pr view "$PR_URL" --json body -q '.body' 2>/dev/null || true)
        case "$BODY" in
          *"Prepared with AI assistance"*) echo "disclosure: OK";;
          *) echo "disclosure: VIOLATION (missing)";;
        esac
        FILES=$(gh pr view "$PR_URL" --json files -q '[.files[].path] | join(" ")' 2>/dev/null || true)
        echo "files: $FILES"
        if echo "$FILES" | grep -Eq '(^| )(.*/)?tests?/[^ ]*|[^ ]*[_-]test\.[^ ]*|[^ ]*\.test\.[^ ]*' ; then
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
            echo "docs-quota: VIOLATION ($DOCS_WEEK docs-only in repo history, max 1/week)"
          else
            echo "docs-quota: OK"
          fi
        fi
      } >> docs/daily/AUDIT-"$TODAY".md
    done < "$SUBMIT_FILE"
    if grep -q "VIOLATION" docs/daily/AUDIT-"$TODAY".md 2>/dev/null; then
      grep -B1 "VIOLATION" docs/daily/AUDIT-"$TODAY".md > docs/daily/VIOLATION-"$TODAY".md
      echo "[$(date -u +%FT%TZ)] QUALITY VIOLATION recorded, next cycle must resolve first" >> "$LOG"
    fi
  fi
  git add docs/daily/"$TODAY".md docs/daily/SUBMITTED-"$TODAY".md docs/daily/AUDIT-"$TODAY".md docs/daily/VIOLATION-"$TODAY".md VPS_PLAN.md 2>/dev/null || true
  git diff --cached --quiet || git commit -qm "ops: $TODAY cycle"
  git push -u origin "$BRANCH" >> "$LOG" 2>&1 || true
  sleep 120
done
