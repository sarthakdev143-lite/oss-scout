# TRIAL Run — doomscroller (2026-10-30)

Scope: ONLY `sarthakdev143-lite/doomscroller` (public, default branch `master`).
Trial limits honored: max ONE issue + ONE PR, both trial-labeled. Nothing else touched.

## Setup
- Separate trial state: `/tmp/trial-config.json` (copy of `~/.oss-scout/oss-scout.config.json`
  with `stateDir /home/sarthak/.oss-scout-trial`, `repos.allow ["sarthakdev143-lite/doomscroller"]`,
  `screening.minStars 0`, `screening.minScore 0`, `mode queue`).
- All CLI calls used `--config /tmp/trial-config.json` from `~/oss-scout`; `oss-scout status`
  confirmed isolated state (0 queue items, trial stateDir). Tokens via `source ~/.oss-scout/env`.

## 1) Recon
- Repo: Python FastAPI + APScheduler + Streamlit YouTube-Shorts factory, SQLite, pytest suite.
- Issues: **0 open** confirmed (`gh issue list --state open` empty; `--state all` empty).
- Tests: `pytest.ini` → `testpaths = tests`, `slow` marker (real ffmpeg, ~3 min).
- Baseline in docker sandbox (`python:3.12-slim`, full `requirements.txt` install,
  `pytest -m "not slow"`): **189 passed, 1 failed, 14 deselected**.
  The 1 failure is `test_resolve_font_finds_something_on_this_machine` — the slim image
  ships no system fonts (`no usable font found`), environment-specific, unrelated to any change.
  (CLAUDE.md claims "124 fast / 138 total"; actual is 190 fast / 204 total — doc drift, not filed.)

## 2) Issue (ONE, trial-labeled)
- **#1** `[trial] Publish cadence docs drift: README/scheduler docstring say 3/day + 8h, code defaults are 8/day + 3h`
  https://github.com/sarthakdev143-lite/doomscroller/issues/1
- Genuine + verified: `app/config.py` defaults `uploads_per_day=8` / `upload_interval_hours=3`,
  `.env.example` agrees (8/3), scheduler derives `24 / uploads_per_day` (`app/scheduler.py:576,595`)
  = 3h at defaults — while README (7 spots) + scheduler docstring said 3/day + 8h,
  and the startup log hardcoded `"(8/day jitter)"`.

## 3) Fix (minimal diff, sandboxed)
- `README.md` (7 spots → 8/day + 3h) + `app/scheduler.py` docstring (default 3h) +
  startup log renders actual `uploads_per_day` instead of hardcoded 8.
- Diff: **2 files, 11+/11-** (under all caps). Docs-only + log string; no behavior change.
- Post-fix sandbox run: identical **189 passed / same 1 env-specific fail** → no regressions.
- Log format string simulated (`%`-args balanced), `scheduler.py` parses OK, stale-string grep clean.

## 4) Gates
- Verification gate: PASS (sandboxed baseline == post-fix; diff minimal; claims grep-verified).
- Critic (self-review): PASS — docs now match code, args balanced, no behavior change.
- Security review: PASS — no secrets/network/exec/input-handling changes; int-only log format.
  (Ravan subagent not available in this session; strict manual pass done instead.)

## 5) Submit (ONE PR, trial-labeled)
- Fork impossible: authed user `sarthakdev143-lite` owns the repo (GitHub rejects self-fork),
  so pushed the exact reviewed commit to trial branch `trial/docs-publish-cadence` on origin instead.
- **PR #2** `[oss-scout trial] Fix publish cadence docs drift (8/day + 3h defaults)`
  https://github.com/sarthakdev143-lite/doomscroller/pull/2
  Base `master`, head `trial/docs-publish-cadence` (single commit `dacb469`),
  closes #1, body contains disclosure line `Prepared with AI assistance; reviewed and tested by me.`

## Result
Trial COMPLETE: 1 issue + 1 PR submitted, all gates passed. No gate failed, no extra repos touched.
