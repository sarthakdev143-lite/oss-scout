/**
 * Text command router shared by the CLI, the opencode slash commands (/oss-*) and the LLM tools.
 * Every command returns text; failures come back as "error: <message>" (run() never throws).
 *
 * Approval is a human act: `approve` (and `resume`, `run`) are refused when invoked via "tool". The
 * CLI (src/cli.ts) additionally refuses approve/resume/edit/sync without an interactive terminal and
 * asks the human to confirm approve/resume by typing, so an agent's shell tool cannot run them.
 * `approve` is also refused while the config file on disk disagrees with the loaded config (mode).
 *
 * Output via "tool" (an LLM tool result) and "command" (a slash command, posted into the session
 * where the next model turn reads it) can reach an LLM context. Those outputs never carry diffs,
 * PR/comment bodies, test output or critic free text (`show` returns the LLM-safe summary), and
 * third-party-derived text (repo names, titles, links, error messages) is single-line, truncated and
 * placed under UNTRUSTED_DATA_HEADER. Only "cli" (a human at a terminal) gets the full review view.
 */
import { readdirSync } from "node:fs"
import type { App } from "../app.ts"
import type { LoadedConfig } from "../config/load.ts"
import { ALLOW_CUSTOM_GITHUB_API_ENV, configJsonSchema, isDefaultGithubApiUrl } from "../config/schema.ts"
import { audit, type AppContext } from "../core/context.ts"
import type { AuditActor, QueueItem, QueueStatus } from "../core/types.ts"
import { tokenKind } from "../github/client.ts"
import type { TokenInfo } from "../github/types.ts"
import { approveCommands, digest8 } from "../queue/queue.ts"
import { approveQueueItem, type ApprovalResult } from "../queue/submit.ts"
import { runningScheduler, type TickReport } from "../scheduler/daemon.ts"
import { buildStatus, formatStatus } from "../status/status.ts"
import { codespacesFindings } from "../util/codespaces.ts"
import { errorMessage } from "../util/log.ts"
import { findGitRoot } from "../util/paths.ts"
import { oneLine, UNTRUSTED_DATA_HEADER } from "../util/text.ts"

export type Via = "cli" | "command" | "tool"

export interface CommandRouter {
  names: string[]
  run(name: string, args: string, via: Via): Promise<string>
}

/** The parts of App the router uses (tokens and env are optional so tests can pass a partial app). */
export type CommandApp = Pick<App, "ctx" | "loaded" | "queue" | "scheduler"> & Partial<Pick<App, "tokens" | "env">>

/** Collaborators, injectable for tests. */
export interface CommandDeps {
  approve: (ctx: AppContext, input: { id: number; digest: string; via: "cli" | "command" }) => Promise<ApprovalResult>
  buildStatus: typeof buildStatus
}

const defaultDeps: CommandDeps = { approve: approveQueueItem, buildStatus }

// ---------------------------------------------------------------------------
// quote-aware argument parsing
// ---------------------------------------------------------------------------

export interface ArgToken {
  /** Unquoted value. */
  value: string
  /** Offsets of the raw token in the input. */
  start: number
  end: number
  quoted: boolean
}

const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c)

/**
 * Split on whitespace. A token that STARTS with " or ' is quoted up to the matching quote
 * (double quotes understand \" and \\; single quotes are literal). Quotes inside a word are
 * literal (so "doesn't" stays one word). An unterminated quote runs to the end of the input.
 */
export function tokenize(input: string): ArgToken[] {
  const out: ArgToken[] = []
  const n = input.length
  let i = 0
  while (i < n) {
    while (i < n && isSpace(input[i])) i++
    if (i >= n) break
    const start = i
    const q = input[i]
    if (q === '"' || q === "'") {
      i++
      let value = ""
      while (i < n && input[i] !== q) {
        const next = input[i + 1]
        if (q === '"' && input[i] === "\\" && (next === '"' || next === "\\")) {
          value += next
          i += 2
          continue
        }
        value += input[i]
        i++
      }
      i = Math.min(n, i + 1)
      while (i < n && !isSpace(input[i])) value += input[i++]
      out.push({ value, start, end: i, quoted: true })
    } else {
      while (i < n && !isSpace(input[i])) i++
      out.push({ value: input.slice(start, i), start, end: i, quoted: false })
    }
  }
  return out
}

