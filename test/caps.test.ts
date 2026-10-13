import { afterEach, describe, expect, test } from "bun:test"
import type { ConfigInput } from "../src/config/schema.ts"
import type { QueueItem, TaskRecord, TrackedPr } from "../src/core/types.ts"
import {
  canStartAnyTask,
  canStartTaskForRepo,
  canSubmitPr,
  capsSnapshot,
  type CapsSnapshot,
} from "../src/scheduler/caps.ts"
import { DAY } from "../src/util/clock.ts"
import { makeTestContext, testConfig, type TestContext } from "./helpers/fakes.ts"

let ctx: TestContext | null = null
afterEach(() => {
  ctx?.cleanup()
  ctx = null
})

function context(config: ConfigInput = {}): TestContext {
  ctx = makeTestContext({ config })
  return ctx
}

function pr(over: Partial<TrackedPr> = {}): TrackedPr {
  const repo = over.repo ?? "acme/widget"
  const number = over.number ?? 1
  return {
    id: `${repo}#${number}`,
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    queueItemId: null,
    branch: null,
    headRepo: null,
    state: "open",
    openedAt: 0,
    closedAt: null,
    mergedAt: null,
    lastPolledAt: null,
    lastSeenActivityAt: null,
    data: {},
    ...over,
  }
}

function queueItem(over: Partial<Omit<QueueItem, "id">> = {}): Omit<QueueItem, "id"> {
  return {
    kind: "pr",
    status: "pending",
    repo: "acme/widget",
    issueUrl: null,
    prUrl: null,
    taskId: null,
    title: "t",
    body: "b",
    diff: "",
    testOutput: "",
    critic: null,
    verification: null,
    branch: null,
    workspace: null,
    baseBranch: null,
    digest: "0".repeat(64),
    createdAt: 0,
    updatedAt: 0,
    decidedAt: null,
    decisionReason: null,
    submittedUrl: null,
    error: null,
    data: {},
    ...over,
  }
}

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: over.id ?? "t1",
    kind: "contribution",
    repo: "acme/widget",
    issueId: null,
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

const EMPTY: CapsSnapshot = {
  now: Date.UTC(2026, 0, 15),
  submittedLast7Days: 0,
  openPrsByRepo: {},
  queuedByRepo: {},
  inFlightByRepo: {},
  activeTasksByRepo: {},
  cooldownUntilByRepo: {},
  pendingQueue: 0,
  activeTasks: 0,
}

describe("capsSnapshot", () => {
  test("empty store", () => {
    const c = context()
    expect(capsSnapshot(c.store, c.config, c.clock.now())).toEqual({ ...EMPTY, now: c.clock.now() })
  })

  test("counts open PRs (incl. external), queued pr items, active/waiting contribution tasks; keys lowercased", () => {
    const c = context()
    c.store.upsertPr(pr({ repo: "Acme/Widget", number: 1 }))
    c.store.upsertPr(pr({ repo: "other/lib", number: 2, data: { external: true } }))
    c.store.upsertPr(pr({ repo: "acme/widget", number: 3, state: "merged", mergedAt: 1, closedAt: 1 }))
    c.store.insertQueueItem(queueItem({ repo: "ACME/widget" }))
    c.store.insertQueueItem(queueItem({ status: "approved", data: { dryRun: true }, decidedAt: c.clock.now() - DAY }))
    c.store.insertQueueItem(queueItem({ status: "rejected" }))
    c.store.insertQueueItem(queueItem({ kind: "reply", status: "pending" }))
    c.store.saveTask(task({ id: "a", repo: "Acme/Widget" }))
    c.store.saveTask(task({ id: "b", repo: "x/y", status: "waiting" }))
    c.store.saveTask(task({ id: "c", status: "done" }))
    c.store.saveTask(task({ id: "d", kind: "followup_fix" }))
    const snap = capsSnapshot(c.store, c.config, c.clock.now())
    expect(snap.openPrsByRepo).toEqual({ "acme/widget": 1, "other/lib": 1 })
    expect(snap.queuedByRepo).toEqual({ "acme/widget": 2 })
    expect(snap.activeTasksByRepo).toEqual({ "acme/widget": 1, "x/y": 1 })
    expect(snap.activeTasks).toBe(2)
    expect(snap.pendingQueue).toBe(2)
  })

  test("cooldown from the latest merged/closed PR; expired cooldowns are dropped", () => {
    const c = context({ caps: { repoCooldownDays: 30 } })
    const now = c.clock.now()
    c.store.upsertPr(pr({ number: 1, state: "merged", mergedAt: now - 10 * DAY, closedAt: now - 10 * DAY }))
    c.store.upsertPr(pr({ number: 2, state: "closed", closedAt: now - 5 * DAY }))
    c.store.upsertPr(pr({ repo: "old/repo", number: 3, state: "closed", closedAt: now - 31 * DAY }))
    c.store.upsertPr(pr({ repo: "Mixed/Case", number: 4, state: "merged", mergedAt: now - DAY, closedAt: null }))
    const snap = capsSnapshot(c.store, c.config, now)
    expect(snap.cooldownUntilByRepo).toEqual({ "acme/widget": now + 25 * DAY, "mixed/case": now + 29 * DAY })
  })

  test("cooldown of 0 days disables cooldowns", () => {
    const c = context({ caps: { repoCooldownDays: 0 } })
    c.store.upsertPr(pr({ state: "closed", closedAt: c.clock.now() }))
    expect(capsSnapshot(c.store, c.config, c.clock.now()).cooldownUntilByRepo).toEqual({})
  })

  test("weekly window over submitted items moves with the clock", () => {
    const c = context()
    const now = c.clock.now()
    c.store.insertQueueItem(queueItem({ status: "submitted", decidedAt: now - 6 * DAY }))
    c.store.insertQueueItem(queueItem({ status: "submitted", decidedAt: now - 1 * DAY }))
    c.store.insertQueueItem(queueItem({ status: "submitted", decidedAt: now - 8 * DAY }))
    c.store.insertQueueItem(queueItem({ kind: "reply", status: "submitted", decidedAt: now }))
    expect(capsSnapshot(c.store, c.config, now).submittedLast7Days).toBe(2)
    c.clock.advance(1 * DAY + 1)
    expect(capsSnapshot(c.store, c.config, c.clock.now()).submittedLast7Days).toBe(1)
    c.clock.advance(6 * DAY)
    expect(capsSnapshot(c.store, c.config, c.clock.now()).submittedLast7Days).toBe(0)
  })

  test("falls back to scout-opened PRs without double counting", () => {
    const c = context()
    const now = c.clock.now()
    const item = c.store.insertQueueItem(queueItem({ status: "submitted", decidedAt: now - DAY }))
    c.store.upsertPr(pr({ number: 5, queueItemId: item.id, openedAt: now - DAY }))
    expect(capsSnapshot(c.store, c.config, now).submittedLast7Days).toBe(1)
    // queue row missing for a second PR → PR fallback wins
    c.store.upsertPr(pr({ number: 6, queueItemId: 999, openedAt: now - 2 * DAY, state: "merged", mergedAt: now }))
    c.store.upsertPr(pr({ number: 7, queueItemId: null, openedAt: now - DAY }))
    expect(capsSnapshot(c.store, c.config, now).submittedLast7Days).toBe(2)
  })
})

