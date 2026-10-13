import type { AppContext } from "../core/context.ts"
import type { AuditEntry, ErrorEntry, Millis, QueueStatus, RepoStatus, TaskRecord } from "../core/types.ts"
import type { RateLimitInfo } from "../github/types.ts"
import { isInterruptedSubmission } from "../queue/queue.ts"
import { capsSnapshot } from "../scheduler/caps.ts"
import { utcDay } from "../util/clock.ts"
import { errorMessage } from "../util/log.ts"
import { oneLine, UNTRUSTED_DATA_HEADER } from "../util/text.ts"
import type { SandboxAvailability } from "../workspace/sandbox.ts"

export interface StatusReport {
  at: Millis
  mode: string
  killSwitch: { engaged: boolean; reason: string | null }
  scheduler: {
    running: boolean
    leader: string | null
    leaseExpiresAt: Millis | null
    /** Last tick that ran its steps (as leader). */
    lastTickAt: Millis | null
    /** Last tick that was skipped before its steps (kill switch, no token, lease held elsewhere, …). */
    lastSkip: { at: Millis; reason: string } | null
  }
  host: { llm: string | null; sandbox: SandboxAvailability | null; tokenPresent: boolean }
  currentTasks: Array<Pick<TaskRecord, "id" | "repo" | "issueId" | "stage" | "status" | "attempts" | "nextRunAt" | "lastError">>
  queue: Record<QueueStatus, number>
  repos: Record<RepoStatus, number>
  caps: {
    submittedLast7Days: number
    maxPerWeek: number
    openPrsByRepo: Record<string, number>
    cooldowns: Array<{ repo: string; until: Millis }>
    pendingQueue: number
    maxPendingQueue: number
  }
  budget: { day: string; tokens: number; maxTokens: number; costUsd: number; maxCostUsd: number }
  rateLimits: RateLimitInfo[]
  githubPausedUntil: Millis | null
  lastErrors: ErrorEntry[]
  recentSkips: Array<{ subject: string; reason: string; at: Millis }>
  /** PRs with new review activity the human must answer personally (repo AI policy; nothing drafted). */
  replyYourself: Array<{ pr: string; comments: number; at: Millis }>
  /** Queue items whose (queue-mode) submission was interrupted: approve again to resume, or reject. */
  interruptedSubmissions?: number[]
}

/** Collaborators, injectable for tests. */
export interface StatusDeps {
  capsSnapshot: typeof capsSnapshot
}

const defaultStatusDeps: StatusDeps = { capsSnapshot }

/** Audit actions whose "skip" decisions show up under "Recently skipped". */
export const SKIP_ACTIONS = ["repo.screen", "issue.skip", "task.abort", "repo.discover.skip"] as const
const SKIP_DECISIONS = new Set(["skip", "skipped"])
const KV_LAST_TICK = "scheduler.lastTickAt"
const KV_LAST_SKIP = "scheduler.lastSkip"
const KV_GITHUB_PAUSED = "github.pausedUntil"
const LEASE_NAME = "scheduler"

