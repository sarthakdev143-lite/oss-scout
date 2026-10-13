import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Hooks, PluginInput, ToolContext, ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { createApp } from "../src/app.ts"
import { agentSessionDirs, agentSessions, BLOCKED_MESSAGE, registerAgentSession } from "../src/plugin/llm-v2.ts"
import { buildV1Tools, createServerV1, serverV1 } from "../src/plugin/v1.ts"
import { runningScheduler } from "../src/scheduler/daemon.ts"
import { FakeClock } from "../src/util/clock.ts"
import { FakeGitHub, FakeSandbox, fakeExec } from "./helpers/fakes.ts"

// ---------------------------------------------------------------------------
// environment hygiene: no real token, no real network
// ---------------------------------------------------------------------------

const ENV_KEYS = ["GITHUB_TOKEN", "OSS_SCOUT_WRITE_TOKEN", "OSS_SCOUT_CONFIG"] as const
let savedEnv: Record<string, string | undefined> = {}
let realFetch: typeof fetch
let realConsoleError: typeof console.error
let fetchCalls: string[] = []
let consoleErrors: string[] = []
const cleanups: Array<() => Promise<void> | void> = []

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  realFetch = globalThis.fetch
  fetchCalls = []
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls.push(String(input))
    throw new Error("network disabled in tests")
  }) as unknown as typeof fetch
  realConsoleError = console.error
  consoleErrors = []
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "))
  }
})

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  globalThis.fetch = realFetch
  console.error = realConsoleError
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  expect(fetchCalls).toEqual([])
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oss-scout-v1-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return dir
}

function project(config: Record<string, unknown> = {}): { dir: string; stateDir: string; configFile: string } {
  const dir = tempDir()
  const stateDir = join(dir, "state")
  const configFile = join(dir, "oss-scout.config.json")
  writeFileSync(configFile, JSON.stringify({ stateDir, scheduler: { autostart: false }, ...config }))
  return { dir, stateDir, configFile }
}

// ---------------------------------------------------------------------------
// fake V1 plugin input
// ---------------------------------------------------------------------------

function v1Input(directory: string): PluginInput {
  const noLlm = async () => {
    throw new Error("no LLM in tests")
  }
  return {
    directory,
    worktree: directory,
    project: { id: "prj_test", worktree: directory, time: { created: 0 } },
    client: { session: { create: noLlm, prompt: noLlm, messages: noLlm, abort: noLlm, delete: noLlm } },
    serverUrl: new URL("http://127.0.0.1:4096"),
    experimental_workspace: { register: () => undefined },
    $: undefined,
  } as unknown as PluginInput
}

const toolCtx = (sessionID: string): ToolContext => ({
  sessionID,
  messageID: "msg_1",
  agent: "build",
  directory: "/x",
  worktree: "/x",
  abort: new AbortController().signal,
  metadata: () => undefined,
  ask: async () => undefined,
})

/**
 * The plugin never reads the location's config: a config in `directory` is selected with the
 * `configPath` option, and ~/.oss-scout / the checkout are replaced with empty temp dirs (the real
 * ~/.oss-scout is never read or written).
 */
async function start(directory: string, options?: Record<string, unknown>, withFakes = false): Promise<Hooks> {
  const isolated = tempDir()
  const located = join(directory, "oss-scout.config.json")
  const opts = options ?? (existsSync(located) ? { configPath: located } : { stateDir: join(isolated, "state") })
  const server = createServerV1({
    homeDir: isolated,
    packageDirectory: isolated,
    ...(withFakes
      ? {
          env: {},
          exec: fakeExec(),
          overrides: { github: new FakeGitHub(), githubWriter: new FakeGitHub(), sandbox: new FakeSandbox(), clock: new FakeClock() },
        }
      : {}),
  })
  const hooks = await server(v1Input(directory), opts)
  if (hooks.dispose) cleanups.push(hooks.dispose)
  return hooks
}

async function run(t: ToolDefinition | undefined, args: unknown, sessionID = "ses_human"): Promise<string> {
  if (!t) throw new Error("tool missing")
  const out = await t.execute(args as never, toolCtx(sessionID))
  return typeof out === "string" ? out : out.output
}

async function guard(hooks: Hooks, tool: string, sessionID: string, args: unknown = {}): Promise<string> {
  try {
    await hooks["tool.execute.before"]!({ tool, sessionID, callID: "call_1" }, { args })
    return "allowed"
  } catch (err) {
    return (err as Error).message
  }
}

function trackAgentSession(id: string): string {
  agentSessions.add(id)
  cleanups.push(() => {
    agentSessions.delete(id)
  })
  return id
}

async function seedItem(dir: string): Promise<number> {
  const app = createApp({ directory: dir, llm: null, env: {}, exec: fakeExec(), overrides: { clock: new FakeClock() } })
  try {
    return app.queue.enqueue({
      kind: "pr",
      repo: "acme/widget",
      issueUrl: null,
      prUrl: null,
      taskId: null,
      title: "fix: handle zero timeout",
      body: "Fixes #42",
      diff: "diff --git a/x b/x\n+fix\n",
      testOutput: "",
      critic: null,
      verification: null,
      branch: null,
      workspace: null,
      baseBranch: null,
    }).id
  } finally {
    await app.close()
  }
}