describe("capsSnapshot: approvals", () => {
  test("dry-run approvals never count as submitted and leave the per-repo/weekly totals after 7 days", () => {
    const c = context()
    const now = c.clock.now()
    c.store.insertQueueItem(queueItem({ status: "approved", data: { dryRun: true }, decidedAt: now - 6 * DAY }))
    c.store.insertQueueItem(queueItem({ repo: "old/dry", status: "approved", data: { dryRun: true }, decidedAt: now - 8 * DAY }))
    const snap = capsSnapshot(c.store, c.config, now)
    expect(snap.submittedLast7Days).toBe(0)
    expect(snap.queuedByRepo).toEqual({ "acme/widget": 1 })
    expect(snap.inFlightByRepo).toEqual({})
    // a day later the remaining one ages out too: default dry-run mode never stalls for good
    c.clock.advance(DAY + 1)
    expect(capsSnapshot(c.store, c.config, c.clock.now()).queuedByRepo).toEqual({})
    expect(canStartAnyTask(capsSnapshot(c.store, c.config, c.clock.now()), c.config).ok).toBe(true)
  })

  test("queue-mode approvals still being submitted count as submitted (weekly) and per repo, once", () => {
    const c = context({ caps: { maxSubmittedPrsPerWeek: 3, maxConcurrentTasks: 4, maxPendingQueueItems: 10 } })
    const now = c.clock.now()
    const inflight = c.store.insertQueueItem(queueItem({ status: "approved", data: {}, decidedAt: now }))
    c.store.insertQueueItem(queueItem({ repo: "x/y", status: "pending" }))
    const snap = capsSnapshot(c.store, c.config, now)
    expect(snap.submittedLast7Days).toBe(1)
    expect(snap.inFlightByRepo).toEqual({ "acme/widget": 1 })
    expect(snap.queuedByRepo).toEqual({ "acme/widget": 1, "x/y": 1 })
    // 1 submitted (in flight) + 1 queued: the in-flight item is not counted twice
    expect(canStartAnyTask(snap, c.config).ok).toBe(true)
    expect(canStartAnyTask({ ...snap, activeTasks: 1 }, c.config).ok).toBe(false)
    expect(canStartTaskForRepo(snap, "acme/widget", c.config).ok).toBe(false)
    // the item being approved is excluded from its own check
    const own = capsSnapshot(c.store, c.config, now, { excludeQueueItemId: inflight.id })
    expect(own.submittedLast7Days).toBe(0)
    expect(own.inFlightByRepo).toEqual({})
  })
})

