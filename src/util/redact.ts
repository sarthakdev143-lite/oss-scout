/**
 * Secret redaction for logs, audit details, command output and anything persisted.
 * Exact secret values are registered at startup (tokens from env); well-known token shapes
 * are always redacted as a backstop.
 */

const registered = new Set<string>()

/** Register an exact secret value (e.g. the GitHub token) so it is scrubbed everywhere. */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 8) registered.add(value)
}

/** For tests. */
export function clearRegisteredSecrets(): void {
  registered.clear()
}

interface Pattern {
  re: RegExp
  /** Number of leading capture groups to keep (e.g. "Authorization: Bearer "). */
  keepPrefix: boolean
}

const PATTERNS: Pattern[] = [
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, keepPrefix: false }, // classic PAT / OAuth / app tokens
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, keepPrefix: false }, // fine-grained PAT
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, keepPrefix: false }, // AWS access key id
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, keepPrefix: false }, // Slack
  { re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, keepPrefix: false }, // OpenAI / Anthropic style keys
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, keepPrefix: false }, // Google API key
  { re: /(authorization:\s*(?:basic|bearer|token)\s+)[^\s"']+/gi, keepPrefix: true }, // auth headers
  { re: /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, keepPrefix: true }, // credentials in URLs
]

export function redact(text: string): string {
  if (!text) return text
  let out = text
  for (const secret of registered) {
    if (out.includes(secret)) out = out.split(secret).join("[REDACTED]")
  }
  for (const { re, keepPrefix } of PATTERNS) {
    out = out.replace(re, (_match: string, prefix?: unknown) =>
      keepPrefix && typeof prefix === "string" ? `${prefix}[REDACTED]${prefix.startsWith("http") ? "@" : ""}` : "[REDACTED]",
    )
  }
  return out
}

/** Deep-redact any JSON-like value (strings are redacted; keys that look secret are masked). */
export function redactValue<T>(value: T): T {
  return walk(value, 0) as T
}

/**
 * Keys whose string values are always masked: any key ENDING in a secret-ish word ("writeToken",
 * "client_secret", "apiKey"). Anchored at the end so "tokensUsed" / "maxTokens" are not masked.
 */
const SECRET_KEY = /(token|secret|password|passwd|authorization|api[-_]?key|private[-_]?key)$/i

function walk(v: unknown, depth: number): unknown {
  if (depth > 8) return "[…]"
  if (typeof v === "string") return redact(v)
  if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1))
  if (v instanceof Error) return { name: v.name, message: redact(v.message) }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && typeof val === "string" && val.length > 0 ? "[REDACTED]" : walk(val, depth + 1)
    }
    return out
  }
  return v
}
