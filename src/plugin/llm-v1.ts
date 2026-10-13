/**
 * LlmHost backed by the opencode V1 SDK client handed to V1 plugins (`input.client`).
 * `session.prompt` blocks until the assistant finishes; tools are restricted per prompt.
 * Type-only imports from @opencode-ai/*: nothing from them is loaded at runtime.
 */
import type { PluginInput } from "@opencode-ai/plugin"
import type { AssistantMessage, Message, Part, TextPart } from "@opencode-ai/sdk"
import {
  ZERO_USAGE,
  type AgentRunRequest,
  type AgentRunResult,
  type GenerateRequest,
  type GenerateResult,
  type LlmHost,
  type ModelRef,
  type Usage,
} from "../llm/host.ts"
import { errorMessage, nullLogger, type Logger } from "../util/log.ts"
import { agentSessions, assertIsolatedAgentDirectory, registerAgentSession, sweepLocation } from "./llm-v2.ts"

export type V1Client = PluginInput["client"]
export type V1SessionClient = Pick<V1Client, "session">

/**
 * Per-prompt tool map of every agent prompt. opencode V1 turns it into the session's permission
 * rules, in order ({permission: key, pattern: "*", action: allow|deny}; the last matching rule wins)
 * and REPLACES the session's rules with them. So this is deny-by-default: "*" first denies every tool
 * and permission (shell, web, sub-agents, questions, skills, LSP, MCP server tools, other plugins'
 * tools, external_directory, doom_loop — nothing falls back to "ask"), then only the file tools are
 * allowed. (V1 checks write/apply_patch under "edit".) Key order matters: "*" must stay first.
 */
export const AGENT_TOOLS_V1: Readonly<Record<string, boolean>> = {
  "*": false,
  read: true,
  edit: true,
  write: true,
  patch: true,
  glob: true,
  grep: true,
  list: true,
}

/** Every tool disabled (tool-less completion). */
export const NO_TOOLS_V1: Readonly<Record<string, boolean>> = {
  "*": false,
  read: false,
  edit: false,
  write: false,
  patch: false,
  glob: false,
  grep: false,
  list: false,
  bash: false,
  webfetch: false,
  websearch: false,
  task: false,
  todowrite: false,
  todoread: false,
  question: false,
  skill: false,
  lsp: false,
}

const DEFAULT_GENERATE_TIMEOUT_MS = 10 * 60_000

/**
 * Like AbortSignal.any([AbortSignal.timeout(ms), parent]) but with a ref'd timer: Bun's
 * AbortSignal.timeout does not reliably fire (see registries.ts), which would let a stuck prompt hang
 * forever. Call clear() once the request has settled.
 */
export function deadlineSignal(ms: number, parent?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException(`timed out after ${ms} ms`, "TimeoutError")), Math.max(1, ms))
  const onAbort = () => controller.abort(parent?.reason)
  if (parent?.aborted) controller.abort(parent.reason)
  else parent?.addEventListener("abort", onAbort, { once: true })
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer)
      parent?.removeEventListener("abort", onAbort)
    },
  }
}

interface V1Message {
  info: Message
  parts: Part[]
}

function toV1Model(model: ModelRef | null | undefined): { providerID: string; modelID: string } | undefined {
  return model ? { providerID: model.providerID, modelID: model.modelID } : undefined
}

/** Readable text for an SDK error union / thrown value. */
export function describeError(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { name?: unknown; message?: unknown; data?: { message?: unknown } }
    if (o.data && typeof o.data.message === "string" && o.data.message) return o.data.message
    if (typeof o.message === "string" && o.message) return o.message
    if (typeof o.name === "string" && o.name) return o.name
  }
  return errorMessage(e)
}

