# oss-scout architecture

Plan written before implementation (Step 0). It records the runtime facts we verified, the design,
the file layout, the state schema, and the safety model. The README links here.

## 1. Verified runtime facts (2026-10-11)

| Fact | Consequence |
|---|---|
| Installed `opencode` is **V2 (2.0.24)**. V1 function plugins fail to load in V2 (`Plugin must export a default definition with an id and an effect or setup function`). | Primary target is the V2 plugin API: `export default { id, setup(ctx) }`, with **type-only** imports from `@opencode/plugin@2.0.24`. A V1 `server()` export is included for opencode 1.x (≥ 1.18.29), which ignores `setup`. |
| V2 loads `.opencode/plugins/*.ts` and config `"plugins": ["<directory>"]` entries (directory with `server.ts`/`index.ts`). `.ts` file paths in config are rejected. Local plugin deps are **not** auto-installed. | Repo root has `server.ts`; project-local shim at `.opencode/plugins/oss-scout.ts`. Users run `bun install` in this repo, then restart the opencode service. |
| V2 plugin runtime is Bun: `bun:sqlite`, `fetch`, `node:child_process`, `setInterval` all work. Plugins are instantiated **per location (directory)**; `setup` re-runs on hot reload; cleanup does not run on hard kill. | SQLite is the source of truth; the scheduler is leader-elected through a lease row + process guard, idempotent, resumable. |
| V2 `ctx.session.create({ location, permissions })` + `prompt` + `wait` + `context` drive an agent session; `ctx.generate.text({ prompt, model })` is a tool-less completion. | Implementation uses agent sessions; the critic and follow-up drafts use `generate.text` (optionally a different model). |
| A session located in a directory loads that directory's `opencode.json`, `.opencode/plugins`, `AGENTS.md`. Plugins found there execute on the host. The built-in `shell` tool runs on the host. | Sessions are located in the **task directory** (`<task>/`), never in the clone (`<task>/repo`). Session permissions are deny-by-default: only file actions are allowed, and `shell`, web access, sub-agents, external directories and questions are denied. All repo code runs in a container. |
| opencode treats every path inside the location's git repository as in-project (no `external_directory` check; from the 2.0.24 binary, not re-verified live). | Agent sessions are refused when the task directory is inside a git work tree (`doctor` reports a state dir inside a repository as `[FAIL]`); V2 rules also deny resources starting with `..`. |
| V1 (`session/prompt.ts`) turns the per-prompt `tools` map into the session's permission rules, in key order, last match wins, and replaces the session's rules with them; an unmatched permission falls back to `ask`. MCP tools are `<server>_<tool>`. | The V1 agent tool map starts with `"*": false` and then allows only the file tools, so MCP and other plugins' tools, `external_directory` and `doom_loop` are denied instead of asked. |
| opencode's shell tool runs with the opencode environment (tokens included) and has no TTY (code review, 2026-10-12; not re-verified live). | The CLI refuses `approve`/`resume`/`edit`/`sync` without a terminal and asks for a typed confirmation for `approve`/`resume`. |
| Fine-grained PATs **cannot** open PRs or comment on repos you don't own (documented gap; roadmap item paused). Fork creation with a fine-grained PAT is uncertain. | Reads use `GITHUB_TOKEN` (fine-grained recommended). Approved writes use `OSS_SCOUT_WRITE_TOKEN` (classic, `public_repo` only) when set, otherwise `GITHUB_TOKEN`; a 403 yields a clear message + a manual compare URL. |
| GitHub: search 30 req/min, 5000 req/h core, secondary limits (≈80 content-creating req/min), `retry-after` / `x-ratelimit-reset`, 304s are free. Sync SBOM endpoint closes 2026-11-13. | Serial requests, ETag cache in SQLite, RateLimitError pauses all GitHub work until reset, ≥1.5 s between writes. Discovery parses manifests itself. |
| Docker/Podman is **not installed** on the development machine. | Without a container runtime, tasks wait at the `baseline` stage with reason "sandbox unavailable"; nothing runs on the host. |

## 2. Pipeline

