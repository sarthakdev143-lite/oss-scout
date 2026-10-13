/**
 * LlmHost backed by the opencode V2 plugin context (`ctx.session.*`, `ctx.generate.text`).
 * Type-only imports from @opencode/plugin: nothing from it is loaded at runtime.
 */
import type { Plugin } from "@opencode/plugin"
import { lstatSync, realpathSync, rmSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  estimateTokens,
  type AgentRunRequest,
  type AgentRunResult,
  type GenerateRequest,
  type GenerateResult,
  type LlmHost,
  type ModelRef,
  type Usage,
} from "../llm/host.ts"
import { errorMessage, type Logger } from "../util/log.ts"
import { findGitRoot } from "../util/paths.ts"

type Session = Plugin.Context["session"]
type SessionInfo = Awaited<ReturnType<Session["get"]>>
type SessionMessage = Awaited<ReturnType<Session["context"]>>[number]
type AssistantMessage = Extract<SessionMessage, { type: "assistant" }>

/** The parts of the V2 plugin context the host uses. */
export type V2LlmContext = Pick<Plugin.Context, "session" | "generate">

export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

// ---------------------------------------------------------------------------
// agent session registry (shared by every plugin instance in the process)
// ---------------------------------------------------------------------------

const SESSIONS_KEY = Symbol.for("oss-scout.agent-sessions")

function sharedSessionSet(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>
  let set = g[SESSIONS_KEY]
  if (!set) {
    set = new Set<string>()
    g[SESSIONS_KEY] = set
  }
  return set
}

/** Ids of the sessions oss-scout runs on untrusted repositories. The tool guards consult it. */
export const agentSessions: Set<string> = sharedSessionSet()

const SESSION_DIRS_KEY = Symbol.for("oss-scout.agent-session-dirs")

function sharedSessionDirs(): Map<string, string> {
  const g = globalThis as unknown as Record<symbol, Map<string, string> | undefined>
  let map = g[SESSION_DIRS_KEY]
  if (!map) {
    map = new Map<string, string>()
    g[SESSION_DIRS_KEY] = map
  }
  return map
}

/** Task directory (the session's location) of each oss-scout agent session, for the path guard. */
export const agentSessionDirs: Map<string, string> = sharedSessionDirs()

/** Mark `sessionID` as an oss-scout agent session located in `taskDir`. */
export function registerAgentSession(sessionID: string, taskDir: string): void {
  agentSessions.add(sessionID)
  agentSessionDirs.set(sessionID, taskDir)
}

/**
 * The ONLY tools an oss-scout agent session may run: file tools (V1 and V2 spellings) and the
 * session-local todo list. Everything else (shell, web, sub-agents, questions, skills, LSP, MCP
 * server tools, other plugins' tools, our own queue tools…) is blocked by the tool guard.
 */
export const ALLOWED_AGENT_TOOLS = [
  "read",
  "edit",
  "write",
  "patch",
  "apply_patch",
  "multiedit",
  "glob",
  "grep",
  "list",
  "todowrite",
  "todoread",
] as const

const ALLOWED_AGENT_TOOL_SET: ReadonlySet<string> = new Set(ALLOWED_AGENT_TOOLS)

export function isAllowedAgentTool(tool: string): boolean {
  return ALLOWED_AGENT_TOOL_SET.has(tool.trim().toLowerCase())
}

export function isBlockedAgentTool(tool: string): boolean {
  return !isAllowedAgentTool(tool)
}

export const BLOCKED_MESSAGE = "blocked by oss-scout: untrusted workspace session"

/** Tools that create, change or delete files (V1 and V2 names). */
export const MUTATING_FILE_TOOL_RE = /^(edit|write|patch|multiedit|apply_patch)$/i

/**
 * opencode loads `.opencode/` (plugins, tools, agents, commands) and `opencode.json[c]` from a session's
 * location and runs those plugins ON THE HOST. A prompt-injected agent must never be able to plant them.
 */
export function isOpencodeConfigPath(path: string): boolean {
  const segments = path
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .split(/[\\/]+/)
    .filter(Boolean)
  const last = segments[segments.length - 1] ?? ""
  return segments.some((s) => s.toLowerCase() === ".opencode") || /^opencode\.jsonc?$/i.test(last)
}

