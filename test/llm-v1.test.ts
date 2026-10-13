import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part } from "@opencode-ai/sdk"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AGENT_TOOLS_V1,
  createV1LlmHost,
  deadlineSignal,
  describeError,
  NO_TOOLS_V1,
  repliesTo,
  textFromParts,
  usageFromAssistant,
  type V1SessionClient,
} from "../src/plugin/llm-v1.ts"
import { agentSessions } from "../src/plugin/llm-v2.ts"

// ---------------------------------------------------------------------------
// fixtures (shapes follow @opencode-ai/sdk AssistantMessage / UserMessage / TextPart)
// ---------------------------------------------------------------------------

const STATE_DIR = "/state"
const TASK_DIR = "/state/workspaces/t1"

function assistantInfo(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "msg_a1",
    sessionID: "ses_v1",
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID: "msg_u1",
    modelID: "m",
    providerID: "p",
    mode: "build",
    path: { cwd: TASK_DIR, root: TASK_DIR },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...over,
  }
}

function userInfo(id: string) {
  return { id, sessionID: "ses_v1", role: "user" as const, time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } }
}

function textPart(text: string, over: { synthetic?: boolean; ignored?: boolean } = {}): Part {
  return { id: `prt_${text}`, sessionID: "ses_v1", messageID: "msg_a1", type: "text", text, ...over } as Part
}

const toolPart = (): Part => ({ id: "prt_tool", sessionID: "ses_v1", messageID: "msg_a1", type: "tool" }) as unknown as Part

type Result<T> = { data?: T; error?: unknown }

interface FakeOpts {
  create?: (o: unknown) => Result<{ id: string }>
  prompt?: (o: { signal?: AbortSignal; body: unknown; path: { id: string } }) => Promise<Result<{ info: AssistantMessage; parts: Part[] }>>
  messages?: (o: unknown) => Promise<Result<Array<{ info: unknown; parts: Part[] }>>>
}

function fakeV1(opts: FakeOpts = {}) {
  const rec = {
    created: [] as unknown[],
    prompts: [] as Array<{ path: { id: string }; query: { directory: string }; body: Record<string, unknown>; signal?: AbortSignal }>,
    messages: [] as unknown[],
    aborts: [] as unknown[],
    deletes: [] as unknown[],
  }
  let n = 0
  const session = {
    async create(o: unknown) {
      rec.created.push(o)
      return opts.create ? opts.create(o) : { data: { id: `ses_v1_${++n}` } }
    },
    async prompt(o: (typeof rec.prompts)[number]) {
      rec.prompts.push(o)
      if (opts.prompt) return opts.prompt(o)
      return { data: { info: assistantInfo({ tokens: { input: 7, output: 3, reasoning: 1, cache: { read: 50, write: 2 } }, cost: 0.004 }), parts: [textPart("done")] } }
    },
    async messages(o: unknown) {
      rec.messages.push(o)
      if (opts.messages) return opts.messages(o)
      return { data: [] }
    },
    async abort(o: unknown) {
      rec.aborts.push(o)
      return { data: true }
    },
    async delete(o: unknown) {
      rec.deletes.push(o)
      return { data: true }
    },
  }
  const host = createV1LlmHost({ session } as unknown as V1SessionClient, STATE_DIR)
  return { host, rec }
}

/**
 * opencode V1 semantics (session/prompt.ts + permission/index.ts, v1.19.0): the per-prompt tools map
 * becomes the session's rules in key order ({permission: key, pattern: "*", action}), the last
 * matching rule wins (wildcard keys), edit-like tools are checked as "edit", and no match means "ask".
 */
function v1Decision(tools: Record<string, boolean>, tool: string): "allow" | "deny" | "ask" {
  const permission = ["edit", "write", "apply_patch"].includes(tool) ? "edit" : tool
  const match = (pattern: string, value: string) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "s").test(value)
  const rules = Object.entries(tools).map(([key, enabled]) => ({ permission: key, action: enabled ? ("allow" as const) : ("deny" as const) }))
  return rules.findLast((r) => match(r.permission, permission))?.action ?? "ask"
}

