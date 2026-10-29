# VPS Automation — paste ready, fill nothing

Agent: do everything below end-to-end. Do not ask for repo names, paths, or tokens. Derive everything. Model for all 24/7 work is always `opencode-go/muse-spark-1.3-contributor`. Never use deepseek or any other model.

## 0. Detect what this project is

Read `README.md`, file list, `package.json` / `requirements.txt` / `go.mod` / `Cargo.toml`, `src/` / `app/` layout.

- RESEARCH = hypothesis + proofs output. Signals: `findings/`, `corpus/`, triage/probe scripts, PoCs, goal is prove/gather evidence, not ship a product.
- DEVELOPMENT = shippable product. Signals: `src/`, `app/`, `components/`, `pages/`, `server/`, `Dockerfile`, build/start scripts, API routes, DB migrations, goal is ship features. Output is PRs.

Decide once, write it to `VPS_TYPE` (one word), commit it. Everything below branches on this.

## 0.5 Stop limits — ask the user, do not assume

One round, then proceed. Defaults in brackets.

1. Time: hours per day, which UTC window, until what date? [2h/day, 02:00-04:00 UTC, no end date]
2. Budget/dev cap: max cycles, max cost, max PRs? [no cap except time window]
3. Stop metric: what counts as done? Research: first reportable finding / all tracks exhausted / never. Development: plan complete / all CI green / N PRs merged / never. [never stop early]

Write answers at the top of `VPS.md` under `## Limits for this project` (this file), commit it. Set `START_HOUR_UTC` + `RUN_MINUTES` in the loop script from these values.

## Limits for this project

- Time: 2h/day, 02:00-04:00 UTC (07:30-09:30 IST), no end date
- Budget: no cap except time window (muse-spark via OpenCode Go)
- Stop: never stop early, keep logging
- Daily: 1 day = 1 branch, pushed every cycle

## 1. Auto-detect paths

```text
PROJ_DIR = current folder basename
REPO = sarthakdev143-lite/<basename>
VPS_DIR = ~/<basename>
```

Box is `sarthak` (Mumbai). VPS commands run as `bash -lc` in `$HOME`, 120s max. Long work goes in tmux, never in `run_command`. If `gh auth status` fails, stop.

## 2. Local git

- If not a repo: `git init -b main`
- If no `.gitignore`, create one: `node_modules/`, `__pycache__/`, `.venv/`, `.opencode-logs/`, `*.pyc`
- Stage sources + docs + findings. Never stage secrets (`.env`, tokens, `secrets.env`) or bulk (`node_modules`, `.venv`).
- Commit, then `gh repo create sarthakdev143-lite/<basename> --private --source=. --push` (or `git push -u origin main` if repo exists).

## 3. VPS clone + env

```
cd ~ && gh repo clone sarthakdev143-lite/<basename>
cd ~/<basename>
# python:
curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"; uv venv .venv; uv pip install -r requirements.txt
# node:
npm install --silent
```

Verify with the project's own quick command (<60s). Longer checks go in tmux.

## 4A. RESEARCH workflow (VPS_TYPE=research)

Brief for the agent (this is what the loop attaches):

```text
You live in ~/<basename> on box sarthak. Python .venv/bin/python, node 24.
Hard rules: work only from repo files. Every claim needs PoC + version + 5-15 line repro + cross-check. Append to findings/LOG.md, update findings/daily/YYYY-MM-DD.md.
Pipeline: read README first, run the repo's own verify command.
Tracks: 1. re-run baseline. 2. smallest next verifiable step from README/TODO. 3. prove, log, commit.
Daily: branch research/vps-YYYY-MM-DD (UTC). Work ONLY there. Never main. Small commits there. End of cycle update findings/daily/YYYY-MM-DD.md and push origin <branch>.
```

Loop `run-research.sh` (exact — never hand-edit the opencode line, it breaks quoting):

