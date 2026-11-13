# How the autopilot runs (post-VPS)

The 8x VPS is gone. The contributor loop now runs on GitHub Actions, free for this public repo.

## Schedule

`.github/workflows/daily-ops.yml`

- Cron `0 1 * * *` (01:00 UTC = 06:30 IST), plus manual dispatch.
- `concurrency: oss-scout-daily` — never two runs at once.
- `timeout-minutes: 340` — under the 6h job ceiling.
- **A run opens its own window from when the job actually starts.** GitHub's scheduler is late in
  practice (observed 6.5h), so a wall-clock window would already be closed and the job would do
  nothing while reporting success. `RUN_ONCE=1` implies `FORCE_WINDOW=1`.
- Window length 120 min by default; the loop exits early when the daily PR quota (2) is met.

## What one cycle does

1. Pick an org by rotation (least recently submitted).
2. Build a candidate pool: up to 100 open, unassigned issues per org carrying a target label.
3. Reject only on five provable blockers: assigned, linked PR, acknowledged claim, 180-day stale,
   AI policy restricts. "Looks contested" is not a blocker.
4. Implement in a clean workspace, failing test first, minimal diff.
5. Gates: verification, critic (0.85), security.
6. Submit: fork, push, PR with the disclosure line.
7. Record the submission in `docs/daily/SUBMITTED-<date>.md`.

## The ledger contract

One line per submission, exactly 7+ fields:

```
- <owner/repo> <PR-URL> <digest> <code+tests|docs-only> <issue-URL> <fixed_file> <verify_cmd>
```

`verify_cmd` is everything from field 7 to end of line, so it may contain spaces.
Lines in the older 8-field shape (ending in `main`/`master`) are recognised as legacy and are
never executed or auto-closed.

## Verification (the part that must not be trusted on faith)

`ops/verify-claim.sh <repo> <pr-url> <fixed_file> <base> <verify_cmd>`

- Clones the base repo, `gh pr checkout` (fork PRs included).
- Installs dependencies: pinned, then unpinned on failure; pytest for manifest-less repos; npm
  for Node.
- Runs `verify_cmd` with the fix → must succeed.
- Reverts only `fixed_file` to base → `verify_cmd` must now fail.
- `VERIFY_BASELINE=1` additionally compares full-suite pass counts against base.

Exit codes: `0` verified · `1` claim did not reproduce · `2` unreachable · `3` environment could
not be built.

Behaviour in the nightly audit:

| Outcome | Action |
|---|---|
| verified | recorded, PR left open |
| exit 1 | **PR closed** with a neutral comment |
| exit 3 | `UNVERIFIED-ENV` — left open, flagged; never closed for our own tooling gap |
| missing verifier / no fields | violation; blocks the next submission |

`.github/workflows/gate-selftest.yml` pins this behaviour: a known-good fix must verify, and a
command that proves nothing (`true`) must be rejected. It runs weekly.

## Inspect

```bash
gh run list --workflow=daily-ops.yml --limit 5
gh run view <id> --log
gh pr list --author sarthakdev143-lite --state all
gh api "repos/sarthakdev143-lite/oss-scout/commits?sha=dev/vps-$(date -u +%F)&per_page=10"
```

## Stop it

```bash
gh workflow disable daily-ops
```

Per-run: cancel from the Actions tab. Nothing else is scheduled.

## Limits worth remembering

- Cron can start hours late; 60 days of repo inactivity disables the schedule.
- Free minutes apply because the repo is public; a private repo would consume quota.
- `verify_cmd` is agent-supplied and executes in the runner. It proves claims; it does not sandbox
  a hostile agent. The agent already runs arbitrary commands during a cycle, so this is not a new
  privilege — but it is not containment either.
- Java/Node repos rely on the command bringing its own tooling; those surface as `UNVERIFIED-ENV`
  rather than false verdicts.
- Success is merge rate, not PR count.
