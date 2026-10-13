import type { OssScoutConfig } from "../config/schema.ts"
import type { Exec, ExecResult } from "../util/exec.ts"
import { safeEnv, tail } from "../util/exec.ts"
import type { Logger } from "../util/log.ts"
import { errorMessage } from "../util/log.ts"
import { redact } from "../util/redact.ts"
import { SandboxUnavailableError, type Sandbox, type SandboxAvailability, type SandboxRunRequest, type SandboxRunResult } from "./sandbox.ts"

type Runtime = "docker" | "podman"

/** Env keys that look like credentials are never passed into a container. */
export const SECRET_ENV_KEY_RE = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|AUTH|CREDENTIAL|GITHUB|GH_|AWS_|AZURE_|GOOGLE_|OPENAI|ANTHROPIC/i

const AVAILABILITY_TTL_MS = 5 * 60_000
const VERSION_TIMEOUT_MS = 15_000
const INSPECT_TIMEOUT_MS = 30_000
const PULL_TIMEOUT_MS = 15 * 60_000
const KILL_TIMEOUT_MS = 30_000
/** `docker run` itself failed (daemon error, bad flags) — not the command inside the container. */
const RUNTIME_ERROR_EXIT = 125
/** Exit code reported for a run cut short by its AbortSignal (128 + SIGKILL). */
const ABORTED_EXIT = 137

function abortedResult(why: string): SandboxRunResult {
  return { exitCode: ABORTED_EXIT, output: `[oss-scout] sandbox run ${why}`, timedOut: false, durationMs: 0 }
}

/** uid/gid to run as on POSIX hosts (so bind-mount writes keep the host owner); null on Windows. */
export function hostUser(): { uid: number; gid: number } | null {
  if (process.platform === "win32" || typeof process.getuid !== "function" || typeof process.getgid !== "function") return null
  return { uid: process.getuid(), gid: process.getgid() }
}

/** Container names: [a-z0-9_.-], starting with an alphanumeric, bounded length. */
export function sanitizeContainerName(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 100)
  return s || "oss-scout"
}

/** Throws when an env entry could carry a secret or is malformed. */
export function validateContainerEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`sandbox env: invalid variable name ${JSON.stringify(key)}`)
    if (SECRET_ENV_KEY_RE.test(key)) throw new Error(`sandbox env: refusing secret-like variable ${key}`)
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`sandbox env: invalid value for ${key}`)
    if (redact(value) !== value) throw new Error(`sandbox env: value of ${key} looks like a credential`)
  }
}

