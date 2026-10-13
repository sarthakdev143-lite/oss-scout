import type { OssScoutConfig } from "../config/schema.ts"
import type { Millis, QueueItem } from "../core/types.ts"
import type { Store } from "../state/store.ts"
import { DAY, utcDay } from "../util/clock.ts"

/**
 * Contribution caps (open PRs per repo, cooldowns, weekly PR cap, pending queue, concurrency).
 * The snapshot is read once from the store; the decision functions are pure.
 *
 * Queue items count as follows (kind "pr"):
 *   pending                         queued (per repo and toward the weekly total)
 *   approved, dry-run               queued for 7 days after the approval, then not at all (nothing was written)
 *   approved, queue mode            in flight: counted as submitted (weekly) and per repo, until it is
 *                                   submitted, fails or is rejected
 *   submitted                       submitted, for 7 days (rolling window)
 */

export interface CapsSnapshot {
  now: Millis
  /** PRs submitted (status submitted, kind pr) in the last 7 days, plus queue-mode approvals still in flight. */
  submittedLast7Days: number
  /** Open PRs per repo (tracked PRs incl. ones you opened outside oss-scout). Keys lowercased. */
  openPrsByRepo: Record<string, number>
  /** Pending + recent dry-run-approved + in-flight approved queue items per repo (kind pr). Keys lowercased. */
  queuedByRepo: Record<string, number>
  /**
   * The in-flight (approved in queue mode, not yet submitted) part of queuedByRepo. Keys lowercased.
   * Always set by capsSnapshot; optional only so hand-built snapshots (tests) stay valid.
   */
  inFlightByRepo?: Record<string, number>
  /** Active/waiting contribution tasks per repo. Keys lowercased. */
  activeTasksByRepo: Record<string, number>
  /** Repo → cooldown end (latest merged/closed PR + repoCooldownDays). Keys lowercased. Only future values. */
  cooldownUntilByRepo: Record<string, Millis>
  /** All pending queue items. */
  pendingQueue: number
  /** Active/waiting contribution tasks. */
  activeTasks: number
}

export interface CapDecision {
  ok: boolean
  reason: string | null
}

export const WEEK = 7 * DAY

const key = (repo: string) => repo.toLowerCase()

function bump(map: Record<string, number>, repo: string): void {
  const k = key(repo)
  map[k] = (map[k] ?? 0) + 1
}

function sum(map: Record<string, number>): number {
  return Object.values(map).reduce((a, b) => a + b, 0)
}

const OK: CapDecision = { ok: true, reason: null }
const no = (reason: string): CapDecision => ({ ok: false, reason })

/** An approved queue-mode item (its submission is running or was interrupted): it will become a PR. */
export function isInFlightApproval(item: Pick<QueueItem, "status" | "data">): boolean {
  return item.status === "approved" && item.data.dryRun !== true
}

/** A dry-run approval still inside its 7-day cap window. */
function isRecentDryRunApproval(item: Pick<QueueItem, "status" | "data" | "decidedAt" | "updatedAt">, now: Millis): boolean {
  return item.status === "approved" && item.data.dryRun === true && (item.decidedAt ?? item.updatedAt) > now - WEEK
}

export function capsSnapshot(
  store: Store,
  config: OssScoutConfig,
  now: Millis,
  /** excludeQueueItemId: the item being approved (approval-time checks must not count it against itself). */
  opts: { excludeQueueItemId?: number } = {},
): CapsSnapshot {
  const openPrsByRepo: Record<string, number> = {}
  for (const pr of store.listPrs({ state: "open" })) bump(openPrsByRepo, pr.repo)

  const queuedByRepo: Record<string, number> = {}
  const inFlightByRepo: Record<string, number> = {}
  let inFlight = 0
  for (const item of store.listQueue({ kind: "pr", status: ["pending", "approved"] })) {
    if (item.id === opts.excludeQueueItemId) continue
    if (isInFlightApproval(item)) {
      bump(queuedByRepo, item.repo)
      bump(inFlightByRepo, item.repo)
      inFlight++
    } else if (item.status === "pending" || isRecentDryRunApproval(item, now)) {
      bump(queuedByRepo, item.repo)
    }
  }

  const activeTasksByRepo: Record<string, number> = {}
  const tasks = store.listTasks({ kind: "contribution", status: ["active", "waiting"] })
  for (const t of tasks) bump(activeTasksByRepo, t.repo)

  const cooldownUntilByRepo: Record<string, Millis> = {}
  const cooldownMs = config.caps.repoCooldownDays * DAY
  if (cooldownMs > 0) {
    for (const pr of store.listPrs({ state: ["merged", "closed"] })) {
      const endedAt = pr.closedAt ?? pr.mergedAt
      if (endedAt === null) continue
      const until = endedAt + cooldownMs
      const k = key(pr.repo)
      if (until > now && until > (cooldownUntilByRepo[k] ?? 0)) cooldownUntilByRepo[k] = until
    }
  }

  const weekStart = now - WEEK
  const submittedItems = store
    .listQueue({ kind: "pr", status: "submitted" })
    .filter((i) => i.id !== opts.excludeQueueItemId && (i.decidedAt ?? i.updatedAt) >= weekStart).length
  // Fallback when queue rows are missing: PRs oss-scout opened (they carry a queue item id).
  const openedByScout = store
    .listPrs()
    .filter((p) => p.queueItemId !== null && p.queueItemId !== opts.excludeQueueItemId && p.openedAt >= weekStart).length

  return {
    now,
    submittedLast7Days: Math.max(submittedItems, openedByScout) + inFlight,
    openPrsByRepo,
    queuedByRepo,
    inFlightByRepo,
    activeTasksByRepo,
    cooldownUntilByRepo,
    pendingQueue: store.countQueue().pending,
    activeTasks: tasks.length,
  }
}

