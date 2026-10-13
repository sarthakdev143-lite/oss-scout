import type { OssScoutConfig } from "../config/schema.ts"
import type { Millis, TaskRecord } from "../core/types.ts"
import { totalTokens, ZERO_USAGE, type Usage } from "../llm/host.ts"
import type { Store } from "../state/store.ts"
import { utcDay } from "../util/clock.ts"

/** Per-task and per-day LLM token/cost caps, checked before every LLM call. */

export interface BudgetDecision {
  ok: boolean
  reason: string | null
  /** "task" = this task's cap is spent (abort it); "day" = daily cap spent (wait). */
  scope: "task" | "day" | null
  /** When the daily budget resets (next UTC midnight), for scope "day". */
  retryAt: Millis | null
}

/** Start of the next UTC day. */
export function nextUtcMidnight(now: Millis): Millis {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

const nonNegative = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)

/** A cost cap of 0 only refuses once some (known) cost was incurred. */
const costSpent = (cost: number, max: number): boolean => cost > 0 && cost >= max

const fmtUsd = (n: number): string => `$${n.toFixed(2)}`

/** Check per-day and (when a task is given) per-task token/cost caps. */
export function checkBudget(store: Store, config: OssScoutConfig, task: TaskRecord | null, now: Millis): BudgetDecision {
  return checkBudgetWith(store, config, task, ZERO_USAGE, now)
}

/** Same as checkBudget but also counts `pending` usage not yet recorded (mid-run guard). */
export function checkBudgetWith(
  store: Store,
  config: OssScoutConfig,
  task: TaskRecord | null,
  pending: Usage,
  now: Millis,
): BudgetDecision {
  const pendingTokens = nonNegative(totalTokens(pending))
  const pendingCost = nonNegative(pending.costUsd)

  if (task) {
    const { maxTokens, maxCostUsd } = config.budget.perTask
    const tokens = task.tokensUsed + pendingTokens
    const cost = task.costUsd + pendingCost
    if (tokens >= maxTokens) {
      return { ok: false, scope: "task", retryAt: null, reason: `task token budget spent: ${tokens} of ${maxTokens} tokens` }
    }
    if (costSpent(cost, maxCostUsd)) {
      return { ok: false, scope: "task", retryAt: null, reason: `task cost budget spent: ${fmtUsd(cost)} of ${fmtUsd(maxCostUsd)}` }
    }
  }

  const day = utcDay(now)
  const usage = store.getUsage(day)
  const { maxTokens, maxCostUsd } = config.budget.perDay
  const tokens = usage.tokens + pendingTokens
  const cost = usage.costUsd + pendingCost
  const retryAt = nextUtcMidnight(now)
  const resets = `resets ${new Date(retryAt).toISOString()}`
  if (tokens >= maxTokens) {
    return { ok: false, scope: "day", retryAt, reason: `daily token budget spent: ${tokens} of ${maxTokens} tokens on ${day} (${resets})` }
  }
  if (costSpent(cost, maxCostUsd)) {
    return {
      ok: false,
      scope: "day",
      retryAt,
      reason: `daily cost budget spent: ${fmtUsd(cost)} of ${fmtUsd(maxCostUsd)} on ${day} (${resets})`,
    }
  }
  return { ok: true, reason: null, scope: null, retryAt: null }
}

/** Add usage to the day total and (if given) the task's counters; returns the updated task (not saved). */
export function recordUsage(store: Store, task: TaskRecord | null, usage: Usage, now: Millis): TaskRecord | null {
  const tokens = Math.round(nonNegative(totalTokens(usage)))
  const cost = nonNegative(usage.costUsd)
  store.addUsage(utcDay(now), tokens, cost)
  if (!task) return null
  return { ...task, tokensUsed: task.tokensUsed + tokens, costUsd: task.costUsd + cost }
}
