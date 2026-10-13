import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { estimateTokens } from "../src/llm/host.ts"
import {
  agentPermissionRules,
  agentSessionDirs,
  agentSessions,
  ALLOWED_AGENT_ACTIONS,
  ALLOWED_AGENT_TOOLS,
  assertIsolatedAgentDirectory,
  checkAgentPaths,
  createV2LlmHost,
  extractReply,
  isAllowedAgentTool,
  isBlockedAgentCall,
  isBlockedAgentTool,
  PARENT_DIR_RESOURCES,
  PATH_AGENT_ACTIONS,
  patchFilePaths,
  pathGuardBlocks,
  realPathOf,
  registerAgentSession,
  removePlantedOpencodeConfig,
  isOpencodeConfigPath,
  raceWait,
  targetsOpencodeConfig,
  toV2Model,
  usageDelta,
  usageSnapshot,
  type PermissionRule,
  type V2LlmContext,
} from "../src/plugin/llm-v2.ts"
import { nullLogger } from "../src/util/log.ts"

// ---------------------------------------------------------------------------
// fake V2 session domain (shapes follow @opencode/client SessionInfo / SessionMessageInfo)
// ---------------------------------------------------------------------------

interface Tokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

interface Info {
  id: string
  projectID: string
  cost: number
  tokens: Tokens
  outcome?: "succeeded" | "failed" | "interrupted"
  time: { created: number; updated: number }
  location: { directory: string }
  title?: string
}

type Message =
  | { type: "user"; id: string; text: string; time: { created: number } }
  | {
      type: "assistant"
      id: string
      agent: string
      model: { id: string; providerID: string }
      content: Array<{ type: "text"; text: string } | { type: "reasoning"; text: string } | { type: "tool"; id: string; name: string }>
      time: { created: number }
      error?: { type: string; message: string }
    }

function tokens(over: Partial<Omit<Tokens, "cache">> & { cacheRead?: number; cacheWrite?: number } = {}): Tokens {
  return {
    input: over.input ?? 0,
    output: over.output ?? 0,
    reasoning: over.reasoning ?? 0,
    cache: { read: over.cacheRead ?? 0, write: over.cacheWrite ?? 0 },
  }
}

function info(over: Partial<Info> = {}): Info {
  return {
    id: "ses_new",
    projectID: "prj_1",
    cost: 0,
    tokens: tokens(),
    time: { created: 1, updated: 1 },
    location: { directory: "/state/workspaces/t1" },
    ...over,
  }
}

const user = (text: string, id = `msg_u_${text}`): Message => ({ type: "user", id, text, time: { created: 1 } })

function assistant(text: string | null, over: { error?: { type: string; message: string }; tool?: boolean } = {}): Message {
  const content: Array<{ type: "text"; text: string } | { type: "reasoning"; text: string } | { type: "tool"; id: string; name: string }> = []
  content.push({ type: "reasoning", text: "thinking about it" })
  if (over.tool) content.push({ type: "tool", id: "call_1", name: "edit" })
  if (text !== null) content.push({ type: "text", text })
  return {
    type: "assistant",
    id: `msg_a_${text ?? "tool"}`,
    agent: "build",
    model: { id: "m", providerID: "p" },
    content,
    time: { created: 2 },
    ...(over.error ? { error: over.error } : {}),
  }
}

interface FakeOpts {
  created?: Info
  /** session.get results, in order (the last one repeats). */
  gets?: Array<Info | Error>
  messages?: Message[] | Error
  wait?: (input: { sessionID: string }, opts: { signal?: AbortSignal } | undefined) => Promise<void>
  prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>
  generate?: (input: unknown, opts: { signal?: AbortSignal } | undefined) => Promise<{ text: string }>
}

function fakeHost(opts: FakeOpts = {}) {
  const calls: string[] = []
  const rec = {
    created: [] as unknown[],
    prompts: [] as Array<{ sessionID: string; text: string }>,
    waits: [] as Array<{ input: { sessionID: string }; signal: AbortSignal | undefined }>,
    interrupts: [] as unknown[],
    contexts: [] as unknown[],
    gets: [] as unknown[],
    generations: [] as Array<{ input: unknown; signal: AbortSignal | undefined }>,
  }
  let getIndex = 0
  const session = {
    async create(input: unknown) {
      calls.push("create")
      rec.created.push(input)
      return opts.created ?? info()
    },
    async prompt(input: { sessionID: string; text: string }) {
      calls.push("prompt")
      rec.prompts.push(input)
      if (opts.prompt) return opts.prompt(input)
      return { id: "inbox_1" }
    },
    async wait(input: { sessionID: string }, requestOptions?: { signal?: AbortSignal }) {
      calls.push("wait")
      rec.waits.push({ input, signal: requestOptions?.signal })
      if (opts.wait) return opts.wait(input, requestOptions)
    },
    async interrupt(input: unknown) {
      calls.push("interrupt")
      rec.interrupts.push(input)
      return { interrupted: true }
    },
    async context(input: unknown) {
      calls.push("context")
      rec.contexts.push(input)
      if (opts.messages instanceof Error) throw opts.messages
      return opts.messages ?? [user("do it"), assistant("done")]
    },
    async get(input: unknown) {
      calls.push("get")
      rec.gets.push(input)
      const list = opts.gets ?? [info()]
      const r = list[Math.min(getIndex++, list.length - 1)]!
      if (r instanceof Error) throw r
      return r
    },
  }
  const generate = {
    async text(input: unknown, requestOptions?: { signal?: AbortSignal }) {
      calls.push("generate")
      rec.generations.push({ input, signal: requestOptions?.signal })
      if (opts.generate) return opts.generate(input, requestOptions)
      return { text: "generated text" }
    },
  }
  const pctx = { session, generate } as unknown as V2LlmContext
  const host = createV2LlmHost(pctx, { log: nullLogger })
  return { host, calls, rec }
}

