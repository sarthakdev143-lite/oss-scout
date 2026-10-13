/**
 * The LLM capabilities oss-scout borrows from the opencode host it runs in. The pipeline only
 * talks to this interface, so it is independent of the opencode plugin API version.
 */

export interface ModelRef {
  providerID: string
  modelID: string
  variant?: string
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** USD as reported by the host; 0 when unknown. */
  costUsd: number
  /** true when token counts are estimated (e.g. chars/4) rather than reported. */
  estimated: boolean
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: false }

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
    estimated: a.estimated || b.estimated,
  }
}

export function totalTokens(u: Usage): number {
  return u.inputTokens + u.outputTokens
}

/** Rough token estimate when the host does not report usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export interface AgentRunRequest {
  /** Session title shown in opencode. */
  title: string
  /**
   * Directory the agent session is located in. MUST be the task directory (parent of the clone),
   * never the clone itself, so that the clone's own opencode config/plugins are not loaded.
   */
  directory: string
  prompt: string
  model?: ModelRef | null
  agent?: string | null
  timeoutMs: number
  /** Continue an existing session (follow-up attempt) instead of creating a new one. */
  sessionId?: string | null
  signal?: AbortSignal
}

export interface AgentRunResult {
  sessionId: string
  /** Final assistant text. */
  text: string
  usage: Usage
  outcome: "succeeded" | "failed" | "interrupted" | "timeout"
  error: string | null
}

export interface GenerateRequest {
  prompt: string
  model?: ModelRef | null
  timeoutMs?: number
  signal?: AbortSignal
}

export interface GenerateResult {
  text: string
  usage: Usage
}

export interface LlmHost {
  readonly kind: "opencode-v2" | "opencode-v1" | "fake"
  /**
   * Run a tool-using agent session that may read and edit files under `directory` only.
   * Implementations MUST deny shell/command execution, web access, sub-agents and any path outside
   * `directory`: untrusted repo code is executed only by the sandbox, never by the agent.
   */
  runAgent(req: AgentRunRequest): Promise<AgentRunResult>
  /** Tool-less single completion (critic, summaries, reply drafts). */
  generate(req: GenerateRequest): Promise<GenerateResult>
}