const TOOL_NAMES = ["oss_scout_queue_edit", "oss_scout_queue_list", "oss_scout_queue_reject", "oss_scout_queue_show", "oss_scout_status"]

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

describe("serverV1 tools", () => {
  test("exactly the five oss_scout tools, no approve; descriptions say approval is CLI-only", async () => {
    const { dir } = project()
    const hooks = await start(dir)
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual(TOOL_NAMES)
    expect(Object.keys(hooks.tool ?? {}).some((n) => /approve/i.test(n))).toBe(false)
    for (const t of Object.values(hooks.tool ?? {})) {
      expect(t.description).toContain("human-only")
      expect(t.description).toContain("interactive terminal")
      // the model is never handed a command line it could run from a shell tool
      expect(t.description).not.toContain("bun src/cli.ts")
    }
    expect(Object.keys(hooks).sort()).toEqual(["dispose", "tool", "tool.execute.before"])
  })

  test("tool args are zod shapes matching the V2 inputs", async () => {
    const { dir } = project()
    const tools = (await start(dir)).tool!
    const parse = (name: string, v: unknown) => z.object(tools[name]!.args).safeParse(v).success
    expect(parse("oss_scout_status", {})).toBe(true)
    expect(parse("oss_scout_queue_list", {})).toBe(true)
    expect(parse("oss_scout_queue_list", { status: "all" })).toBe(true)
    expect(parse("oss_scout_queue_list", { status: "bogus" })).toBe(false)
    expect(parse("oss_scout_queue_show", { id: 3 })).toBe(true)
    expect(parse("oss_scout_queue_show", { id: 0 })).toBe(false)
    expect(parse("oss_scout_queue_reject", { id: 3, reason: "dup" })).toBe(true)
    expect(parse("oss_scout_queue_reject", { id: 3, reason: "" })).toBe(false)
    expect(parse("oss_scout_queue_edit", { id: 3, field: "body", text: "x" })).toBe(true)
    expect(parse("oss_scout_queue_edit", { id: 3, field: "status", text: "x" })).toBe(false)
  })

  test("execute routes to the command router as a tool", async () => {
    const { dir } = project()
    const id = await seedItem(dir)
    const tools = (await start(dir, undefined, true)).tool!
    expect(await run(tools.oss_scout_queue_list, {})).toContain("Approval queue (pending): 1 item(s)")
    expect(await run(tools.oss_scout_queue_list, { status: "all" })).toContain("Approval queue (all): 1 item(s)")
    expect(await run(tools.oss_scout_queue_show, { id })).toContain(`Queue item #${id}`)
    expect(await run(tools.oss_scout_status, {})).toContain("oss-scout status at")
    expect(await run(tools.oss_scout_queue_edit, { id, field: "title", text: "fix: zero timeouts" })).toContain(
      "A human must review it again",
    )
    expect(await run(tools.oss_scout_queue_reject, { id, reason: "not useful" })).toBe(
      `Rejected queue item #${id} (acme/widget): not useful`,
    )
  })

  test("invalid input is reported, not thrown", async () => {
    const { dir } = project()
    const tools = (await start(dir)).tool!
    expect(await run(tools.oss_scout_queue_show, { id: "abc" })).toStartWith("error: invalid input for oss_scout_queue_show")
    expect(await run(tools.oss_scout_queue_edit, { id: 1, field: "title" })).toStartWith("error: invalid input")
  })

  test("tools refuse inside an oss-scout agent session", async () => {
    const { dir } = project()
    const tools = (await start(dir)).tool!
    const agent = trackAgentSession("ses_v1_agent_tools")
    for (const t of Object.values(tools)) expect(await run(t, { id: 1, reason: "x" }, agent)).toBe(`error: ${BLOCKED_MESSAGE}`)
  })

  test("buildV1Tools works on any app", async () => {
    const { dir } = project()
    const app = createApp({ directory: dir, llm: null, env: {}, exec: fakeExec() })
    cleanups.push(() => app.close())
    const tools = buildV1Tools(app)
    expect(Object.keys(tools).sort()).toEqual(TOOL_NAMES)
    expect(await run(tools.oss_scout_queue_list, {})).toContain("Approval queue (pending): 0 item(s)")
  })
})

// ---------------------------------------------------------------------------
// guard, dispose, task locations, failures, autostart
// ---------------------------------------------------------------------------

