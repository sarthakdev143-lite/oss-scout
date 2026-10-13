# oss-scout

An [opencode](https://opencode.ai) plugin that finds, prepares and queues open-source contributions for
**you** to review and submit. It works through a pipeline: discover repos → screen their policies and
health → pick issues → implement a fix in a sandboxed clone → verify it → critic review → approval queue →
follow up on review feedback.

Nothing is written to GitHub until you approve it. No push, no fork, no PR and no comment happens
without your approval. The default mode is **dry-run**.

> **Assumptions (read first)**
>
> * **opencode V2 is the primary target.** The installed `opencode` is **2.0.24**, and V2 does not load
>   V1 plugins. oss-scout exports a V2 plugin (`{ id, setup }`). It also exports a V1 `server()` entry for
>   opencode 1.x ≥ 1.18.29, but that entry has not been run against a live V1 server. Under V1, approvals
>   are done from the CLI only. The docs at opencode.ai/docs describe V1; the V2 docs are at
>   opencode.ai/v2/docs.
> * **Fine-grained tokens cannot open PRs on repos you don't own.** This is a documented GitHub gap.
>   Use `GITHUB_TOKEN` (fine-grained, public read) for everything automatic. For approved writes, set
>   `OSS_SCOUT_WRITE_TOKEN` to a classic PAT with only the `public_repo` scope. If you don't, approval
>   falls back to `GITHUB_TOKEN`. If GitHub refuses, you get a ready-to-click compare URL instead.
> * **Untrusted code runs only in Docker or Podman.** If neither is available, tasks wait at the
>   `baseline` stage. There is deliberately no "run on the host" fallback.
> * **Forks are created at approval time, not during preparation**, because forking is a GitHub write.
>   Preparation clones the upstream read-only into an isolated workspace.

## Contents

- [How it works](#how-it-works)
- [Install](#install) (and [Run in GitHub Codespaces](#run-in-github-codespaces))
- [Configure](#configure)
- [Run in dry-run](#run-in-dry-run)
- [Review and approve](#review-and-approve)
- [Commands and tools](#commands-and-tools)
- [Safety model](#safety-model)
- [State, logs and status](#state-logs-and-status)
- [Known limitations](#known-limitations)
- [Development](#development)

## How it works

```
discover ─▶ screen ─▶ select issue ─▶ prepare ─▶ baseline ─▶ implement ─▶ verify ─▶ critic ─▶ approval queue
                                                                                                │
                                         you: /oss-approve <id> <digest>  ◀─────────────────────┘
                                                    │ (queue mode only)
                                                    ▼
                                      fork ─▶ push ─▶ open PR ─▶ follow-up poll ─▶ drafted replies/fixes ─▶ queue
```

* **Discovery.** Reads the manifests in your own repos (`package.json`, `requirements*.txt`,
  `pyproject.toml`, `pom.xml`, `build.gradle[.kts]`) and maps each dependency to its GitHub repo through
  deps.dev, npm, PyPI or Maven Central. It also runs repository searches built from your `interests`.
* **Screening.** Looks at recent maintainer activity, the merge rate for outside PRs, time to first
  response, CI, the stale PR backlog and the license. It also reads `CONTRIBUTING`, `CODE_OF_CONDUCT`,
  PR templates and any **AI/LLM policy**. Each repo gets a score and reasons. It is hard-skipped when it
  scores below the threshold or when its AI policy prohibits AI contributions or is unclear and
  restrictive.
* **Issue selection.** Prefers issues labelled `good first issue`, `help wanted`, confirmed bugs, docs
  and tests. Skips issues that are assigned, already linked to a PR, claimed by someone else in the
  comments, stale, or waiting on a design decision. Also skips "good first issue" issues in repos that
  reserve them for new human contributors. An issue you rejected, or whose task failed or was
  abandoned, is never picked again.
* **Implementation.** An opencode agent session reads and edits files in its task directory only. It
  has no shell, no web access, no sub-agents, and no MCP or other plugins' tools. For bugs it first
  writes a failing test; the sandbox confirms the test fails. It then writes the minimal fix; the
  sandbox confirms the tests and linter pass. It gets up to `implementation.maxAttempts` tries.
* **Verification gate.** Checks that tests pass, lint passes, tests were added, the reproduction was
  observed, and the diff size and number of files are within limits. Also checks for unrelated changes
  (lockfiles, CI, formatting), secrets (on the raw, unredacted diff), a filled-in PR template and the
  AI disclosure.
* **Critic.** A separate, tool-less review step acts as a skeptical maintainer. It can use a different
  model (`critic.model`). Anything short of a confident approve rejects the task.
* **Approval queue.** Each item holds the repo, issue link, diff, PR title and body, test output,
  verification results and critic notes. Each item is also written to `<stateDir>/queue/<id>/`
  (default `~/.oss-scout/queue/<id>/`) so you can read and edit it.
* **Follow-through.** After you submit, oss-scout polls your PRs, summarises the reviews and drafts
  replies or follow-up fixes into the same queue. It never replies on its own.

## Install

Requirements: [Bun](https://bun.sh) ≥ 1.3, git, opencode 2.x, and Docker Desktop or Podman for the
sandbox.

```bash
git clone <this repo> oss-scout && cd oss-scout
bun install                      # opencode V2 does not install local plugin dependencies itself
bun run test                     # optional: run the unit tests (bun test with a 30 s per-test timeout)
```

Register the plugin with opencode. Either of these works:

* **Project-local:** run opencode inside this directory. `.opencode/plugins/oss-scout.ts` is picked up
  automatically.
* **From anywhere:** add the repo directory (not a `.ts` file) to `~/.config/opencode/opencode.jsonc`.
  `configPath` is optional (see [Configure](#configure) for where the config is looked up):

  ```jsonc
  { "plugins": [{ "package": "D:/path/to/oss-scout", "options": { "configPath": "~/.oss-scout/oss-scout.config.json" } }] }
  ```

After `bun install`, or any change to dependencies, restart the opencode service: `opencode service restart`.

**Tokens.** The opencode V2 background service has its own environment, separate from your shell.
Either start opencode with `--standalone` from a shell where the variables are set, or give them to
the service:

```bash
opencode service set env GITHUB_TOKEN <fine-grained PAT>        # read-only use is enough
opencode service set env OSS_SCOUT_WRITE_TOKEN <classic PAT>     # optional; scope: public_repo only
```

`opencode service set env` probably stores the value in plain text in the service config file. If
that matters to you, use `--standalone` instead. Either way, the tokens are in the environment of
opencode's own shell tool too: see [Who can approve](#who-can-approve).

**Token permissions.**

* `GITHUB_TOKEN`: a fine-grained PAT with resource owner = you and access to public repositories
  (read-only). No extra permissions are needed for discovery and screening. If you want approved pushes
  to use this token, give it *Contents: read & write* with **All repositories**. Forks created later are
  not added to a "selected repositories" list.
* `OSS_SCOUT_WRITE_TOKEN` (recommended for queue mode): a classic PAT with only the `public_repo`
  scope. It is used only after you approve an item.

### Run in GitHub Codespaces

No Docker on your machine? Run oss-scout in a GitHub Codespace. It is free within the monthly quota
(60 hours a month on a 2-core machine) and needs no payment method. The repository ships a dev
container with Docker-in-Docker and pinned versions of Bun and opencode. It also ships a Codespaces
config preset, `oss-scout.config.codespaces.json`, which reads its tokens from the Codespaces secrets
`OSS_SCOUT_GITHUB_TOKEN` and `OSS_SCOUT_WRITE_TOKEN`. In a codespace, `doctor` checks that the
codespace's own `GITHUB_TOKEN` isn't used and that the state survives rebuilds. See
[docs/CODESPACES.md](docs/CODESPACES.md).

## Configure

Create `oss-scout.config.json`. Every field has a default. Where it is looked up (first match wins):

| | opencode plugin | CLI (`bun src/cli.ts …`) |
|---|---|---|
| 1 | the `configPath` plugin option | `--config <path>` |
| 2 | `$OSS_SCOUT_CONFIG` | `$OSS_SCOUT_CONFIG` |
| 3 | — | `./oss-scout.config.json` (current directory) |
| 4 | `~/.oss-scout/oss-scout.config.json` | `~/.oss-scout/oss-scout.config.json` |
| 5 | `oss-scout.config.json` in this checkout | `oss-scout.config.json` in this checkout |
| 6 | built-in defaults | built-in defaults |

* **The project you open in opencode is never a config source.** A cloned repository cannot change
  oss-scout's settings, token or API host.
* **Keep the CLI on the same config as the plugin.** Run the CLI from this checkout, where it resolves
  like a plugin without a `configPath` option, or pass the same file with `--config` /
  `OSS_SCOUT_CONFIG`. The kill switch and the database
  live in the config's `stateDir`, so a CLI on another config acts on another state dir. `kill`,
  `resume` and `approve` print the config and state dir they used. `doctor` warns about config files
  that exist but are not used.
* **Relative paths.** `stateDir` and `homeDirectory` in a file resolve against the file's folder. A
  relative `configPath`, and the paths of a config given only as plugin options, resolve against this
  checkout.
* **Changes need a restart.** The plugin reads its config once, when opencode loads it. Restart
  opencode (`opencode service restart`) after editing the file. Until then, `/oss-doctor` warns, and
  `/oss-approve` refuses to run while the file on disk differs from the loaded one in `mode` (or
  another file would now be found). The CLI reads the config on every run.

This is enough to start:

```json
{
  "$schema": "./schema/oss-scout.config.schema.json",
  "interests": {
    "languages": ["TypeScript", "JavaScript", "Python", "Java"],
    "topics": ["react", "nextjs", "fastapi", "spring-boot", "mongodb", "llm"]
  }
}
```

See [`oss-scout.config.example.json`](oss-scout.config.example.json) for an example and
[`schema/oss-scout.config.schema.json`](schema/oss-scout.config.schema.json) for every option. The most
important settings:

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `"dry-run"` | `dry-run`: prepare everything; approving writes nothing to GitHub. `queue`: approving creates the fork, branch and PR. `off`: no background work. Takes effect after an opencode restart. |
| `homeDirectory` | the config file's folder (this checkout on defaults) | The opencode location whose plugin runs the background loop. With the config in `~/.oss-scout/`, set it to the folder you run opencode in. |
| `caps.maxOpenPrsPerRepo` | `1` | Counts your open PRs, queued items (pending, dry-run-approved in the last 7 days, being submitted) and in-flight tasks per repo. |
| `caps.repoCooldownDays` | `30` | Days a repo is skipped after one of your PRs there is merged or closed. |
| `caps.maxSubmittedPrsPerWeek` | `3` | Rolling 7 days, across all repos. New work also counts queued items and tasks in progress, so they do not overshoot the cap once submitted. A dry-run approval counts for 7 days. |
| `caps.maxPendingQueueItems` | `3` | Stop preparing new work while this many items wait for your review. |
| `repos.allow` / `repos.deny` | `[]` | Entries like `"owner/repo"` or `"owner/*"`. Deny wins. A non-empty allow list is exclusive. |
| `screening.*` | | Minimum stars and score, maintainer activity window, merge-rate floor, CI/license requirements, AI-policy strictness. |
| `issues.labels` / `issues.excludeLabels` | | Preferred labels and labels that are skipped. |
| `implementation.model`, `critic.model` | opencode default | `"providerID/modelID"`. Use a different model for the critic if you can. |
| `implementation.maxAttempts` | `3` | Attempts before a task is abandoned. The reason is recorded. |
| `budget.perTask` / `budget.perDay` | 600k / 3M tokens, $5 / $20 | LLM caps per task and per day, checked before each agent prompt and each generation call. One agent session can overshoot them; see [Known limitations](#known-limitations). |
| `sandbox.runtime` | `"docker"` | `"docker"` or `"podman"`. |
| `disclosure.line` | `"Prepared with AI assistance; reviewed and tested by me."` | Added to every PR body. Must mention AI. Cannot be disabled. |
| `stateDir` | `~/.oss-scout` | DB, workspaces, queue files, logs, kill switch. Must be outside any git repository: agent sessions are refused there, and `doctor` fails. |
| `github.tokenEnv` / `github.writeTokenEnv` | `GITHUB_TOKEN` / `OSS_SCOUT_WRITE_TOKEN` | Environment variables holding the tokens. The name must be upper case and contain `GITHUB`, `GH_` or `OSS_SCOUT`, so a config cannot send another secret (such as `OPENAI_API_KEY`) as a GitHub token. |
| `github.apiBaseUrl` | `https://api.github.com` | The only host the token is sent to. Another `https://` host is accepted only when the environment sets `OSS_SCOUT_ALLOW_CUSTOM_GITHUB_API=1`. |

## Run in dry-run

1. Set `GITHUB_TOKEN` (see above) and write a config. `mode` defaults to `dry-run`.
2. Start opencode in the home directory: `homeDirectory`, which defaults to the folder holding the
   config file (this checkout when you use the project-local setup or no config file). The background
   loop only runs in that location. Running opencode elsewhere just gives you the commands.
3. Check health with `/oss-doctor`, then `/oss-status`. The CLI equivalents are
   `bun src/cli.ts doctor` (exit code 2 when a check fails) and `bun src/cli.ts status`. When a tick
   is skipped, for example because `GITHUB_TOKEN` is not set, status says why ("last tick skipped 3s
   ago: GITHUB_TOKEN not set") and the log records it once at info level.
4. Leave it running. Each tick, roughly every 60 s, the scheduler:
   1. polls follow-ups, when they are due
   2. runs discovery, about every 24 h
   3. screens a few repos
   4. advances any tasks that are due
   5. starts a new task when the caps allow it

   `/oss-run` forces a tick now.

Without Docker or Podman, tasks stop at the `baseline` stage with "sandbox unavailable". Discovery,
screening and selection still run, so you can watch the candidate list grow in `/oss-status`.

## Review and approve

Do the full review in a terminal, or read the files in `<stateDir>/queue/<id>/` (`REVIEW.md`,
`diff.patch`, `PR_BODY.md`, `test-output.txt`) in your editor:

```bash
bun src/cli.ts queue
bun src/cli.ts show 3              # full review: diff, PR title/body, tests, gate results, critic notes, digest
bun src/cli.ts approve 3 1a2b3c4d  # shows what will happen, then asks you to type the repo name (e.g. acme/widget)
```

In opencode:

```
/oss-queue                     list pending items
/oss-show 3                    summary: status, digest, check results, critic verdict, AI rules, file paths
/oss-edit 3 title Fix crash on zero timeout
/oss-edit 3 sync               after editing <stateDir>/queue/3/PR_BODY.md in your editor
/oss-reject 3 not the approach maintainers asked for
/oss-approve 3 1a2b3c4d        approve exactly what you reviewed (digest prefix from show)
```

* **Slash-command output goes to the session inbox.** opencode V2 shows it and consumes it with your
  next message, so the model reads it as well. That is why `/oss-show` (and the `oss_scout_*` tools)
  never include a diff, PR body, test output or critic text, and why repo names, titles, links and
  error messages sit below an "Untrusted third-party data" line. Long output is cut at about 6,000
  characters.
* An approval must quote the first 8+ characters of the item's **digest**: a SHA-256 over the kind,
  repo, title, body, diff and, for PRs and fixes, the exact commit that will be pushed. Any edit
  changes the digest, so you always approve exactly what you last reviewed.
* **In dry-run**, approving checks the caps and the issue's freshness, then records the exact planned
  actions (fork, push, PR payload). Nothing is written. The approved item counts toward the caps for 7
  days; reject it to free the slot sooner. To submit for real, set `"mode": "queue"`, restart opencode
  (`opencode service restart`) and approve the same item again.
* **In queue mode**, approving ensures a fork exists, pushes exactly the reviewed commit to the branch,
  opens the PR (disclosure line re-checked) and starts tracking it for follow-ups. Caps are re-checked
  and the slot is reserved in the same database transaction, so two approvals cannot both take the last
  slot.
* **Interrupted submissions.** If opencode stops mid-submission, the item stays "approved" and is
  treated as interrupted after 15 minutes. Approve it again to resume (a PR that was already opened is
  adopted, nothing is written twice) or reject it.
* **Follow-up fixes come one at a time per PR.** While a fix for a PR waits in the queue, new review
  requests for that PR are kept and turned into the next fix after this one is approved or rejected.
* A drafted review reply cannot be approved in a repo whose AI policy asks for human-written replies.
  Answer on GitHub yourself; `/oss-status` lists such PRs under "New review activity to answer yourself".

### Who can approve

Only you. The paths are `/oss-approve`, a slash command you type (opencode runs it without the model),
and the CLI in an interactive terminal.

* The `oss_scout_*` tools cannot approve. When asked to, they tell the model that only you can.
* The CLI refuses `approve`, `resume`, `edit` and `sync` unless stdin and stdout are a terminal. An
  agent's shell tool is not one, so the command fails with "approval must be run interactively by a
  human in a terminal". In a terminal, `approve` prints the repo, kind, title, mode and what will be
  written to GitHub, then asks you to type the repository name. `resume` asks you to type `resume`.
  Anything else aborts.
* These checks stop an agent from running the CLI. They do not stop an agent that has an unrestricted
  shell and your tokens in its environment from calling GitHub directly. In opencode, the chat agent's
  shell runs with the opencode environment, including the tokens. Deny that agent the shell, or keep
  `OSS_SCOUT_WRITE_TOKEN` out of opencode's environment and run approvals from a terminal where it is
  set.
* In Git Bash's own window (mintty), Bun does not see a terminal. Use Windows Terminal, PowerShell or
  the VS Code terminal, or prefix the command with `winpty`.

## Commands and tools

| Slash command (V2) | CLI | What it does |
|---|---|---|
| `/oss-status` | `status` | Mode, kill switch, scheduler (including the last skipped tick and why), current task, queue size, caps used, budget, rate limits, last errors, recently skipped repos and issues with reasons, review activity to answer yourself |
| `/oss-queue [status]` | `queue` | List queue items |
| `/oss-show <id>` | `show <id>` | opencode: a summary and the review file paths. CLI: the full review view |
| `/oss-approve <id> <digest>` | `approve <id> <digest>` * | Human approval (the only path to GitHub writes) |
| `/oss-reject <id> <reason>` | `reject <id> <reason>` | Reject. The issue is not picked again. |
| `/oss-edit <id> title\|body <text>` / `sync` | `edit …` * / `sync <id>` * | Edit the title or body (disclosure is kept) |
| `/oss-kill [reason]` / `/oss-resume` | `kill` / `resume` * | Global kill switch |
| `/oss-run` | `run` | Force one scheduler tick |
| `/oss-doctor` | `doctor` | Checks the config (and other config files it found), tokens, sandbox and state dir |
| | `config-schema` | Prints the config JSON Schema |

\* Interactive terminal only; `approve` and `resume` also ask you to confirm by typing.

Every CLI command takes `--config <path>` before the command name, e.g. `bun src/cli.ts --config
~/.oss-scout/oss-scout.config.json kill`. CLI exit codes: `0` ok, `1` error, `2` when `doctor` reports a
`[FAIL]` check (scripts and CI can gate on it).

The opencode agent also gets these tools, so you can ask in chat. None of them can write to GitHub:
`oss_scout_status`, `oss_scout_queue_list`, `oss_scout_queue_show`, `oss_scout_queue_reject`,
`oss_scout_queue_edit`.

## Safety model

1. **Human approval before any GitHub write.** Every mutating GitHub call needs a `WriteAuthorization`.
   Only the approval executor can mint one, and only from an approved item whose digest you quoted,
   in `queue` mode. The executor is reachable only from `/oss-approve` and the CLI's `approve`, which
   needs an interactive terminal and your typed confirmation ([Who can approve](#who-can-approve)).
   The scheduler and the agent tools cannot reach it. The writer client has writes disabled outside
   queue mode. Approval pushes exactly the commit you reviewed.
2. **Transparency.** Every PR body carries the disclosure line, and the schema rejects lines that
   don't mention AI. Drafted replies carry a reply disclosure. There is no timing randomisation, typing
   simulation or other behaviour meant to look manual. Pacing exists only to respect maintainers (caps,
   cooldowns) and rate limits.
3. **Repo rules are respected.** CONTRIBUTING, CODE_OF_CONDUCT, PR templates and AI policies are read.
   Repos that prohibit AI contributions, or are unclear and restrictive about them, are skipped with
   the reason recorded. PR templates must be filled in. DCO sign-off is applied when required. CLA and
   "open an issue first" requirements are flagged on the queue item. Repos that reserve good first
   issues for human newcomers have those issues skipped.
4. **Isolation of untrusted code.** Installs, tests and linters run only in containers:
   * `--network none` for tests and lint
   * `--cap-drop ALL`, `no-new-privileges`, a read-only root filesystem, and memory/CPU/pids limits
   * the git directory lives outside the work tree and is mounted read-only

   Host-side git always runs with an explicit `--git-dir`/`--work-tree`, an empty global config, no
   hooks, no fsmonitor, no external diff, and `--no-verify`. The agent session is placed in the task
   directory, not in the clone, so the clone's own opencode config or plugins never load. Its
   permissions are deny-by-default (V2 session rules; under V1 the per-prompt tool map starts with
   `"*": false`), and a tool guard allows only the file tools (`read`, `edit`, `write`, `patch`,
   `glob`, `grep`, `list`) and the todo list. Shell, web, sub-agents, questions, MCP server tools,
   other plugins' tools, paths outside the task directory and writes to opencode config files are
   refused. As a second layer, the guard resolves the path arguments of file tools through symlinks
   and junctions and blocks any that end up outside the clone (`<task>/repo`). Symlinks planted by repo
   code that point outside the work tree, and nested `.git` entries, are removed before every agent turn
   and host git command. opencode config files that still appear in the task directory are deleted
   before the session starts and after every prompt, and that attempt is discarded. Agent sessions are refused
   outright when the state dir is inside a git repository, because opencode would treat that whole
   repository as the session's project.
5. **Secrets.** Tokens are read only from the environment and scrubbed from log lines, audit records,
   command output and error messages. The one exception is the git diff fed to the secrets gate, which
   is kept raw so that token-shaped strings in a change fail the gate. Tokens are never put in argv,
   remote URLs, files or sandboxes. A push gets the token through `GIT_CONFIG_*` environment
   variables. The token is only sent to `https://api.github.com` (another host needs
   `OSS_SCOUT_ALLOW_CUSTOM_GITHUB_API=1` in the environment) and to `github.com` for pushes, and only
   read from variables whose names contain `GITHUB`, `GH_` or `OSS_SCOUT`. The config is never read
   from the project opened in opencode.
6. **Caps, budgets and the kill switch.** Caps are enforced at selection and again at approval. Token
   and cost budgets are checked before each agent prompt and each generation call, and the usage
   reported by opencode is recorded as each call ends. The kill switch (`<stateDir>/KILL`, `/oss-kill`
   or `bun src/cli.ts kill`) stops the scheduler, interrupts a running implementation (agent session
   and sandbox runs), and blocks all GitHub traffic and approvals. The CLI's `kill` acts on the state
   dir of the config it loaded and prints it; see [Configure](#configure).

## State, logs and status

Paths below are under `stateDir` (default `~/.oss-scout`).

* **SQLite DB**, `<stateDir>/oss-scout.db`, holds repos, issues, tasks, queue items, PR tracking, the
  audit log, errors, LLM usage, the ETag cache and the scheduler lease. Every decision is recorded with
  its reasons. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the schema.
* **Structured logs** are written as JSON lines to `<stateDir>/logs/oss-scout.log`, redacted.
* **Workspaces**: `<stateDir>/workspaces/<task>/repo` is the work tree; `<stateDir>/gitdirs/<task>`
  is the git directory.
* **Status** comes from `/oss-status` or `bun src/cli.ts status`.
* **Resuming:** tasks persist their stage. After a restart the scheduler picks up where it stopped,
  with backoff on errors and a pause until reset when rate limited.

## Known limitations

* **Fine-grained tokens and upstream PRs.** A fine-grained PAT cannot open PRs or comment on upstream
  repos you don't own. Use a classic `public_repo` token for `OSS_SCOUT_WRITE_TOKEN`, or follow the
  manual compare URL that oss-scout prints. Fork creation with a fine-grained token is not documented
  either way.
* **No sandbox means no implementation.** Without Docker or Podman, implementation never starts. On
  Windows you need Docker Desktop with WSL 2, or Podman.
* **Command detection is heuristic.** The install, test and lint commands for npm, pnpm, yarn, bun,
  pip, poetry, Maven and Gradle are guessed. Repos with unusual setups may fail at baseline. Use
  `implementation.overrides["owner/repo"]` to fix them.
* **Offline tests.** Tests run without network. Suites that need network, such as integration tests,
  fail baseline and are skipped.
* **The V1 adapter is untested live.** Under opencode V1 there are no slash commands, so approve from
  the CLI in a terminal.
* **The plugin needs a running server.** The scheduler runs inside opencode's server process. If the
  server stops, work pauses; it resumes from the database on the next start.
* **Budgets are checked between LLM calls, not during one.** One agent session runs until it ends or
  times out (`implementation.sessionTimeoutMinutes`, 30 by default) before the next check, so it can
  overshoot `budget.perTask` and `budget.perDay`.
* **Critic and follow-up costs are estimated.** These use opencode's tool-less text generation, which
  under V2 reports no usage. oss-scout records an estimate of the tokens (characters / 4) and $0, so
  the cost caps do not see that spend. A generation that times out cannot be cancelled: it may finish
  in the background, and nothing is recorded for it. Under V1 the reported tokens and cost are used.
* **Config changes need an opencode restart.** See [Configure](#configure).
* **The terminal check is not a sandbox.** It keeps an agent from running the CLI, not an agent with
  a shell and your tokens from calling GitHub itself; see [Who can approve](#who-can-approve).
* **Policy classification is keyword- and regex-based.** It may misclassify unusual wording. Treat the
  recorded evidence as a hint, and add repos to `repos.deny` freely.
* **The critic is a heuristic filter, not a replacement for your own review.** Read the diff before
  approving.

## Development

```bash
bun install
bun run test          # unit tests (GitHub API, sandbox and LLM are mocked); = bun test --timeout 30000
bun run typecheck     # tsc --noEmit, strict
bun src/cli.ts help
```

The module layout and contracts are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