describe("canStartAnyTask", () => {
  const config = testConfig({ caps: { maxPendingQueueItems: 3, maxConcurrentTasks: 1, maxSubmittedPrsPerWeek: 3 } })

  test("ok when nothing is going on", () => {
    expect(canStartAnyTask(EMPTY, config)).toEqual({ ok: true, reason: null })
  })

  test("pending queue full", () => {
    const d = canStartAnyTask({ ...EMPTY, pendingQueue: 3 }, config)
    expect(d.ok).toBe(false)
    expect(d.reason).toContain("approval queue full")
  })

  test("concurrency", () => {
    const d = canStartAnyTask({ ...EMPTY, activeTasks: 1 }, config)
    expect(d.ok).toBe(false)
    expect(d.reason).toContain("concurrency")
  })

  test("weekly cap counts submitted + queued + active work", () => {
    const cfg = testConfig({ caps: { maxConcurrentTasks: 4, maxPendingQueueItems: 10, maxSubmittedPrsPerWeek: 3 } })
    expect(canStartAnyTask({ ...EMPTY, submittedLast7Days: 2 }, cfg).ok).toBe(true)
    const d = canStartAnyTask({ ...EMPTY, submittedLast7Days: 1, queuedByRepo: { "a/b": 1 }, activeTasks: 1 }, cfg)
    expect(d.ok).toBe(false)
    expect(d.reason).toStartWith("weekly PR cap:")
  })
})

describe("canStartTaskForRepo", () => {
  const config = testConfig({ caps: { maxOpenPrsPerRepo: 1 } })

  test("open, queued or active work in the repo blocks a new task (case-insensitive)", () => {
    expect(canStartTaskForRepo(EMPTY, "Acme/Widget", config).ok).toBe(true)
    expect(canStartTaskForRepo({ ...EMPTY, openPrsByRepo: { "acme/widget": 1 } }, "Acme/Widget", config).ok).toBe(false)
    expect(canStartTaskForRepo({ ...EMPTY, queuedByRepo: { "acme/widget": 1 } }, "ACME/WIDGET", config).ok).toBe(false)
    expect(canStartTaskForRepo({ ...EMPTY, activeTasksByRepo: { "acme/widget": 1 } }, "acme/widget", config).ok).toBe(false)
    expect(canStartTaskForRepo({ ...EMPTY, openPrsByRepo: { "other/x": 1 } }, "acme/widget", config).ok).toBe(true)
  })

  test("cooldown blocks until it expires", () => {
    const until = EMPTY.now + 3 * DAY
    const snap = { ...EMPTY, cooldownUntilByRepo: { "acme/widget": until } }
    const d = canStartTaskForRepo(snap, "Acme/widget", config)
    expect(d.ok).toBe(false)
    expect(d.reason).toStartWith("cooldown until 2026-01-18")
    expect(canStartTaskForRepo({ ...snap, now: until + 1 }, "acme/widget", config).ok).toBe(true)
  })

  test("end to end: merged PR puts the repo on cooldown, the clock releases it", () => {
    const c = context({ caps: { repoCooldownDays: 30 } })
    c.store.upsertPr(pr({ state: "merged", mergedAt: c.clock.now(), closedAt: c.clock.now() }))
    expect(canStartTaskForRepo(capsSnapshot(c.store, c.config, c.clock.now()), "ACME/widget", c.config).ok).toBe(false)
    c.clock.advance(30 * DAY + 1)
    expect(canStartTaskForRepo(capsSnapshot(c.store, c.config, c.clock.now()), "acme/widget", c.config).ok).toBe(true)
  })
})

describe("canSubmitPr", () => {
  const config = testConfig({ caps: { maxOpenPrsPerRepo: 1, maxSubmittedPrsPerWeek: 3 } })

  test("ignores queued items (the one being approved) but counts open PRs", () => {
    expect(canSubmitPr({ ...EMPTY, queuedByRepo: { "acme/widget": 2 } }, "acme/widget", config).ok).toBe(true)
    const d = canSubmitPr({ ...EMPTY, openPrsByRepo: { "acme/widget": 1 } }, "Acme/Widget", config)
    expect(d.ok).toBe(false)
    expect(d.reason).toContain("open PR cap")
  })

  test("another approval being submitted in the repo or this week counts", () => {
    const d = canSubmitPr({ ...EMPTY, inFlightByRepo: { "acme/widget": 1 } }, "acme/widget", config)
    expect(d.ok).toBe(false)
    expect(d.reason).toContain("1 being submitted")
    expect(canSubmitPr({ ...EMPTY, inFlightByRepo: { "other/x": 1 } }, "acme/widget", config).ok).toBe(true)
    // hand-built snapshots without the field still work
    const { inFlightByRepo: _x, ...legacy } = EMPTY
    expect(canSubmitPr(legacy, "acme/widget", config).ok).toBe(true)
  })

  test("cooldown and weekly cap", () => {
    const cool = canSubmitPr({ ...EMPTY, cooldownUntilByRepo: { "acme/widget": EMPTY.now + DAY } }, "acme/widget", config)
    expect(cool.reason).toStartWith("cooldown until")
    const weekly = canSubmitPr({ ...EMPTY, submittedLast7Days: 3 }, "acme/widget", config)
    expect(weekly.ok).toBe(false)
    expect(weekly.reason).toStartWith("weekly PR cap")
    expect(canSubmitPr({ ...EMPTY, submittedLast7Days: 2 }, "acme/widget", config).ok).toBe(true)
  })
})