```
discover ─▶ screen ─▶ select issue ─▶ task: prepare ─▶ baseline ─▶ implement ─▶ verify ─▶ critic ─▶ enqueue
                                                                                                    │
                       human: /oss-approve <id> <digest>  (or CLI)  ◀────────────────────────────────┘
                                │ (queue mode only)
                                ▼
                       fork ─▶ push branch ─▶ create PR ─▶ track ─▶ follow-up poll ─▶ draft reply / fix ─▶ queue
```

* **Discovery** – dependencies parsed from your own repos' manifests (package.json, requirements*.txt,
  pyproject.toml, pom.xml, build.gradle[.kts]) mapped to GitHub repos via deps.dev / npm / PyPI /
  Maven metadata, plus repository searches built from `interests`.
* **Screening** – metrics (maintainer activity, outside-PR merge rate, first-response time, CI,
  stale PR backlog, license) + policy (CONTRIBUTING, CODE_OF_CONDUCT, PR template, AI policy) →
  score 0..1 with reasons; hard skips are recorded with reasons and audited.
* **Selection** – per eligible repo: issue search (`is:issue is:open no:assignee -linked:pr …`), then
  per-issue checks (timeline for linked PRs, claims in comments, design-decision signals, staleness)
  and scoring (clarity, reproducibility, scope, labels). Caps are enforced before a task starts.