/**
 * Free text from token `index` on: a single (possibly quoted) token yields its unquoted value;
 * several tokens yield the raw remaining text (spacing, newlines and quotes preserved).
 */
export function restFrom(input: string, tokens: ArgToken[], index: number): string {
  const first = tokens[index]
  if (!first) return ""
  if (index === tokens.length - 1) return first.value
  return input.slice(first.start).trim()
}

/** Quote one argument so that `tokenize` returns it unchanged (used by the CLI and the tools). */
export function quoteArg(arg: string): string {
  if (arg !== "" && !/\s/.test(arg) && arg[0] !== '"' && arg[0] !== "'") return arg
  return `"${arg.replace(/[\\"]/g, (m) => `\\${m}`)}"`
}

class Args {
  readonly tokens: ArgToken[]
  constructor(readonly raw: string) {
    this.tokens = tokenize(raw)
  }
  get length(): number {
    return this.tokens.length
  }
  at(i: number): string | undefined {
    return this.tokens[i]?.value
  }
  rest(i: number): string {
    return restFrom(this.raw, this.tokens, i)
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

class UsageError extends Error {}

const QUEUE_STATUSES: readonly QueueStatus[] = ["pending", "approved", "submitted", "rejected", "failed", "superseded"]

function parseId(value: string | undefined, usage: string): number {
  if (value === undefined) throw new UsageError(`missing queue item id. Usage: ${usage}`)
  const v = value.replace(/^#/, "")
  const n = /^\d+$/.test(v) ? Number(v) : NaN
  if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError(`invalid queue item id "${value}". Usage: ${usage}`)
  return n
}

function actorFor(via: Via): AuditActor {
  return via === "tool" ? "scout" : "human"
}

export { findGitRoot }

/**
 * Has the config on disk changed in a way that matters since it was loaded? The opencode plugin
 * reads its config once at startup, so e.g. switching "mode" in the file has no effect until opencode
 * restarts; approving meanwhile would use the old mode. Returns why, or null.
 */
export function configDrift(loaded: LoadedConfig): string | null {
  if (!loaded.reload) return null
  let current: LoadedConfig
  try {
    current = loaded.reload()
  } catch (err) {
    return `the oss-scout config on disk is no longer valid (${oneLine(errorMessage(err), 300)})`
  }
  const name = (f: string | null): string => f ?? "built-in defaults"
  if ((current.file ?? "") !== (loaded.file ?? "")) {
    return `the config lookup now finds ${name(current.file)}, but ${name(loaded.file)} is loaded`
  }
  if (current.config.mode !== loaded.config.mode) {
    return `the config file says "mode": "${current.config.mode}", but "${loaded.config.mode}" is loaded`
  }
  return null
}

const RELOAD_HINT = "Restart opencode (opencode service restart) so the change takes effect; the CLI re-reads the config on every run"

function countDirs(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
  } catch {
    return 0
  }
}

/** Output read by an LLM (tool result or slash-command post into a session). */
function llmVisible(via: Via): boolean {
  return via !== "cli"
}

function formatTick(report: TickReport, via: Via): string {
  const lines = [`Scheduler tick at ${new Date(report.at).toISOString()} (leader: ${report.leader ? "yes" : "no"})`]
  if (report.skipped) lines.push(`Skipped: ${oneLine(report.skipped, 300)}`)
  // Step details can carry repo/issue names and error messages.
  if (report.steps.length > 0 && llmVisible(via)) lines.push(UNTRUSTED_DATA_HEADER)
  for (const s of report.steps) lines.push(`  [${s.ok ? "ok" : "FAIL"}] ${s.step}: ${oneLine(s.detail, 300)}`)
  if (!report.skipped && report.steps.length === 0) lines.push("  (no steps ran)")
  return lines.join("\n")
}

const HUMAN_ONLY = "this command needs a human: the user runs it as an opencode slash command (/oss-<name>) or in an interactive terminal"

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

interface Spec {
  usage: string
  summary: string
  /** May an LLM tool invoke it? */
  tool: boolean
  run(args: Args, via: Via): Promise<string> | string
}

const ALIASES: Record<string, string> = {
  "?": "help",
  "-h": "help",
  "--help": "help",
  list: "queue",
  "queue-list": "queue",
  queue_list: "queue",
  queue_show: "show",
  "queue-show": "show",
  queue_reject: "reject",
  "queue-reject": "reject",
  queue_edit: "edit",
  "queue-edit": "edit",
  schema: "config-schema",
  config_schema: "config-schema",
}

/** "/oss-queue", "oss_scout_queue_list", "Queue" → canonical command name. */
export function normalizeCommandName(name: string): string {
  const n = name
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/^oss_scout_/, "")
    .replace(/^oss-scout[-_ ]/, "")
    .replace(/^oss-/, "")
  return ALIASES[n] ?? n
}

export function createCommandRouter(app: CommandApp, deps: Partial<CommandDeps> = {}): CommandRouter {
  const d: CommandDeps = { ...defaultDeps, ...deps }
  const { ctx, queue } = app

  const specs: Record<string, Spec> = {
    help: { usage: "help", summary: "this list", tool: true, run: (_args, via) => helpText(via) },

    status: {
      usage: "status",
      summary: "mode, kill switch, current task, queue size, caps, budget, rate limits, errors, recent skips",
      tool: true,
      run: async (_args, via) =>
        formatStatus(await d.buildStatus(ctx, { schedulerRunning: schedulerRunning(), checkSandbox: true }), {
          untrustedHeader: llmVisible(via),
        }),
    },

    queue: {
      usage: "queue [pending|all|approved|submitted|rejected|failed|superseded]",
      summary: "list approval-queue items (pending by default)",
      tool: true,
      run: (args, via) => {
        const which = (args.at(0) ?? "pending").toLowerCase()
        let items: QueueItem[]
        if (which === "all") items = queue.list()
        else if ((QUEUE_STATUSES as readonly string[]).includes(which)) items = queue.list({ status: which as QueueStatus })
        else throw new UsageError(`unknown queue status "${which}". Usage: ${specs.queue!.usage}`)
        const header = `Approval queue (${which}): ${items.length} item(s)`
        if (items.length === 0) return `${header}\n${queue.formatList(items)}`
        // Titles in the table are single-line and truncated; they are still third-party text.
        const table = llmVisible(via) ? `${UNTRUSTED_DATA_HEADER}\n${queue.formatList(items)}` : queue.formatList(items)
        const hint = llmVisible(via)
          ? "Summary of an item: /oss-show <id>. Full review in a terminal: bun src/cli.ts show <id>."
          : "Review an item with bun src/cli.ts show <id> (/oss-show <id> in opencode gives a summary)."
        return `${header}\n${table}\n\n${hint}`
      },
    },

    show: {
      usage: "show <id>",
      summary: "review an item (CLI: full diff, PR body, tests, critic notes; opencode: summary + file paths)",
      tool: true,
      run: (args, via) => {
        const id = parseId(args.at(0), specs.show!.usage)
        const item = queue.get(id)
        if (!item) throw new Error(`queue item ${id} not found`)
        // The full view carries attacker-influenced text (diff, body, test output): terminal only.
        return via === "cli" ? queue.formatItem(item) : queue.formatItemSummary(item)
      },
    },

    approve: {
      usage: "approve <id> <digest>",
      summary: "approve exactly the reviewed content (the ONLY path to GitHub writes; human only)",
      tool: false,
      run: async (args, via) => {
        const usage = specs.approve!.usage
        if (via !== "cli" && via !== "command") throw new Error(`approval refused: ${HUMAN_ONLY}`)
        const id = parseId(args.at(0), usage)
        const digest = args.at(1)
        if (!digest) throw new UsageError(`missing digest (first 8 characters shown by "show ${id}"). Usage: ${usage}`)
        // The loaded mode decides whether this writes to GitHub: refuse when the file says otherwise.
        const drift = configDrift(app.loaded)
        if (drift) {
          audit(ctx, "human", "queue.approve", `queue:${id}`, "refused", ["config changed on disk"], { via, drift })
          throw new Error(`approval refused: ${drift}. ${RELOAD_HINT}. Nothing was written.`)
        }
        const result = await d.approve(ctx, { id, digest, via })
        if (!result.ok) throw new Error(result.message)
        let text = result.message
        if (result.status === "submitted" && result.actions.length > 0) {
          text = `${result.message}\nActions:\n${result.actions.map((a) => `  - ${a}`).join("\n")}`
        }
        // Planned/performed actions name the PR title and links: mark them for the session's model.
        if (llmVisible(via) && result.actions.length > 0) {
          const [first, ...rest] = text.split("\n")
          text = [first, UNTRUSTED_DATA_HEADER, ...rest].join("\n")
        }
        return text
      },
    },

    reject: {
      usage: "reject <id> <reason…>",
      summary: "reject an item with a reason (the issue is not picked again)",
      tool: true,
      run: (args, via) => {
        const usage = specs.reject!.usage
        const id = parseId(args.at(0), usage)
        const reason = args.rest(1).trim()
        if (!reason) throw new UsageError(`a reason is required. Usage: ${usage}`)
        const item = queue.reject(id, reason, actorFor(via))
        return `Rejected queue item #${item.id} (${item.repo}): ${item.decisionReason ?? reason}`
      },
    },

    edit: {
      usage: "edit <id> title <text…> | edit <id> body <text…> | edit <id> sync",
      summary: "edit the title/body (the AI disclosure is kept) or re-read the edited files in the queue folder",
      tool: true,
      run: (args, via) => {
        const usage = specs.edit!.usage
        const id = parseId(args.at(0), usage)
        const field = (args.at(1) ?? "").toLowerCase()
        const before = queue.get(id)
        if (!before) throw new Error(`queue item ${id} not found`)
        const actor = actorFor(via)
        let after: QueueItem
        if (field === "sync") {
          after = queue.syncFromFiles(id, actor)
        } else if (field === "title" || field === "body") {
          const text = args.rest(2)
          if (!text.trim()) throw new UsageError(`missing ${field} text. Usage: ${usage}`)
          after = field === "title" ? queue.editTitle(id, text, actor) : queue.editBody(id, text, actor)
        } else {
          throw new UsageError(`expected "title", "body" or "sync". Usage: ${usage}`)
        }
        return editResult(before, after, field, via)
      },
    },

    sync: {
      usage: "sync <id>",
      summary: "same as edit <id> sync (after editing PR_TITLE.txt / PR_BODY.md in the queue folder)",
      tool: true,
      run: (args, via) => {
        const id = parseId(args.at(0), specs.sync!.usage)
        const before = queue.get(id)
        if (!before) throw new Error(`queue item ${id} not found`)
        return editResult(before, queue.syncFromFiles(id, actorFor(via)), "sync", via)
      },
    },

    kill: {
      usage: "kill [reason…]",
      summary: "engage the global kill switch (scheduler idles, GitHub traffic and approvals refused)",
      tool: true,
      run: (args, via) => {
        const reason = args.rest(0).trim() || `engaged via ${via}`
        const was = ctx.kill.isEngaged()
        ctx.kill.engage(reason, ctx.clock.now())
        audit(ctx, actorFor(via), "killswitch.engage", null, "engaged", [reason], { via, alreadyEngaged: was })
        return [
          `Kill switch ENGAGED${was ? " (it was already engaged; reason updated)" : ""}: ${reason}`,
          "The scheduler idles, every GitHub request is refused and approvals are refused.",
          via === "cli"
            ? "Release it with bun src/cli.ts resume (interactive terminal) or /oss-resume in opencode."
            : "Only the user can release it (/oss-resume).",
        ].join("\n")
      },
    },

    resume: {
      usage: "resume",
      summary: "release the kill switch",
      tool: false,
      run: (_args, via) => {
        if (via === "tool") throw new Error(`refused: ${HUMAN_ONLY}`)
        if (!ctx.kill.isEngaged()) return "Kill switch is not engaged; nothing to resume."
        const reason = ctx.kill.reason()
        ctx.kill.release()
        audit(ctx, "human", "killswitch.release", null, "released", reason ? [reason] : [], { via })
        return `Kill switch released (was: ${reason ?? "engaged"}). The scheduler resumes on its next tick.`
      },
    },

    run: {
      usage: "run",
      summary: "force one scheduler tick now and report its steps",
      tool: false,
      run: async (_args, via) => {
        if (via === "tool") throw new Error(`refused: ${HUMAN_ONLY}`)
        return formatTick(await app.scheduler.tick({ force: true }), via)
      },
    },

    doctor: {
      usage: "doctor",
      summary: "check config, mode, state dir, tokens, sandbox and LLM host",
      tool: true,
      run: () => doctor(),
    },

    "config-schema": {
      usage: "config-schema",
      summary: "print the config JSON Schema",
      tool: true,
      run: () => JSON.stringify(configJsonSchema(), null, 2),
    },
  }

  const names = Object.keys(specs)

  /** This app's scheduler, or another one running in this process for the same state dir (other location). */
  function schedulerRunning(): boolean {
    return app.scheduler.running || runningScheduler(ctx.paths.stateDir) !== null
  }

  function helpText(via: Via): string {
    const width = 26
    const row = (n: string): string => {
      const { usage, summary } = specs[n]!
      return usage.length < width ? `  ${usage.padEnd(width)}${summary}` : `  ${usage}\n  ${"".padEnd(width)}${summary}`
    }
    return [
      "oss-scout commands (opencode: /oss-<name> …; CLI: bun src/cli.ts <name> …)",
      "",
      ...names.map(row),
      "",
      via === "cli"
        ? "Approval is human-only: /oss-approve <id> <digest> in opencode, or bun src/cli.ts approve <id> <digest> in an interactive terminal (you confirm by typing the repository name). approve, resume, edit and sync refuse to run without a terminal."
        : "Approval is human-only: the user types /oss-approve <id> <digest> after reviewing the item. Tools and agents cannot approve.",
    ].join("\n")
  }

  function editResult(before: QueueItem, after: QueueItem, field: string, via: Via): string {
    if (after.digest === before.digest) return `No change to queue item #${after.id}.`
    const what = field === "sync" ? "synced from its files" : `${field} updated`
    if (via === "tool") {
      return `Queue item #${after.id} ${what}; its digest changed. A human must review it again (/oss-show ${after.id}) before approving.`
    }
    const cmd = approveCommands(after)
    // A slash-command post is read by the session's model too: never hand it a shell command line.
    const approveWith = via === "cli" ? `${cmd.command} (CLI, interactive terminal: ${cmd.cli})` : cmd.command
    return [
      `Queue item #${after.id} ${what}. New digest: ${digest8(after)} (status: ${after.status}).`,
      `Review it (bun src/cli.ts show ${after.id}, or the files in its queue folder), then approve with ${approveWith}.`,
    ].join("\n")
  }

  async function doctor(): Promise<string> {
    const { config, paths } = ctx
    const lines: string[] = ["oss-scout doctor"]
    const ok = (s: string) => lines.push(`[ok]   ${s}`)
    const info = (s: string) => lines.push(`[info] ${s}`)
    const warn = (s: string) => lines.push(`[WARN] ${s}`)
    const fail = (s: string) => lines.push(`[FAIL] ${s}`)

    const searched = app.loaded.searched?.length ? `looked for ${app.loaded.searched.join(", ")}` : `nothing found near ${app.loaded.baseDir}`
    ok(`Config: ${app.loaded.file ?? `built-in defaults (${searched})`}`)
    for (const other of app.loaded.shadowed ?? []) {
      warn(`Also found ${other}, which is NOT used (${app.loaded.file ?? "the loaded config"} comes first). Keep one config file, or pass --config / OSS_SCOUT_CONFIG.`)
    }
    const drift = configDrift(app.loaded)
    if (drift) warn(`Config changed on disk since it was loaded: ${drift}. ${RELOAD_HINT}; until then the loaded settings below apply.`)
    const modeNote =
      config.mode === "queue"
        ? "approved items are submitted to GitHub"
        : config.mode === "dry-run"
          ? "nothing is written to GitHub; approvals record the planned actions"
          : "the background loop does nothing"
    ok(`Mode: ${config.mode} (${modeNote})`)
    info(`Home directory (background loop runs only here): ${config.homeDirectory ?? "(unset)"}`)

    ok(`State dir: ${paths.stateDir}`)
    const gitRoot = findGitRoot(paths.stateDir)
    if (gitRoot) {
      fail(
        `State dir is inside a git repository (${gitRoot}): opencode would let agent sessions read and edit that whole repository, so implementation is refused. Set "stateDir" outside any repository.`,
      )
    }
    if (!isDefaultGithubApiUrl(config.github.apiBaseUrl)) {
      warn(`GitHub API: ${config.github.apiBaseUrl} (custom, allowed by ${ALLOW_CUSTOM_GITHUB_API_ENV}=1): your GitHub tokens are sent to this host`)
    }
    const report = { info, warn, fail }
    const findings = codespacesFindings({
      env: app.env ?? process.env,
      tokenEnv: config.github.tokenEnv,
      writeTokenEnv: config.github.writeTokenEnv,
      stateDir: paths.stateDir,
    })
    for (const f of findings) report[f.level](f.text)

    const readPresent = ctx.secrets.hasReadToken()
    const readKind: TokenInfo["kind"] | null = app.tokens ? app.tokens.read : null
    if (!readPresent) {
      fail(`${config.github.tokenEnv} is not set: discovery, screening and approvals need a GitHub token`)
    } else {
      try {
        const t = await ctx.github.tokenInfo()
        const scopes = t.scopes === null ? "" : `; scopes: ${t.scopes.length ? t.scopes.join(", ") : "(none)"}`
        ok(`Read token: ${config.github.tokenEnv} set (${t.kind}${scopes}; login ${t.login})`)
      } catch (err) {
        warn(`Read token: ${config.github.tokenEnv} set (${readKind ?? "kind unknown"}) but GitHub check failed: ${errorMessage(err)}`)
      }
    }

    const writeKind = app.tokens ? app.tokens.write : null
    if (writeKind) ok(`Write token: ${config.github.writeTokenEnv} set (${writeKind})`)
    else info(`Write token: ${config.github.writeTokenEnv} not set; approved writes use ${config.github.tokenEnv}`)
    const writeToken = ctx.secrets.writeToken()
    const effectiveWriteKind = writeKind ?? (writeToken ? tokenKind(writeToken) : null)
    if (effectiveWriteKind === "fine-grained") {
      warn(
        `Approved writes would use a fine-grained PAT, which cannot open PRs or comment on repositories you do not own. Set ${config.github.writeTokenEnv} to a classic PAT with only the "public_repo" scope before using queue mode.`,
      )
    }

    try {
      const s = await ctx.sandbox.available()
      if (s.ok) ok(`Sandbox: ${s.runtime}${s.version ? ` ${s.version}` : ""} available`)
      else warn(`Sandbox unavailable (${s.reason ?? s.runtime}): tasks wait at the baseline stage; repository code never runs on the host`)
    } catch (err) {
      warn(`Sandbox check failed: ${errorMessage(err)}`)
    }

    if (ctx.llm) ok(`LLM host: ${ctx.llm.kind}`)
    else info("LLM host: none (CLI); new work is prepared only inside opencode")

    info(`Workspaces: ${countDirs(paths.workspacesDir)} task director(ies) in ${paths.workspacesDir}`)
    if (ctx.kill.isEngaged()) warn(`Kill switch ENGAGED: ${ctx.kill.reason() ?? "engaged"}`)
    else ok("Kill switch: off")
    const scheduler = app.scheduler.running
      ? "running in this process"
      : runningScheduler(paths.stateDir) !== null
        ? "running in this process (started by another opencode location with the same state dir)"
        : "not running in this process"
    info(`Scheduler: ${scheduler}`)
    return lines.join("\n")
  }

  async function run(name: string, rawArgs: string, via: Via): Promise<string> {
    const cmd = normalizeCommandName(name)
    try {
      const spec = Object.hasOwn(specs, cmd) ? specs[cmd] : undefined
      if (!spec) return `error: unknown command "${name}". Run "help" for the list of commands.`
      const args = new Args(rawArgs ?? "")
      if (via === "tool" && !spec.tool) {
        if (cmd === "approve") {
          const id = args.at(0)
          audit(ctx, "scout", "queue.approve", id ? `queue:${id.replace(/^#/, "")}` : null, "refused", ["approval via tool is not allowed"], { via })
          return `error: approval requires a human. Tools can only list, show, reject and edit queue items, and you must not try to approve in any other way. Ask the user to review the item and approve it themselves (the user types /oss-approve <id> <digest>).`
        }
        return `error: "${cmd}" refused: ${HUMAN_ONLY}`
      }
      ctx.log.debug("command", { command: cmd, via })
      return await spec.run(args, via)
    } catch (err) {
      return `error: ${errorMessage(err)}`
    }
  }

  return { names, run }
}