function kvNumber(ctx: AppContext, key: string): number | null {
  try {
    const v = ctx.store.getKv<unknown>(key)
    return typeof v === "number" && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

function kvLastSkip(ctx: AppContext): StatusReport["scheduler"]["lastSkip"] {
  try {
    const v = ctx.store.getKv<unknown>(KV_LAST_SKIP)
    if (!v || typeof v !== "object") return null
    const { at, reason } = v as { at?: unknown; reason?: unknown }
    return typeof at === "number" && Number.isFinite(at) && typeof reason === "string" ? { at, reason } : null
  } catch {
    return null
  }
}

function capsFor(ctx: AppContext, now: Millis, deps: StatusDeps): StatusReport["caps"] {
  const maxPerWeek = ctx.config.caps.maxSubmittedPrsPerWeek
  const maxPendingQueue = ctx.config.caps.maxPendingQueueItems
  try {
    const snap = deps.capsSnapshot(ctx.store, ctx.config, now)
    const cooldowns = Object.entries(snap.cooldownUntilByRepo)
      .filter(([, until]) => until > now)
      .map(([repo, until]) => ({ repo, until }))
      .sort((a, b) => a.until - b.until)
    return {
      submittedLast7Days: snap.submittedLast7Days,
      maxPerWeek,
      openPrsByRepo: { ...snap.openPrsByRepo },
      cooldowns,
      pendingQueue: snap.pendingQueue,
      maxPendingQueue,
    }
  } catch (err) {
    ctx.log.warn("status: caps snapshot unavailable", { error: errorMessage(err) })
    const openPrsByRepo: Record<string, number> = {}
    for (const pr of ctx.store.listPrs({ state: "open" })) {
      const k = pr.repo.toLowerCase()
      openPrsByRepo[k] = (openPrsByRepo[k] ?? 0) + 1
    }
    return { submittedLast7Days: 0, maxPerWeek, openPrsByRepo, cooldowns: [], pendingQueue: ctx.store.countQueue().pending, maxPendingQueue }
  }
}

function skipReason(entry: AuditEntry): string {
  const fromDetails = entry.details.skipReason
  return entry.reasons[0] ?? (typeof fromDetails === "string" && fromDetails ? fromDetails : entry.decision ?? "skipped")
}

/** Latest skip decisions across screening, selection, tasks and discovery (newest first). */
export function recentSkips(ctx: Pick<AppContext, "store">, limit = 10): StatusReport["recentSkips"] {
  const entries: AuditEntry[] = []
  for (const action of SKIP_ACTIONS) {
    // over-fetch: repo.screen also records "eligible" decisions
    entries.push(...ctx.store.listAudit({ action, limit: limit * 5 }).filter((e) => SKIP_DECISIONS.has(e.decision ?? "")))
  }
  return entries
    .sort((a, b) => b.ts - a.ts || b.id - a.id)
    .slice(0, limit)
    .map((e) => ({ subject: e.subject ?? "-", reason: skipReason(e), at: e.ts }))
}

/**
 * Latest "followup.summary" audits with decision "reply_yourself" (repos whose AI policy wants
 * human-written review replies), newest first, one per PR; PRs no longer open are dropped.
 */
export function replyYourself(ctx: Pick<AppContext, "store">, limit = 5): StatusReport["replyYourself"] {
  const seen = new Set<string>()
  const out: StatusReport["replyYourself"] = []
  const entries = ctx.store
    .listAudit({ action: "followup.summary", limit: limit * 10 })
    .filter((e) => e.decision === "reply_yourself" && e.subject)
    .sort((a, b) => b.ts - a.ts || b.id - a.id)
  for (const e of entries) {
    const pr = e.subject!
    if (seen.has(pr)) continue
    seen.add(pr)
    const tracked = ctx.store.getPr(pr)
    if (tracked && tracked.state !== "open") continue
    const n = e.details.activity
    out.push({ pr, comments: typeof n === "number" && Number.isFinite(n) ? n : 0, at: e.ts })
    if (out.length >= limit) break
  }
  return out
}

async function sandboxAvailability(ctx: AppContext): Promise<SandboxAvailability> {
  try {
    return await ctx.sandbox.available()
  } catch (err) {
    return { ok: false, reason: errorMessage(err), runtime: ctx.sandbox.kind, version: null }
  }
}

export async function buildStatus(
  ctx: AppContext,
  extra: { schedulerRunning?: boolean; checkSandbox?: boolean } = {},
  deps: Partial<StatusDeps> = {},
): Promise<StatusReport> {
  const d: StatusDeps = { ...defaultStatusDeps, ...deps }
  const now = ctx.clock.now()
  const lease = ctx.store.getLease(LEASE_NAME)
  const pausedUntil = kvNumber(ctx, KV_GITHUB_PAUSED)
  const day = utcDay(now)
  const usage = ctx.store.getUsage(day)
  let rateLimits: RateLimitInfo[] = []
  try {
    rateLimits = ctx.github.rateLimitSnapshot()
  } catch {
    rateLimits = []
  }

  return {
    at: now,
    mode: ctx.config.mode,
    killSwitch: { engaged: ctx.kill.isEngaged(), reason: ctx.kill.reason() },
    scheduler: {
      running: extra.schedulerRunning ?? false,
      leader: lease?.holder ?? null,
      leaseExpiresAt: lease?.expiresAt ?? null,
      lastTickAt: kvNumber(ctx, KV_LAST_TICK),
      lastSkip: kvLastSkip(ctx),
    },
    host: {
      llm: ctx.llm?.kind ?? null,
      sandbox: extra.checkSandbox ? await sandboxAvailability(ctx) : null,
      tokenPresent: ctx.secrets.hasReadToken(),
    },
    currentTasks: ctx.store.listTasks({ status: ["active", "waiting"] }).map((t) => ({
      id: t.id,
      repo: t.repo,
      issueId: t.issueId,
      stage: t.stage,
      status: t.status,
      attempts: t.attempts,
      nextRunAt: t.nextRunAt,
      lastError: t.lastError,
    })),
    queue: ctx.store.countQueue(),
    repos: ctx.store.countRepos(),
    caps: capsFor(ctx, now, d),
    budget: {
      day,
      tokens: usage.tokens,
      maxTokens: ctx.config.budget.perDay.maxTokens,
      costUsd: usage.costUsd,
      maxCostUsd: ctx.config.budget.perDay.maxCostUsd,
    },
    rateLimits,
    githubPausedUntil: pausedUntil !== null && pausedUntil > now ? pausedUntil : null,
    lastErrors: ctx.store.listErrors(5),
    recentSkips: recentSkips(ctx, 10),
    replyYourself: replyYourself(ctx, 5),
    interruptedSubmissions: ctx.store
      .listQueue({ status: "approved" })
      .filter((i) => isInterruptedSubmission(i, now))
      .map((i) => i.id),
  }
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

/** "2026-01-15 12:00Z" */
function stamp(ms: Millis): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`
}

/** "in 5m" / "3h ago" relative to `now` ("0s ago" for `now` itself). */
export function relative(ms: Millis, now: Millis): string {
  const diff = ms - now
  const abs = Math.abs(diff)
  const text =
    abs < 60_000
      ? `${Math.round(abs / 1000)}s`
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)}m`
        : abs < 172_800_000
          ? `${Math.round(abs / 3_600_000)}h`
          : `${Math.round(abs / 86_400_000)}d`
  return diff > 0 ? `in ${text}` : `${text} ago`
}

const when = (ms: Millis, now: Millis): string => `${stamp(ms)} (${relative(ms, now)})`

const fmtInt = (n: number): string => Math.round(n).toLocaleString("en-US")
const fmtUsd = (n: number): string => `$${n.toFixed(2)}`

function counts<K extends string>(rec: Record<K, number>, order: readonly K[]): string {
  return order.map((k) => `${rec[k] ?? 0} ${k}`).join(", ")
}

function sandboxLine(s: SandboxAvailability | null): string {
  if (!s) return "not checked"
  return s.ok ? `${s.runtime}${s.version ? ` ${s.version}` : ""} available` : `UNAVAILABLE (${s.reason ?? s.runtime})`
}

/** "last tick …", "last tick skipped 3s ago: <reason>" (+ the last full tick, if any) or "never ticked". */
function tickText(s: StatusReport["scheduler"], now: Millis): string {
  const skip = s.lastSkip
  if (skip && (s.lastTickAt === null || skip.at >= s.lastTickAt)) {
    const full = s.lastTickAt === null ? "" : ` (last full tick ${when(s.lastTickAt, now)})`
    return `last tick skipped ${relative(skip.at, now)}: ${oneLine(skip.reason, 200)}${full}`
  }
  return s.lastTickAt === null ? "never ticked" : `last tick ${when(s.lastTickAt, now)}`
}

function schedulerLines(r: StatusReport): string[] {
  const s = r.scheduler
  const lease =
    s.leader === null
      ? "no leader"
      : s.leaseExpiresAt !== null && s.leaseExpiresAt <= r.at
        ? `lease of ${s.leader} expired ${relative(s.leaseExpiresAt, r.at)}`
        : `leader ${s.leader}${s.leaseExpiresAt !== null ? ` (lease until ${stamp(s.leaseExpiresAt)})` : ""}`
  return [`Scheduler: ${s.running ? "running" : "not running in this process"}; ${lease}; ${tickText(s, r.at)}`]
}

function taskLines(r: StatusReport): string[] {
  if (r.currentTasks.length === 0) return ["  (none)"]
  return r.currentTasks.map((t) => {
    const next = t.nextRunAt > r.at ? `, next run ${when(t.nextRunAt, r.at)}` : ", due now"
    const err = t.lastError ? `\n      last error: ${oneLine(t.lastError)}` : ""
    return `  ${t.id}  ${t.issueId ?? t.repo}  stage ${t.stage} [${t.status}]  attempts ${t.attempts}${next}${err}`
  })
}

function capsLines(r: StatusReport): string[] {
  const c = r.caps
  const open = Object.entries(c.openPrsByRepo)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, n]) => `${repo} ${n}`)
  const cooldowns = c.cooldowns.map((x) => `${x.repo} until ${stamp(x.until)}`)
  return [
    `  PRs submitted: ${c.submittedLast7Days}/${c.maxPerWeek} this week (rolling 7 days)`,
    `  Pending approvals: ${c.pendingQueue}/${c.maxPendingQueue}`,
    `  Open PRs by repo: ${open.length ? open.join(", ") : "none"}`,
    `  Cooldowns: ${cooldowns.length ? cooldowns.join(", ") : "none"}`,
  ]
}

