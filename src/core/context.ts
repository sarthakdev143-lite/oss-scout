import type { OssScoutConfig } from "../config/schema.ts"
import type { GitHubApi } from "../github/api.ts"
import type { LlmHost } from "../llm/host.ts"
import type { KillSwitch } from "../scheduler/killswitch.ts"
import type { Store } from "../state/store.ts"
import type { Clock } from "../util/clock.ts"
import type { Exec } from "../util/exec.ts"
import type { Logger } from "../util/log.ts"
import type { Paths } from "../util/paths.ts"
import type { Sandbox } from "../workspace/sandbox.ts"
import type { AuditActor } from "./types.ts"

/**
 * Everything a pipeline stage may use. Built once by `createApp()` (src/app.ts) and passed
 * explicitly; there are no module-level singletons, so every module is testable with fakes.
 */
export interface AppContext {
  readonly config: OssScoutConfig
  readonly paths: Paths
  readonly store: Store
  /** Read-only use by pipeline stages. Mutating methods need a WriteAuthorization. */
  readonly github: GitHubApi
  /**
   * Client used ONLY by the approval executor (queue/submit.ts). Uses the write token when
   * configured, else the read token. Writes are enabled only in "queue" mode.
   */
  readonly githubWriter: GitHubApi
  readonly clock: Clock
  readonly log: Logger
  readonly kill: KillSwitch
  /** fetch for non-GitHub HTTP (package registries). */
  readonly fetch: typeof fetch
  /** Host-side process runner (git, container CLI). Never used to run repo code directly. */
  readonly exec: Exec
  readonly sandbox: Sandbox
  /** null when running outside opencode (CLI): LLM stages are then skipped. */
  readonly llm: LlmHost | null
  readonly secrets: {
    /** Token for git push over HTTPS of approved work. Never pass to sandboxed commands. */
    writeToken(): string | null
    hasReadToken(): boolean
  }
  /** Authenticated GitHub login (cached after first call). */
  login(): Promise<string>
}

/** Convenience: write an audit entry stamped with the context clock. */
export function audit(
  ctx: Pick<AppContext, "store" | "clock">,
  actor: AuditActor,
  action: string,
  subject: string | null,
  decision: string | null,
  reasons: string[] = [],
  details: Record<string, unknown> = {},
): void {
  ctx.store.audit({ ts: ctx.clock.now(), actor, action, subject, decision, reasons, details })
}

/** Record an error for `status` and the log. */
export function recordError(
  ctx: Pick<AppContext, "store" | "clock" | "log">,
  scope: string,
  message: string,
  details: Record<string, unknown> = {},
): void {
  ctx.log.error(message, { scope, ...details })
  ctx.store.recordError(scope, message, details, ctx.clock.now())
}