const PATH_KEY_RE = /path|file|dir|target|dest/i
/** File headers of apply_patch-style and unified-diff patches. */
const PATCH_HEADER_RE = /^(?:\*\*\*\s+(?:add|update|delete)\s+file:|\*\*\*\s+move\s+to:|\+\+\+|---)\s*(\S.*)$/gim

function patchTargets(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(PATCH_HEADER_RE)) out.push(m[1]!.replace(/^[ab]\//, "").trim())
  return out
}

/**
 * Does a file-tool input name an opencode config path? Checks path-like keys (filePath, path, …) and the
 * file headers of patch texts. Content fields (oldString/newString/content) are not treated as paths.
 */
export function targetsOpencodeConfig(input: unknown, key = "", depth = 0): boolean {
  if (typeof input === "string") {
    if (PATH_KEY_RE.test(key) && isOpencodeConfigPath(input)) return true
    return patchTargets(input).some(isOpencodeConfigPath)
  }
  if (depth > 6 || input === null || typeof input !== "object") return false
  if (Array.isArray(input)) return input.some((v) => targetsOpencodeConfig(v, key, depth + 1))
  return Object.entries(input as Record<string, unknown>).some(([k, v]) => targetsOpencodeConfig(v, k, depth + 1))
}

/** Tool-call check for agent sessions: any tool outside the allowlist, or file edits aimed at opencode config/plugins. */
export function isBlockedAgentCall(tool: string, input: unknown): boolean {
  if (!isAllowedAgentTool(tool)) return true
  return MUTATING_FILE_TOOL_RE.test(tool.trim()) && targetsOpencodeConfig(input)
}

// ---------------------------------------------------------------------------
// path guard (second layer behind the session permissions): symlink/junction escapes
// ---------------------------------------------------------------------------

/** The clone's work tree inside a task directory (`<taskDir>/repo`, see workspace/workspace.ts). */
export const WORK_TREE_DIR = "repo"

const FILE_TOOLS = new Set(["read", "edit", "write", "multiedit"])
const PATCH_TOOLS = new Set(["patch", "apply_patch"])
const SEARCH_TOOLS = new Set(["glob", "grep", "list"])
const FILE_PATH_KEYS = ["filePath", "file_path", "path", "file"]
const SEARCH_ROOT_KEYS = ["path", "dir", "directory", "cwd"]
const PATCH_TEXT_KEYS = ["patchText", "patch_text", "patch", "input", "diff"]

/** Tools whose path arguments the path guard checks. */
export function isPathAgentTool(tool: string): boolean {
  const t = tool.trim().toLowerCase()
  return FILE_TOOLS.has(t) || PATCH_TOOLS.has(t) || SEARCH_TOOLS.has(t)
}

export type PathCheck = { verdict: "inside" } | { verdict: "outside"; path: string } | { verdict: "unknown"; why: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function stringAt(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return null
}

/**
 * File paths named by a patch text. apply_patch format: only the `*** Add/Update/Delete File:` and
 * `*** Move to:` headers. Unified diff: only a `--- x` line directly followed by `+++ y` (a removed
 * line starting with "-- " is content, not a header). /dev/null is skipped.
 */
export function patchFilePaths(text: string): string[] {
  const out: string[] = []
  const lines = text.split(/\r?\n/)
  if (/^\*\*\*\s+begin patch/im.test(text)) {
    for (const line of lines) {
      const m = /^\*\*\*\s+(?:(?:add|update|delete)\s+file|move\s+to):\s*(\S.*)$/i.exec(line)
      if (m) out.push(m[1]!.trim())
    }
    return out
  }
  for (let i = 0; i + 1 < lines.length; i++) {
    const minus = /^---\s+(\S.*)$/.exec(lines[i]!)
    const plus = /^\+\+\+\s+(\S.*)$/.exec(lines[i + 1]!)
    if (!minus || !plus) continue
    for (const raw of [minus[1]!, plus[1]!]) {
      const p = raw.replace(/\t.*$/, "").trim()
      if (p !== "/dev/null") out.push(p.replace(/^[ab]\//, ""))
    }
    i++
  }
  return out
}

/** Real path of `p` (relative to `base`): symlinks/junctions resolved; for a path that does not exist yet, the nearest existing parent is resolved. */
export function realPathOf(p: string, base: string): string {
  const abs = resolve(base, p)
  let current = abs
  const rest: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return rest.length > 0 ? join(real, ...rest) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return abs
      rest.unshift(basename(current))
      current = parent
    }
  }
}

function normalizedPath(p: string): string {
  const r = resolve(p).replace(/[\\/]+$/, "")
  return process.platform === "win32" ? r.toLowerCase() : r
}

/** `child` is `parent` or below it (both real, absolute paths). */
function within(child: string, parent: string): boolean {
  const rel = relative(normalizedPath(parent), normalizedPath(child))
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../") && !isAbsolute(rel))
}

/** A glob/include pattern that climbs out of its root (absolute, or a ".." segment). */
function patternEscapes(pattern: string): boolean {
  return isAbsolute(pattern) || /^[a-z]:/i.test(pattern) || pattern.split(/[\\/]+/).includes("..")
}

/**
 * Where do a file tool's path arguments really point? Paths resolve against the task directory
 * (the session's location), symlinks and junctions are followed, and the result must be inside
 * `<taskDir>/repo`. The root of glob/grep/list may also be the task directory itself (its default).
 * An input shape that names no recognizable path is "unknown" (the caller allows it and logs it).
 */
export function checkAgentPaths(tool: string, input: unknown, taskDir: string): PathCheck {
  const t = tool.trim().toLowerCase()
  const taskReal = realPathOf(taskDir, taskDir)
  const repoReal = realPathOf(join(taskDir, WORK_TREE_DIR), taskDir)
  const inRepo = (p: string): PathCheck => {
    const real = realPathOf(p, taskDir)
    return within(real, repoReal) ? { verdict: "inside" } : { verdict: "outside", path: real }
  }
  const all = (paths: string[]): PathCheck => {
    for (const p of paths) {
      const c = inRepo(p)
      if (c.verdict !== "inside") return c
    }
    return { verdict: "inside" }
  }

  if (SEARCH_TOOLS.has(t)) {
    const obj = isRecord(input) ? input : {}
    if (input !== undefined && input !== null && !isRecord(input)) return { verdict: "unknown", why: "input is not an object" }
    const root = stringAt(obj, SEARCH_ROOT_KEYS)
    if (root) {
      const real = realPathOf(root, taskDir)
      if (!within(real, repoReal) && normalizedPath(real) !== normalizedPath(taskReal)) return { verdict: "outside", path: real }
    }
    for (const key of t === "glob" ? ["pattern", "include"] : t === "grep" ? ["include"] : []) {
      const v = obj[key]
      if (typeof v === "string" && patternEscapes(v.trim())) return { verdict: "outside", path: v }
    }
    return { verdict: "inside" }
  }
  if (!isRecord(input)) return { verdict: "unknown", why: "input is not an object" }
  if (FILE_TOOLS.has(t)) {
    const paths: string[] = []
    const direct = stringAt(input, FILE_PATH_KEYS)
    if (direct) paths.push(direct)
    if (Array.isArray(input.edits)) {
      for (const e of input.edits) if (isRecord(e)) paths.push(...[stringAt(e, FILE_PATH_KEYS)].filter((x): x is string => x !== null))
    }
    return paths.length > 0 ? all(paths) : { verdict: "unknown", why: "no path argument" }
  }
  if (PATCH_TOOLS.has(t)) {
    const text = stringAt(input, PATCH_TEXT_KEYS)
    if (!text) return { verdict: "unknown", why: "no patch text" }
    const paths = patchFilePaths(text)
    return paths.length > 0 ? all(paths) : { verdict: "unknown", why: "no file headers in the patch" }
  }
  return { verdict: "inside" }
}

/**
 * Path-guard decision for one tool call of an oss-scout agent session (true = block). Only sessions
 * created by runAgent are known (with their task directory); unknown input shapes are allowed (the
 * session permissions stay the first layer) and reported through `onUnknown`.
 */
export function pathGuardBlocks(tool: string, sessionID: string, input: unknown, onUnknown?: (why: string) => void): boolean {
  const taskDir = agentSessionDirs.get(sessionID)
  if (!taskDir || !isPathAgentTool(tool)) return false
  let check: PathCheck
  try {
    check = checkAgentPaths(tool, input, taskDir)
  } catch {
    return true
  }
  if (check.verdict === "unknown") {
    onUnknown?.(check.why)
    return false
  }
  return check.verdict === "outside"
}

/** opencode config entries a session location loads (and runs, for plugins) when its instance boots. */
export const LOCATION_CONFIG_ENTRIES = [".opencode", "opencode.json", "opencode.jsonc"] as const

/**
 * Remove opencode config/plugins from a task directory (top level only; oss-scout never creates
 * them there). opencode would load them, and run plugins on the host, the next time the task
 * location boots, e.g. when a persisted session is resumed. V2 session rules already deny these
 * writes; under V1 nothing at session level can, and the tool guard only runs where the plugin is
 * loaded. Returns the removed paths.
 */
export function removePlantedOpencodeConfig(directory: string): string[] {
  const removed: string[] = []
  for (const name of LOCATION_CONFIG_ENTRIES) {
    const p = join(directory, name)
    let present = false
    try {
      lstatSync(p)
      present = true
    } catch {
      present = false
    }
    if (!present) continue
    rmSync(p, { recursive: true, force: true })
    removed.push(p)
  }
  return removed
}

/**
 * removePlantedOpencodeConfig + a warning. Returns an error message when something was removed (the
 * attempt then fails: an agent that writes opencode config is not trusted with the result), else null.
 */
export function sweepLocation(directory: string, log: Pick<Logger, "warn">): string | null {
  const removed = removePlantedOpencodeConfig(directory)
  if (removed.length === 0) return null
  log.warn("removed opencode config/plugins from an agent task directory", { directory, removed })
  return `opencode config/plugin files appeared in the task directory and were removed (${removed.map((p) => basename(p)).join(", ")}); this attempt is discarded`
}

/**
 * opencode treats every path inside the session location's git repository as "in project" (no
 * external_directory check). A task directory inside a git work tree (e.g. a stateDir inside a
 * repository) would therefore expose that whole repository to the agent: refuse to run there.
 */
export function assertIsolatedAgentDirectory(directory: string): void {
  const root = findGitRoot(directory)
  if (root) {
    throw new Error(
      `refusing to run an agent session in ${directory}: it is inside the git repository ${root}, so opencode would let the agent read and edit that whole repository. Set "stateDir" to a directory outside any git repository.`,
    )
  }
}

// ---------------------------------------------------------------------------
// permissions
// ---------------------------------------------------------------------------

/** File-only actions an agent session may use (inside its location only). */
export const ALLOWED_AGENT_ACTIONS = ["read", "edit", "write", "patch", "glob", "grep", "list", "todowrite", "todoread"] as const

/** Actions denied explicitly (after the allows, so they win even if an allow pattern overlaps). */
export const DENIED_AGENT_ACTIONS = [
  "external_directory",
  "shell",
  "bash",
  "webfetch",
  "websearch",
  "subagent",
  "task",
  "question",
  "skill",
  "execute",
  "oss_scout_*",
] as const

/** File-changing permission actions (V2 renamed write/patch to edit; both spellings are covered). */
export const WRITE_AGENT_ACTIONS = ["edit", "write", "patch"] as const

/** opencode config/plugin paths an agent may never write (see isOpencodeConfigPath). */
export const PROTECTED_CONFIG_RESOURCES = [
  "*.opencode",
  "*.opencode/*",
  "*.opencode\\*",
  "*opencode.json",
  "*opencode.jsonc",
] as const

/** File actions whose resource is a path (denied when it leaves the location). */
export const PATH_AGENT_ACTIONS = ["read", "edit", "write", "patch", "glob", "grep", "list"] as const

/**
 * In-location resources are relative paths without a ".." prefix; anything that climbs out of the
 * location (into an enclosing repository, see assertIsolatedAgentDirectory) is denied.
 */
export const PARENT_DIR_RESOURCES = ["..", "../*", "..\\*"] as const

/**
 * Ordered session permission rules (last match wins). Everything is denied first, file actions
 * are allowed, then paths outside the location, secrets reads, writes to opencode config/plugin
 * paths (which opencode would load and run on the host) and every dangerous action are denied
 * again. No rule says "ask": a headless session would hang waiting for an answer.
 */
export function agentPermissionRules(): PermissionRule[] {
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...ALLOWED_AGENT_ACTIONS.map((action): PermissionRule => ({ action, resource: "*", effect: "allow" })),
    ...PATH_AGENT_ACTIONS.flatMap((action) =>
      PARENT_DIR_RESOURCES.map((resource): PermissionRule => ({ action, resource, effect: "deny" })),
    ),
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "read", resource: "*.env.*", effect: "deny" },
    ...WRITE_AGENT_ACTIONS.flatMap((action) =>
      PROTECTED_CONFIG_RESOURCES.map((resource): PermissionRule => ({ action, resource, effect: "deny" })),
    ),
    ...DENIED_AGENT_ACTIONS.map((action): PermissionRule => ({ action, resource: "*", effect: "deny" })),
  ]
}

