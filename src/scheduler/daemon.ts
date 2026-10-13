import { resolve } from "node:path"
import { audit, type AppContext } from "../core/context.ts"
import type { Millis, TaskRecord } from "../core/types.ts"
import { runDiscovery } from "../discovery/discover.ts"
import { runExternalPrSync, runFollowup } from "../followup/followup.ts"
import { ApprovalQueue, isInterruptedSubmission, isOpenForDecision, issueIdOf } from "../queue/queue.ts"
import { runScreening } from "../screening/screen.ts"
import { selectNextIssue } from "../selection/issues.ts"
import { DAY, HOUR, MINUTE } from "../util/clock.ts"
import { errorMessage } from "../util/log.ts"
import { makeId } from "../util/text.ts"
import { pruneWorkspaces } from "../workspace/workspace.ts"
import { canStartAnyTask, capsSnapshot } from "./caps.ts"
import { repoBlockReason } from "./eligibility.ts"
import { advanceTask, GITHUB_PAUSED_KEY, startContributionTask, type PipelineDeps } from "./pipeline.ts"

export interface SchedulerDeps extends PipelineDeps {
  runDiscovery: typeof runDiscovery
  runScreening: typeof runScreening
  selectNextIssue: typeof selectNextIssue
  runFollowup: typeof runFollowup
  /** External-PR sync used while follow-up drafting is disabled (caps/cooldowns still need it). */
  runExternalPrSync: typeof runExternalPrSync
  capsSnapshot: typeof capsSnapshot
  canStartAnyTask: typeof canStartAnyTask
  advanceTask: typeof advanceTask
  startContributionTask: typeof startContributionTask
  pruneWorkspaces: typeof pruneWorkspaces
}

type OwnDeps = Pick<
  SchedulerDeps,
  | "runDiscovery"
  | "runScreening"
  | "selectNextIssue"
  | "runFollowup"
  | "runExternalPrSync"
  | "capsSnapshot"
  | "canStartAnyTask"
  | "advanceTask"
  | "startContributionTask"
  | "pruneWorkspaces"
>

const defaultSchedulerDeps: OwnDeps = {
  runDiscovery,
  runScreening,
  selectNextIssue,
  runFollowup,
  runExternalPrSync,
  capsSnapshot,
  canStartAnyTask,
  advanceTask,
  startContributionTask,
  pruneWorkspaces,
}

export interface TickStep {
  step: string
  ok: boolean
  detail: string
}

export interface TickReport {
  at: number
  leader: boolean
  /** Why the tick did nothing (kill switch, mode off, not leader, rate-limited, …). */
  skipped: string | null
  steps: TickStep[]
}

export const LEASE_NAME = "scheduler"
export const KV_LAST_TICK = "scheduler.lastTickAt"
/** Last skipped tick: { at, reason } (status shows it next to the last full tick). */
export const KV_LAST_SKIP = "scheduler.lastSkip"
export const KV_FOLLOWUP_LAST_RUN = "followup.lastRun"
export const KV_DISCOVERY_LAST_RUN = "discovery.lastRun"
/** Last discovery attempt (successful or not); throttles retries after failures. */
export const KV_DISCOVERY_LAST_ATTEMPT = "discovery.lastAttemptAt"
/** Minimum spacing between discovery attempts (failures, empty database). */
export const DISCOVERY_RETRY_MS = HOUR
/** Delay before the first tick after start(). */
export const FIRST_TICK_DELAY_MS = 1000
/** How often a running tick checks the kill switch (and aborts the in-flight stage when it is engaged). */
export const KILL_POLL_MS = 2000
/** Last workspace / cache / audit pruning (at most once per day). */
export const KV_LAST_PRUNE = "workspaces.lastPrune"
export const PRUNE_INTERVAL_MS = DAY
/** Workspaces of finished work are removed once untouched for this long. */
export const WORKSPACE_RETENTION_MS = 7 * DAY
/** Cached GitHub responses older than this are dropped. */
export const HTTP_CACHE_RETENTION_MS = 14 * DAY
/** The audit log keeps at most this many (newest) rows. */
export const AUDIT_MAX_ROWS = 50_000

// ---------------------------------------------------------------------------
// process-wide single-instance guard
// ---------------------------------------------------------------------------

const GUARD_KEY = Symbol.for("oss-scout.scheduler.running")

