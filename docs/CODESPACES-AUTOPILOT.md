# Autopilot in a GitHub Codespace

The VPS is gone. This is the replacement host for the 24/7 contributor loop. It runs the same
model (`opencode-go/muse-spark-1.3-contributor`) and the same quality gates, with one hard
constraint you must plan around: **compute is metered**.

## Quota reality (read this first)

| Plan | Compute per month | At 2h/day |
|---|---|---|
| GitHub Free | 120 core-hours = **60 h on 2-core** | exactly 60 h — no slack |
| GitHub Pro / Student | 180 core-hours = **90 h** | comfortable |

* The loop therefore runs **2 h/day (01:00–03:00 UTC = 06:30–08:30 IST)**, not the old 5 h.
* A codespace **stops** after the idle timeout (max 240 min). It does not keep running on its own,
  and a stopped codespace costs storage only.
* **You can't be billed by accident** without a payment method: when the quota runs out GitHub
  blocks the codespace until the monthly reset.

## One-time setup

1. **Give `gh` the codespace scope** (required; the CLI refuses without it):

   ```bash
   gh auth refresh -h github.com -s codespace
   ```

2. **Add two Codespaces secrets** at <https://github.com/settings/codespaces> → *New secret*,
   each granted to `sarthakdev143-lite/oss-scout`:

   | Secret | What it is |
   |---|---|
   | `OSS_SCOUT_GITHUB_TOKEN` | fine-grained PAT, public repos **read-only** |
   | `OSS_SCOUT_WRITE_TOKEN` | classic PAT, **`public_repo` only** (fork / push / PR) |

   Never name a secret `GITHUB_*`: GitHub blocks those, and inside a codespace `GITHUB_TOKEN`
   is the codespace's own repo-scoped token, which cannot read or write upstream repos.

3. **Log opencode in non-interactively.** The OpenCode Go credential can be moved with
   `opencode auth export` / `import`, so no browser step is needed inside the codespace. On a
   machine already logged in:

   ```bash
   opencode auth export "OpenCode Console" | base64 -w0      # prints only to your terminal
   ```

   Put that value in a third Codespaces secret, `OPENCODE_AUTH_B64`. `post-start.sh` imports it on
   every start. Verify inside the codespace:

   ```bash
   opencode run --model opencode-go/muse-spark-1.3-contributor "reply ok"
   ```

4. **Set the idle timeout** to 240 minutes (Settings → Codespaces), so a 2 h window fits in one
   session.

## Daily operation

Create a codespace just before 01:00 UTC. `postStartCommand` runs automatically and, if it is
inside the window, starts the loop in tmux:

```bash
gh codespace create -R sarthakdev143-lite/oss-scout -m basicLinux32gb --idle-timeout 240m
gh codespace code -R sarthakdev143-lite/oss-scout --web   # or: gh codespace ssh
```

In the codespace:

```bash
tmux attach -t ops          # Ctrl-b d to detach
tail -f docs/daily-24-7.log
bun run cli doctor
```

Stop it when the window is done — that is what protects the quota:

```bash
gh codespace stop -c <name>
```

## What runs unchanged

* Quality bar: maintainer-filed labeled issues only, no self-filed issues, tests required,
  docs-only max 1/week, critic at 0.85, strict security pass.
* Post-cycle audit writes `docs/daily/AUDIT-<date>.md`; any violation writes
  `docs/daily/VIOLATION-<date>.md` and blocks the next submission until resolved.
* Ledger: `docs/daily/SUBMITTED-<date>.md` — one line per PR, with its maintainer issue URL.
* Caps: 2 submissions/day, 14/week, 1 open PR per repo, 30-day per-repo cooldown.

## Known limits

* **A stopped codespace runs nothing.** If you do not start it, that day produces no PRs.
  This is the main behavioural change from the VPS.
* **Interactive auth expiry.** If the OpenCode Go credential expires, cycles fail fast and the log
  says so; re-export it and update the `OPENCODE_AUTH_B64` secret.
* **Storage counts while stopped.** A codespace stopped for 30 days is deleted with its state.