/** A wait that only ends when its request is aborted (like a real long-poll being cancelled). */
const hangingWait = (_input: unknown, opts: { signal?: AbortSignal } | undefined): Promise<void> =>
  new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  })

const baseReq = { title: "oss-scout acme/widget#42 fix", directory: "/state/workspaces/t1", prompt: "Fix the bug.", timeoutMs: 60_000 }

// ---------------------------------------------------------------------------
// permissions
// ---------------------------------------------------------------------------

/** Minimal evaluator: last matching rule wins; `*` matches anything (including separators). */
function evaluate(rules: PermissionRule[], action: string, resource: string): string | null {
  const match = (pattern: string, value: string) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "s").test(value)
  let effect: string | null = null
  for (const r of rules) if (match(r.action, action) && match(r.resource, resource)) effect = r.effect
  return effect
}

describe("agentPermissionRules", () => {
  const rules = agentPermissionRules()
  const lastAllow = rules.map((r) => r.effect).lastIndexOf("allow")

  test("everything is denied first", () => {
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
  })

  test("only file actions are allowed", () => {
    const allowed = rules.filter((r) => r.effect === "allow")
    expect(allowed.map((r) => r.action).sort()).toEqual([...ALLOWED_AGENT_ACTIONS].sort())
    expect(allowed.every((r) => r.resource === "*")).toBe(true)
    for (const a of ["shell", "bash", "webfetch", "websearch", "subagent", "task", "question", "external_directory"]) {
      expect(allowed.some((r) => r.action === a)).toBe(false)
    }
  })

  test("dangerous actions are denied again after the allows", () => {
    for (const action of ["shell", "bash", "webfetch", "websearch", "subagent", "task", "external_directory", "question", "skill"]) {
      const idx = rules.findIndex((r) => r.action === action && r.resource === "*" && r.effect === "deny")
      expect(idx).toBeGreaterThan(lastAllow)
    }
  })

  test("no rule asks (a headless session would hang)", () => {
    expect(rules.some((r) => r.effect === "ask")).toBe(false)
  })

  test("paths that leave the location (an enclosing repository) are denied for every file action", () => {
    for (const action of PATH_AGENT_ACTIONS) {
      for (const resource of ["..", "../src/plugin/v2.ts", "../../.config/opencode/plugins/x.ts", "..\\..\\src\\x.ts"]) {
        expect(`${action} ${resource}: ${evaluate(rules, action, resource)}`).toBe(`${action} ${resource}: deny`)
      }
    }
    // in-location paths (relative, no ".." prefix) stay allowed — including names that merely start with ".."
    expect(evaluate(rules, "edit", "repo/src/index.ts")).toBe("allow")
    expect(evaluate(rules, "read", "repo/..config")).toBe("allow")
    expect(evaluate(rules, "read", "..foo")).toBe("allow")
    for (const r of PARENT_DIR_RESOURCES) expect(rules.findIndex((x) => x.resource === r)).toBeGreaterThan(lastAllow)
  })

  test("reading .env files is denied after the read allow", () => {
    const readAllow = rules.findIndex((r) => r.action === "read" && r.effect === "allow")
    const envDeny = rules.findIndex((r) => r.action === "read" && r.resource === "*.env" && r.effect === "deny")
    expect(envDeny).toBeGreaterThan(readAllow)
  })

  test("the rules evaluate as intended (last match wins)", () => {
    expect(evaluate(rules, "shell", "rm -rf /")).toBe("deny")
    expect(evaluate(rules, "bash", "*")).toBe("deny")
    expect(evaluate(rules, "webfetch", "https://example.com")).toBe("deny")
    expect(evaluate(rules, "external_directory", "/etc")).toBe("deny")
    expect(evaluate(rules, "some_mcp_tool", "x")).toBe("deny")
    expect(evaluate(rules, "oss_scout_queue_reject", "*")).toBe("deny")
    expect(evaluate(rules, "read", "/state/workspaces/t1/repo/src/a.ts")).toBe("allow")
    expect(evaluate(rules, "read", "/state/workspaces/t1/repo/.env")).toBe("deny")
    expect(evaluate(rules, "read", "/state/workspaces/t1/repo/.env.local")).toBe("deny")
    expect(evaluate(rules, "edit", "/state/workspaces/t1/repo/src/a.ts")).toBe("allow")
    expect(evaluate(rules, "write", "repo/test/a.test.ts")).toBe("allow")
  })

  test("writing opencode config/plugins (which would run on the host) is denied", () => {
    for (const action of ["edit", "write", "patch"]) {
      for (const resource of [
        "/state/workspaces/t1/.opencode/plugins/evil.ts",
        ".opencode/plugins/evil.ts",
        "C:\\state\\workspaces\\t1\\.opencode\\plugins\\evil.ts",
        "/state/workspaces/t1/.opencode",
        "/state/workspaces/t1/opencode.json",
        "opencode.jsonc",
      ]) {
        expect(`${action} ${resource} → ${evaluate(rules, action, resource)}`).toBe(`${action} ${resource} → deny`)
      }
    }
    expect(evaluate(rules, "read", "/state/workspaces/t1/opencode.json")).toBe("allow")
  })

  test("a fresh array every call", () => {
    expect(agentPermissionRules()).not.toBe(agentPermissionRules())
    expect(agentPermissionRules()).toEqual(rules)
  })
})

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