describe("serverV1 hooks", () => {
  test("the guard blocks bash (and config writes) for agent sessions only", async () => {
    const { dir } = project()
    const hooks = await start(dir)
    const agent = trackAgentSession("ses_v1_agent_guard")
    // allowlist: MCP server tools and other plugins' tools are blocked as well
    for (const t of ["bash", "shell", "webfetch", "task", "oss_scout_queue_reject", "github_create_pull_request", "neon_run_sql", "lsp", "skill"]) {
      expect(await guard(hooks, t, agent)).toBe(BLOCKED_MESSAGE)
      expect(await guard(hooks, t, "ses_normal")).toBe("allowed")
    }
    for (const t of ["edit", "glob", "grep", "list", "apply_patch"]) expect(await guard(hooks, t, agent)).toBe("allowed")
    expect(await guard(hooks, "write", agent, { filePath: join(dir, ".opencode", "plugins", "x.ts"), content: "" })).toBe(
      BLOCKED_MESSAGE,
    )
    expect(await guard(hooks, "write", agent, { filePath: join(dir, "repo", "src", "x.ts"), content: "" })).toBe("allowed")
    expect(await guard(hooks, "read", agent)).toBe("allowed")
  })

  test("the guard blocks agent paths that escape the work tree through a junction", async () => {
    const { dir } = project()
    const hooks = await start(dir)
    const taskDir = join(dir, "task")
    mkdirSync(join(taskDir, "repo", "src"), { recursive: true })
    const outside = join(dir, "outside")
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(taskDir, "repo", "link"), "junction")
    const agent = trackAgentSession("ses_v1_agent_paths")
    registerAgentSession(agent, taskDir)
    cleanups.push(() => {
      agentSessionDirs.delete(agent)
    })
    expect(await guard(hooks, "read", agent, { filePath: join(taskDir, "repo", "link", "x.txt") })).toBe(BLOCKED_MESSAGE)
    expect(await guard(hooks, "write", agent, { filePath: "repo/link/x.ts", content: "" })).toBe(BLOCKED_MESSAGE)
    expect(await guard(hooks, "read", agent, { filePath: "repo/src/a.ts" })).toBe("allowed")
    expect(await guard(hooks, "read", agent, { odd: 1 })).toBe("allowed")
  })

  test("dispose closes the app (idempotent)", async () => {
    const { dir } = project()
    const hooks = await start(dir)
    await hooks.dispose!()
    expect(await run(hooks.tool!.oss_scout_queue_list, {})).toStartWith("error:")
    await hooks.dispose!()
  })

  test("inside the workspaces dir only the guard is returned (every session) and no app is created", async () => {
    const { configFile, stateDir } = project()
    const taskDir = join(stateDir, "workspaces", "task_1")
    mkdirSync(taskDir, { recursive: true })
    const hooks = await start(taskDir, { configPath: configFile })
    expect(Object.keys(hooks)).toEqual(["tool.execute.before"])
    expect(existsSync(join(stateDir, "oss-scout.db"))).toBe(false)
    expect(await guard(hooks, "bash", "ses_anyone")).toBe(BLOCKED_MESSAGE)
    expect(await guard(hooks, "read", "ses_anyone")).toBe("allowed")
  })

  test("an invalid config logs the reason and keeps only the guard", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "oss-scout.config.json"), JSON.stringify({ mode: "yolo" }))
    const hooks = await start(dir)
    expect(Object.keys(hooks)).toEqual(["tool.execute.before"])
    expect(consoleErrors.join("\n")).toContain("Invalid oss-scout config")
    expect(consoleErrors.join("\n")).toContain("bun src/cli.ts doctor")
    const agent = trackAgentSession("ses_v1_agent_badcfg")
    expect(await guard(hooks, "bash", agent)).toBe(BLOCKED_MESSAGE)
    expect(await guard(hooks, "bash", "ses_normal")).toBe("allowed")
  })

  test("autostarts the scheduler in the home directory; dispose stops it", async () => {
    const { dir, stateDir } = project({ scheduler: { autostart: true, tickSeconds: 10 } })
    const hooks = await start(dir)
    await new Promise((r) => setTimeout(r, 30))
    expect(runningScheduler(stateDir)).not.toBeNull()
    await hooks.dispose!()
    expect(runningScheduler(stateDir)).toBeNull()
  })

  test("no autostart in mode off", async () => {
    const { dir, stateDir } = project({ mode: "off", scheduler: { autostart: true, tickSeconds: 10 } })
    await start(dir)
    await new Promise((r) => setTimeout(r, 30))
    expect(runningScheduler(stateDir)).toBeNull()
  })

  test("the opened project's oss-scout.config.json is never loaded (no token redirect, no scheduler)", async () => {
    const attacker = tempDir()
    const attackerState = join(attacker, ".s")
    writeFileSync(
      join(attacker, "oss-scout.config.json"),
      JSON.stringify({ github: { apiBaseUrl: "https://attacker.example" }, stateDir: "./.s", scheduler: { autostart: true, tickSeconds: 10 } }),
    )
    const hooks = await start(attacker, {})
    expect(Object.keys(hooks).sort()).toEqual(["dispose", "tool", "tool.execute.before"])
    expect(await run(hooks.tool!.oss_scout_status, {})).not.toContain("attacker.example")
    await new Promise((r) => setTimeout(r, 30))
    expect(existsSync(attackerState)).toBe(false)
    expect(runningScheduler(attackerState)).toBeNull()
  })
})
