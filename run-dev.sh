#!/bin/bash
set -u
cd "$HOME/oss-scout"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
mkdir -p docs/daily
START_HOUR_UTC=2
RUN_MINUTES=120
echo "[$(date -u +%FT%TZ)] boot 2h/day window ${START_HOUR_UTC}:00 UTC +${RUN_MINUTES}min: $(git rev-parse --short HEAD)" >> docs/daily-24-7.log
CYCLE=0
while true; do
  NOW_EPOCH=$(date -u +%s)
  DAY_START=$(date -u -d "$(date -u +%F) ${START_HOUR_UTC}:00:00" +%s)
  WINDOW_END=$((DAY_START + RUN_MINUTES * 60))
  if [ "$NOW_EPOCH" -lt "$DAY_START" ]; then
    SLEEP_SEC=$((DAY_START - NOW_EPOCH))
    if [ "$SLEEP_SEC" -lt 60 ]; then SLEEP_SEC=60; fi
    if [ "$SLEEP_SEC" -gt 600 ]; then SLEEP_SEC=600; fi
    echo "[$(date -u +%FT%TZ)] idle until window ${START_HOUR_UTC}:00 UTC, sleep ${SLEEP_SEC}s" >> docs/daily-24-7.log
    sleep "$SLEEP_SEC"
    continue
  fi
  if [ "$NOW_EPOCH" -ge "$WINDOW_END" ]; then
    NEXT_DAY=$(date -u -d "tomorrow" +%F)
    NEXT_START=$(date -u -d "$NEXT_DAY ${START_HOUR_UTC}:00:00" +%s)
    SLEEP_SEC=$((NEXT_START - NOW_EPOCH))
    if [ "$SLEEP_SEC" -lt 60 ]; then SLEEP_SEC=60; fi
    if [ "$SLEEP_SEC" -gt 600 ]; then SLEEP_SEC=600; fi
    echo "[$(date -u +%FT%TZ)] window done, next $NEXT_DAY ${START_HOUR_UTC}:00 UTC, sleep ${SLEEP_SEC}s" >> docs/daily-24-7.log
    sleep "$SLEEP_SEC"
    continue
  fi
  CYCLE=$((CYCLE+1))
  TODAY=$(date -u +%F)
  BRANCH="dev/vps-$TODAY"
  if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
    git checkout -b "$BRANCH" >> docs/daily-24-7.log 2>&1
  else
    git checkout "$BRANCH" >> docs/daily-24-7.log 2>&1
  fi
  echo "[$(date -u +%FT%TZ)] cycle $CYCLE start branch=$BRANCH" >> docs/daily-24-7.log
  PROMPT_FILE=$(mktemp)
  cat VPS.md VPS_PLAN.md > "$PROMPT_FILE"
  {
    echo ""
    echo "Today is $TODAY, branch is $BRANCH (already checked out)."
    echo "Pick the next unchecked task from VPS_PLAN.md. Branch feat/$TODAY-<slug> from main, implement + test, push, open PR with gh pr create --fill to main. Never push main directly."
    echo "Then update docs/daily/$TODAY.md and VPS_PLAN.md on $BRANCH only and commit there."
  } >> "$PROMPT_FILE"
  MSG="Today is $TODAY branch $BRANCH. Read the attached brief and do one cycle."
  opencode run --model opencode-go/muse-spark-1.3-contributor -f "$PROMPT_FILE" "$MSG" >> docs/daily-24-7.log 2>&1
  rm -f "$PROMPT_FILE"
  echo "[$(date -u +%FT%TZ)] cycle $CYCLE exit=$? branch=$BRANCH daily-push" >> docs/daily-24-7.log
  git add docs/daily/"$TODAY".md VPS_PLAN.md 2>/dev/null || true
  git diff --cached --quiet || git commit -qm "daily: $TODAY update cycle $CYCLE"
  git push -u origin "$BRANCH" >> docs/daily-24-7.log 2>&1 || true
  sleep 120
done