describe("runAgent", () => {
  test("creates a located, permission-restricted session with the mapped model and agent", async () => {
    const { host, rec } = fakeHost({ created: info({ id: "ses_create_1" }) })
    const res = await host.runAgent({
      ...baseReq,
      model: { providerID: "anthropic", modelID: "claude-x", variant: "high" },
      agent: "build",
    })
    expect(host.kind).toBe("opencode-v2")
    expect(rec.created).toEqual([
      {
        title: baseReq.title,
        location: { directory: baseReq.directory },
        permissions: agentPermissionRules(),
        model: { providerID: "anthropic", id: "claude-x", variant: "high" },
        agent: "build",
      },
    ])
    expect(res.sessionId).toBe("ses_create_1")
    expect(agentSessions.has("ses_create_1")).toBe(true)
  })

  test("refuses a task directory inside a git work tree (opencode would expose that repository) before creating a session", async () => {
    const root = mkdtempSync(join(tmpdir(), "oss-scout-v2-gitroot-"))
    try {
      mkdirSync(join(root, ".git"))
      const taskDir = join(root, "state", "workspaces", "t1")
      mkdirSync(taskDir, { recursive: true })
      const { host, calls } = fakeHost()
      await expect(host.runAgent({ ...baseReq, directory: taskDir })).rejects.toThrow(`inside the git repository ${root}`)
      await expect(host.runAgent({ ...baseReq, directory: taskDir, sessionId: "ses_resume" })).rejects.toThrow("refusing to run an agent session")
      expect(calls).toEqual([])
      expect(() => assertIsolatedAgentDirectory(taskDir)).toThrow('Set "stateDir" to a directory outside any git repository')
      rmSync(join(root, ".git"), { recursive: true })
      expect(() => assertIsolatedAgentDirectory(taskDir)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("opencode config planted in the task directory is removed before the location boots and fails the attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "oss-scout-v2-plant-"))
    try {
      const taskDir = join(root, "workspaces", "t1")
      mkdirSync(join(taskDir, "repo", ".opencode"), { recursive: true })
      // left over from an earlier run (e.g. a crash): removed before session.create boots the location
      mkdirSync(join(taskDir, ".opencode", "plugins"), { recursive: true })
      writeFileSync(join(taskDir, ".opencode", "plugins", "evil.ts"), "export default {}")
      let leftoverAtPrompt: boolean | null = null
      const { host } = fakeHost({
        prompt: async () => {
          leftoverAtPrompt = existsSync(join(taskDir, ".opencode"))
          // the agent plants config during the session
          writeFileSync(join(taskDir, "opencode.json"), "{}")
          return { id: "inbox_1" }
        },
      })
      const res = await host.runAgent({ ...baseReq, directory: taskDir })
      expect(leftoverAtPrompt === false).toBe(true)
      expect(existsSync(join(taskDir, ".opencode"))).toBe(false)
      expect(existsSync(join(taskDir, "opencode.json"))).toBe(false)
      expect(res.outcome).toBe("failed")
      expect(res.error).toContain("opencode config/plugin files appeared in the task directory and were removed (opencode.json)")
      // the clone's own files are not touched (the location is the task directory, not the clone)
      expect(existsSync(join(taskDir, "repo", ".opencode"))).toBe(true)
      expect(removePlantedOpencodeConfig(taskDir)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("an already-aborted signal (kill switch / stop) sends no prompt", async () => {
    const { host, calls } = fakeHost({ created: info({ id: "ses_pre_abort" }) })
    const ctl = new AbortController()
    ctl.abort()
    const res = await host.runAgent({ ...baseReq, signal: ctl.signal })
    expect(res.outcome).toBe("interrupted")
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: false })
    expect(calls).not.toContain("prompt")
  })

  test("omits model and agent when not given; no variant key without a variant", async () => {
    const a = fakeHost()
    await a.host.runAgent(baseReq)
    expect(a.rec.created[0]).toEqual({ title: baseReq.title, location: { directory: baseReq.directory }, permissions: agentPermissionRules() })
    const b = fakeHost()
    await b.host.runAgent({ ...baseReq, model: { providerID: "p", modelID: "m" }, agent: null })
    expect((b.rec.created[0] as { model: unknown }).model).toEqual({ providerID: "p", id: "m" })
    expect("agent" in (b.rec.created[0] as object)).toBe(false)
  })

  test("prompt, then wait, then context: text is the latest reply's final text", async () => {
    const { host, calls, rec } = fakeHost({
      created: info({ id: "ses_order" }),
      messages: [
        user("first"),
        assistant("old reply"),
        user("Fix the bug."),
        assistant("step one"),
        assistant(null, { tool: true }),
        assistant("final answer"),
      ],
    })
    const res = await host.runAgent(baseReq)
    expect(calls).toEqual(["create", "prompt", "wait", "context", "get"])
    expect(rec.prompts).toEqual([{ sessionID: "ses_order", text: "Fix the bug." }])
    expect(rec.waits[0]!.input).toEqual({ sessionID: "ses_order" })
    expect(rec.waits[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(res).toMatchObject({ sessionId: "ses_order", text: "final answer", outcome: "succeeded", error: null })
    expect(rec.interrupts).toHaveLength(0)
  })

  test("a trailing tool-only message falls back to the previous text; no reply means empty text", async () => {
    const a = fakeHost({ messages: [user("go"), assistant("the summary"), assistant(null, { tool: true })] })
    expect((await a.host.runAgent(baseReq)).text).toBe("the summary")
    const b = fakeHost({ messages: [user("old"), assistant("stale"), user("go")] })
    expect((await b.host.runAgent(baseReq)).text).toBe("")
  })

  test("usage is the session.get delta: input + cache writes, output + reasoning, cost", async () => {
    const { host } = fakeHost({
      created: info({ cost: 0.01, tokens: tokens({ input: 10, cacheWrite: 5, output: 3, reasoning: 2, cacheRead: 1000 }) }),
      gets: [info({ cost: 0.21, tokens: tokens({ input: 110, cacheWrite: 25, output: 53, reasoning: 12, cacheRead: 9000 }) })],
    })
    const res = await host.runAgent(baseReq)
    expect(res.usage.inputTokens).toBe(120)
    expect(res.usage.outputTokens).toBe(60)
    expect(res.usage.costUsd).toBeCloseTo(0.2, 10)
    expect(res.usage.estimated).toBe(false)
  })

  test("timeout: the wait is cancelled, the session interrupted, outcome timeout", async () => {
    const { host, rec } = fakeHost({ created: info({ id: "ses_slow" }), wait: hangingWait, messages: [user("go"), assistant("partial")] })
    const res = await host.runAgent({ ...baseReq, timeoutMs: 20 })
    expect(res.outcome).toBe("timeout")
    expect(res.error).toBe("agent session timed out after 20 ms")
    expect(res.text).toBe("partial")
    expect(rec.interrupts).toEqual([{ sessionID: "ses_slow" }])
    expect(rec.waits[0]!.signal!.aborted).toBe(true)
  })

  test("an external abort signal interrupts the session: outcome interrupted", async () => {
    const ctl = new AbortController()
    const { host, rec } = fakeHost({ created: info({ id: "ses_abort" }), wait: hangingWait })
    setTimeout(() => ctl.abort(), 10)
    const res = await host.runAgent({ ...baseReq, signal: ctl.signal })
    expect(res.outcome).toBe("interrupted")
    expect(res.error).toBe("agent session was interrupted")
    expect(rec.interrupts).toEqual([{ sessionID: "ses_abort" }])
  })

  test("an already-aborted signal never prompts or waits (nothing to interrupt)", async () => {
    const ctl = new AbortController()
    ctl.abort()
    const { host, calls } = fakeHost({ wait: hangingWait })
    const res = await host.runAgent({ ...baseReq, signal: ctl.signal })
    expect(res.outcome).toBe("interrupted")
    expect(calls).toEqual(["create"])
    // resuming an existing session: not even a create
    const resumed = fakeHost({ wait: hangingWait })
    expect((await resumed.host.runAgent({ ...baseReq, sessionId: "ses_old", signal: ctl.signal })).outcome).toBe("interrupted")
    expect(resumed.calls).not.toContain("prompt")
    expect(resumed.calls).not.toContain("wait")
  })

  test("an assistant error makes the outcome failed", async () => {
    const { host } = fakeHost({
      messages: [user("go"), assistant("half done", { error: { type: "ProviderError", message: "overloaded" } })],
      gets: [info({ outcome: "failed" })],
    })
    const res = await host.runAgent(baseReq)
    expect(res).toMatchObject({ outcome: "failed", error: "overloaded", text: "half done" })
  })

  test("without a session outcome, a reply error still means failed", async () => {
    const { host } = fakeHost({ messages: [user("go"), assistant(null, { error: { type: "APIError", message: "" } })] })
    expect(await host.runAgent(baseReq)).toMatchObject({ outcome: "failed", error: "APIError" })
  })

  test("a session outcome of interrupted/failed without a reply error gets a generic error", async () => {
    const a = fakeHost({ gets: [info({ outcome: "interrupted" })] })
    expect(await a.host.runAgent(baseReq)).toMatchObject({ outcome: "interrupted", error: "agent session interrupted" })
    const b = fakeHost({ gets: [info({ outcome: "failed" })] })
    expect(await b.host.runAgent(baseReq)).toMatchObject({ outcome: "failed", error: "agent session failed" })
  })

  test("an unreadable transcript is a failure with a clear error", async () => {
    const { host } = fakeHost({ messages: new Error("connection reset") })
    const res = await host.runAgent(baseReq)
    expect(res.outcome).toBe("failed")
    expect(res.error).toBe("could not read the session transcript: connection reset")
  })

  test("unreadable session info: zero usage delta, still a result", async () => {
    const { host } = fakeHost({
      created: info({ cost: 1, tokens: tokens({ input: 5 }) }),
      gets: [new Error("500")],
    })
    const res = await host.runAgent(baseReq)
    expect(res.outcome).toBe("succeeded")
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: false })
  })

  test("reusing a session id does not create a new session; usage is measured from its current totals", async () => {
    const { host, calls, rec } = fakeHost({
      gets: [info({ id: "ses_reuse", cost: 1, tokens: tokens({ input: 100, output: 10 }) }), info({ id: "ses_reuse", cost: 1.5, tokens: tokens({ input: 150, output: 30 }) })],
    })
    const res = await host.runAgent({ ...baseReq, sessionId: "ses_reuse", prompt: "Now fix the lint error." })
    expect(calls).toEqual(["get", "prompt", "wait", "context", "get"])
    expect(rec.created).toHaveLength(0)
    expect(rec.prompts).toEqual([{ sessionID: "ses_reuse", text: "Now fix the lint error." }])
    expect(res.sessionId).toBe("ses_reuse")
    expect(res.usage).toMatchObject({ inputTokens: 50, outputTokens: 20 })
    expect(res.usage.costUsd).toBeCloseTo(0.5, 10)
    expect(agentSessions.has("ses_reuse")).toBe(true)
  })

  test("a failing prompt or wait interrupts the session before the error propagates", async () => {
    const a = fakeHost({
      created: info({ id: "ses_prompt_fail" }),
      prompt: async () => {
        throw new Error("400 bad prompt")
      },
    })
    await expect(a.host.runAgent(baseReq)).rejects.toThrow("400 bad prompt")
    expect(a.rec.interrupts).toEqual([{ sessionID: "ses_prompt_fail" }])
    expect(agentSessions.has("ses_prompt_fail")).toBe(true)

    const b = fakeHost({
      created: info({ id: "ses_wait_fail" }),
      wait: async () => {
        throw new Error("socket hang up")
      },
    })
    await expect(b.host.runAgent(baseReq)).rejects.toThrow("socket hang up")
    expect(b.rec.interrupts).toEqual([{ sessionID: "ses_wait_fail" }])
  })
})

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

describe("generate", () => {
  test("calls generate.text with the mapped model and estimates usage", async () => {
    const { host, rec, calls } = fakeHost({ generate: async () => ({ text: "verdict: approve" }) })
    const prompt = "Review this diff as a skeptical maintainer."
    const res = await host.generate({ prompt, model: { providerID: "openai", modelID: "gpt-x", variant: "low" } })
    expect(calls).toEqual(["generate"])
    expect(rec.generations[0]!.input).toEqual({ prompt, model: { providerID: "openai", id: "gpt-x", variant: "low" } })
    expect(rec.generations[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(res.text).toBe("verdict: approve")
    expect(res.usage).toEqual({
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens("verdict: approve"),
      costUsd: 0,
      estimated: true,
    })
  })

  test("without a model the request has no model key; a missing text is empty", async () => {
    const { host, rec } = fakeHost({ generate: async () => ({}) as { text: string } })
    const res = await host.generate({ prompt: "hi", model: null })
    expect(rec.generations[0]!.input).toEqual({ prompt: "hi" })
    expect(res.text).toBe("")
  })

  test("timeout cancels the request and throws", async () => {
    const { host, rec } = fakeHost({
      generate: (_input, opts) =>
        new Promise((_resolve, reject) => opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    })
    await expect(host.generate({ prompt: "slow", timeoutMs: 20 })).rejects.toThrow("generation timed out after 20 ms")
    expect(rec.generations[0]!.signal!.aborted).toBe(true)
  })

  test("an external abort throws 'interrupted'", async () => {
    const ctl = new AbortController()
    const { host } = fakeHost({ generate: () => new Promise(() => undefined) })
    setTimeout(() => ctl.abort(), 10)
    await expect(host.generate({ prompt: "slow", signal: ctl.signal })).rejects.toThrow("generation was interrupted")
  })

  test("a generation error propagates", async () => {
    const { host } = fakeHost({
      generate: async () => {
        throw new Error("model not found")
      },
    })
    await expect(host.generate({ prompt: "x" })).rejects.toThrow("model not found")
  })
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

describe("helpers", () => {
  test("toV2Model", () => {
    expect(toV2Model(null)).toBeUndefined()
    expect(toV2Model(undefined)).toBeUndefined()
    expect(toV2Model({ providerID: "p", modelID: "m" })).toEqual({ providerID: "p", id: "m" })
    expect(toV2Model({ providerID: "p", modelID: "m", variant: "v" })).toEqual({ providerID: "p", id: "m", variant: "v" })
  })

  test("usageSnapshot tolerates missing fields; usageDelta never goes negative", () => {
    expect(usageSnapshot(null)).toEqual({ input: 0, output: 0, costUsd: 0 })
    expect(usageSnapshot({ cost: Number.NaN, tokens: undefined } as never)).toEqual({ input: 0, output: 0, costUsd: 0 })
    expect(usageDelta({ input: 10, output: 10, costUsd: 1 }, { input: 5, output: 20, costUsd: 0.5 })).toEqual({
      inputTokens: 0,
      outputTokens: 10,
      costUsd: 0,
      estimated: false,
    })
  })

  test("extractReply", () => {
    expect(extractReply([] as never)).toEqual({ text: "", error: null })
    expect(extractReply([assistant("no user yet")] as never)).toEqual({ text: "no user yet", error: null })
    const msgs = [user("go"), assistant("ok"), assistant(null, { error: { type: "X", message: "boom" } })]
    expect(extractReply(msgs as never)).toEqual({ text: "ok", error: "boom" })
  })

  test("raceWait: done, timeout, interrupted, pre-aborted; the work signal is aborted afterwards", async () => {
    let seen: AbortSignal | null = null
    const done = await raceWait(async (s) => {
      seen = s
      return 42
    }, 1000)
    expect(done).toEqual({ kind: "done", value: 42 })
    expect(seen!.aborted).toBe(true)

    expect(await raceWait(() => new Promise(() => undefined), 5)).toEqual({ kind: "timeout" })
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 5)
    expect(await raceWait(() => new Promise(() => undefined), null, ctl.signal)).toEqual({ kind: "interrupted" })
    let called = false
    expect(
      await raceWait(
        async () => {
          called = true
        },
        null,
        ctl.signal,
      ),
    ).toEqual({ kind: "interrupted" })
    expect(called).toBe(false)
    await expect(raceWait(async () => Promise.reject(new Error("work failed")), 1000)).rejects.toThrow("work failed")
  })

  test("isAllowedAgentTool is an allowlist (file tools + todo); everything else is blocked", () => {
    for (const t of ["read", "edit", "write", "patch", "apply_patch", "multiedit", "glob", "grep", "list", "todowrite", "todoread", " READ "]) {
      expect(`${t}:${isAllowedAgentTool(t)}`).toBe(`${t}:true`)
      expect(isBlockedAgentTool(t)).toBe(false)
    }
    for (const t of [
      "shell",
      "bash",
      "BASH",
      " webfetch ",
      "websearch",
      "subagent",
      "task",
      "question",
      "execute",
      "skill",
      "codemode",
      "lsp",
      "invalid",
      "browser_open",
      "oss_scout_queue_reject",
      "oss-scout_status",
      // MCP server tools (<server>_<tool>) and other plugins' tools
      "github_create_pull_request",
      "github_add_issue_comment",
      "neon_run_sql",
      "read_mcp_resource",
      "list_mcp_resources",
      "bash_history_reader",
      "tasks",
      "my_shell",
      "read_file",
      "",
    ]) {
      expect(`${t}:${isBlockedAgentTool(t)}`).toBe(`${t}:true`)
    }
    expect(([...ALLOWED_AGENT_TOOLS] as string[]).sort()).toEqual(
      ["apply_patch", "edit", "glob", "grep", "list", "multiedit", "patch", "read", "todoread", "todowrite", "write"].sort(),
    )
  })

  test("isBlockedAgentCall blocks MCP / plugin tools whatever their input", () => {
    expect(isBlockedAgentCall("github_create_pull_request", { owner: "acme", repo: "widget", title: "x" })).toBe(true)
    expect(isBlockedAgentCall("neon_run_sql", { sql: "drop table x" })).toBe(true)
  })

  test("isOpencodeConfigPath", () => {
    for (const p of [".opencode", ".opencode/plugins/x.ts", "/t/.opencode/x", "C:\\t\\.OpenCode\\plugins\\x.ts", "opencode.json", "/t/opencode.jsonc", '"/t/opencode.json"']) {
      expect(`${p}:${isOpencodeConfigPath(p)}`).toBe(`${p}:true`)
    }
    for (const p of ["src/opencode.ts", "docs/opencode.json.md", "x.opencode/y", "/t/repo/src/index.ts", ""]) {
      expect(`${p}:${isOpencodeConfigPath(p)}`).toBe(`${p}:false`)
    }
  })

  test("targetsOpencodeConfig looks at path keys and patch headers, not file contents", () => {
    expect(targetsOpencodeConfig({ filePath: "/t/.opencode/plugins/evil.ts", content: "x" })).toBe(true)
    expect(targetsOpencodeConfig({ path: "opencode.json" })).toBe(true)
    expect(targetsOpencodeConfig({ edits: [{ file_path: "C:\\t\\.opencode\\a.ts" }] })).toBe(true)
    expect(targetsOpencodeConfig({ patchText: "*** Begin Patch\n*** Add File: .opencode/plugins/x.ts\n+export default {}\n*** End Patch" })).toBe(true)
    expect(targetsOpencodeConfig({ patch: "--- a/src/x.ts\n+++ b/opencode.json\n@@ -1 +1 @@" })).toBe(true)
    expect(targetsOpencodeConfig({ filePath: "/t/repo/.gitignore", oldString: "dist/", newString: "dist/\n.opencode/" })).toBe(false)
    expect(targetsOpencodeConfig({ filePath: "/t/repo/README.md", content: "see opencode.json" })).toBe(false)
    expect(targetsOpencodeConfig(null)).toBe(false)
    expect(targetsOpencodeConfig("plain")).toBe(false)
  })

  test("isBlockedAgentCall: dangerous tools, or file writes aimed at opencode config", () => {
    expect(isBlockedAgentCall("shell", {})).toBe(true)
    expect(isBlockedAgentCall("write", { filePath: "/t/.opencode/plugins/evil.ts", content: "..." })).toBe(true)
    expect(isBlockedAgentCall("edit", { filePath: "/t/opencode.json" })).toBe(true)
    expect(isBlockedAgentCall("apply_patch", { input: "*** Update File: .opencode/x.ts" })).toBe(true)
    expect(isBlockedAgentCall("read", { filePath: "/t/.opencode/plugins/x.ts" })).toBe(false)
    expect(isBlockedAgentCall("write", { filePath: "/t/repo/src/a.ts", content: "..." })).toBe(false)
    expect(isBlockedAgentCall("edit", undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// path guard: symlink / junction escapes (second layer behind the session permissions)
// ---------------------------------------------------------------------------

/** <root>/workspaces/t1/repo with a directory junction repo/escape -> <root>/outside (no admin needed on Windows). */
function junctionFixture() {
  const root = mkdtempSync(join(tmpdir(), "oss-scout-pathguard-"))
  const taskDir = join(root, "workspaces", "t1")
  const repo = join(taskDir, "repo")
  const outside = join(root, "outside")
  mkdirSync(join(repo, "src"), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1\n")
  writeFileSync(join(outside, "secret.txt"), "host secret")
  writeFileSync(join(taskDir, "notes.txt"), "outside the work tree")
  symlinkSync(outside, join(repo, "escape"), "junction")
  return { root, taskDir, repo, outside, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe("path guard", () => {
  test("patchFilePaths reads apply_patch headers and unified-diff header pairs only", () => {
    expect(
      patchFilePaths("*** Begin Patch\n*** Update File: repo/a.ts\n@@\n--- not a header\n+x\n*** Add File: repo/b.ts\n*** Move to: repo/c.ts\n*** End Patch"),
    ).toEqual(["repo/a.ts", "repo/b.ts", "repo/c.ts"])
    expect(patchFilePaths("--- a/repo/x.ts\n+++ b/repo/x.ts\n@@ -1 +1 @@\n--- removed sql comment\n+new\n--- /dev/null\n+++ b/repo/new.ts\n")).toEqual([
      "repo/x.ts",
      "repo/x.ts",
      "repo/new.ts",
    ])
    expect(patchFilePaths("just text")).toEqual([])
  })

  test("realPathOf follows junctions, and resolves a missing file through its nearest existing parent", () => {
    const f = junctionFixture()
    try {
      const real = (p: string) => realpathSync.native(p)
      expect(realPathOf("repo/escape/secret.txt", f.taskDir)).toBe(real(join(f.outside, "secret.txt")))
      expect(realPathOf("repo/escape/new/dir/x.ts", f.taskDir)).toBe(join(real(f.outside), "new", "dir", "x.ts"))
      expect(realPathOf(join(f.repo, "src", "new.ts"), "/ignored")).toBe(join(real(join(f.repo, "src")), "new.ts"))
    } finally {
      f.cleanup()
    }
  })

  test("checkAgentPaths: file tools must stay inside <taskDir>/repo after resolving symlinks/junctions", () => {
    const f = junctionFixture()
    try {
      const check = (tool: string, input: unknown) => checkAgentPaths(tool, input, f.taskDir).verdict
      // inside the work tree (relative to the task dir, absolute, new files and new directories)
      expect(check("read", { filePath: "repo/src/a.ts" })).toBe("inside")
      expect(check("read", { filePath: join(f.repo, "src", "a.ts") })).toBe("inside")
      expect(check("write", { filePath: join(f.repo, "src", "brand-new.ts"), content: "x" })).toBe("inside")
      expect(check("write", { filePath: "repo/new/deep/dir/x.ts", content: "x" })).toBe("inside")
      expect(check("edit", { filePath: "repo/src/a.ts", oldString: "../../etc", newString: "x" })).toBe("inside")
      // through the junction, a sibling of repo/, or plainly outside
      const escapes: Array<[string, unknown]> = [
        ["read", { filePath: "repo/escape/secret.txt" }],
        ["read", { filePath: join(f.repo, "escape", "secret.txt") }],
        ["write", { filePath: "repo/escape/planted.ts", content: "x" }],
        ["edit", { filePath: "repo/escape/secret.txt", oldString: "a", newString: "b" }],
        ["multiedit", { filePath: "repo/src/a.ts", edits: [{ filePath: "repo/escape/secret.txt", oldString: "a", newString: "b" }] }],
        ["read", { filePath: "notes.txt" }],
        ["read", { filePath: "repo/../../outside/secret.txt" }],
        ["read", { file_path: join(f.outside, "secret.txt") }],
        ["apply_patch", { patchText: "*** Begin Patch\n*** Update File: repo/escape/secret.txt\n@@\n-host secret\n+x\n*** End Patch" }],
        ["patch", { patch: "--- a/repo/src/a.ts\n+++ b/repo/escape/x.ts\n@@ -1 +1 @@\n" }],
        ["glob", { pattern: "**/*", path: "repo/escape" }],
        ["glob", { pattern: "../**/*" }],
        ["grep", { pattern: "secret", path: f.outside }],
        ["grep", { pattern: "x", include: "../../*.txt" }],
        ["list", { path: join(f.repo, "escape") }],
      ]
      for (const [tool, input] of escapes) {
        expect(`${tool} ${JSON.stringify(input)}: ${check(tool, input)}`).toBe(`${tool} ${JSON.stringify(input)}: outside`)
      }
      // search roots: the task dir itself (the default) or inside the work tree
      expect(check("glob", { pattern: "**/*.ts" })).toBe("inside")
      expect(check("glob", { pattern: "repo/**/*.ts", path: f.taskDir })).toBe("inside")
      expect(check("grep", { pattern: "\\.\\./", path: "repo/src", include: "*.ts" })).toBe("inside")
      expect(check("list", {})).toBe("inside")
      expect(check("list", undefined)).toBe("inside")
      expect(check("apply_patch", { patchText: "*** Begin Patch\n*** Add File: repo/src/b.ts\n+x\n*** End Patch" })).toBe("inside")
      // unknown shapes are reported, not blocked
      expect(check("read", { something: "else" })).toBe("unknown")
      expect(check("read", "repo/escape/secret.txt")).toBe("unknown")
      expect(check("apply_patch", { patchText: "no headers here" })).toBe("unknown")
      expect(check("apply_patch", {})).toBe("unknown")
    } finally {
      f.cleanup()
    }
  })

  test("pathGuardBlocks applies only to sessions registered by runAgent, and reports unknown shapes", async () => {
    const f = junctionFixture()
    try {
      const unknown: string[] = []
      expect(pathGuardBlocks("read", "ses_unregistered_pg", { filePath: "repo/escape/secret.txt" })).toBe(false)
      const { host } = fakeHost({ created: info({ id: "ses_pathguard" }) })
      await host.runAgent({ ...baseReq, directory: f.taskDir })
      expect(agentSessionDirs.get("ses_pathguard")).toBe(f.taskDir)
      expect(pathGuardBlocks("read", "ses_pathguard", { filePath: "repo/escape/secret.txt" })).toBe(true)
      expect(pathGuardBlocks("read", "ses_pathguard", { filePath: "repo/src/a.ts" })).toBe(false)
      // not a path tool: the allowlist decides (pathGuardBlocks leaves it alone)
      expect(pathGuardBlocks("shell", "ses_pathguard", { command: "cat repo/escape/secret.txt" })).toBe(false)
      expect(pathGuardBlocks("read", "ses_pathguard", { weird: 1 }, (why) => unknown.push(why))).toBe(false)
      expect(unknown).toEqual(["no path argument"])
      registerAgentSession("ses_pathguard_manual", f.taskDir)
      expect(pathGuardBlocks("write", "ses_pathguard_manual", { filePath: "repo/escape/x.ts", content: "" })).toBe(true)
    } finally {
      for (const id of ["ses_pathguard", "ses_pathguard_manual"]) {
        agentSessions.delete(id)
        agentSessionDirs.delete(id)
      }
      f.cleanup()
    }
  })
})
