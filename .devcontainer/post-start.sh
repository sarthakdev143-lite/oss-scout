#!/usr/bin/env bash
# Codespaces postStartCommand: runs on EVERY start (unlike setup.sh, which runs on create).
# It restores tokens from Codespaces secrets, writes the autopilot config, and starts the
# 24/7 loop in tmux if the daily window is open. Safe to re-run.
set -u

ROOT="/workspaces/oss-scout"
STATE_DIR="/workspaces/.oss-scout"
LOG="$ROOT/docs/daily-24-7.log"
mkdir -p "$STATE_DIR" "$ROOT/docs/daily" 2>/dev/null || true

log() { echo "[$(date -u +%FT%TZ)] post-start: $*" >> "$LOG"; }

# 1. Tokens. In a codespace GITHUB_TOKEN is the codespace's own repo-scoped token: never use it
#    for upstream reads or writes. Only the OSS_SCOUT_* secrets are valid.
if [ -n "${OSS_SCOUT_GITHUB_TOKEN:-}" ]; then
  umask 077
  {
    printf 'GITHUB_TOKEN=%s\n' "$OSS_SCOUT_GITHUB_TOKEN"
    if [ -n "${OSS_SCOUT_WRITE_TOKEN:-}" ]; then
      printf 'OSS_SCOUT_WRITE_TOKEN=%s\n' "$OSS_SCOUT_WRITE_TOKEN"
      printf 'GH_TOKEN=%s\n' "$OSS_SCOUT_WRITE_TOKEN"
    else
      printf 'GH_TOKEN=%s\n' "$OSS_SCOUT_GITHUB_TOKEN"
    fi
  } > "$HOME/.oss-scout/env"
  chmod 600 "$HOME/.oss-scout/env"
  log "tokens restored from Codespaces secrets (write token: $([ -n "${OSS_SCOUT_WRITE_TOKEN:-}" ] && echo yes || echo NO))"
else
  log "WARNING OSS_SCOUT_GITHUB_TOKEN is empty: add the Codespaces secret, then stop/start this codespace"
fi

# 2. Autopilot config (kept in the state dir so a repo edit does not silently change live caps).
if [ -f "$ROOT/oss-scout.config.autopilot.json" ]; then
  cp "$ROOT/oss-scout.config.autopilot.json" "$STATE_DIR/oss-scout.config.json"
  export OSS_SCOUT_CONFIG="$STATE_DIR/oss-scout.config.json"
fi

# 3. Model auth is interactive and cannot be automated. Warn loudly instead of failing silently.
if [ ! -f "$HOME/.local/share/opencode/auth.json" ] && [ ! -f "$HOME/.config/opencode/auth.json" ]; then
  log "WARNING opencode is not logged in: run 'opencode auth login' once in this terminal (model opencode-go/muse-spark-1.3-contributor)"
fi

# 4. Docker (sandbox for untrusted repo code).
if docker info >/dev/null 2>&1; then
  log "docker OK"
else
  log "WARNING docker not ready yet; tasks will wait at the baseline stage"
fi

# 5. Start the loop only when the daily window is open and it is not already running.
if tmux has-session -t ops 2>/dev/null; then
  log "loop already running"
  exit 0
fi
NOW=$(date -u +%s)
DAY_START=$(date -u -d "$(date -u +%F) 01:00:00" +%s)
WINDOW_END=$((DAY_START + 120 * 60))
if [ "$NOW" -ge "$DAY_START" ] && [ "$NOW" -lt "$WINDOW_END" ]; then
  cd "$ROOT" || exit 0
  tmux new-session -d -s ops -c "$ROOT" "bash -lc 'bash $ROOT/run-ops.sh'"
  log "loop started (inside window)"
else
  log "outside 01:00-03:00 UTC window: loop not started (keep the codespace stopped to save quota)"
fi
