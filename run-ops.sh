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
    echo "1. Work only repos under repos.allow in ~/.oss-scout/oss-scout.config.json. Never touch main directly."
    echo "2. Advance the oss-scout pipeline (status/queue/show are read-only and allowed)."
    echo "3. Submit a PR ONLY if ALL hold: verification gate passes, critic approves, ravan security review passes, repo AI policy is clear, disclosure line present, diff within limits, caps allow it."
    echo "4. Submit with gh using OSS_SCOUT_WRITE_TOKEN only: fork, push the exact reviewed commit, open PR with disclosure. Any doubt = skip, record reason in docs/daily/$TODAY.md."
    echo "5. Append one line per submitted PR to docs/daily/SUBMITTED-$TODAY.md: '- <repo> <PR-URL> <digest>'."
    echo "6. Stop after $MAX_SUBMITS_PER_DAY submissions. Update docs/daily/$TODAY.md with what ran, skipped, and why."
  } >> "$PROMPT_FILE"
  MSG="Today is $TODAY. Run one autonomous contributor cycle under the autonomy rules."
  opencode run --model opencode-go/muse-spark-1.3-contributor -f "$PROMPT_FILE" "$MSG" >> "$LOG" 2>&1
  rm -f "$PROMPT_FILE"
  echo "[$(date -u +%FT%TZ)] ops cycle exit=$? daily-push" >> "$LOG"
  git add docs/daily/"$TODAY".md docs/daily/SUBMITTED-"$TODAY".md VPS_PLAN.md 2>/dev/null || true
  git diff --cached --quiet || git commit -qm "ops: $TODAY cycle"
  git push -u origin "$BRANCH" >> "$LOG" 2>&1 || true
  sleep 120
done
