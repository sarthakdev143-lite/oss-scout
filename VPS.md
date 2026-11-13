# oss-scout autopilot — brief

This file is attached to every cycle. It describes the CURRENT setup. The 8x VPS no longer exists;
everything below runs on GitHub Actions.

## What this is

A plugin that finds, prepares and queues open-source contributions for a human to review. The
autopilot in this repo uses it to make one to two verified contributions a day, unattended, from the
owner's GitHub account.

- Type: `VPS_TYPE` = development (see that file)
- Owner/repo: `sarthakdev143-lite/oss-scout`
- Model for all autonomous work: `opencode-go/deepseek-v4.1-flash#max`

## Limits

- 01:00 UTC window, 120 minutes, at most 2 submissions/day.
- No spending cap beyond the model plan; runner is free because the repo is public.
- Never stop early: if nothing is eligible, say why in the daily log and end the cycle.

## Environment

- `.github/workflows/daily-ops.yml` runs the window (`RUN_ONCE=1`, opens its own window from job start
  because GitHub's cron is routinely hours late).
- `.github/workflows/repo-scout.yml` refreshes the target list every Monday and commits it.
- `.github/workflows/verify-pr.yml` re-runs a claimed fix; `gate-selftest.yml` proves the gate still works.
- State lives in `$HOME/.oss-scout` (cached between runs); config in `oss-scout.config.autopilot.json`.
- Tokens come from repo secrets: `OSS_SCOUT_READ_TOKEN`, `OSS_SCOUT_WRITE_TOKEN`, `OPENCODE_AUTH_B64`.
  Never print, log or commit a token.

## How work is chosen

Read `docs/ORG-FEASIBILITY.md` first. Then:

1. Rotation: the allow-listed repo touched least recently.
2. Pool: up to 100 open, unassigned issues per repo with a target label (`good first issue`,
   `help wanted`, `bug`, `confirmed`, `tests`, `documentation`).
3. Blockers are only: assigned; linked open PR; a claim a maintainer acknowledged; stale >180 days;
   the repo's AI policy forbids autonomous-agent contributions. "Looks contested" is not a blocker.
4. Rank by small blast radius, reproducible defect over feature, maintainer-filed.

## Quality bar (non-negotiable)

- Never file your own issues on allow-listed repos. Work maintainer-filed issues only.
- Docs-only changes: at most one per week across all repos. The staple is code with tests.
- Every code change needs a test that fails before the fix and passes after it.
- Modify only the files the issue is about. Never add agent tooling or config to a target repo
  (no `.claude/`, `.cursor/`, `.github/`, `skills/`, `AGENTS.md`, `CLAUDE.md`). Never force-push.
- First PR to a repo: read its AI policy (CONTRIBUTING, `AGENTS.md`, and any page they link) before
  writing code. Some projects forbid exactly this workflow; respect that and record it.
- Submit only when the verification gate, critic (0.85) and a strict security pass all agree.

## Ledger

One line per submission in `docs/daily/SUBMITTED-<date>.md`, exactly:

```
- <owner/repo> <PR-URL> <digest> <code+tests|docs-only> <issue-URL> <fixed_file> <verify_cmd>
```

`verify_cmd` is the exact command that proves the fix in a fresh clone, spaces allowed. The harness
re-runs it: with the fix it must pass, with `fixed_file` reverted it must fail. An unreproducible
claim closes the PR after two independent failures; a command the harness cannot run never closes it.

## Reporting

Every cycle updates `docs/daily/<date>.md` with the pool size, the candidates considered, the exact
blocker for each, and what was submitted. A zero-submission cycle must name a provable blocker per
candidate; "no survivor" alone is not an answer.

See `docs/OPS.md` for the operational detail and `docs/ORG-FEASIBILITY.md` for per-repo gates.
