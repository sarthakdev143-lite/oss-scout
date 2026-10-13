/**
 * Sandbox abstraction. Untrusted repository code (installs, builds, tests, linters) runs ONLY
 * through a Sandbox implementation backed by a container runtime. There is deliberately no
 * "run on the host" implementation.
 */

export interface SandboxRunRequest {
  /** Host path of the work tree, mounted read-write at /work. */
  workTree: string
  /** Host path of the git dir, mounted read-only at /work/.git (optional). */
  gitDir?: string | null
  /** Shell command executed with `sh -lc` inside the container. */
  command: string
  image: string
  network: "none" | "bridge"
  timeoutMs: number
  /** Extra env for the container. MUST NOT contain secrets; validated by implementations. */
  env?: Record<string, string>
  /** Label used to name/kill the container. */
  label: string
  /** Abort = kill the container now (kill switch, scheduler stop). The result reports a non-zero exit. */
  signal?: AbortSignal
}

export interface SandboxRunResult {
  exitCode: number
  /** Combined stdout+stderr tail, redacted. */
  output: string
  timedOut: boolean
  durationMs: number
}

export interface SandboxAvailability {
  ok: boolean
  /** Human-readable reason when not ok (e.g. "docker CLI not found"). */
  reason: string | null
  runtime: string
  version: string | null
}

export interface Sandbox {
  readonly kind: string
  available(): Promise<SandboxAvailability>
  run(req: SandboxRunRequest): Promise<SandboxRunResult>
}

/**
 * A sandbox run was cut short by its AbortSignal (kill switch, scheduler stop). Its result says
 * nothing about the command, so it must not be read as a failed install or test: retry later.
 */
export class SandboxInterruptedError extends Error {
  constructor(message = "sandbox run interrupted (kill switch / scheduler stop)") {
    super(message)
    this.name = "SandboxInterruptedError"
  }
}

/** Thrown when untrusted code would have to run but no sandbox is available. */
export class SandboxUnavailableError extends Error {
  constructor(reason: string) {
    super(`sandbox unavailable: ${reason}`)
    this.name = "SandboxUnavailableError"
  }
}
