/**
 * Auto-fallback model mode.
 *
 * The agent starts on the primary model — the user's claude sonnet 5.5
 * (`anthropic/claude-sonnet-5-5`). When it does not reply (the model call fails or returns no
 * text), every LLM call retries once with the best free opencode model available on the
 * machine, chosen from `opencode models`: the first model id ending in `-free`, else the first
 * opencode model listed.
 */
import { execFileSync } from "node:child_process"
import { parseModelRef } from "../config/schema.ts"
import type { AgentRunRequest, AgentRunResult, GenerateRequest, GenerateResult, LlmHost, ModelRef } from "../llm/host.ts"
import type { Logger } from "../util/log.ts"

/** Primary model: the user's claude sonnet 5.5, on opencode. */
export const PRIMARY_MODEL = "anthropic/claude-sonnet-5-5"

function readOpencodeModels(): string {
  try {
    return execFileSync("opencode", ["models"], { encoding: "utf8", timeout: 15_000, windowsHide: true })
  } catch {
    return ""
  }
}

/**
 * The best free opencode model available (the first `opencode/…-free` in `opencode models`,
 * else the first opencode model listed), or null when opencode offers no model at all.
 */
export function bestFreeOpencodeModel(modelsOutput?: string): string | null {
  const lines = (modelsOutput ?? readOpencodeModels())
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.find((l) => /^opencode\/[^/]+-free$/.test(l)) ?? lines.find((l) => /^opencode\/[^/]+$/.test(l)) ?? null
}

/** The fallback ModelRef, or null when opencode offers no model at all. */
export function fallbackModelRef(): ModelRef | null {
  return parseModelRef(bestFreeOpencodeModel() ?? null)
}

function logFallback(log: Logger, req: { model?: ModelRef | null }, fb: ModelRef): void {
  log.info("llm: primary model did not reply; retrying with fallback model", {
    primary: req.model?.modelID ?? PRIMARY_MODEL,
    fallback: fb.modelID,
  })
}

/**
 * Wrap a LlmHost: `req.model ?? PRIMARY_MODEL` is tried first; when it does not reply the call
 * retries once with the best free opencode model. Interrupted runs are never retried.
 */
export function withAutoFallback(host: LlmHost, log: Logger): LlmHost {
  async function runAgent(req: AgentRunRequest): Promise<AgentRunResult> {
    const model = req.model ?? parseModelRef(PRIMARY_MODEL)
    let res: AgentRunResult
    try {
      res = await host.runAgent({ ...req, model })
    } catch (err) {
      const fb = fallbackModelRef()
      if (!fb) throw err
      logFallback(log, { model }, fb)
      return host.runAgent({ ...req, model: fb, sessionId: null })
    }
    if (res.outcome !== "interrupted" && (res.outcome !== "succeeded" || !res.text.trim())) {
      const fb = fallbackModelRef()
      if (fb) {
        logFallback(log, { model }, fb)
        return host.runAgent({ ...req, model: fb, sessionId: null })
      }
    }
    return res
  }

  async function generate(req: GenerateRequest): Promise<GenerateResult> {
    const model = req.model ?? parseModelRef(PRIMARY_MODEL)
    let res: GenerateResult
    try {
      res = await host.generate({ ...req, model })
    } catch (err) {
      const fb = fallbackModelRef()
      if (!fb) throw err
      logFallback(log, { model }, fb)
      return host.generate({ ...req, model: fb })
    }
    if (!res.text.trim()) {
      const fb = fallbackModelRef()
      if (fb) {
        logFallback(log, { model }, fb)
        return host.generate({ ...req, model: fb })
      }
    }
    return res
  }

  return { ...host, runAgent, generate }
}

if (import.meta.main) {
  const fb = bestFreeOpencodeModel()
  if (fb) console.log(fb)
}
