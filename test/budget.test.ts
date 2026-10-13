import { afterEach, describe, expect, test } from "bun:test"
import type { TaskRecord } from "../src/core/types.ts"
import { ZERO_USAGE, type Usage } from "../src/llm/host.ts"
import { checkBudget, checkBudgetWith, nextUtcMidnight, recordUsage } from "../src/scheduler/budget.ts"
import { utcDay } from "../src/util/clock.ts"
import { makeTestContext, type TestContext } from "./helpers/fakes.ts"

let ctx: TestContext | null = null
afterEach(() => {
  ctx?.cleanup()
  ctx = null
})

function context(): TestContext {
  ctx = makeTestContext({
    config: { budget: { perTask: { maxTokens: 10_000, maxCostUsd: 1 }, perDay: { maxTokens: 50_000, maxCostUsd: 5 } } },
  })
  return ctx
}

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1",
    kind: "contribution",
    repo: "acme/widget",
    issueId: "acme/widget#42",
    prId: null,
    stage: "implement",
    status: "active",
    attempts: 0,
    failures: 0,
    nextRunAt: 0,
    lastError: null,
    abortReason: null,
    workspace: null,
    branch: null,
    tokensUsed: 0,
    costUsd: 0,
    createdAt: 0,
    updatedAt: 0,
    data: {},
    ...over,
  }
}

const usage = (inputTokens: number, outputTokens: number, costUsd: number): Usage => ({
  inputTokens,
  outputTokens,
  costUsd,
  estimated: false,
})

describe("nextUtcMidnight", () => {
  test("is the start of the next UTC day", () => {
    expect(nextUtcMidnight(Date.UTC(2026, 0, 15, 12, 0, 0))).toBe(Date.UTC(2026, 0, 16))
    expect(nextUtcMidnight(Date.UTC(2026, 0, 31, 23, 59, 59))).toBe(Date.UTC(2026, 1, 1))
    expect(nextUtcMidnight(Date.UTC(2026, 11, 31, 0, 0, 0))).toBe(Date.UTC(2027, 0, 1))
  })
})

describe("checkBudget", () => {
  test("ok with no usage", () => {
    const c = context()
    expect(checkBudget(c.store, c.config, task(), c.clock.now())).toEqual({ ok: true, reason: null, scope: null, retryAt: null })
    expect(checkBudget(c.store, c.config, null, c.clock.now()).ok).toBe(true)
  })

  test("day token cap → scope day with retryAt next UTC midnight", () => {
    const c = context()
    c.store.addUsage(utcDay(c.clock.now()), 50_000, 0)
    const d = checkBudget(c.store, c.config, null, c.clock.now())
    expect(d.ok).toBe(false)
    expect(d.scope).toBe("day")
    expect(d.retryAt).toBe(Date.UTC(2026, 0, 16))
    expect(d.reason).toContain("daily token budget")
  })

  test("day cost cap", () => {
    const c = context()
    c.store.addUsage(utcDay(c.clock.now()), 10, 5.01)
    const d = checkBudget(c.store, c.config, null, c.clock.now())
    expect(d).toMatchObject({ ok: false, scope: "day" })
    expect(d.reason).toContain("daily cost budget")
  })

  test("usage from yesterday does not count today", () => {
    const c = context()
    c.store.addUsage(utcDay(c.clock.now() - 86_400_000), 1_000_000, 100)
    expect(checkBudget(c.store, c.config, null, c.clock.now()).ok).toBe(true)
  })

  test("task caps → scope task (abort), no retryAt", () => {
    const c = context()
    const tokens = checkBudget(c.store, c.config, task({ tokensUsed: 10_000 }), c.clock.now())
    expect(tokens).toMatchObject({ ok: false, scope: "task", retryAt: null })
    const cost = checkBudget(c.store, c.config, task({ costUsd: 1 }), c.clock.now())
    expect(cost).toMatchObject({ ok: false, scope: "task" })
    expect(cost.reason).toContain("task cost budget")
  })

  test("task cap wins over day cap (the task must be aborted, not delayed)", () => {
    const c = context()
    c.store.addUsage(utcDay(c.clock.now()), 60_000, 0)
    expect(checkBudget(c.store, c.config, task({ tokensUsed: 20_000 }), c.clock.now()).scope).toBe("task")
  })

  test("a zero cost cap only trips once a known cost was incurred", () => {
    const c = makeTestContext({ config: { budget: { perDay: { maxCostUsd: 0 } } } })
    ctx = c
    expect(checkBudget(c.store, c.config, null, c.clock.now()).ok).toBe(true)
    c.store.addUsage(utcDay(c.clock.now()), 10, 0.01)
    expect(checkBudget(c.store, c.config, null, c.clock.now()).scope).toBe("day")
  })
})

describe("checkBudgetWith", () => {
  test("counts pending usage against task and day caps", () => {
    const c = context()
    const t = task({ tokensUsed: 9_000 })
    expect(checkBudgetWith(c.store, c.config, t, usage(400, 500, 0), c.clock.now()).ok).toBe(true)
    expect(checkBudgetWith(c.store, c.config, t, usage(600, 500, 0), c.clock.now()).scope).toBe("task")
    c.store.addUsage(utcDay(c.clock.now()), 49_000, 0)
    expect(checkBudgetWith(c.store, c.config, null, usage(1_000, 0, 0), c.clock.now()).scope).toBe("day")
    expect(checkBudgetWith(c.store, c.config, null, ZERO_USAGE, c.clock.now()).ok).toBe(true)
  })

  test("ignores negative / NaN pending numbers", () => {
    const c = context()
    c.store.addUsage(utcDay(c.clock.now()), 50_000, 0)
    expect(checkBudgetWith(c.store, c.config, null, usage(-100_000, Number.NaN, -5), c.clock.now()).ok).toBe(false)
  })
})

describe("recordUsage", () => {
  test("adds to the day total and returns an updated task copy without saving", () => {
    const c = context()
    const t = task({ tokensUsed: 100, costUsd: 0.5 })
    const updated = recordUsage(c.store, t, usage(1_000, 200, 0.02), c.clock.now())
    expect(updated).not.toBe(t)
    expect(updated!.tokensUsed).toBe(1_300)
    expect(updated!.costUsd).toBeCloseTo(0.52)
    expect(t.tokensUsed).toBe(100)
    expect(c.store.getTask("t1")).toBeNull()
    expect(c.store.getUsage(utcDay(c.clock.now()))).toEqual({ tokens: 1_200, costUsd: 0.02, calls: 1 })
  })

  test("null task → day usage only", () => {
    const c = context()
    expect(recordUsage(c.store, null, usage(10, 5, 0), c.clock.now())).toBeNull()
    recordUsage(c.store, null, usage(10, 5, 0), c.clock.now())
    expect(c.store.getUsage(utcDay(c.clock.now()))).toMatchObject({ tokens: 30, calls: 2 })
  })

  test("recorded usage then trips the cap", () => {
    const c = context()
    let t: TaskRecord | null = task()
    for (let i = 0; i < 9; i++) t = recordUsage(c.store, t, usage(1_000, 0, 0), c.clock.now())
    expect(checkBudget(c.store, c.config, t, c.clock.now()).ok).toBe(true)
    t = recordUsage(c.store, t, usage(1_000, 0, 0), c.clock.now())
    expect(checkBudget(c.store, c.config, t, c.clock.now()).scope).toBe("task")
  })
})