function cooldownDecision(snap: CapsSnapshot, repo: string): CapDecision {
  const until = snap.cooldownUntilByRepo[key(repo)]
  if (until !== undefined && until > snap.now) {
    return no(`cooldown until ${utcDay(until)} (a PR of yours in ${repo} was merged or closed recently)`)
  }
  return OK
}

/** May the scheduler start ANY new contribution task now? (pending queue, concurrency, weekly cap reached) */
export function canStartAnyTask(snap: CapsSnapshot, config: OssScoutConfig): CapDecision {
  const caps = config.caps
  if (snap.pendingQueue >= caps.maxPendingQueueItems) {
    return no(`approval queue full: ${snap.pendingQueue} pending item(s) (max ${caps.maxPendingQueueItems}); review the queue first`)
  }
  if (snap.activeTasks >= caps.maxConcurrentTasks) {
    return no(`concurrency: ${snap.activeTasks} task(s) in progress (max ${caps.maxConcurrentTasks})`)
  }
  // In-flight approvals are already part of submittedLast7Days.
  const queued = sum(snap.queuedByRepo) - sum(snap.inFlightByRepo ?? {})
  const committed = snap.submittedLast7Days + queued + snap.activeTasks
  if (committed >= caps.maxSubmittedPrsPerWeek) {
    return no(
      `weekly PR cap: ${snap.submittedLast7Days} submitted in the last 7 days + ${queued} queued + ${snap.activeTasks} in progress >= ${caps.maxSubmittedPrsPerWeek}`,
    )
  }
  return OK
}

/** May a new contribution task start for this repo? (open PR cap incl. queued/active work, cooldown) */
export function canStartTaskForRepo(snap: CapsSnapshot, repo: string, config: OssScoutConfig): CapDecision {
  const k = key(repo)
  const open = snap.openPrsByRepo[k] ?? 0
  const queued = snap.queuedByRepo[k] ?? 0
  const active = snap.activeTasksByRepo[k] ?? 0
  const max = config.caps.maxOpenPrsPerRepo
  if (open + queued + active >= max) {
    return no(`open PR cap for ${repo}: ${open} open + ${queued} queued + ${active} in progress >= ${max}`)
  }
  return cooldownDecision(snap, repo)
}

/**
 * Final check at approval time for kind "pr". Build the snapshot with `excludeQueueItemId` = the item
 * being approved. Counts open PRs plus other approvals still being submitted (per repo and weekly).
 */
export function canSubmitPr(snap: CapsSnapshot, repo: string, config: OssScoutConfig): CapDecision {
  const k = key(repo)
  const open = snap.openPrsByRepo[k] ?? 0
  const inFlight = snap.inFlightByRepo?.[k] ?? 0
  const max = config.caps.maxOpenPrsPerRepo
  if (open + inFlight >= max) {
    const being = inFlight > 0 ? ` + ${inFlight} being submitted` : ""
    return no(`open PR cap for ${repo}: ${open} open PR(s)${being} (max ${max})`)
  }
  const cooldown = cooldownDecision(snap, repo)
  if (!cooldown.ok) return cooldown
  if (snap.submittedLast7Days >= config.caps.maxSubmittedPrsPerWeek) {
    return no(
      `weekly PR cap: ${snap.submittedLast7Days} PR(s) submitted (or being submitted) in the last 7 days (max ${config.caps.maxSubmittedPrsPerWeek})`,
    )
  }
  return OK
}
