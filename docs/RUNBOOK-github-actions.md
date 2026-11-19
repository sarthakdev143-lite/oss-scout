# Runbook: run the daily contributor loop on GitHub Actions (free)

Written 2026-11-12, when the 8x VPS box stopped being available. Goal: the same autonomous
daily cycle that `run-ops.sh` ran in tmux on the box, now as one scheduled GitHub Actions job.
This repo is public, so standard Linux runners are free with unlimited minutes, and
`ubuntu-latest` ships Docker (the sandbox runtime in the config). Implement this on a branch
from `main`, open a PR, and test it with a manual run before relying on the schedule.

## What ran on the box (the behaviour to keep)

- `run-ops.sh`, started in tmux, looped forever: a daily window from 01:00 UTC for 300 minutes,
  at most 2 submitted PRs per day, one `opencode run` cycle at a time with a 120 s pause.
- Model: `opencode-go/muse-spark-1.3-contributor` (OpenCode Go plan), opencode **2.0.24**, Bun.
- Each cycle: works on branch `dev/vps-<today>`, builds the prompt from `VPS_PLAN.md`
  + the autonomy rules, runs the agent, audits every submitted PR (disclosure line, tests,
  maintainer-filed issue, docs quota), records violations, commits `docs/daily/*` and pushes the
  daily branch.
- State lived outside the repo in `~/.oss-scout/`: `oss-scout.config.json` (mode `queue`,
  13 allow-listed repos, caps, budget, `sandbox.runtime: docker`), `oss-scout.db` (25.7 MB
  pipeline database), `env` and `logs/`.
- Tokens: `GITHUB_TOKEN` (fine-grained PAT, read use) and `OSS_SCOUT_WRITE_TOKEN` (classic PAT,
  `public_repo`), from `~/.oss-scout/env` and the opencode service env.
- The `ravan` security-review agent and 15 skills came from the global opencode config
  (`~/.config/opencode/agents/ravan.md`, `~/.config/opencode/skills/`), not from this repo.

A copy of all of that box state is on the laptop at
`D:\Sarthak\vps-sarthak\2026-11-12\extracted\box-config\` (`.oss-scout\` and
`.config\opencode\`). It contains live tokens: read values from those files into
`gh secret set`, never paste them into a chat or commit them.

## Target design

`.github/workflows/daily-ops.yml`:

- Triggers: `schedule: cron "0 1 * * *"` and `workflow_dispatch` (with an input to force a
  window now, for testing).
- `concurrency: oss-scout-daily` (never two runs at once), `timeout-minutes: 340`
  (under the 6 h job limit), `permissions: contents: write`.
- Steps:
  1. `actions/checkout` with `fetch-depth: 0`; then `ln -s "$GITHUB_WORKSPACE" "$HOME/oss-scout"`
     so `run-ops.sh` finds the repo at the path it expects.
  2. Git identity for the daily commits: `sarthakdev143-lite` /
     `sarthakdev143.official@gmail.com`.
  3. `oven-sh/setup-bun`, then `bun install`.
  4. Install opencode **2.0.24** (pin the version the box ran) and log it in to OpenCode Go
     non-interactively from a secret. Find out how opencode 2.x stores provider credentials on
     a logged-in machine, and restore exactly that from the secret. This is the one step that
     needs research.
  5. Restore state with `actions/cache/restore` (path `~/.oss-scout`, key
     `oss-scout-state-${{ github.run_id }}`, restore-keys `oss-scout-state-`).
     On the first run (cache miss), seed it (see below).
  6. Install the global agent and skills: commit `ravan.md` and the skills the prompt relies on
     under e.g. `ops/opencode-global/` (check them for secrets first, the repo is public) and
     copy them to `~/.config/opencode/` in this step.
  7. Run the loop in single-window mode (see `run-ops.sh` change) with env:
     `GITHUB_TOKEN: ${{ secrets.OSS_SCOUT_READ_TOKEN }}` (secret names cannot start with
     `GITHUB_`, the env var can), `OSS_SCOUT_WRITE_TOKEN: ${{ secrets.OSS_SCOUT_WRITE_TOKEN }}`,
     and whatever `gh` needs to run the audit (`GH_TOKEN`). Run opencode standalone so it sees
     this env (README: the V2 background service has its own environment).
  8. `actions/cache/save` with `if: always()` so state survives a failed or timed-out run.
  9. Upload `docs/daily-24-7.log` and `~/.oss-scout/logs/` as an artifact for debugging.

`run-ops.sh` change (keep the box behaviour as the default):

- Add `RUN_ONCE=1`: when the window ends or the daily quota is met, **exit 0** instead of
  sleeping until tomorrow. Add `FORCE_WINDOW=1`: treat "now" as the window start (for manual
  test runs outside 01:00 UTC). Everything else (prompt, audit, commit, push) stays identical.

Secrets to create (`gh secret set NAME < file` from the laptop copy):

- `OSS_SCOUT_READ_TOKEN`: the box's `GITHUB_TOKEN` value.
- `OSS_SCOUT_WRITE_TOKEN`: the box's `OSS_SCOUT_WRITE_TOKEN` value.
- The OpenCode Go credential (name it after step 4's research).

Seeding `oss-scout.db` (25.7 MB, too big for a secret): either start with fresh state (the
pipeline re-discovers; history stays in `docs/daily/`), or one-time seed: encrypt the db with a
passphrase stored as a secret, publish the encrypted file somewhere the run can download, let the
first run decrypt it into `~/.oss-scout/`, then delete the encrypted file. After that the cache
carries it forward.

## Things to know

- Scheduled runs can start late when GitHub is busy; the window logic must use elapsed time,
  not the wall clock alone.
- Caches unused for 7 days are evicted; daily runs keep it alive. If it is ever lost, the run
  starts with fresh state.
- GitHub disables scheduled workflows in public repos after 60 days without repo activity; the
  daily branch pushes should count, otherwise re-enable it from the Actions tab.
- Keep it to this one daily job: GitHub's terms allow Actions for project automation, not as
  general always-on compute.
- Model cost is unchanged: the OpenCode Go plan must stay active.

## Done when

1. A manual run (`FORCE_WINDOW=1`, short window) completes a cycle, pushes `dev/vps-<today>`
   and saves the state cache.
2. The next manual run restores the cache (same `oss-scout.db`, queue intact).
3. The scheduled run at 01:00 UTC runs on its own and exits after the window or the quota.
4. No token value appears in the repo, the logs or the artifacts.
