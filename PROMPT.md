You are building an opencode plugin called "oss-scout": an autonomous agent that finds, prepares, and queues high-quality open source contributions for me to review and submit from my GitHub account.

## Step 0: Research before coding
1. Read the current opencode plugin documentation (plugin structure, hooks/events, custom tools, config, how plugins are loaded). Do not rely on memory for the API. If anything is ambiguous, state your assumption in a short note at the top of the README.
2. Read the GitHub REST/GraphQL docs for the endpoints you plan to use (search, issues, pulls, rate limits).
3. Write a brief plan (architecture, file layout, state schema) and then implement it. Do not ask me questions; make reasonable decisions and document them.

## Goal
Run continuously for hours or days, working through a pipeline of: discover repos -> screen policy/health -> pick issues -> implement fix in a sandboxed clone -> self-verify -> critic review -> queue for my approval -> track review feedback after submission.

## Hard rules (non-negotiable)
- Quality over volume. Default caps: max 1 open PR per repo, 30-day cooldown per repo after a PR is merged or closed, max 3 submitted PRs per week globally. All configurable.
- Human approval is required before ANY push, PR creation, issue comment, or other write to GitHub. The agent prepares everything locally (fork branch, diff, PR title/body, test output) and puts it in an approval queue. Default mode is dry-run.
- Never conceal AI involvement. Every PR body must include a disclosure line, e.g. "Prepared with AI assistance; reviewed and tested by me." Do not implement timing randomization, fake typing cadence, or any behavior designed to make activity look manually performed. Pacing exists only to respect maintainers and rate limits.
- Respect each repo's rules: read CONTRIBUTING.md, CODE_OF_CONDUCT, PR templates, and any AI/LLM contribution policy. If a repo prohibits AI-generated contributions or the policy is unclear and restrictive, skip it and record the reason.
- Use a fine-grained GitHub token from env (GITHUB_TOKEN) scoped to specific permissions. Never log tokens. Never run untrusted repo code outside the sandbox.

## Pipeline modules
1. Config (oss-scout.config.json + schema validation): my interest areas (TypeScript, JavaScript/React/Next.js, Python/FastAPI, Java/Spring Boot, MongoDB, LLM/AI tooling), allowed/denied repos and orgs, caps, labels to target, min repo stars/activity thresholds, mode (dry-run | queue | off).
2. Discovery: build candidate repos from (a) dependencies found in my own GitHub repos (package.json, requirements.txt/pyproject, pom.xml/build.gradle) and (b) topic/language search matching my interest areas.
3. Repo screening: score on recent maintainer activity, outside-PR merge rate and time-to-first-response, CI presence, backlog of stale PRs, license, contribution/AI policy. Output a score plus reasons. Hard-skip below threshold.
4. Issue selection: prefer labeled `good first issue`, `help wanted`, confirmed bugs, and docs/test gaps. Skip issues that are assigned, already have an open or linked PR, are stale, or need architectural decisions. Score by clarity, reproducibility, and scope (small diffs).
5. Implementation: fork + clone to an isolated workspace, branch per task, follow the repo's code style and commit conventions, run the project's own install/lint/test commands. Reproduce the bug first, add or update tests, keep the diff minimal. Abort and record the reason after N failed attempts (configurable).
6. Verification gate: tests pass, linter passes, diff size within limit, no unrelated changes, no secrets, PR template filled in.
7. Critic pass: a separate review step (different prompt, ideally a different model if configured) that reviews the diff as a skeptical maintainer and returns approve/reject with reasons. Reject anything not clearly good.
8. Approval queue: persist each ready PR as a record (repo, issue link, diff, PR title/body, test output, critic notes). Expose commands/tools: list queue, show item, approve (creates the PR), reject (with reason), edit body.
9. Follow-through: after submission, poll my open PRs, summarize review comments, draft replies and fixes into the same approval queue. Never auto-reply.
10. Scheduler/daemon: durable loop that survives restarts. Tasks are resumable from persisted state, with backoff on GitHub rate limits and API errors, a global kill switch (file flag or command), and token/cost budget caps per task and per day.

## State and observability
- SQLite (or similar) for repos, issues, tasks, queue items, PR tracking, and an audit log of every action and decision with reasons.
- Structured logs plus a `status` command showing: current task, queue size, caps used, last errors, repos skipped and why.

## Deliverables
- Working plugin with TypeScript, strict mode, clear module boundaries.
- README: install, config, how to run in dry-run, how to approve PRs, the safety model, and known limitations.
- Unit tests for scoring, cap enforcement, policy screening, and state persistence. Mock the GitHub API.
- Sensible defaults so it runs in dry-run mode with only a token and an interest list.

Build it end to end, run the tests, and finish with a short summary of what you built, assumptions made, and what I should verify manually before enabling queue mode.