* **Task stages** (each one persisted; a crash resumes at the same stage):
  * `prepare` – clone upstream (unauthenticated, read-only) into `<stateDir>/workspaces/<task>/repo`
    with its git dir at `<stateDir>/gitdirs/<task>` (outside the agent session's directory), create
    branch `oss-scout/<n>-<slug>`, detect ecosystem/commands/conventions.
  * `baseline` – install + test in the sandbox on the untouched code (aborts if the suite is already
    broken or the sandbox is missing → task waits).
  * `implement` – agent session (no shell) writes a failing reproduction test (bugs), sandbox
    confirms it fails, agent fixes, sandbox confirms tests + lint pass; up to `maxAttempts`; then a
    final JSON with commit message, PR title and PR body (template-filled). Commit locally.
  * `verify` – deterministic gate: tests pass, lint pass, tests added, reproduction observed, diff
    size, files changed, unrelated changes, secrets, PR template filled, disclosure present.
  * `critic` – separate tool-less completion (optionally different model) acting as a skeptical
    maintainer; strict JSON; anything but a confident approve rejects the task.
  * `enqueue` – approval-queue item with diff, PR title/body, test output, verification and critic notes.
* **Approval** – only via `/oss-approve <id> <digest>` (opencode slash command, runs code without an
  LLM) or `bun src/cli.ts approve <id> <digest>` in an interactive terminal, after the human types the
  repository name. Never exposed as an LLM tool. In dry-run the approval records the planned actions
  without touching GitHub. In queue mode it pushes exactly the reviewed commit (part of the digest).
* **Follow-through** – polls your PRs, records merged/closed (cooldowns), drafts replies and
  follow-up fixes into the queue. Nothing is posted without approval.

## 3. File layout

```
server.ts                         V2 directory-plugin entry (re-exports src/plugin/entry.ts)
.opencode/plugins/oss-scout.ts    project-local shim (same re-export)
oss-scout.config.example.json     example config; schema/oss-scout.config.schema.json generated
oss-scout.config.codespaces.json  GitHub Codespaces preset (selected by OSS_SCOUT_CONFIG in the dev container)
.devcontainer/                    Codespaces dev container (Docker-in-Docker) + setup.sh; see docs/CODESPACES.md
src/
  app.ts                          composition root: config → paths → store → clients → AppContext
  cli.ts                          `bun src/cli.ts <command>` (status, queue, show, approve, …); TTY gate + typed confirmation
  config/{schema,load}.ts         zod schema with defaults; file lookup (§6) + validation
  core/{types,context,allowlist}.ts  domain types, AppContext, allow/deny lists
  state/{db,store}.ts             bun:sqlite schema/migrations; typed data access
  github/{api,types,client}.ts    GitHubApi interface, write-authorization guard, REST client
  discovery/{manifests,registries,discover}.ts
  screening/{policy,health,screen}.ts
  selection/issues.ts
  workspace/{git,project,sandbox,container,workspace}.ts
  llm/host.ts                     LlmHost interface (opencode V2 / V1 adapters implement it)
  implement/{prompts,implementer}.ts
  verify/{diff,secrets,gate}.ts
  critic/critic.ts
  queue/{prbody,queue,submit}.ts  submit.ts is the ONLY GitHub-write path
  followup/followup.ts
  scheduler/{caps,budget,killswitch,pipeline,daemon}.ts
  status/status.ts
  plugin/{entry,v2,v1,commands,llm-v2,llm-v1}.ts
  util/{clock,codespaces,exec,log,paths,redact,text}.ts
test/                             bun tests; test/helpers/fakes.ts has FakeGitHub/FakeSandbox/FakeLlm/makeTestContext
```

## 4. State schema (SQLite, `~/.oss-scout/oss-scout.db`)

| Table | Purpose |
|---|---|
| `repos` | candidates/eligible/skipped repos: source, score, reasons, skip_reason, policy JSON, metrics JSON, next_screen_at |
| `issues` | issue candidates: kind, status (candidate/selected/skipped/done), score, reasons, skip_reason |
| `tasks` | durable work units: stage, status, attempts, failures, next_run_at, workspace, branch, token/cost usage, data JSON (project, attempts log, implementation, verification, critic) |
| `queue_items` | approval queue: kind (pr/reply/fix), status, title, body, diff, test output, critic, verification, digest, decision |
| `prs` | tracked PRs (yours): state, opened/closed/merged, last polled, last seen activity |
| `audit` | every decision and action with actor (scout/human/critic/system), subject, decision, reasons, details |
| `errors` | recent errors for `status` (bounded) |
| `usage` | LLM tokens/cost per UTC day |
| `kv` | small state: discovery cursor, last tick, GitHub pause-until, registry cache |
| `leases` | scheduler leader lease |
| `http_cache` | GitHub ETag cache |

## 5. Safety model

1. **No GitHub write without a human approval.** Mutating GitHub methods require a `WriteAuthorization`
   that only `mintWriteAuthorization()` creates, which requires: actor `human`, item status `approved`,
   a digest prefix (≥ 8 hex chars) matching the item's current content, and mode `queue`. The writer
   client is created with `allowWrites` only in `queue` mode. `submit.ts` is the only caller, and it is
   reachable only from the CLI and the `/oss-approve` slash command — never from the scheduler or an
   LLM-callable tool. The CLI requires stdin and stdout to be a terminal (opencode's shell tool has
   none) and a typed confirmation (the repository name); it is a guard against an agent running the
   CLI, not against an agent that has a shell and the tokens. `approve` is also refused while the
   config file on disk disagrees with the loaded one (mode or file), since the plugin reads its config
   once. The router's LLM-visible texts (help, tool refusals, edit results, kill) and the V1 tool
   descriptions name `/oss-approve` but never a shell command line for approving. Forks are created
   at approval time (forking is a write).
2. **Disclosure** – every PR body gets the configured disclosure line (schema refuses lines that do not
   mention AI); it is re-applied on every edit and re-verified at approval. Replies get a reply line.
   No timing randomization or human-mimicking behavior exists; pacing is only caps + rate limits.
3. **Untrusted code isolation** – repo code runs only in Docker/Podman (`--network none` for tests/lint,
   `--cap-drop ALL`, `no-new-privileges`, memory/cpu/pids limits, git dir mounted read-only). Host git
   always runs with explicit `--git-dir/--work-tree`, `core.hooksPath=<empty>`, `core.fsmonitor=false`,
   no textconv/ext-diff, `--no-verify`. Child processes get a scrubbed env (no tokens). The agent session
   is located outside the clone, never inside a git work tree, with deny-by-default permissions (V2
   `agentPermissionRules`; V1 `AGENT_TOOLS_V1` starting with `"*": false`). The `tool.execute.before`
   guard (oss-scout's agent sessions, and every session in a task location) is an allowlist:
   `read`, `edit`, `write`, `patch`, `apply_patch`, `multiedit`, `glob`, `grep`, `list`, `todowrite`,
   `todoread`; file writes aimed at `.opencode/` or `opencode.json[c]` are blocked as well. For
   sessions started by `runAgent` (task dir tracked per session id) the guard also resolves file-tool
   path arguments (`filePath`/`path`, glob/grep/list roots and patterns, patch headers) against the
   task dir with `realpathSync.native` (nearest existing parent for new files) and blocks results
   outside `<taskDir>/repo` (a search root may also be the task dir itself); unknown input shapes are
   allowed and logged at debug. The guard
   only runs where the plugin is loaded (a project-local install does not load it in task
   locations), so both hosts also delete `.opencode/` and `opencode.json[c]` from the task directory
   before a session is created or resumed and after every prompt, failing that attempt.
4. **Repo rules** – CONTRIBUTING/CoC/PR templates/AI policies are read; prohibited or unclear-restrictive
   AI policies are hard skips with recorded reasons; CLA / issue-first / sign-off requirements are
   surfaced on the queue item (sign-off is applied automatically when required).
5. **Caps** – 1 open PR per repo (counting queued + in-flight work), 30-day cooldown after merge/close,
   3 submitted PRs per rolling week, bounded pending queue; enforced at selection and again at approval.
6. **Kill switch** – `<stateDir>/KILL` (or `/oss-kill`, `bun src/cli.ts kill`): scheduler idles, a running
   implementation is interrupted (agent session and sandbox runs), GitHub client refuses all requests,
   approvals refused. The CLI acts on the state dir of the config it loaded and prints it.
7. **Secrets** – tokens only from env; registered with the redactor; never in argv, URLs, files, logs or
   sandboxes; git push gets the token via `GIT_CONFIG_*` env (http.extraHeader). Command output is
   redacted except where `exec(..., { raw: true })` is used (the git diff scanned by the secrets gate,
   never logged). `github.tokenEnv`/`writeTokenEnv` must be upper-case names containing `GITHUB`, `GH_`
   or `OSS_SCOUT`; `github.apiBaseUrl` must be `https://api.github.com` unless the environment sets
   `OSS_SCOUT_ALLOW_CUSTOM_GITHUB_API=1`. The config is never read from an opencode location (§6).
8. **Budgets** – per-task and per-day token/cost caps checked before each agent prompt and each
   generation call; usage is recorded as each call reports it. A single agent session is not stopped
   mid-way by a budget (it can run up to `sessionTimeoutMinutes`). V2 `generate.text` reports no usage:
   critic and follow-up drafts record estimated tokens (chars/4) and $0, and a generation that loses
   its timeout race cannot be cancelled (the plugin adapter drops request options).
9. **LLM-visible output** – tool results and `/oss-*` output (posted with `session.synthetic`,
   `delivery: "queue"`, `resume: false`; V2 keeps it in the session inbox and the next model turn reads
   it) never carry diffs, PR/comment bodies, test output or critic free text. `show` returns
   `formatItemSummary` there (fixed-vocabulary facts + review file paths); third-party strings are
   single-line, truncated and placed under an "Untrusted third-party data" header; posts are capped at
   6,000 characters. The full review (`formatItem`) is CLI-only, plus the files in `<stateDir>/queue/<id>/`.

## 6. Config lookup

| Step | opencode plugin (V2 `setup`, V1 `server`) | CLI |
|---|---|---|
| 1 | plugin option `configPath` | `--config <path>` |
| 2 | `$OSS_SCOUT_CONFIG` | `$OSS_SCOUT_CONFIG` |
| 3 | — | `<cwd>/oss-scout.config.json` |
| 4 | `~/.oss-scout/oss-scout.config.json` | `~/.oss-scout/oss-scout.config.json` |
| 5 | `<checkout>/oss-scout.config.json` (the directory holding `server.ts`, `PACKAGE_ROOT`) | same |
| 6 | built-in defaults | built-in defaults |

* The opencode **location** (the project opened in opencode) is never searched (`loadPluginConfig`:
  `searchDirectory: false`), so a cloned repository cannot change the token variable, the API host,
  the state dir or autostart. A cwd equal to the checkout is searched at step 5, so the CLI run from
  the checkout resolves like the plugin. Relative explicit paths and the relative paths of a
  defaults-only config resolve against the checkout (plugin) or the cwd (CLI); `stateDir` and
  `homeDirectory` in a file resolve against the file's folder. `homeDirectory` defaults to the
  config file's folder (the checkout on defaults).
* `LoadedConfig` records the files searched, existing files that were not used (`shadowed`, reported
  by `doctor`) and a `reload()` used to detect on-disk changes (`doctor` warns; `approve` refuses).