function guard(): Map<string, Scheduler> {
  const g = globalThis as unknown as Record<symbol, Map<string, Scheduler> | undefined>
  let map = g[GUARD_KEY]
  if (!map) {
    map = new Map()
    g[GUARD_KEY] = map
  }
  return map
}

function guardKey(stateDir: string): string {
  const p = resolve(stateDir)
  return process.platform === "win32" ? p.toLowerCase() : p
}

/** The Scheduler currently running in this process for a state dir, if any. */
export function runningScheduler(stateDir: string): Scheduler | null {
  return guard().get(guardKey(stateDir)) ?? null
}

function unref(timer: unknown): void {
  const t = timer as { unref?: () => void } | null
  if (t && typeof t.unref === "function") t.unref()
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** "discovery.lastRun" holds a DiscoveryLastRun summary ({ at, … }); older/foreign values may be a number. */
export function lastRunAt(value: unknown): Millis | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (value && typeof value === "object") {
    const at = (value as { at?: unknown }).at
    if (typeof at === "number" && Number.isFinite(at)) return at
  }
  return null
}

function isNamed(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name
}

function rateLimitResetAt(err: unknown): number | null {
  if (!isNamed(err, "RateLimitError")) return null
  const at = (err as { resetAt?: unknown }).resetAt
  return typeof at === "number" && Number.isFinite(at) ? at : null
}

const iso = (ms: Millis): string => new Date(ms).toISOString()

function count(v: unknown): number {
  return Array.isArray(v) ? v.length : 0
}

class StopTick extends Error {}

/** Abort reason for the in-flight stage. */
class TickAborted extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TickAborted"
  }
}

/**
 * Durable background loop. Each tick (when leader, not killed, mode != off):
 *   follow-up poll (due) → discovery (due) → screening → advance due tasks → select + start new task (caps)
 * All state is in SQLite, so a restart simply resumes. Rate limits pause GitHub work until reset.
 */
export class Scheduler {
  private readonly id: string
  private readonly deps: OwnDeps
  private timer: ReturnType<typeof setTimeout> | null = null
  private active = false
  private current: Promise<TickReport> | null = null
  /** Aborts the running tick's in-flight stage (stop(), kill switch, lost lease). */
  private tickAbort: AbortController | null = null
  /** Reason of the previous tick's skip (null after a tick that ran): info-log only when it changes. */
  private lastSkipReason: string | null = null

  constructor(
    readonly ctx: AppContext,
    readonly opts: {
      holderId?: string
      deps?: Partial<SchedulerDeps>
      /** Kill-switch poll interval while a tick runs (default KILL_POLL_MS). */
      killPollMs?: number
      /** Lease/claim heartbeat interval while a tick runs (default a third of the lease). */
      heartbeatMs?: number
    } = {},
  ) {
    const salt = makeId("s", ctx.clock.now(), `${process.pid}:${Math.random()}`).split("_").pop() ?? "0"
    this.id = opts.holderId ?? `${process.pid}-${salt}`
    this.deps = { ...defaultSchedulerDeps, ...(opts.deps ?? {}) }
  }

  /** Start the periodic loop (non-blocking). No-op if already running. */
  start(): void {
    if (this.active) return
    const key = guardKey(this.ctx.paths.stateDir)
    const other = guard().get(key)
    if (other && other !== this) {
      this.ctx.log.info("scheduler already running in this process; not starting another", {
        holder: other.holderId,
        stateDir: this.ctx.paths.stateDir,
      })
      return
    }
    guard().set(key, this)
    this.active = true
    this.ctx.log.info("scheduler started", { holder: this.id, tickSeconds: this.ctx.config.scheduler.tickSeconds })
    this.schedule(FIRST_TICK_DELAY_MS)
  }

  /**
   * Stop the loop: interrupt the in-flight stage (agent session, sandbox run, critic; the task waits and
   * resumes on the next start, without counting a failure), wait for the tick to wind down, release the lease.
   */
  async stop(): Promise<void> {
    const wasActive = this.active
    this.active = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.tickAbort?.abort(new TickAborted("scheduler stopping"))
    if (this.current) await this.current.catch(() => undefined)
    try {
      this.ctx.store.releaseLease(LEASE_NAME, this.id)
    } catch {
      // the store may already be closed during shutdown
    }
    const key = guardKey(this.ctx.paths.stateDir)
    if (guard().get(key) === this) guard().delete(key)
    if (wasActive) this.ctx.log.info("scheduler stopped", { holder: this.id })
  }