/** Host paths end up inside a CSV `--mount` spec: no commas, quotes or control characters. */
function assertMountPath(kind: string, path: string): void {
  if (!path || /[,"\r\n\0]/.test(path)) throw new Error(`sandbox: unsupported ${kind} path for a bind mount: ${JSON.stringify(path)}`)
}

/** Build the docker/podman argv for a run request (exported for tests). */
export function buildContainerArgs(
  runtime: "docker" | "podman",
  req: SandboxRunRequest,
  config: OssScoutConfig["sandbox"],
  containerName: string,
  user: { uid: number; gid: number } | null = hostUser(),
): string[] {
  if (req.network !== "none" && req.network !== "bridge") throw new Error(`sandbox: unsupported network ${String(req.network)}`)
  if (!req.image || /\s/.test(req.image) || req.image.startsWith("-")) throw new Error(`sandbox: invalid image ${JSON.stringify(req.image)}`)
  if (containerName !== sanitizeContainerName(containerName)) throw new Error(`sandbox: invalid container name ${containerName}`)
  if (!req.command.trim()) throw new Error("sandbox: empty command")
  assertMountPath("work tree", req.workTree)
  if (req.gitDir) assertMountPath("git dir", req.gitDir)
  const env = req.env ?? {}
  validateContainerEnv(env)
  return [
    runtime,
    "run",
    "--rm",
    "--name",
    containerName,
    "--label",
    "oss-scout=1",
    "--network",
    req.network,
    "--memory",
    config.memory,
    "--memory-swap",
    config.memory,
    "--cpus",
    config.cpus,
    "--pids-limit",
    String(config.pidsLimit),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--init",
    ...(config.readOnlyRootfs ? ["--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,size=2g"] : []),
    "--mount",
    `type=bind,source=${req.workTree},target=/work`,
    ...(req.gitDir ? ["--mount", `type=bind,source=${req.gitDir},target=/work/.git,readonly`] : []),
    "-w",
    "/work",
    "-e",
    "CI=true",
    "-e",
    "HOME=/tmp/home",
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...(user ? ["--user", `${user.uid}:${user.gid}`] : []),
    "--entrypoint",
    "sh",
    req.image,
    "-lc",
    req.command,
  ]
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT"
}

function stderrTail(res: ExecResult, max = 500): string {
  return tail(redact((res.stderr || res.stdout).trim()), max)
}

/** Docker/Podman-backed sandbox. The only way oss-scout executes repository code. */
export class ContainerSandbox implements Sandbox {
  readonly kind: string
  private cached: { at: number; value: SandboxAvailability } | null = null
  private readonly images = new Set<string>()
  private seq = 0

  constructor(
    readonly opts: {
      runtime: "docker" | "podman"
      exec: Exec
      config: OssScoutConfig["sandbox"]
      log: Logger
      /** Injectable for tests. */
      now?: () => number
      /** POSIX uid/gid override for tests (default: detected). */
      user?: { uid: number; gid: number } | null
    },
  ) {
    this.kind = opts.runtime
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  private get runtime(): Runtime {
    return this.opts.runtime
  }

  private execRuntime(args: string[], timeoutMs: number, maxOutputBytes?: number, signal?: AbortSignal): Promise<ExecResult> {
    return this.opts.exec([this.runtime, ...args], {
      env: safeEnv(),
      timeoutMs,
      ...(maxOutputBytes ? { maxOutputBytes } : {}),
      ...(signal ? { signal } : {}),
    })
  }

  async available(): Promise<SandboxAvailability> {
    const hit = this.cached
    if (hit && this.now() - hit.at < AVAILABILITY_TTL_MS) return hit.value
    const value = await this.probe()
    this.cached = { at: this.now(), value }
    return value
  }

  /** Forget the cached availability (e.g. after the runtime disappeared mid-run). */
  invalidate(): void {
    this.cached = null
  }

  private async probe(): Promise<SandboxAvailability> {
    const base = { runtime: this.runtime, version: null }
    let res: ExecResult
    try {
      res = await this.execRuntime(["version", "--format", "{{.Server.Version}}"], VERSION_TIMEOUT_MS)
    } catch (err) {
      const reason = isEnoent(err)
        ? `${this.runtime} CLI not found on PATH (install Docker Desktop or Podman)`
        : `failed to run ${this.runtime}: ${errorMessage(err)}`
      return { ...base, ok: false, reason }
    }
    if (res.timedOut) return { ...base, ok: false, reason: `${this.runtime} daemon not reachable: timed out after ${VERSION_TIMEOUT_MS / 1000}s` }
    const version = res.stdout.trim()
    if (res.exitCode !== 0 || !version) {
      return { ...base, ok: false, reason: `${this.runtime} daemon not reachable: ${stderrTail(res) || `exit code ${res.exitCode}`}` }
    }
    return { ...base, ok: true, reason: null, version: version.split(/\r?\n/)[0]!.trim() }
  }

  private async ensureImage(image: string, signal?: AbortSignal): Promise<void> {
    if (this.images.has(image)) return
    const inspect = await this.execRuntime(["image", "inspect", "--format", "{{.Id}}", image], INSPECT_TIMEOUT_MS, undefined, signal)
    if (signal?.aborted) return
    if (inspect.exitCode === 0 && !inspect.timedOut) {
      this.images.add(image)
      return
    }
    this.opts.log.info("sandbox: pulling image", { runtime: this.runtime, image })
    const pull = await this.execRuntime(["pull", image], PULL_TIMEOUT_MS, undefined, signal)
    if (signal?.aborted) return
    if (pull.exitCode !== 0 || pull.timedOut) {
      const why = pull.timedOut ? "timed out" : stderrTail(pull) || `exit code ${pull.exitCode}`
      throw new Error(`sandbox: failed to pull image ${image}: ${why}`)
    }
    this.opts.log.info("sandbox: image pulled", { runtime: this.runtime, image, durationMs: pull.durationMs })
    this.images.add(image)
  }

  private nextName(label: string): string {
    this.seq += 1
    const suffix = `${this.now().toString(36)}${this.seq.toString(36)}`
    return sanitizeContainerName(`${sanitizeContainerName(label).slice(0, 80)}-${suffix}`)
  }

  private async stop(name: string): Promise<void> {
    for (const args of [["kill", name], ["rm", "-f", name]]) {
      try {
        await this.execRuntime(args, KILL_TIMEOUT_MS)
      } catch (err) {
        this.opts.log.warn("sandbox: cleanup command failed", { args, error: errorMessage(err) })
      }
    }
  }

  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    const cfg = this.opts.config
    const name = this.nextName(req.label)
    // Validates network/env/paths before anything is executed.
    const argv = buildContainerArgs(this.runtime, req, cfg, name, this.opts.user === undefined ? hostUser() : this.opts.user)
    const signal = req.signal
    if (signal?.aborted) return abortedResult("aborted before start")
    try {
      await this.ensureImage(req.image, signal)
    } catch (err) {
      if (isEnoent(err)) throw this.unavailable(err)
      throw err
    }
    if (signal?.aborted) return abortedResult("aborted before start")
    const started = this.now()
    // Abort (kill switch, scheduler stop): killing the CLI client does not stop the container, so the
    // named container is killed and removed right away, and once more after the client exits (in
    // case the daemon created it after the first attempt).
    const abort: { requested: boolean; killing: Promise<void> | null } = { requested: false, killing: null }
    const onAbort = () => {
      abort.requested = true
      this.opts.log.warn("sandbox: run aborted; killing container", { name })
      abort.killing = this.stop(name)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    let res: ExecResult
    try {
      res = await this.opts.exec(argv, {
        env: safeEnv(),
        timeoutMs: req.timeoutMs,
        maxOutputBytes: cfg.maxOutputBytes,
        ...(signal ? { signal } : {}),
      })
    } catch (err) {
      throw isEnoent(err) ? this.unavailable(err) : err
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
    if (abort.requested) {
      if (abort.killing) await abort.killing
      await this.stop(name)
      const combined = [res.stdout, res.stderr].filter((s) => s.length > 0).join("\n")
      return {
        exitCode: res.exitCode !== 0 ? res.exitCode : ABORTED_EXIT,
        output: redact(tail(combined, cfg.maxOutputBytes)),
        timedOut: false,
        durationMs: res.durationMs || this.now() - started,
      }
    }
    if (res.timedOut) {
      this.opts.log.warn("sandbox: command timed out; killing container", { name, timeoutMs: req.timeoutMs })
      await this.stop(name)
    } else if (res.exitCode === RUNTIME_ERROR_EXIT && /^(docker: |Error response from daemon|Error: )/.test(res.stderr.trimStart())) {
      throw new Error(`sandbox: ${this.runtime} run failed: ${stderrTail(res)}`)
    }
    const combined = [res.stdout, res.stderr].filter((s) => s.length > 0).join("\n")
    const output = redact(tail(combined, cfg.maxOutputBytes))
    const durationMs = res.durationMs || this.now() - started
    this.opts.log.info("sandbox: run finished", {
      name,
      image: req.image,
      network: req.network,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      durationMs,
    })
    return { exitCode: res.exitCode, output, timedOut: res.timedOut, durationMs }
  }

  private unavailable(err: unknown): SandboxUnavailableError {
    this.invalidate()
    return new SandboxUnavailableError(
      isEnoent(err) ? `${this.runtime} CLI not found on PATH (install Docker Desktop or Podman)` : errorMessage(err),
    )
  }
}

export function createSandbox(config: OssScoutConfig, exec: Exec, log: Logger): Sandbox {
  return new ContainerSandbox({ runtime: config.sandbox.runtime, exec, config: config.sandbox, log })
}