/** A prompt that only ends when its request signal aborts (like a blocking V1 prompt being cancelled). */
const hangingPrompt = (o: { signal?: AbortSignal }): Promise<never> =>
  new Promise((_resolve, reject) => {
    o.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true })
  })

const req = { title: "oss-scout acme/widget#42 fix", directory: TASK_DIR, prompt: "Fix the bug.", timeoutMs: 60_000 }

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

describe("createV1LlmHost.runAgent", () => {
  test("creates a session in the task directory and prompts with shell/web/sub-agent tools disabled", async () => {
    const { host, rec } = fakeV1()
    const res = await host.runAgent({ ...req, model: { providerID: "anthropic", modelID: "claude-x", variant: "high" }, agent: "build" })
    expect(host.kind).toBe("opencode-v1")
    expect(rec.created).toEqual([{ query: { directory: TASK_DIR }, body: { title: req.title } }])
    expect(rec.prompts).toHaveLength(1)
    const p = rec.prompts[0]!
    expect(p.path).toEqual({ id: "ses_v1_1" })
    expect(p.query).toEqual({ directory: TASK_DIR })
    expect(p.signal).toBeInstanceOf(AbortSignal)
    expect(p.body).toEqual({
      parts: [{ type: "text", text: "Fix the bug." }],
      tools: { ...AGENT_TOOLS_V1 },
      model: { providerID: "anthropic", modelID: "claude-x" },
      agent: "build",
    })
    const tools = p.body.tools as Record<string, boolean>
    // deny-by-default: "*" first, then only the file tools
    expect(Object.keys(tools)[0]).toBe("*")
    expect(tools["*"]).toBe(false)
    for (const t of ["bash", "shell", "webfetch", "websearch", "task", "question", "skill", "lsp", "oss_scout_queue_reject", "github_create_pull_request", "neon_run_sql", "external_directory", "doom_loop"]) {
      expect(`${t}:${v1Decision(tools, t)}`).toBe(`${t}:deny`)
    }
    for (const t of ["read", "edit", "write", "apply_patch", "glob", "grep", "list"]) expect(`${t}:${v1Decision(tools, t)}`).toBe(`${t}:allow`)
    expect(res).toMatchObject({ sessionId: "ses_v1_1", text: "done", outcome: "succeeded", error: null })
    expect(agentSessions.has("ses_v1_1")).toBe(true)
    agentSessions.delete("ses_v1_1")
  })

  test("no model/agent keys when not configured", async () => {
    const { host, rec } = fakeV1()
    await host.runAgent(req)
    expect(Object.keys(rec.prompts[0]!.body).sort()).toEqual(["parts", "tools"])
  })

  test("usage sums every assistant reply to the prompt (input + cache writes, output + reasoning, cost)", async () => {
    const { host } = fakeV1({
      prompt: async () => ({ data: { info: assistantInfo({ id: "msg_a2", parentID: "msg_u2" }), parts: [textPart("final"), textPart("hidden", { synthetic: true })] } }),
      messages: async () => ({
        data: [
          { info: userInfo("msg_u1"), parts: [] },
          { info: assistantInfo({ id: "old", parentID: "msg_u1", tokens: { input: 1000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 9 }), parts: [] },
          { info: userInfo("msg_u2"), parts: [] },
          { info: assistantInfo({ id: "s1", parentID: "msg_u2", tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 400, write: 3 } }, cost: 0.01 }), parts: [] },
          { info: assistantInfo({ id: "msg_a2", parentID: "msg_u2", tokens: { input: 20, output: 6, reasoning: 1, cache: { read: 400, write: 0 } }, cost: 0.02 }), parts: [] },
        ],
      }),
    })
    const res = await host.runAgent({ ...req, sessionId: "ses_reused" })
    expect(res.text).toBe("final")
    expect(res.usage.inputTokens).toBe(33)
    expect(res.usage.outputTokens).toBe(14)
    expect(res.usage.costUsd).toBeCloseTo(0.03, 10)
    expect(res.usage.estimated).toBe(false)
  })

  test("falls back to the response's own usage when the messages cannot be read", async () => {
    const { host } = fakeV1({ messages: async () => ({ error: { name: "NotFoundError", data: { message: "gone" } } }) })
    const res = await host.runAgent(req)
    expect(res.usage).toMatchObject({ inputTokens: 9, outputTokens: 4 })
    expect(res.usage.costUsd).toBeCloseTo(0.004, 10)
  })

  test("reusing a session id does not create a session", async () => {
    const { host, rec } = fakeV1()
    const res = await host.runAgent({ ...req, sessionId: "ses_existing" })
    expect(rec.created).toHaveLength(0)
    expect(rec.prompts[0]!.path).toEqual({ id: "ses_existing" })
    expect(res.sessionId).toBe("ses_existing")
    expect(agentSessions.has("ses_existing")).toBe(true)
    agentSessions.delete("ses_existing")
  })

  test("a failed session creation throws a clear error", async () => {
    const { host } = fakeV1({ create: () => ({ error: { name: "BadRequestError", data: { message: "directory not allowed" } } }) })
    await expect(host.runAgent(req)).rejects.toThrow("could not create an opencode session: directory not allowed")
  })

  test("timeout: the prompt is cancelled, the session aborted, outcome timeout with partial text/usage", async () => {
    const { host, rec } = fakeV1({
      prompt: (o) => hangingPrompt(o),
      messages: async () => ({
        data: [
          { info: userInfo("msg_u1"), parts: [] },
          { info: assistantInfo({ parentID: "msg_u1", tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.1 }), parts: [textPart("partial work")] },
        ],
      }),
    })
    const res = await host.runAgent({ ...req, timeoutMs: 20 })
    expect(res.outcome).toBe("timeout")
    expect(res.error).toBe("agent session timed out after 20 ms")
    expect(res.text).toBe("partial work")
    expect(res.usage).toMatchObject({ inputTokens: 5, outputTokens: 5 })
    expect(rec.aborts).toEqual([{ path: { id: "ses_v1_1" }, query: { directory: TASK_DIR } }])
    expect(rec.prompts[0]!.signal!.aborted).toBe(true)
  })

  test("an already-aborted signal sends no prompt", async () => {
    const ctl = new AbortController()
    ctl.abort()
    const { host, rec } = fakeV1()
    const res = await host.runAgent({ ...req, signal: ctl.signal })
    expect(res).toMatchObject({ outcome: "interrupted", error: "agent session was interrupted" })
    expect(rec.prompts).toHaveLength(0)
  })

  test("refuses a task directory inside a git work tree before creating a session", async () => {
    const root = mkdtempSync(join(tmpdir(), "oss-scout-v1-gitroot-"))
    try {
      mkdirSync(join(root, ".git"))
      const taskDir = join(root, "workspaces", "t1")
      mkdirSync(taskDir, { recursive: true })
      const { host, rec } = fakeV1()
      await expect(host.runAgent({ ...req, directory: taskDir })).rejects.toThrow(`inside the git repository ${root}`)
      expect(rec.created).toHaveLength(0)
      expect(rec.prompts).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("opencode config planted in the task directory is removed (before the session and after the prompt) and fails the attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "oss-scout-v1-plant-"))
    try {
      const taskDir = join(root, "workspaces", "t1")
      mkdirSync(join(taskDir, ".opencode", "plugins"), { recursive: true })
      writeFileSync(join(taskDir, ".opencode", "plugins", "evil.ts"), "export default {}")
      let leftoverAtPrompt: boolean | null = null
      const { host } = fakeV1({
        prompt: async () => {
          leftoverAtPrompt = existsSync(join(taskDir, ".opencode"))
          mkdirSync(join(taskDir, ".opencode", "plugins"), { recursive: true })
          writeFileSync(join(taskDir, "opencode.jsonc"), "{}")
          return { data: { info: assistantInfo(), parts: [textPart("done")] } }
        },
      })
      const res = await host.runAgent({ ...req, directory: taskDir })
      expect(leftoverAtPrompt === false).toBe(true)
      expect(existsSync(join(taskDir, ".opencode"))).toBe(false)
      expect(existsSync(join(taskDir, "opencode.jsonc"))).toBe(false)
      expect(res.outcome).toBe("failed")
      expect(res.error).toContain("were removed (.opencode, opencode.jsonc)")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("an external abort signal: outcome interrupted", async () => {
    const ctl = new AbortController()
    const { host, rec } = fakeV1({ prompt: (o) => hangingPrompt(o) })
    setTimeout(() => ctl.abort(), 10)
    const res = await host.runAgent({ ...req, signal: ctl.signal })
    expect(res.outcome).toBe("interrupted")
    expect(res.error).toBe("agent session was interrupted")
    expect(rec.aborts).toHaveLength(1)
  })

  test("assistant errors: aborted → interrupted, others → failed", async () => {
    const aborted = fakeV1({
      prompt: async () => ({ data: { info: assistantInfo({ error: { name: "MessageAbortedError", data: { message: "aborted by user" } } }), parts: [] } }),
    })
    expect(await aborted.host.runAgent(req)).toMatchObject({ outcome: "interrupted", error: "aborted by user" })
    const api = fakeV1({
      prompt: async () => ({
        data: { info: assistantInfo({ error: { name: "APIError", data: { message: "overloaded", isRetryable: true } } }), parts: [textPart("half")] },
      }),
    })
    expect(await api.host.runAgent(req)).toMatchObject({ outcome: "failed", error: "overloaded", text: "half" })
  })

  test("a failed prompt request is a failure and the session is aborted", async () => {
    const errored = fakeV1({ prompt: async () => ({ error: { name: "BadRequestError", data: { message: "bad body" } } }) })
    const a = await errored.host.runAgent(req)
    expect(a).toMatchObject({ outcome: "failed", error: "bad body", text: "" })
    expect(errored.rec.aborts).toHaveLength(1)

    const thrown = fakeV1({
      prompt: async () => {
        throw new Error("ECONNRESET")
      },
    })
    const b = await thrown.host.runAgent(req)
    expect(b).toMatchObject({ outcome: "failed", error: "ECONNRESET" })
    expect(b.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: false })
    expect(thrown.rec.aborts).toEqual([{ path: { id: "ses_v1_1" }, query: { directory: TASK_DIR } }])
  })
})

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

describe("createV1LlmHost.generate", () => {
  test("uses a temporary tool-less session in the state dir and deletes it", async () => {
    const { host, rec } = fakeV1({
      prompt: async () => ({
        data: { info: assistantInfo({ tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 0, write: 10 } }, cost: 0.05 }), parts: [textPart("verdict")] },
      }),
    })
    const res = await host.generate({ prompt: "Critique this.", model: { providerID: "openai", modelID: "gpt-x" } })
    expect(rec.created).toEqual([{ query: { directory: STATE_DIR }, body: { title: "oss-scout (tool-less generation)" } }])
    const p = rec.prompts[0]!
    expect(p.query).toEqual({ directory: STATE_DIR })
    expect(p.body).toEqual({ parts: [{ type: "text", text: "Critique this." }], tools: { ...NO_TOOLS_V1 }, model: { providerID: "openai", modelID: "gpt-x" } })
    const tools = p.body.tools as Record<string, boolean>
    for (const t of ["*", "read", "edit", "write", "bash", "webfetch", "task", "glob", "grep", "list"]) expect(tools[t]).toBe(false)
    expect(Object.values(tools).every((v) => v === false)).toBe(true)
    expect(rec.deletes).toEqual([{ path: { id: "ses_v1_1" }, query: { directory: STATE_DIR } }])
    expect(agentSessions.has("ses_v1_1")).toBe(false)
    expect(res.text).toBe("verdict")
    expect(res.usage).toMatchObject({ inputTokens: 110, outputTokens: 25, estimated: false })
    expect(res.usage.costUsd).toBeCloseTo(0.05, 10)
  })

  test("an assistant error throws, and the temporary session is still deleted", async () => {
    const { host, rec } = fakeV1({
      prompt: async () => ({ data: { info: assistantInfo({ error: { name: "ProviderAuthError", data: { providerID: "p", message: "no key" } } }), parts: [] } }),
    })
    await expect(host.generate({ prompt: "x" })).rejects.toThrow("generation failed: no key")
    expect(rec.deletes).toHaveLength(1)
  })

  test("a failed request throws, and the session is deleted", async () => {
    const { host, rec } = fakeV1({ prompt: async () => ({ error: { name: "BadRequestError", data: { message: "nope" } } }) })
    await expect(host.generate({ prompt: "x" })).rejects.toThrow("generation failed: nope")
    expect(rec.deletes).toHaveLength(1)
  })

  test("timeout and interruption", async () => {
    const slow = fakeV1({ prompt: (o) => hangingPrompt(o) })
    await expect(slow.host.generate({ prompt: "x", timeoutMs: 20 })).rejects.toThrow("generation timed out after 20 ms")
    expect(slow.rec.deletes).toHaveLength(1)

    const ctl = new AbortController()
    const stopped = fakeV1({ prompt: (o) => hangingPrompt(o) })
    setTimeout(() => ctl.abort(), 10)
    await expect(stopped.host.generate({ prompt: "x", signal: ctl.signal })).rejects.toThrow("generation was interrupted")
    expect(stopped.rec.deletes).toHaveLength(1)
  })

  test("a failed session creation throws", async () => {
    const { host, rec } = fakeV1({ create: () => ({ error: { name: "UnknownError", data: { message: "server down" } } }) })
    await expect(host.generate({ prompt: "x" })).rejects.toThrow("could not create an opencode session: server down")
    expect(rec.prompts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

describe("helpers", () => {
  test("deadlineSignal fires after its timeout, follows its parent, and clear() stops it", async () => {
    const t = deadlineSignal(10)
    await new Promise((r) => t.signal.addEventListener("abort", r, { once: true }))
    expect((t.signal.reason as DOMException).name).toBe("TimeoutError")

    const parent = new AbortController()
    const linked = deadlineSignal(60_000, parent.signal)
    parent.abort("stop")
    expect(linked.signal.aborted).toBe(true)
    expect(linked.signal.reason).toBe("stop")
    linked.clear()

    const already = new AbortController()
    already.abort()
    const pre = deadlineSignal(60_000, already.signal)
    expect(pre.signal.aborted).toBe(true)
    pre.clear()

    const cleared = deadlineSignal(10)
    cleared.clear()
    await new Promise((r) => setTimeout(r, 30))
    expect(cleared.signal.aborted).toBe(false)
  })

  test("describeError prefers data.message, then message, then name", () => {
    expect(describeError({ name: "APIError", data: { message: "rate limited" } })).toBe("rate limited")
    expect(describeError({ name: "X", message: "plain" })).toBe("plain")
    expect(describeError({ name: "MessageOutputLengthError", data: {} })).toBe("MessageOutputLengthError")
    expect(describeError(new Error("boom"))).toBe("boom")
    expect(describeError("text")).toBe("text")
    expect(describeError(undefined)).toBe("undefined")
  })

  test("textFromParts keeps only real text parts", () => {
    expect(textFromParts([textPart("a"), toolPart(), textPart("hidden", { synthetic: true }), textPart("ign", { ignored: true }), textPart("b")])).toBe("a\nb")
    expect(textFromParts([])).toBe("")
  })

  test("usageFromAssistant tolerates missing numbers", () => {
    expect(usageFromAssistant([])).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: false })
    expect(usageFromAssistant([{ cost: Number.NaN, tokens: undefined } as unknown as AssistantMessage])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      estimated: false,
    })
  })

  test("repliesTo picks the replies to a parent (or to the last user message)", () => {
    const msgs = [
      { info: userInfo("u1"), parts: [] },
      { info: assistantInfo({ id: "a1", parentID: "u1" }), parts: [] },
      { info: userInfo("u2"), parts: [] },
      { info: assistantInfo({ id: "a2", parentID: "u2" }), parts: [] },
      { info: assistantInfo({ id: "a3", parentID: "u2" }), parts: [] },
    ] as Parameters<typeof repliesTo>[0]
    expect(repliesTo(msgs, "u1").map((m) => m.info.id)).toEqual(["a1"])
    expect(repliesTo(msgs, null).map((m) => m.info.id)).toEqual(["a2", "a3"])
    expect(repliesTo([], null)).toEqual([])
  })
})