function githubLines(r: StatusReport): string[] {
  const limits = [...r.rateLimits]
    .sort((a, b) => a.resource.localeCompare(b.resource))
    .map((l) => `${l.resource} ${l.remaining}/${l.limit} (resets ${stamp(l.resetAt)})`)
  return [
    `GitHub: token ${r.host.tokenPresent ? "present" : "MISSING"}; ${r.githubPausedUntil !== null ? `PAUSED until ${when(r.githubPausedUntil, r.at)} (rate limit)` : "not paused"}`,
    `  Rate limits: ${limits.length ? limits.join("; ") : "no requests yet"}`,
  ]
}

/**
 * Human-readable multi-line status. `untrustedHeader` (tool results, slash-command posts) puts
 * UNTRUSTED_DATA_HEADER above the sections that carry repo/issue names and error messages.
 */
export function formatStatus(report: StatusReport, opts: { untrustedHeader?: boolean } = {}): string {
  const r = report
  const lines: string[] = []
  lines.push(`oss-scout status at ${stamp(r.at)}`)
  const kill = r.killSwitch.engaged ? `ENGAGED${r.killSwitch.reason ? ` (${oneLine(r.killSwitch.reason)})` : ""}` : "off"
  lines.push(`Mode: ${r.mode}    Kill switch: ${kill}`)
  lines.push(...schedulerLines(r))
  lines.push(`Host: LLM ${r.host.llm ?? "unavailable (outside opencode)"}; sandbox ${sandboxLine(r.host.sandbox)}`)

  if (opts.untrustedHeader) lines.push("", UNTRUSTED_DATA_HEADER)
  lines.push("", `Current task(s): ${r.currentTasks.length}`, ...taskLines(r))
  if (r.replyYourself.length) {
    lines.push("")
    for (const x of r.replyYourself) {
      const n = `${x.comments} comment${x.comments === 1 ? "" : "s"}`
      lines.push(`New review activity to answer yourself: ${oneLine(x.pr, 100)} (${n}, ${relative(x.at, r.at)})`)
    }
  }
  lines.push("", `Queue: ${counts(r.queue, ["pending", "approved", "submitted", "rejected", "failed", "superseded"])}`)
  const interrupted = r.interruptedSubmissions ?? []
  if (interrupted.length) {
    lines.push(`  Interrupted submissions: ${interrupted.map((id) => `#${id}`).join(", ")} (approve again to resume, or reject)`)
  }
  lines.push(`Repos: ${counts(r.repos, ["candidate", "eligible", "skipped"])}`)

  lines.push("", "Caps used:", ...capsLines(r))

  const b = r.budget
  lines.push(
    "",
    `Budget today (${b.day} UTC): ${fmtInt(b.tokens)}/${fmtInt(b.maxTokens)} tokens, ${fmtUsd(b.costUsd)}/${fmtUsd(b.maxCostUsd)}`,
  )

  lines.push("", ...githubLines(r))

  lines.push("", "Last errors:")
  if (r.lastErrors.length === 0) lines.push("  (none)")
  for (const e of r.lastErrors) lines.push(`  ${stamp(e.ts)} [${e.scope}] ${oneLine(e.message)}`)

  lines.push("", "Recently skipped (why):")
  if (r.recentSkips.length === 0) lines.push("  (none)")
  for (const s of r.recentSkips) lines.push(`  ${stamp(s.at)} ${oneLine(s.subject, 100)}: ${oneLine(s.reason)}`)

  return lines.join("\n")
}