// ---------------------------------------------------------------------------
// helpers (exported for tests)
// ---------------------------------------------------------------------------

export function toV2Model(model: ModelRef | null | undefined): { providerID: string; id: string; variant?: string } | undefined {
  if (!model) return undefined
  return model.variant
    ? { providerID: model.providerID, id: model.modelID, variant: model.variant }
    : { providerID: model.providerID, id: model.modelID }
}

interface UsageSnapshot {
  input: number
  output: number
  costUsd: number
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/**
 * Token accounting: input = fresh input + cache writes, output = output + reasoning. Cache reads
 * are excluded from the token count (they are cheap and already reflected in the reported cost).
 */
export function usageSnapshot(info: Pick<SessionInfo, "cost" | "tokens"> | null | undefined): UsageSnapshot {
  const t = info?.tokens
  return {
    input: n(t?.input) + n(t?.cache?.write),
    output: n(t?.output) + n(t?.reasoning),
    costUsd: n(info?.cost),
  }
}

export function usageDelta(before: UsageSnapshot, after: UsageSnapshot): Usage {
  return {
    inputTokens: Math.max(0, after.input - before.input),
    outputTokens: Math.max(0, after.output - before.output),
    costUsd: Math.max(0, after.costUsd - before.costUsd),
    estimated: false,
  }
}

/** Assistant messages after the last user message (the reply to the latest prompt). */
function latestReply(messages: readonly SessionMessage[]): AssistantMessage[] {
  let lastUser = -1
  messages.forEach((m, i) => {
    if (m.type === "user") lastUser = i
  })
  return messages.slice(lastUser + 1).filter((m): m is AssistantMessage => m.type === "assistant")
}

function textOf(m: AssistantMessage): string {
  return m.content
    .filter((c): c is Extract<AssistantMessage["content"][number], { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim()
}

/** Final assistant text of the latest reply, plus the last assistant error (if any). */
export function extractReply(messages: readonly SessionMessage[]): { text: string; error: string | null } {
  const replies = latestReply(messages)
  const last = replies[replies.length - 1]
  let text = ""
  for (let i = replies.length - 1; i >= 0 && !text; i--) text = textOf(replies[i]!)
  return { text, error: last?.error ? last.error.message || last.error.type : null }
}

type Raced<T> = { kind: "done"; value: T } | { kind: "timeout" } | { kind: "interrupted" }

/**
 * Race `work` against an optional timer and an abort signal. `work` receives a signal that is
 * aborted once the race is decided (it cancels the pending request only where the host honours
 * request signals; runAgent additionally interrupts the session).
 */
export async function raceWait<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | null,
  signal?: AbortSignal,
): Promise<Raced<T>> {
  if (signal?.aborted) return { kind: "interrupted" }
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  let onAbort: (() => void) | null = null
  const racers: Array<Promise<Raced<T>>> = [work(ctl.signal).then((value): Raced<T> => ({ kind: "done", value }))]
  if (timeoutMs !== null) {
    racers.push(
      new Promise<Raced<T>>((res) => {
        timer = setTimeout(() => res({ kind: "timeout" }), Math.max(0, timeoutMs))
      }),
    )
  }
  if (signal) {
    racers.push(
      new Promise<Raced<T>>((res) => {
        onAbort = () => res({ kind: "interrupted" })
        signal.addEventListener("abort", onAbort, { once: true })
      }),
    )
  }
  try {
    return await Promise.race(racers)
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener("abort", onAbort)
    ctl.abort()
  }
}

// ---------------------------------------------------------------------------
// host
// ---------------------------------------------------------------------------

export function createV2LlmHost(pctx: V2LlmContext, opts: { log: Logger }): LlmHost {
  const log = opts.log
  const session = pctx.session

  async function snapshot(sessionID: string): Promise<UsageSnapshot> {
    try {
      return usageSnapshot(await session.get({ sessionID }))
    } catch (err) {
      log.warn("could not read session usage", { sessionID, error: errorMessage(err) })
      return { input: 0, output: 0, costUsd: 0 }
    }
  }

  async function runAgent(req: AgentRunRequest): Promise<AgentRunResult> {
    assertIsolatedAgentDirectory(req.directory)
    // Before the location boots (create/resume): never let it load planted config or plugins.
    sweepLocation(req.directory, log)
    let sessionID = req.sessionId ?? null
    let before: UsageSnapshot = { input: 0, output: 0, costUsd: 0 }
    if (sessionID) {
      registerAgentSession(sessionID, req.directory)
      before = await snapshot(sessionID)
    } else {
      const model = toV2Model(req.model)
      const created = await session.create({
        title: req.title,
        location: { directory: req.directory },
        permissions: agentPermissionRules(),
        ...(model ? { model } : {}),
        ...(req.agent ? { agent: req.agent } : {}),
      })
      sessionID = created.id
      registerAgentSession(sessionID, req.directory)
      before = usageSnapshot(created)
    }
    const id = sessionID
    const interrupt = async (): Promise<void> => {
      try {
        await session.interrupt({ sessionID: id })
      } catch (err) {
        log.warn("could not interrupt agent session", { sessionID: id, error: errorMessage(err) })
      }
    }

    // Kill switch / stop() fired before the prompt: spend nothing.
    if (req.signal?.aborted) {
      return { sessionId: id, text: "", usage: usageDelta(before, before), outcome: "interrupted", error: "agent session was interrupted" }
    }

    let waited: Raced<void>["kind"]
    try {
      await session.prompt({ sessionID: id, text: req.prompt })
      waited = (await raceWait((signal) => session.wait({ sessionID: id }, { signal }), req.timeoutMs, req.signal)).kind
    } catch (err) {
      // Nobody would be watching the session any more: stop it before reporting the error, so an
      // agent does not keep editing the task directory (and spending budget) in the background.
      await interrupt()
      sweepLocation(req.directory, log)
      throw err
    }
    if (waited !== "done") await interrupt()

    let reply: { text: string; error: string | null } = { text: "", error: null }
    try {
      reply = extractReply(await session.context({ sessionID: id }))
    } catch (err) {
      reply = { text: "", error: `could not read the session transcript: ${errorMessage(err)}` }
    }

    let info: SessionInfo | null = null
    try {
      info = await session.get({ sessionID: id })
    } catch (err) {
      log.warn("could not read session info", { sessionID: id, error: errorMessage(err) })
    }
    const usage = usageDelta(before, info ? usageSnapshot(info) : before)

    const planted = sweepLocation(req.directory, log)
    if (planted) return { sessionId: id, text: reply.text, usage, outcome: "failed", error: planted }
    if (waited === "timeout") {
      return { sessionId: id, text: reply.text, usage, outcome: "timeout", error: `agent session timed out after ${req.timeoutMs} ms` }
    }
    if (waited === "interrupted") {
      return { sessionId: id, text: reply.text, usage, outcome: "interrupted", error: "agent session was interrupted" }
    }
    const outcome = info?.outcome ?? (reply.error ? "failed" : "succeeded")
    const error = outcome === "succeeded" ? null : (reply.error ?? `agent session ${outcome}`)
    return { sessionId: id, text: reply.text, usage, outcome, error }
  }

  async function generate(req: GenerateRequest): Promise<GenerateResult> {
    const model = toV2Model(req.model)
    // opencode 2.0.24's plugin adapter drops the request options, so a generation that loses the race
    // (timeout/interrupt) cannot be cancelled: it may finish in the background and is not recorded.
    // generate.text reports no usage either: tokens are estimated (chars/4) and the cost is $0.
    const res = await raceWait(
      (signal) => pctx.generate.text(model ? { prompt: req.prompt, model } : { prompt: req.prompt }, { signal }),
      req.timeoutMs ?? null,
      req.signal,
    )
    if (res.kind === "timeout") throw new Error(`generation timed out after ${req.timeoutMs} ms`)
    if (res.kind === "interrupted") throw new Error("generation was interrupted")
    const text = res.value.text ?? ""
    return {
      text,
      usage: { inputTokens: estimateTokens(req.prompt), outputTokens: estimateTokens(text), costUsd: 0, estimated: true },
    }
  }

  return { kind: "opencode-v2", runAgent, generate }
}
