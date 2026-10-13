#!/usr/bin/env bun
/**
 * oss-scout CLI: `bun src/cli.ts [--config <path>] <command> [args…]`.
 * Same commands as the /oss-* slash commands; approval from here is a human act (via "cli").
 * The CLI has no LLM host, so it never prepares new work; it reviews, approves and inspects.
 * `show` prints the full review view here (diff, PR body, test output), unlike opencode.
 *
 * Human presence: an opencode chat agent can run shell commands, so `approve`, `resume`, `edit` and
 * `sync` refuse to run unless stdin AND stdout are a terminal, and `approve` / `resume` then ask the
 * human to confirm by typing (the repository name / "resume"). This stops a plain shell-tool call; it
 * is not a substitute for denying the agent a shell or keeping tokens away from it (see README).
 *
 * Exit codes: 0 ok, 1 error (output starts with "error:"), 2 `doctor` reported a [FAIL] check.
 */
import { createInterface } from "node:readline/promises"
import { createApp, type App } from "./app.ts"
import { configJsonSchema } from "./config/schema.ts"
import type { QueueItem } from "./core/types.ts"
import { normalizeCommandName, quoteArg } from "./plugin/commands.ts"
import { errorMessage } from "./util/log.ts"
import { PACKAGE_ROOT } from "./util/paths.ts"
import { oneLine } from "./util/text.ts"

export interface CliIo {
  out(text: string): void
  err(text: string): void
}

/** The terminal the CLI talks to (injectable for tests). */
export interface CliInteractive {
  /** stdin and stdout are both a terminal (an agent's shell tool has none). */
  isTTY: boolean
  /** Ask one question on the terminal; resolves with the typed line. */
  prompt(question: string): Promise<string>
}

export interface CliOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  io?: CliIo
  /** Injectable for tests. */
  createApp?: typeof createApp
  /** Injectable for tests; default: the process's terminal. */
  interactive?: CliInteractive
  /** Searched for oss-scout.config.json after ~/.oss-scout (default: the oss-scout checkout; null: none). */
  packageDirectory?: string | null
  /** Home directory for ~/.oss-scout (tests). */
  homeDir?: string
}

export type ParsedCli = { configPath: string | null; command: string; rest: string[] } | { error: string }

const USAGE = "usage: bun src/cli.ts [--config <path>] <command> [args…]   (bun src/cli.ts help lists the commands)"

/** Appended to `help` output in the CLI only (the router's help is shared with opencode). */
export const EXIT_CODES_HELP = "CLI exit codes: 0 ok; 1 error; 2 doctor reported a [FAIL] check."

/** Commands a human must run in an interactive terminal (an opencode agent's shell has no TTY). */
export const INTERACTIVE_ONLY: Readonly<Record<string, string>> = {
  approve: "approval must be run interactively by a human in a terminal",
  resume: "releasing the kill switch must be run interactively by a human in a terminal",
  edit: "editing a queue item must be run interactively by a human in a terminal",
  sync: "editing a queue item must be run interactively by a human in a terminal",
}

/** Exit code of `doctor` output: 2 when any check failed. */
export function doctorExitCode(output: string): number {
  return /^\[FAIL\]/m.test(output) ? 2 : 0
}

/** Leading options, then the command; everything after the command is passed through untouched. */
export function parseCliArgs(argv: readonly string[]): ParsedCli {
  let configPath: string | null = null
  let i = 0
  while (i < argv.length) {
    const a = argv[i]!
    if (a === "--") {
      i++
      break
    }
    if (a === "--config" || a === "-c") {
      const v = argv[i + 1]
      if (v === undefined || v === "") return { error: `${a} needs a path. ${USAGE}` }
      configPath = v
      i += 2
      continue
    }
    if (a.startsWith("--config=")) {
      configPath = a.slice("--config=".length)
      if (!configPath) return { error: `--config needs a path. ${USAGE}` }
      i++
      continue
    }
    if (a === "--help" || a === "-h") return { configPath, command: "help", rest: [] }
    if (a.startsWith("-")) return { error: `unknown option ${a}. ${USAGE}` }
    break
  }
  const command = argv[i]
  return { configPath, command: command ?? "help", rest: argv.slice(i + 1) }
}

const defaultIo: CliIo = {
  out: (t) => process.stdout.write(t.endsWith("\n") ? t : `${t}\n`),
  err: (t) => process.stderr.write(t.endsWith("\n") ? t : `${t}\n`),
}

function processTerminal(): CliInteractive {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async prompt(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
      try {
        return await rl.question(question)
      } finally {
        rl.close()
      }
    },
  }
}

/** Which config and state dir this run uses (the kill switch and the DB live in the state dir). */
export function contextLine(app: Pick<App, "loaded" | "ctx">): string {
  const config = app.loaded.file ?? "built-in defaults (no config file found; pass --config <path> or set OSS_SCOUT_CONFIG)"
  return `(config: ${config}; state dir: ${app.ctx.paths.stateDir})`
}

