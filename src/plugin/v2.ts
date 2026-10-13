/**
 * opencode V2 entry (`setup(ctx)`). Registers the oss_scout_* tools (read-only + reject/edit; never
 * approve), the /oss-* slash commands (approval lives here: they run code, not an LLM), a tool guard
 * for oss-scout's own agent sessions, and autostarts the scheduler in the home directory only.
 * Type-only imports from @opencode/plugin; setup never throws into opencode.
 */
import type { Plugin } from "@opencode/plugin"
import { existsSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { createApp, loadPluginConfig, type App, type CreateAppOptions } from "../app.ts"
import type { LoadedConfig } from "../config/load.ts"
import { ConfigError, type OssScoutConfig } from "../config/schema.ts"
import { errorMessage, type Logger } from "../util/log.ts"
import { resolvePaths, type Paths } from "../util/paths.ts"
import { redact } from "../util/redact.ts"
import { quoteArg } from "./commands.ts"
import { agentSessions, BLOCKED_MESSAGE, createV2LlmHost, isBlockedAgentCall, pathGuardBlocks } from "./llm-v2.ts"

// ---------------------------------------------------------------------------
// shared helpers (also used by the V1 entry)
// ---------------------------------------------------------------------------

function normPath(p: string): string {
  const r = resolve(p).replace(/[\\/]+$/, "")
  return process.platform === "win32" ? r.toLowerCase() : r
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return normPath(a) === normPath(b)
}

/** `child` equals or is below `parent`. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(normPath(parent), normPath(child))
  if (rel === "") return true
  // "..foo" is a child named "..foo", not a parent hop.
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../") && !isAbsolute(rel)
}

/**
 * Config-independent check: `directory` is (inside) the `workspaces/` or `gitdirs/` folder of an
 * oss-scout state dir (one holding oss-scout.db). Catches task locations whose plugin instance loads
 * a different config than the one that created the task (e.g. the config lives only in the home
 * project, so the task directory falls back to defaults with another stateDir).
 */
export function looksLikeTaskLocation(directory: string): boolean {
  let current = resolve(directory)
  for (;;) {
    const name = basename(current).toLowerCase()
    if ((name === "workspaces" || name === "gitdirs") && existsSync(join(dirname(current), "oss-scout.db"))) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/** A location inside a task workspace or git dir: oss-scout must never act there. */
export function isTaskLocation(directory: string, paths: Pick<Paths, "workspacesDir" | "gitDirsDir">): boolean {
  return isInside(directory, paths.workspacesDir) || isInside(directory, paths.gitDirsDir) || looksLikeTaskLocation(directory)
}

export function shouldAutostart(config: OssScoutConfig, directory: string): boolean {
  return config.scheduler.autostart && config.mode !== "off" && samePath(directory, config.homeDirectory)
}

/**
 * Tool-guard decision for one tool call. Applies to oss-scout's agent sessions (and to every session
 * in a task location): tools outside the allowlist, file edits aimed at opencode config/plugin
 * paths, and (agent sessions started by runAgent) file paths that really resolve, through
 * symlinks or junctions, outside the task's work tree. `log` hears about unknown tool input shapes.
 */
export function guardBlocks(
  tool: string,
  sessionID: string,
  everySession: boolean,
  input?: unknown,
  log?: Pick<Logger, "debug">,
): boolean {
  if ((everySession || agentSessions.has(sessionID)) && isBlockedAgentCall(tool, input)) return true
  return pathGuardBlocks(tool, sessionID, input, (why) =>
    log?.debug("path guard: unknown tool input shape; allowed (session permissions still apply)", { tool, sessionID, why }),
  )
}

/**
 * Extra options for the entry points (tests inject env/fetch/exec/fakes, a home directory and the
 * "checkout" directory searched for the config; production passes none).
 */
export type EntryAppOptions = Partial<Pick<CreateAppOptions, "env" | "fetch" | "exec" | "overrides" | "homeDir">> & {
  /** Directory searched for oss-scout.config.json after ~/.oss-scout (default: the oss-scout checkout). */
  packageDirectory?: string
}

/** Config for an entry point: never read from the opencode location (see loadPluginConfig). */
export function loadEntryConfig(pluginOptions: Readonly<Record<string, unknown>> | null | undefined, appOptions: EntryAppOptions): LoadedConfig {
  return loadPluginConfig({
    pluginOptions,
    env: appOptions.env,
    packageDirectory: appOptions.packageDirectory,
    homeDir: appOptions.homeDir,
  })
}

/** createApp options from entry options (packageDirectory only steers the config lookup). */
export function createOptionsFrom(appOptions: EntryAppOptions): Partial<CreateAppOptions> {
  const { packageDirectory: _pkg, ...rest } = appOptions
  return rest
}

/** Paths for a loaded config without opening anything. */
export function pathsFor(loaded: LoadedConfig): Paths {
  return resolvePaths(loaded.config.stateDir, loaded.baseDir)
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const QueueId = z.coerce.number().int().positive()

export interface ToolSpec {
  name: string
  description: string
  input: Record<string, unknown>
  /** Command name + argument string for the router, from validated input. */
  toCommand(input: unknown): { command: string; args: string }
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
})

const idProp = { type: "integer", minimum: 1, description: "Queue item id" }

/** The LLM-callable tools. There is deliberately NO approve tool: approval is a human command. */
export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "status",
    description: "oss-scout status: mode, kill switch, current task, queue size, caps used, budget, last errors, recent skips.",
    input: objectSchema({}),
    toCommand: () => ({ command: "status", args: "" }),
  },
  {
    name: "queue_list",
    description: "List oss-scout approval-queue items (pending by default). Approval itself is human-only (/oss-approve).",
    input: objectSchema({
      status: {
        type: "string",
        enum: ["pending", "all", "approved", "submitted", "rejected", "failed", "superseded"],
        description: "Which items to list (default pending)",
      },
    }),
    toCommand: (input) => {
      const { status } = z.object({ status: z.string().optional() }).parse(input ?? {})
      return { command: "queue", args: status ? quoteArg(status) : "" }
    },
  },
  {
    name: "queue_show",
    description:
      "Summarize one approval-queue item: status, digest, verification results, critic verdict, the repository's AI rules and the paths of its review files. It never includes the diff, PR body or test output; the human reviews those in a terminal.",
    input: objectSchema({ id: idProp }, ["id"]),
    toCommand: (input) => {
      const { id } = z.object({ id: QueueId }).parse(input)
      return { command: "show", args: String(id) }
    },
  },
  {
    name: "queue_reject",
    description: "Reject an approval-queue item with a reason (the issue will not be picked again).",
    input: objectSchema({ id: idProp, reason: { type: "string", minLength: 1, description: "Why it is rejected" } }, ["id", "reason"]),
    toCommand: (input) => {
      const { id, reason } = z.object({ id: QueueId, reason: z.string().trim().min(1) }).parse(input)
      return { command: "reject", args: `${id} ${quoteArg(reason)}` }
    },
  },
  {
    name: "queue_edit",
    description:
      "Edit the PR title or body of a pending approval-queue item (the AI disclosure line is always kept). The digest changes, so a human must review it again before approving.",
    input: objectSchema(
      {
        id: idProp,
        field: { type: "string", enum: ["title", "body"] },
        text: { type: "string", minLength: 1, description: "New title or body" },
      },
      ["id", "field", "text"],
    ),
    toCommand: (input) => {
      const { id, field, text } = z.object({ id: QueueId, field: z.enum(["title", "body"]), text: z.string().min(1) }).parse(input)
      return { command: "edit", args: `${id} ${field} ${quoteArg(text)}` }
    },
  },
]

// ---------------------------------------------------------------------------
// slash commands
// ---------------------------------------------------------------------------

export const SLASH_COMMANDS: ReadonlyArray<{ name: string; command: string; description: string }> = [
  { name: "oss-status", command: "status", description: "oss-scout: status (task, queue, caps, budget, errors, skips)" },
  { name: "oss-queue", command: "queue", description: "oss-scout: list the approval queue [pending|all|<status>]" },
  { name: "oss-show", command: "show", description: "oss-scout: summary of a queue item <id> (full review: bun src/cli.ts show <id>)" },
  { name: "oss-approve", command: "approve", description: "oss-scout: approve a reviewed item <id> <digest> (human only)" },
  { name: "oss-reject", command: "reject", description: "oss-scout: reject a queue item <id> <reason>" },
  { name: "oss-edit", command: "edit", description: "oss-scout: edit <id> title|body <text>, or <id> sync" },
  { name: "oss-kill", command: "kill", description: "oss-scout: engage the kill switch [reason]" },
  { name: "oss-resume", command: "resume", description: "oss-scout: release the kill switch" },
  { name: "oss-run", command: "run", description: "oss-scout: run one scheduler tick now" },
  { name: "oss-doctor", command: "doctor", description: "oss-scout: check config, tokens, sandbox and state" },
]

/** Arguments of a slash command (tolerates a leading "/name" echo). */
export function commandArgs(name: string, text: string | undefined): string {
  const t = (text ?? "").trim()
  const prefix = `/${name}`
  if (t === prefix) return ""
  if (t.startsWith(`${prefix} `) || t.startsWith(`${prefix}\n`)) return t.slice(prefix.length).trim()
  return t
}

/** Longest slash-command post; longer output is cut and points to the files / CLI. */
export const MAX_POST_CHARS = 6000

/** Cap a post at MAX_POST_CHARS (cut at a line break when possible) with a pointer to the full output. */
export function capPost(text: string, max = MAX_POST_CHARS): string {
  if (text.length <= max) return text
  const note = "\n[…output shortened. Full output: run the same command with the CLI (bun src/cli.ts <command>) or read the files in the queue folder.]"
  const room = Math.max(0, max - note.length)
  const cut = text.lastIndexOf("\n", room)
  return `${text.slice(0, cut > room / 2 ? cut : room)}${note}`
}

/**
 * Post command output into the session. opencode V2 admits it to the session inbox: it is shown and
 * consumed with the next turn, so the next model call reads it. "queue" delivery (not "steer") waits
 * for that turn instead of interrupting one in progress; `resume: false` never starts a turn by itself.
 * The router keeps this output LLM-safe (summaries, no diffs/bodies/test output) and it is capped here.
 */
async function postToSession(pctx: Plugin.Context, sessionID: string, text: string, name: string, log: Pick<Logger, "warn">): Promise<void> {
  try {
    await pctx.session.synthetic({
      sessionID,
      text: capPost(text),
      description: `/${name}`,
      metadata: { source: "oss-scout", command: name },
      delivery: "queue",
      resume: false,
    })
  } catch (err) {
    log.warn("could not post command output to the session", { command: name, error: errorMessage(err) })
  }
}

const consoleLog: Pick<Logger, "warn" | "debug"> = {
  warn: (msg, fields) => console.error(`[oss-scout] ${redact(msg)}${fields ? ` ${redact(JSON.stringify(fields))}` : ""}`),
  debug: () => undefined,
}

/** Setup failed (bad config, unreadable DB…): log it and expose only /oss-doctor explaining why. */
async function reportSetupFailure(pctx: Plugin.Context, err: unknown): Promise<void> {
  const reason = err instanceof ConfigError ? err.message : `oss-scout failed to start: ${errorMessage(err)}`
  const text = `${redact(reason)}\n\nFix the problem (see oss-scout.config.example.json and the README), then restart opencode or reload the location.`
  console.error(`[oss-scout] ${redact(reason)}`)
  try {
    await pctx.command.transform((editor) => {
      editor.add({
        name: "oss-doctor",
        description: "oss-scout: why the plugin did not start",
        execute: async ({ sessionID }) => postToSession(pctx, sessionID, `error: ${text}`, "oss-doctor", consoleLog),
      })
    })
  } catch (e) {
    console.error(`[oss-scout] could not register /oss-doctor: ${errorMessage(e)}`)
  }
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

type Registration = Awaited<ReturnType<Plugin.Context["tool"]["hook"]>>

/** Register the tool guard. `everySession` = task location (every session there is untrusted). */
async function registerGuard(pctx: Plugin.Context, everySession: boolean, log: Pick<Logger, "warn" | "debug">): Promise<boolean> {
  try {
    await pctx.tool.hook("execute.before", (e) => {
      if (guardBlocks(e.tool, e.sessionID, everySession, e.input, log)) {
        log.warn("blocked tool call in an untrusted oss-scout session", { tool: e.tool, sessionID: e.sessionID })
        throw new Error(BLOCKED_MESSAGE)
      }
    })
    return true
  } catch (err) {
    console.error(`[oss-scout] could not register the tool guard: ${errorMessage(err)}`)
    return false
  }
}

/** Tools + slash commands. On failure the registrations made so far are disposed, then it rethrows. */
async function registerTools(pctx: Plugin.Context, app: App): Promise<void> {
  const log = app.ctx.log
  const registrations: Registration[] = []
  try {
    registrations.push(
      await pctx.tool.transform((editor) => {
        editor.namespace({ name: "oss_scout", description: "oss-scout approval queue (read-only + reject/edit)" })
        for (const spec of TOOL_SPECS) {
          editor.add({
            name: spec.name,
            description: spec.description,
            input: spec.input,
            options: { namespace: "oss_scout", codemode: false },
            execute: async (input, tctx) => {
              if (agentSessions.has(tctx.sessionID)) return { content: `error: ${BLOCKED_MESSAGE}` }
              let call: { command: string; args: string }
              try {
                call = spec.toCommand(input)
              } catch (err) {
                return { content: `error: invalid input for oss_scout_${spec.name}: ${errorMessage(err)}` }
              }
              return { content: await app.commands.run(call.command, call.args, "tool") }
            },
          })
        }
      }),
    )

    registrations.push(
      await pctx.command.transform((editor) => {
        for (const c of SLASH_COMMANDS) {
          editor.add({
            name: c.name,
            description: c.description,
            execute: async ({ sessionID, prompt }) => {
              const text = await app.commands.run(c.command, commandArgs(c.name, prompt?.text), "command")
              await postToSession(pctx, sessionID, text, c.name, log)
            },
          })
        }
      }),
    )
  } catch (err) {
    for (const r of registrations.reverse()) await Promise.resolve(r?.dispose?.()).catch(() => undefined)
    throw err
  }
}

/** V2 `setup`. Returns the cleanup that stops the scheduler and closes the database. */
export function setupV2(pctx: Plugin.Context): Promise<Plugin.Cleanup | void> {
  return setupV2With(pctx)
}

/** `setupV2` with extra createApp options (tests: env, fetch, exec, fakes). */
export async function setupV2With(pctx: Plugin.Context, appOptions: EntryAppOptions = {}): Promise<Plugin.Cleanup | void> {
  // opencode V1 (>= 1.18.18) may call `setup` with a V1-shaped context: ignore it (V1 uses `server`).
  if (!pctx?.tool?.transform || !pctx?.session?.create) return
  const directory = pctx.location?.directory ?? process.cwd()

  // Even when oss-scout cannot start, its agent sessions (and every session in what looks like a
  // task location) stay guarded.
  const failed = async (err: unknown, guarded = false): Promise<void> => {
    if (!guarded) await registerGuard(pctx, looksLikeTaskLocation(directory), consoleLog)
    return reportSetupFailure(pctx, err)
  }

  // The location (the project opencode was opened in) is never a config source.
  let loaded: LoadedConfig
  try {
    loaded = loadEntryConfig(pctx.options, appOptions)
  } catch (err) {
    return failed(err)
  }

  // Never act inside a task workspace: only guard the (untrusted) sessions located there.
  if (isTaskLocation(directory, pathsFor(loaded))) {
    await registerGuard(pctx, true, consoleLog)
    return
  }

  let app: App
  try {
    app = createApp({
      ...createOptionsFrom(appOptions),
      directory,
      pluginOptions: pctx.options,
      loaded,
      llm: (log) => createV2LlmHost(pctx, { log }),
    })
  } catch (err) {
    return failed(err)
  }

  const guarded = await registerGuard(pctx, false, app.ctx.log)
  try {
    await registerTools(pctx, app)
  } catch (err) {
    await app.close().catch(() => undefined)
    return failed(err, guarded)
  }

  let autostart: ReturnType<typeof setTimeout> | null = null
  if (shouldAutostart(app.ctx.config, directory)) {
    autostart = setTimeout(() => {
      autostart = null
      try {
        app.scheduler.start()
      } catch (err) {
        app.ctx.log.error("scheduler failed to start", { error: errorMessage(err) })
      }
    }, 0)
  }
  app.ctx.log.info("oss-scout plugin ready (opencode v2)", {
    directory,
    mode: app.ctx.config.mode,
    autostart: autostart !== null,
    configFile: app.loaded.file,
  })

  return async () => {
    if (autostart) clearTimeout(autostart)
    autostart = null
    await app.close()
  }
}