/** Text parts of a reply (synthetic/ignored parts excluded). */
export function textFromParts(parts: readonly Part[]): string {
  return parts
    .filter((p): p is TextPart => p.type === "text" && !p.synthetic && !p.ignored)
    .map((p) => p.text)
    .join("\n")
    .trim()
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/** Same accounting as the V2 host: input + cache writes, output + reasoning; cache reads excluded. */
export function usageFromAssistant(messages: ReadonlyArray<Pick<AssistantMessage, "tokens" | "cost">>): Usage {
  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  for (const m of messages) {
    inputTokens += num(m.tokens?.input) + num(m.tokens?.cache?.write)
    outputTokens += num(m.tokens?.output) + num(m.tokens?.reasoning)
    costUsd += num(m.cost)
  }
  return { inputTokens, outputTokens, costUsd, estimated: false }
}

/** Assistant messages answering user message `parentID` (or the last user message when null). */
export function repliesTo(messages: readonly V1Message[], parentID: string | null): Array<{ info: AssistantMessage; parts: Part[] }> {
  let parent = parentID
  if (!parent) {
    for (let i = messages.length - 1; i >= 0 && !parent; i--) if (messages[i]!.info.role === "user") parent = messages[i]!.info.id
  }
  if (!parent) return []
  return messages.filter((m): m is { info: AssistantMessage; parts: Part[] } => m.info.role === "assistant" && m.info.parentID === parent)
}

export function createV1LlmHost(client: V1SessionClient, stateDir: string, opts: { log?: Logger } = {}): LlmHost {
  const log = opts.log ?? nullLogger
  const session = client.session

  async function replies(id: string, directory: string, parentID: string | null) {
    try {
      const res = await session.messages({ path: { id }, query: { directory } })
      if (res.error || !res.data) return null
      return repliesTo(res.data, parentID)
    } catch (err) {
      log.warn("could not list session messages", { sessionID: id, error: errorMessage(err) })
      return null
    }
  }

  async function abort(id: string, directory: string): Promise<void> {
    try {
      await session.abort({ path: { id }, query: { directory } })
    } catch (err) {
      log.warn("could not abort agent session", { sessionID: id, error: errorMessage(err) })
    }
  }

  async function runAgent(req: AgentRunRequest): Promise<AgentRunResult> {
    const directory = req.directory
    assertIsolatedAgentDirectory(directory)
    // Before the location boots (create/resume): never let it load planted config or plugins. Under
    // V1 no session rule can deny writes to these paths, so they are also swept after every prompt.
    sweepLocation(directory, log)
    let id = req.sessionId ?? null
    if (!id) {
      const created = await session.create({ query: { directory }, body: { title: req.title } })
      if (created.error || !created.data) throw new Error(`could not create an opencode session: ${describeError(created.error)}`)
      id = created.data.id
    }
    registerAgentSession(id, directory)
    // Kill switch / stop() fired before the prompt: spend nothing.
    if (req.signal?.aborted) return { sessionId: id, text: "", usage: ZERO_USAGE, outcome: "interrupted", error: "agent session was interrupted" }

    const result = await promptAgent(req, id)
    const planted = sweepLocation(directory, log)
    return planted ? { ...result, outcome: "failed", error: planted } : result
  }

  async function promptAgent(req: AgentRunRequest, id: string): Promise<AgentRunResult> {
    const directory = req.directory
    const deadline = deadlineSignal(req.timeoutMs, req.signal)
    const signal = deadline.signal
    const model = toV1Model(req.model)
    let response: { info: AssistantMessage; parts: Part[] } | null = null
    let failure: string | null = null
    try {
      const res = await session.prompt({
        path: { id },
        query: { directory },
        body: {
          parts: [{ type: "text", text: req.prompt }],
          tools: { ...AGENT_TOOLS_V1 },
          ...(model ? { model } : {}),
          ...(req.agent ? { agent: req.agent } : {}),
        },
        signal,
      })
      if (res.error || !res.data) failure = describeError(res.error)
      else response = res.data
    } catch (err) {
      failure = describeError(err)
    } finally {
      deadline.clear()
    }

    if (signal.aborted) {
      await abort(id, directory)
      const own = await replies(id, directory, null)
      const outcome = req.signal?.aborted ? "interrupted" : "timeout"
      const last = own?.[own.length - 1]
      return {
        sessionId: id,
        text: last ? textFromParts(last.parts) : "",
        usage: own ? usageFromAssistant(own.map((m) => m.info)) : ZERO_USAGE,
        outcome,
        error: outcome === "timeout" ? `agent session timed out after ${req.timeoutMs} ms` : "agent session was interrupted",
      }
    }
    if (!response) {
      // The request failed (transport error, 4xx/5xx): make sure the agent is not left running unwatched.
      await abort(id, directory)
      return { sessionId: id, text: "", usage: ZERO_USAGE, outcome: "failed", error: failure ?? "agent session failed" }
    }

    const own = await replies(id, directory, response.info.parentID)
    const usage = own && own.length > 0 ? usageFromAssistant(own.map((m) => m.info)) : usageFromAssistant([response.info])
    const text = textFromParts(response.parts)
    const err = response.info.error
    if (err) {
      const outcome = err.name === "MessageAbortedError" ? "interrupted" : "failed"
      return { sessionId: id, text, usage, outcome, error: describeError(err) }
    }
    return { sessionId: id, text, usage, outcome: "succeeded", error: null }
  }

  async function generate(req: GenerateRequest): Promise<GenerateResult> {
    const created = await session.create({ query: { directory: stateDir }, body: { title: "oss-scout (tool-less generation)" } })
    if (created.error || !created.data) throw new Error(`could not create an opencode session: ${describeError(created.error)}`)
    const id = created.data.id
    agentSessions.add(id)
    const deadline = deadlineSignal(req.timeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS, req.signal)
    const signal = deadline.signal
    const model = toV1Model(req.model)
    try {
      const res = await session.prompt({
        path: { id },
        query: { directory: stateDir },
        body: { parts: [{ type: "text", text: req.prompt }], tools: { ...NO_TOOLS_V1 }, ...(model ? { model } : {}) },
        signal,
      })
      if (res.error || !res.data) throw new Error(`generation failed: ${describeError(res.error)}`)
      if (res.data.info.error) throw new Error(`generation failed: ${describeError(res.data.info.error)}`)
      return { text: textFromParts(res.data.parts), usage: usageFromAssistant([res.data.info]) }
    } catch (err) {
      if (signal.aborted) {
        throw new Error(req.signal?.aborted ? "generation was interrupted" : `generation timed out after ${req.timeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS} ms`)
      }
      throw err
    } finally {
      deadline.clear()
      try {
        await session.delete({ path: { id }, query: { directory: stateDir } })
      } catch (err) {
        log.warn("could not delete the temporary generation session", { sessionID: id, error: errorMessage(err) })
      }
      agentSessions.delete(id)
    }
  }

  return { kind: "opencode-v1", runAgent, generate }
}