/** What approving `item` does in the loaded mode (shown before the human confirms). */
export function plannedEffect(item: Pick<QueueItem, "kind" | "repo" | "branch" | "prUrl">, mode: string): string {
  if (mode !== "queue") {
    return `Mode is ${mode}: nothing is written to GitHub; the planned actions are only recorded.`
  }
  const repo = oneLine(item.repo, 100)
  const pr = item.prUrl ? oneLine(item.prUrl, 200) : "your pull request"
  switch (item.kind) {
    case "pr":
      return `This will create or reuse your fork of ${repo}, push branch ${oneLine(item.branch ?? "?", 120)} to it and open a pull request against ${repo} on GitHub.`
    case "fix":
      return `This will push the reviewed follow-up commit to the branch of ${pr} on GitHub.`
    case "reply":
      return `This will post the drafted reply as a public comment on ${pr} on GitHub.`
    default:
      return `This will write to GitHub (${oneLine(String(item.kind), 40)} for ${repo}).`
  }
}

const KIND_LABEL: Record<string, string> = { pr: "pull request", fix: "follow-up fix", reply: "review reply" }

/**
 * Confirm `approve <id> <digest>` with the human. Returns null to go ahead, or an error to print.
 * Malformed arguments go to the router, which reports them (it never approves without an id and a digest).
 */
async function confirmApprove(app: App, rest: string[], term: CliInteractive, io: CliIo): Promise<string | null> {
  const [rawId, digest] = rest
  const id = rawId && /^#?\d+$/.test(rawId) ? Number(rawId.replace(/^#/, "")) : NaN
  if (!Number.isSafeInteger(id) || id <= 0 || !digest) return null
  const item = app.queue.get(id)
  if (!item) return `error: queue item ${id} not found`
  const mode = app.ctx.config.mode
  io.out(
    [
      `About to approve queue item #${item.id} (${item.status}):`,
      `  Repository: ${oneLine(item.repo, 100)}`,
      `  Kind:       ${KIND_LABEL[item.kind] ?? oneLine(String(item.kind), 40)}`,
      `  Title:      ${oneLine(item.title, 200)}`,
      `  Digest:     ${oneLine(digest, 64)} (as you quoted it)`,
      `  Mode:       ${mode}`,
      `  ${contextLine(app)}`,
      plannedEffect(item, mode),
    ].join("\n"),
  )
  let answer: string
  try {
    answer = await term.prompt(`Type the repository name (${oneLine(item.repo, 100)}) to approve; anything else aborts: `)
  } catch {
    answer = ""
  }
  if (answer.trim() !== item.repo) return "error: approval aborted: the confirmation did not match the repository name; nothing was approved"
  return null
}

/** Confirm `resume` (release the kill switch). Returns null to go ahead, or an error to print. */
async function confirmResume(app: App, term: CliInteractive, io: CliIo): Promise<string | null> {
  if (!app.ctx.kill.isEngaged()) return null
  io.out(
    [
      `The kill switch is ENGAGED: ${oneLine(app.ctx.kill.reason() ?? "engaged", 200)}`,
      `  ${contextLine(app)}`,
      "Releasing it lets the scheduler run again and allows GitHub requests and approvals.",
    ].join("\n"),
  )
  let answer: string
  try {
    answer = await term.prompt('Type "resume" to release it; anything else aborts: ')
  } catch {
    answer = ""
  }
  if (answer.trim() !== "resume") return "error: resume aborted: the kill switch stays engaged"
  return null
}

/** Run one CLI invocation; returns the exit code (1 when the output is an error, 2 when doctor found a [FAIL]). */
export async function runCli(argv: readonly string[], opts: CliOptions = {}): Promise<number> {
  const io = opts.io ?? defaultIo
  const parsed = parseCliArgs(argv)
  if ("error" in parsed) {
    io.err(`error: ${parsed.error}`)
    return 1
  }
  const command = normalizeCommandName(parsed.command)
  // Works without a token or even a valid config.
  if (command === "config-schema") {
    io.out(JSON.stringify(configJsonSchema(), null, 2))
    return 0
  }

  // A human must be at a terminal: refuse before touching the state dir.
  const term = opts.interactive ?? processTerminal()
  const interactiveReason = Object.hasOwn(INTERACTIVE_ONLY, command) ? INTERACTIVE_ONLY[command] : undefined
  if (interactiveReason && !term.isTTY) {
    io.err(`error: ${interactiveReason}`)
    return 1
  }

  let app: App
  try {
    app = (opts.createApp ?? createApp)({
      directory: opts.cwd ?? process.cwd(),
      packageDirectory: opts.packageDirectory === undefined ? PACKAGE_ROOT : opts.packageDirectory,
      ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
      pluginOptions: parsed.configPath ? { configPath: parsed.configPath } : null,
      llm: null,
      env: opts.env ?? process.env,
    })
  } catch (err) {
    io.err(`error: ${errorMessage(err)}`)
    return 1
  }
  try {
    const refusal =
      command === "approve" ? await confirmApprove(app, parsed.rest, term, io) : command === "resume" ? await confirmResume(app, term, io) : null
    if (refusal) {
      io.err(refusal)
      return 1
    }
    const out = await app.commands.run(parsed.command, parsed.rest.map(quoteArg).join(" "), "cli")
    if (out.startsWith("error:")) {
      io.err(out)
      return 1
    }
    const withContext = command === "kill" || command === "resume" || command === "approve" ? `${out}\n${contextLine(app)}` : out
    io.out(command === "help" ? `${out}\n\n${EXIT_CODES_HELP}` : withContext)
    return command === "doctor" ? doctorExitCode(out) : 0
  } finally {
    await app.close()
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2))
}