  /** Run one tick now. `force` ignores "due" intervals for discovery/follow-up. */
  tick(opts: { force?: boolean } = {}): Promise<TickReport> {
    return this.enqueueTick(opts, false)
  }

  get running(): boolean {
    return this.active
  }

  /** Lease holder id of this scheduler. */
  get holderId(): string {
    return this.id
  }

  // -------------------------------------------------------------------------
  // loop
  // -------------------------------------------------------------------------

  private schedule(delayMs: number): void {
    if (!this.active) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.loopOnce()
    }, delayMs)
    unref(this.timer)
  }

  private async loopOnce(): Promise<void> {
    try {
      await this.enqueueTick({}, true)
    } catch (err) {
      this.ctx.log.error("scheduler tick crashed", { error: errorMessage(err) })
    }
    this.schedule(this.ctx.config.scheduler.tickSeconds * 1000)
  }

  /** Ticks never overlap: a tick requested while another runs starts after it. */
  private enqueueTick(opts: { force?: boolean }, fromLoop: boolean): Promise<TickReport> {
    const previous = this.current
    const run = (previous ? previous.then(noop, noop) : Promise.resolve()).then(() => this.runTick(opts, fromLoop))
    const tracked: Promise<TickReport> = run.finally(() => {
      if (this.current === tracked) this.current = null
    })
    this.current = tracked
    return tracked
  }

  private async runTick(opts: { force?: boolean }, fromLoop: boolean): Promise<TickReport> {
    const { ctx } = this
    const now = ctx.clock.now()
    const report: TickReport = { at: now, leader: false, skipped: null, steps: [] }
    const skip = (reason: string): TickReport => {
      this.recordSkip(now, reason)
      return { ...report, skipped: reason }
    }

    if (fromLoop && !this.active) {
      ctx.log.debug("scheduler tick skipped", { reason: "scheduler stopped" })
      return { ...report, skipped: "scheduler stopped" }
    }
    if (ctx.kill.isEngaged()) return skip(`kill switch engaged${ctx.kill.reason() ? ` (${ctx.kill.reason()})` : ""}`)
    if (ctx.config.mode === "off") return skip('mode is "off"')
    if (!ctx.secrets.hasReadToken()) return skip(`${ctx.config.github.tokenEnv} not set`)
    const leaseMs = ctx.config.scheduler.leaseSeconds * 1000
    if (!ctx.store.tryAcquireLease(LEASE_NAME, this.id, leaseMs, now)) {
      const holder = ctx.store.getLease(LEASE_NAME)?.holder ?? "unknown"
      return skip(`another oss-scout scheduler holds the lease (${holder})`)
    }
    report.leader = true
    if (this.lastSkipReason !== null) {
      ctx.log.info("scheduler ticking again", { previousSkipReason: this.lastSkipReason })
      this.lastSkipReason = null
    }

    // The in-flight stage is interrupted when stop() runs, the kill switch is engaged or the lease is lost.
    const abort = new AbortController()
    this.tickAbort = abort
    // Long stages (implementation can take many minutes) must not let the lease or the task claims lapse.
    // A failed renewal means another scheduler may take over: stop the stage instead of racing it.
    const heartbeat = setInterval(() => {
      if (!this.renewLease()) abort.abort(new TickAborted("lost the scheduler lease"))
    }, this.opts.heartbeatMs ?? Math.max(1000, Math.floor(leaseMs / 3)))
    const killPoll = setInterval(() => {
      if (ctx.kill.isEngaged()) abort.abort(new TickAborted("kill switch engaged"))
    }, this.opts.killPollMs ?? KILL_POLL_MS)
    // Both timers stay referenced: they live only while this tick runs (cleared below), and an
    // unreferenced timer may never fire when the stage awaits nothing else (Bun), so the abort
    // they exist for would never come.
    try {
      await this.runSteps(report, opts.force === true, fromLoop, abort.signal)
    } catch (err) {
      if (!(err instanceof StopTick)) throw err
    } finally {
      clearInterval(heartbeat)
      clearInterval(killPoll)
      if (this.tickAbort === abort) this.tickAbort = null
    }
    try {
      ctx.store.setKv(KV_LAST_TICK, now, ctx.clock.now())
    } catch (err) {
      ctx.log.warn("could not record tick time", { error: errorMessage(err) })
    }
    return report
  }

  /**
   * A skipped tick: stored as KV_LAST_SKIP for status; logged at info level when the reason first
   * appears or changes, at debug level while it repeats (a token-less loop skips every tick).
   */
  private recordSkip(at: Millis, reason: string): void {
    const { ctx } = this
    if (reason !== this.lastSkipReason) ctx.log.info("scheduler tick skipped", { reason })
    else ctx.log.debug("scheduler tick skipped", { reason })
    this.lastSkipReason = reason
    try {
      ctx.store.setKv(KV_LAST_SKIP, { at, reason }, ctx.clock.now())
    } catch (err) {
      ctx.log.warn("could not record the skipped tick", { error: errorMessage(err) })
    }
  }

  /** Renew the scheduler lease and this holder's task claims. */
  private renewLease(): boolean {
    try {
      const ms = this.ctx.config.scheduler.leaseSeconds * 1000
      const now = this.ctx.clock.now()
      if (!this.ctx.store.tryAcquireLease(LEASE_NAME, this.id, ms, now)) return false
      this.ctx.store.renewTaskClaims(this.id, ms, now)
      return true
    } catch {
      return false
    }
  }

  private githubPausedUntil(): Millis | null {
    const until = this.ctx.store.getKv<number>(GITHUB_PAUSED_KEY)
    return typeof until === "number" && until > this.ctx.clock.now() ? until : null
  }

  private async runSteps(report: TickReport, force: boolean, fromLoop: boolean, signal: AbortSignal): Promise<void> {
    const { ctx } = this
    const d = this.deps
    const now = report.at
    const push = (step: string, ok: boolean, detail: string) => report.steps.push({ step, ok, detail })

    /** Throws StopTick when the tick must end early (kill switch, stop(), lease lost). */
    const checkpoint = (step: string) => {
      if (ctx.kill.isEngaged()) {
        push(step, false, "kill switch engaged; stopping tick")
        throw new StopTick()
      }
      if ((fromLoop && !this.active) || signal.aborted) {
        const why = signal.aborted ? errorMessage(signal.reason ?? "aborted") : "scheduler stopping"
        push(step, false, `${why}; tick ended early`)
        throw new StopTick()
      }
      if (!this.renewLease()) {
        push(step, false, "lost the scheduler lease; tick ended early")
        throw new StopTick()
      }
    }

    /** Run a GitHub-touching step: rate limits pause GitHub work, the kill switch ends the tick. */
    const github = async (step: string, fn: () => Promise<string>): Promise<boolean> => {
      const paused = this.githubPausedUntil()
      if (paused !== null) {
        push(step, true, `skipped: GitHub paused until ${iso(paused)} (rate limit)`)
        return false
      }
      checkpoint(step)
      try {
        push(step, true, await fn())
        return true
      } catch (err) {
        this.stepError(step, err, push)
        return false
      }
    }

    // 1. follow-up poll
    if (!ctx.config.followup.enabled) {
      // No polling or drafting, but caps and cooldowns still need your open / recently closed PRs.
      const paused = this.githubPausedUntil()
      if (paused !== null) push("followup", true, "disabled in config")
      else
        await github("followup", async () => {
          const r = await d.runExternalPrSync(ctx)
          return `disabled in config; external PR sync: ${r.stateChanges.length} change(s)`
        })
    } else {
      const last = lastRunAt(ctx.store.getKv(KV_FOLLOWUP_LAST_RUN))
      const nextAt = last === null ? now : last + ctx.config.followup.pollIntervalMinutes * MINUTE
      if (!force && nextAt > now) push("followup", true, `not due until ${iso(nextAt)}`)
      else
        await github("followup", async () => {
          ctx.store.setKv(KV_FOLLOWUP_LAST_RUN, now, now)
          const r = await d.runFollowup(ctx)
          return `polled ${r.polled} PR(s); ${r.stateChanges.length} state change(s); ${r.draftedReplies.length} reply draft(s); ${r.fixTasks.length} fix task(s); ${r.errors.length} error(s)`
        })
    }

    // 2. discovery
    const discoveryDue = this.discoveryDue(now, force)
    if (discoveryDue !== null) push("discovery", true, discoveryDue)
    else
      await github("discovery", async () => {
        ctx.store.setKv(KV_DISCOVERY_LAST_ATTEMPT, now, now)
        const r = await d.runDiscovery(ctx)
        const recorded = lastRunAt(ctx.store.getKv(KV_DISCOVERY_LAST_RUN))
        if (recorded === null || recorded < now) {
          const summary = { at: now, added: count(r.added), existing: r.existing, skipped: count(r.skipped), errors: count(r.errors) }
          ctx.store.setKv(KV_DISCOVERY_LAST_RUN, summary, now)
        }
        if (r.added.length > 0) ctx.log.info("discovery added candidate repos", { added: r.added.slice(0, 50) })
        return `${r.added.length} added, ${r.existing} already known, ${r.skipped.length} skipped, ${r.errors.length} error(s)`
      })

    // 3. screening
    await github("screening", async () => {
      const r = await d.runScreening(ctx)
      const eligible = r.screened.filter((x) => x.status === "eligible").length
      return `screened ${r.screened.length} repo(s) (${eligible} eligible); ${r.errors.length} error(s)`
    })

    // 4. advance due tasks (one stage each, sequentially); runs even while GitHub is paused
    await this.advanceDueTasks(now, push, checkpoint, signal)

    // 5. housekeeping (no GitHub): queue items whose repo became off-limits; daily pruning
    checkpoint("maintenance")
    try {
      push("maintenance", true, this.maintenance(ctx.clock.now()))
    } catch (err) {
      this.stepError("maintenance", err, push)
    }

    // 6. select + start new work
    if (!ctx.llm) {
      push("selection", true, "skipped: no LLM host (new work starts only inside opencode)")
      return
    }
    await github("selection", async () => {
      const cap = d.canStartAnyTask(d.capsSnapshot(ctx.store, ctx.config, ctx.clock.now()), ctx.config)
      if (!cap.ok) return `not starting new work: ${cap.reason ?? "caps reached"}`
      const picked = await d.selectNextIssue(ctx)
      if (!picked) return "no suitable issue found"
      const task = d.startContributionTask(ctx, picked.repo, picked.issue)
      return `started ${task.id} for ${picked.issue.id}`
    })
  }

  /** null = discovery is due; otherwise the reason it is not. */
  private discoveryDue(now: Millis, force: boolean): string | null {
    if (force) return null
    const { ctx } = this
    const { fromDependencies, fromSearch, intervalHours } = ctx.config.discovery
    if (!fromDependencies && !fromSearch) return "disabled in config"
    const attempt = lastRunAt(ctx.store.getKv(KV_DISCOVERY_LAST_ATTEMPT))
    if (attempt !== null && now - attempt < DISCOVERY_RETRY_MS) return `not due until ${iso(attempt + DISCOVERY_RETRY_MS)}`
    const counts = ctx.store.countRepos()
    if (counts.candidate + counts.eligible + counts.skipped === 0) return null
    const last = lastRunAt(ctx.store.getKv(KV_DISCOVERY_LAST_RUN))
    const nextAt = last === null ? now : last + intervalHours * HOUR
    return nextAt > now ? `not due until ${iso(nextAt)}` : null
  }

  private async advanceDueTasks(
    now: Millis,
    push: (step: string, ok: boolean, detail: string) => void,
    checkpoint: (step: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const { ctx } = this
    const due = ctx.store.listTasks({ status: ["active", "waiting"], dueAt: now })
    if (due.length === 0) {
      push("tasks", true, "no task due")
      return
    }
    const claimMs = ctx.config.scheduler.leaseSeconds * 1000
    for (const task of due) {
      const step = `task ${task.id}`
      checkpoint(step)
      // A claim per task: another scheduler that took over an expired lease skips (or cannot overwrite) it.
      if (!ctx.store.claimTask(task.id, this.id, claimMs, ctx.clock.now())) {
        push(step, true, "claimed by another oss-scout scheduler; skipped")
        continue
      }
      try {
        const fresh = ctx.store.getTask(task.id) ?? task
        const next: TaskRecord = await this.deps.advanceTask(ctx, fresh, this.opts.deps ?? {}, { signal, holder: this.id })
        const moved = next.stage !== task.stage ? `${task.stage} → ${next.stage}` : next.stage
        const why = next.status === "aborted" ? `: ${next.abortReason ?? ""}` : next.lastError ? `: ${next.lastError}` : ""
        push(step, next.status !== "failed", `${moved} (${next.status})${why}`)
      } catch (err) {
        this.stepError(step, err, push)
      } finally {
        try {
          ctx.store.releaseTaskClaim(task.id, this.id)
        } catch {
          // the store may be closing
        }
      }
    }
  }

  /**
   * Housekeeping without GitHub calls: supersede open queue items whose repo became off-limits (deny
   * list, AI policy, skipped by a re-screen), and once per day prune old workspaces of finished work,
   * the HTTP cache and the audit log. Returns a one-line summary.
   */
  private maintenance(now: Millis): string {
    const parts = [this.supersedeBlockedItems()]
    const last = this.ctx.store.getKv<number>(KV_LAST_PRUNE)
    if (typeof last !== "number" || now - last >= PRUNE_INTERVAL_MS) parts.push(this.prune(now))
    return parts.filter(Boolean).join("; ") || "nothing to do"
  }

  private supersedeBlockedItems(): string {
    const { ctx } = this
    const queue = new ApprovalQueue(ctx)
    const now = ctx.clock.now()
    let n = 0
    for (const item of ctx.store.listQueue({ status: ["pending", "approved", "failed"] })) {
      if (!isOpenForDecision(item) && !isInterruptedSubmission(item, now)) continue
      const reason = repoBlockReason(ctx, item.repo, item.kind === "pr" ? "contribution" : "followup")
      if (!reason) continue
      queue.supersede(item.id, reason)
      if (item.kind === "pr") {
        const issueId = issueIdOf(item)
        if (issueId && ctx.store.getIssue(issueId)) ctx.store.setIssueStatus(issueId, "skipped", reason, { sticky: true })
      }
      n++
    }
    return n > 0 ? `superseded ${n} queue item(s) whose repo is no longer allowed` : ""
  }

  /** Task ids whose workspace must survive: running tasks, open queue items, open PRs (follow-up fixes). */
  private workspacesInUse(): Set<string> {
    const { ctx } = this
    const keep = new Set<string>()
    const add = (v: unknown) => {
      if (typeof v === "string" && v) keep.add(v)
    }
    for (const t of ctx.store.listTasks({ status: ["active", "waiting"] })) {
      add(t.id)
      add(t.data.reuseTaskId)
    }
    for (const item of ctx.store.listQueue({ status: ["pending", "approved", "failed"] })) {
      add(item.taskId)
      add(item.data.workspaceTaskId)
    }
    for (const pr of ctx.store.listPrs({ state: "open" })) {
      const item = pr.queueItemId !== null ? ctx.store.getQueueItem(pr.queueItemId) : null
      add(item?.taskId)
      add(item?.data.workspaceTaskId)
    }
    return keep
  }

  private prune(now: Millis): string {
    const { ctx } = this
    const { removed } = this.deps.pruneWorkspaces(ctx, { keepTaskIds: this.workspacesInUse(), olderThanMs: WORKSPACE_RETENTION_MS })
    const cache = ctx.store.pruneHttpCache(now - HTTP_CACHE_RETENTION_MS)
    const auditRows = ctx.store.pruneAudit(AUDIT_MAX_ROWS)
    ctx.store.setKv(KV_LAST_PRUNE, now, now)
    if (removed.length > 0 || cache > 0 || auditRows > 0) {
      audit(ctx, "system", "maintenance.prune", null, "pruned", [], { workspaces: removed, httpCache: cache, auditRows })
    }
    return `pruned ${removed.length} workspace(s), ${cache} cached response(s), ${auditRows} audit row(s)`
  }

  private stepError(step: string, err: unknown, push: (step: string, ok: boolean, detail: string) => void): void {
    const { ctx } = this
    const message = errorMessage(err)
    if (isNamed(err, "KilledError")) {
      push(step, false, "kill switch engaged; stopping tick")
      throw new StopTick()
    }
    const resetAt = rateLimitResetAt(err)
    if (resetAt !== null) {
      const now = ctx.clock.now()
      const until = Math.max(resetAt, now, ctx.store.getKv<number>(GITHUB_PAUSED_KEY) ?? 0)
      ctx.store.setKv(GITHUB_PAUSED_KEY, until, now)
      audit(ctx, "system", "scheduler.pause", null, "paused", [`GitHub rate limit during ${step}: ${message}`], { until })
      ctx.log.warn("GitHub rate limit: pausing GitHub work", { step, until: iso(until) })
      push(step, false, `rate limited; GitHub paused until ${iso(until)}`)
      return
    }
    ctx.log.error(`scheduler step ${step} failed`, { error: message })
    try {
      ctx.store.recordError(`scheduler.${step.split(" ")[0]}`, message, { step }, ctx.clock.now())
    } catch {
      // recording must not break the tick
    }
    push(step, false, message)
  }
}

function noop(): void {}