```bash
#!/bin/bash
set -u
cd "$HOME/<basename>"
export PATH="$HOME/.local/bin:$PATH"
mkdir -p findings findings/daily
START_HOUR_UTC=2
RUN_MINUTES=120
echo "[$(date -u +%FT%TZ)] boot 2h/day window ${START_HOUR_UTC}:00 UTC +${RUN_MINUTES}min: $(git rev-parse --short HEAD)" >> findings/24-7.log
CYCLE=0
while true; do
  NOW_EPOCH=$(date -u +%s)
  DAY_START=$(date -u -d "$(date -u +%F) ${START_HOUR_UTC}:00:00" +%s)
  WINDOW_END=$((DAY_START + RUN_MINUTES * 60))
  if [ "$NOW_EPOCH" -lt "$DAY_START" ]; then
    SLEEP_SEC=$((DAY_START - NOW_EPOCH))
    if [ "$SLEEP_SEC" -lt 60 ]; then SLEEP_SEC=60; fi
    if [ "$SLEEP_SEC" -gt 600 ]; then SLEEP_SEC=600; fi
    echo "[$(date -u +%FT%TZ)] idle until window ${START_HOUR_UTC}:00 UTC, sleep ${SLEEP_SEC}s" >> findings/24-7.log
    sleep "$SLEEP_SEC"
    continue
  fi
  if [ "$NOW_EPOCH" -ge "$WINDOW_END" ]; then
    NEXT_DAY=$(date -u -d "tomorrow" +%F)
    NEXT_START=$(date -u -d "$NEXT_DAY ${START_HOUR_UTC}:00:00" +%s)
    SLEEP_SEC=$((NEXT_START - NOW_EPOCH))
    if [ "$SLEEP_SEC" -lt 60 ]; then SLEEP_SEC=60; fi
    if [ "$SLEEP_SEC" -gt 600 ]; then SLEEP_SEC=600; fi
    echo "[$(date -u +%FT%TZ)] window done, next $NEXT_DAY ${START_HOUR_UTC}:00 UTC, sleep ${SLEEP_SEC}s" >> findings/24-7.log
    sleep "$SLEEP_SEC"
    continue
  fi
  CYCLE=$((CYCLE+1))
  TODAY=$(date -u +%F)
  BRANCH="research/vps-$TODAY"
  if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
    git checkout -b "$BRANCH" >> findings/24-7.log 2>&1
  else
    git checkout "$BRANCH" >> findings/24-7.log 2>&1
  fi
  echo "[$(date -u +%FT%TZ)] cycle $CYCLE start branch=$BRANCH" >> findings/24-7.log
  PROMPT_FILE=$(mktemp)
  cat VPS.md > "$PROMPT_FILE"
  {
    echo ""
    echo "Today is $TODAY, branch is $BRANCH (already checked out)."
    echo "Work one track for this cycle only, smallest verifiable step."
    echo "Commit to $BRANCH only. Update findings/daily/$TODAY.md and append to findings/24-7.log and findings/LOG.md."
  } >> "$PROMPT_FILE"
  MSG="Today is $TODAY branch $BRANCH. Read the attached brief and do one cycle."
  opencode run --model opencode-go/muse-spark-1.3-contributor -f "$PROMPT_FILE" "$MSG" >> findings/24-7.log 2>&1
  rm -f "$PROMPT_FILE"
  echo "[$(date -u +%FT%TZ)] cycle $CYCLE exit=$? branch=$BRANCH daily-push" >> findings/24-7.log
  git add findings/daily/"$TODAY".md findings/LOG.md 2>/dev/null || true
  git diff --cached --quiet || git commit -qm "daily: $TODAY update cycle $CYCLE"
  git push -u origin "$BRANCH" >> findings/24-7.log 2>&1 || true
  sleep 120
done
```

Start: `chmod +x run-research.sh; bash -n run-research.sh; tmux kill-session -t research 2>/dev/null; tmux new-session -d -s research -c ~/<basename> "bash -lc 'bash run-research.sh'"`. Verify `ps aux | grep muse-spark` + `tail findings/24-7.log`.

## 4B. DEVELOPMENT workflow (VPS_TYPE=development)

First cycle writes `VPS_PLAN.md` from README/TODO/issues (milestones → tasks, each task = 1 branch + 1 PR). Then task-by-task: branch `feat/YYYY-MM-DD-<slug>` from main, implement + test, push, `gh pr create --fill` to main. Never push main directly, never self-merge unless CI green and brief allows. Many `feat/*` PRs per day is expected. Daily rollup branch `dev/vps-YYYY-MM-DD` holds only status (`docs/daily/YYYY-MM-DD.md` + plan updates). Loop file `run-dev.sh` mirrors the research loop but uses `VPS.md`, session `dev`, log `docs/daily-24-7.log`, and pushes the daily branch.

## 5. View it

VPS portal terminal (box `sarthak`):
```
cd ~/<basename>
git branch -a
git log --oneline -10
tmux attach -t research  # or dev; Ctrl-b d to detach
tail -f findings/24-7.log  # or docs/daily-24-7.log
gh pr list  # development only
```

GitHub `sarthakdev143-lite/<basename>`: `main` + daily `origin/research/vps-*` (or `origin/dev/vps-*`) pushed every cycle + `origin/feat/*` PRs (dev only).

## 6. Troubleshooting

- `bash -n` syntax error on opencode line: restore this exact script, never hand-edit that line.
- `checkout blocked by local changes`: `git stash push -m wip --keep-index`, checkout/merge, `git stash pop`.
- Pull says diverging: `git fetch origin; git checkout main; git merge --ff-only origin/main; git checkout <daily-branch>; git merge main`.
- Wrong model in logs: stop, fix script to `opencode-go/muse-spark-1.3-contributor`, kill tmux, restart.
- 8x-desktops token fails: generate a fresh one in the Desktops portal, revoke the old one.
