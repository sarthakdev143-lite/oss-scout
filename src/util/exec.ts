import { spawn } from "node:child_process"
import { redact } from "./redact.ts"

export interface ExecOptions {
  cwd?: string
  /** Complete environment for the child. Use `safeEnv()` to build it; process.env is NOT inherited. */
  env?: Record<string, string | undefined>
  timeoutMs?: number
  /** Max bytes kept per stream (the tail is kept). */
  maxOutputBytes?: number
  input?: string
  signal?: AbortSignal
  /**
   * Return stdout/stderr WITHOUT redaction. Only for output that is scanned or stored verbatim by
   * design (e.g. `git diff` fed to the secrets gate — redacting it first would hide the secrets the
   * gate must catch). Never log raw output.
   */
  raw?: boolean
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

/** Runs a command (argv form, never through a shell). Resolves for non-zero exit; rejects only on spawn failure. */
export type Exec = (argv: string[], opts?: ExecOptions) => Promise<ExecResult>

/**
 * Env vars that are safe to pass to child processes. Everything else (tokens, API keys, cloud creds)
 * is dropped. Callers add what they need explicitly.
 */
const SAFE_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "LANG",
  "LC_ALL",
  "TZ",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "CONTAINER_HOST",
  "XDG_RUNTIME_DIR",
]

export function safeEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SAFE_ENV_KEYS) {
    const v = process.env[key]
    if (v !== undefined) env[key] = v
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) env[k] = v
  }
  return env
}

class TailBuffer {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false
  constructor(private readonly max: number) {}
  push(chunk: Buffer) {
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.max && this.chunks.length > 1) {
      const first = this.chunks.shift()!
      this.size -= first.length
      this.truncated = true
    }
    if (this.size > this.max && this.chunks.length === 1) {
      const only = this.chunks[0]!
      const cut = only.subarray(only.length - this.max)
      this.chunks[0] = cut
      this.size = cut.length
      this.truncated = true
    }
  }
  toString() {
    const s = Buffer.concat(this.chunks).toString("utf8")
    return this.truncated ? `[…truncated…]\n${s}` : s
  }
}

/** Default Exec using node:child_process (works under Bun and Node). Output is redacted. */
export const execCommand: Exec = (argv, opts = {}) =>
  new Promise<ExecResult>((resolve, reject) => {
    const [cmd, ...args] = argv
    if (!cmd) return reject(new Error("exec: empty argv"))
    const started = Date.now()
    const max = opts.maxOutputBytes ?? 1_000_000
    const out = new TailBuffer(max)
    const err = new TailBuffer(max)
    let timedOut = false
    let settled = false
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: (opts.env ?? safeEnv()) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    })
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            child.kill("SIGKILL")
          }, opts.timeoutMs)
        : null
    const onAbort = () => child.kill("SIGKILL")
    // An already-aborted signal never fires "abort": kill at once (kill switch / stop() before the start).
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", (c: Buffer) => out.push(c))
    child.stderr.on("data", (c: Buffer) => err.push(c))
    child.on("error", (e) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
      reject(e)
    })
    child.on("close", (code, signal) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
      resolve({
        exitCode: code ?? (signal ? 137 : 1),
        stdout: opts.raw ? out.toString() : redact(out.toString()),
        stderr: opts.raw ? err.toString() : redact(err.toString()),
        timedOut,
        durationMs: Date.now() - started,
      })
    })
    child.stdin.on("error", () => {
      // child may exit before reading stdin; ignore EPIPE
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })

/** Keep the last `maxChars` characters of a string, marking truncation. */
export function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `[…${text.length - maxChars} chars truncated…]\n` + text.slice(text.length - maxChars)
}
