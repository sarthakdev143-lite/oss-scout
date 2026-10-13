import { afterEach, describe, expect, test } from "bun:test"
import type { AppContext } from "../src/core/context.ts"
import type { IssueRecord, QueueItem, RepoRecord, TaskRecord } from "../src/core/types.ts"
import type { DiscoveryReport } from "../src/discovery/discover.ts"
import type { FollowupReport } from "../src/followup/followup.ts"
import { KilledError, RateLimitError } from "../src/github/api.ts"
import {
  DISCOVERY_RETRY_MS,
  KV_DISCOVERY_LAST_RUN,
  KV_FOLLOWUP_LAST_RUN,
  KV_LAST_SKIP,
  KV_LAST_TICK,
  lastRunAt,
  runningScheduler,
  Scheduler,
  type SchedulerDeps,
  type TickReport,
} from "../src/scheduler/daemon.ts"
import { GITHUB_PAUSED_KEY } from "../src/scheduler/pipeline.ts"
import { DAY, HOUR, MINUTE } from "../src/util/clock.ts"
import type { Logger } from "../src/util/log.ts"
import { FakeLlm, makeTestContext, type TestContext } from "./helpers/fakes.ts"

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0)

// ---------------------------------------------------------------------------
// fixtures + fakes
// ---------------------------------------------------------------------------

const contexts: TestContext[] = []
const schedulers: Scheduler[] = []

afterEach(async () => {
  for (const s of schedulers.splice(0)) await s.stop()
  for (const c of contexts.splice(0)) c.cleanup()
})

function context(opts: Parameters<typeof makeTestContext>[0] = {}): TestContext {
  const ctx = makeTestContext(opts)
  contexts.push(ctx)
  return ctx
}

function repoRecord(fullName = "acme/widget"): RepoRecord {
  return {
    fullName,
    source: "search",
    sourceDetail: null,
    status: "eligible",
    score: 0.8,
    reasons: [],
    skipReason: null,
    policy: null,
    metrics: null,
    discoveredAt: T0,
    screenedAt: T0,
    nextScreenAt: T0 + DAY,
  }
}

function issueRecord(): IssueRecord {
  return {
    id: "acme/widget#42",
    repo: "acme/widget",
    number: 42,
    title: "Crash when options.timeout is 0",
    url: "https://github.com/acme/widget/issues/42",
    body: "steps",
    labels: ["bug"],
    createdAt: "2026-01-05T09:00:00Z",
    updatedAt: "2026-01-10T09:00:00Z",
    comments: 1,
    kind: "bug",
    status: "selected",
    score: 0.8,
    reasons: ["clear"],
    skipReason: null,
    fetchedAt: T0,
  }
}

function taskRecord(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    kind: "contribution",
    repo: "acme/widget",
    issueId: "acme/widget#42",
    prId: null,
    stage: "prepare",
    status: "active",
    attempts: 0,
    failures: 0,
    nextRunAt: T0,
    lastError: null,
    abortReason: null,
    workspace: null,
    branch: null,
    tokensUsed: 0,
    costUsd: 0,
    createdAt: T0,
    updatedAt: T0,
    data: {},
    ...over,
  }
}

interface Calls {
  followup: number
  externalSync: number
  discovery: number
  screening: number
  select: number
  advanced: string[]
  canStart: number
}

function fakeDeps(over: Partial<SchedulerDeps> = {}): { deps: Partial<SchedulerDeps>; calls: Calls } {
  const calls: Calls = { followup: 0, externalSync: 0, discovery: 0, screening: 0, select: 0, advanced: [], canStart: 0 }
  const deps: Partial<SchedulerDeps> = {
    runFollowup: async (): Promise<FollowupReport> => {
      calls.followup++
      return { polled: 2, stateChanges: [], draftedReplies: [], fixTasks: [], errors: [] }
    },
    runExternalPrSync: async (): Promise<FollowupReport> => {
      calls.externalSync++
      return { polled: 0, stateChanges: ["other/lib#9: tracking your open PR (opened outside oss-scout)"], draftedReplies: [], fixTasks: [], errors: [] }
    },
    pruneWorkspaces: () => ({ removed: [] }),
    runDiscovery: async (c): Promise<DiscoveryReport> => {
      calls.discovery++
      c.store.upsertRepoCandidate({ fullName: "acme/widget", source: "search", sourceDetail: null }, c.clock.now())
      return { added: ["acme/widget"], existing: 0, skipped: [], errors: [] }
    },
    runScreening: async () => {
      calls.screening++
      return { screened: [], errors: [] }
    },
    selectNextIssue: async () => {
      calls.select++
      return null
    },
    advanceTask: async (c, task) => {
      calls.advanced.push(task.id)
      const next: TaskRecord = { ...task, stage: "baseline", nextRunAt: c.clock.now() + HOUR }
      c.store.saveTask(next)
      return next
    },
    canStartAnyTask: () => {
      calls.canStart++
      return { ok: true, reason: null }
    },
    ...over,
  }
  return { deps, calls }
}

function scheduler(ctx: AppContext, deps: Partial<SchedulerDeps>, holderId?: string): Scheduler {
  const s = new Scheduler(ctx, { deps, ...(holderId ? { holderId } : {}) })
  schedulers.push(s)
  return s
}

function stepOf(report: TickReport, name: string) {
  return report.steps.find((s) => s.step === name)
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

// ---------------------------------------------------------------------------
// skip reasons
// ---------------------------------------------------------------------------

describe("Scheduler.tick: skip reasons", () => {
  test("kill switch engaged", async () => {
    const ctx = context()
    const { deps, calls } = fakeDeps()
    ctx.kill.engage("panic button", T0)
    const r = await scheduler(ctx, deps).tick({ force: true })
    expect(r.skipped).toContain("kill switch engaged")
    expect(r.skipped).toContain("panic button")
    expect(r.leader).toBe(false)
    expect(r.steps).toHaveLength(0)
    expect(calls.followup + calls.discovery + calls.screening).toBe(0)
    expect(ctx.store.getLease("scheduler")).toBeNull()
  })

  test('mode "off"', async () => {
    const ctx = context({ config: { mode: "off" } })
    const { deps, calls } = fakeDeps()
    const r = await scheduler(ctx, deps).tick({ force: true })
    expect(r.skipped).toBe('mode is "off"')
    expect(calls.discovery).toBe(0)
  })

  test("no read token", async () => {
    const base = context()
    const ctx = { ...base, secrets: { writeToken: () => null, hasReadToken: () => false } } as AppContext
    const { deps, calls } = fakeDeps()
    const r = await scheduler(ctx, deps).tick({ force: true })
    expect(r.skipped).toBe("GITHUB_TOKEN not set")
    expect(calls.followup).toBe(0)
  })

  test("lease contention between two schedulers on one store", async () => {
    const ctx = context()
    const { deps, calls } = fakeDeps()
    const a = scheduler(ctx, deps, "holder-A")
    const b = scheduler(ctx, deps, "holder-B")

    const ra = await a.tick()
    expect(ra.leader).toBe(true)
    expect(ra.skipped).toBeNull()
    expect(ctx.store.getLease("scheduler")?.holder).toBe("holder-A")

    const rb = await b.tick()
    expect(rb.leader).toBe(false)
    expect(rb.skipped).toBe("another oss-scout scheduler holds the lease (holder-A)")
    expect(calls.screening).toBe(1)

    // A renews on its next tick; B takes over once A's lease has expired
    expect((await a.tick()).leader).toBe(true)
    ctx.clock.advance(ctx.config.scheduler.leaseSeconds * 1000 + 1)
    expect((await b.tick()).leader).toBe(true)
    expect((await a.tick()).skipped).toContain("(holder-B)")
  })
})

// ---------------------------------------------------------------------------
// skipped ticks: recorded for status, logged once per reason
// ---------------------------------------------------------------------------

interface LogLine {
  level: "debug" | "info" | "warn" | "error"
  msg: string
  fields?: Record<string, unknown>
}

function recordingLogger(lines: LogLine[]): Logger {
  const log: Logger = {
    debug: (msg, fields) => lines.push({ level: "debug", msg, fields }),
    info: (msg, fields) => lines.push({ level: "info", msg, fields }),
    warn: (msg, fields) => lines.push({ level: "warn", msg, fields }),
    error: (msg, fields) => lines.push({ level: "error", msg, fields }),
    child: () => log,
  }
  return log
}

describe("Scheduler.tick: skipped ticks are recorded", () => {
  test("stores scheduler.lastSkip and logs at info only when the reason first appears or changes", async () => {
    const base = context()
    const lines: LogLine[] = []
    let hasToken = false
    const ctx = {
      ...base,
      log: recordingLogger(lines),
      secrets: { writeToken: () => null, hasReadToken: () => hasToken },
    } as AppContext
    const { deps, calls } = fakeDeps()
    const s = scheduler(ctx, deps)
    const skipLevels = () => lines.filter((l) => l.msg === "scheduler tick skipped").map((l) => l.level)

    expect((await s.tick()).skipped).toBe("GITHUB_TOKEN not set")
    expect(base.store.getKv<unknown>(KV_LAST_SKIP)).toEqual({ at: T0, reason: "GITHUB_TOKEN not set" })
    expect(base.store.getKv<unknown>(KV_LAST_TICK)).toBeNull()

    base.clock.advance(10_000)
    await s.tick()
    await s.tick()
    expect(base.store.getKv<unknown>(KV_LAST_SKIP)).toEqual({ at: T0 + 10_000, reason: "GITHUB_TOKEN not set" })
    expect(skipLevels()).toEqual(["info", "debug", "debug"])
    expect(lines.find((l) => l.level === "info")!.fields).toEqual({ reason: "GITHUB_TOKEN not set" })

    // a different reason is logged at info, and so is the old one when it comes back
    base.kill.engage("maintenance", T0)
    expect((await s.tick()).skipped).toContain("kill switch engaged")
    expect((base.store.getKv<unknown>(KV_LAST_SKIP) as { reason: string }).reason).toContain("maintenance")
    base.kill.release()
    await s.tick()
    expect(skipLevels()).toEqual(["info", "debug", "debug", "info", "info"])

    // a tick that runs resets the dedupe; lastSkip stays for status to compare with lastTickAt
    hasToken = true
    base.clock.advance(10_000)
    const ran = await s.tick()
    expect(ran.leader).toBe(true)
    expect(calls.screening).toBe(1)
    expect(base.store.getKv<unknown>(KV_LAST_TICK)).toBe(T0 + 20_000)
    expect(base.store.getKv<unknown>(KV_LAST_SKIP)).toEqual({ at: T0 + 10_000, reason: "GITHUB_TOKEN not set" })
    expect(lines.some((l) => l.level === "info" && l.msg === "scheduler ticking again")).toBe(true)
    hasToken = false
    await s.tick()
    expect(skipLevels().at(-1)).toBe("info")
  })

  test("a lease held elsewhere is recorded as the skip reason", async () => {
    const ctx = context()
    const { deps } = fakeDeps()
    await scheduler(ctx, deps, "holder-A").tick()
    await scheduler(ctx, deps, "holder-B").tick()
    expect(ctx.store.getKv<unknown>(KV_LAST_SKIP)).toEqual({ at: T0, reason: "another oss-scout scheduler holds the lease (holder-A)" })
  })
})

// ---------------------------------------------------------------------------
// due logic
// ---------------------------------------------------------------------------

describe("Scheduler.tick: due logic", () => {
  test("follow-up and discovery run when due, otherwise not; force overrides", async () => {
    const ctx = context()
    const { deps, calls } = fakeDeps()
    const s = scheduler(ctx, deps)

    // first tick: never ran + empty database
    const r1 = await s.tick()
    expect(calls).toMatchObject({ followup: 1, discovery: 1, screening: 1 })
    expect(stepOf(r1, "followup")).toMatchObject({ ok: true })
    expect(stepOf(r1, "followup")!.detail).toContain("polled 2 PR(s)")
    expect(stepOf(r1, "discovery")!.detail).toContain("1 added")
    expect(ctx.store.getKv<number>(KV_FOLLOWUP_LAST_RUN)).toBe(T0)
    expect(ctx.store.getKv<Record<string, number>>(KV_DISCOVERY_LAST_RUN)).toMatchObject({ at: T0, added: 1 })
    expect(ctx.store.getKv<number>(KV_LAST_TICK)).toBe(T0)

    // immediately again: nothing is due (screening runs every tick)
    const r2 = await s.tick()
    expect(calls).toMatchObject({ followup: 1, discovery: 1, screening: 2 })
    expect(stepOf(r2, "followup")!.detail).toContain("not due until")
    expect(stepOf(r2, "discovery")!.detail).toContain("not due until")

    // after the poll interval: follow-up only
    ctx.clock.advance(ctx.config.followup.pollIntervalMinutes * MINUTE)
    await s.tick()
    expect(calls).toMatchObject({ followup: 2, discovery: 1 })

    // after the discovery interval: both
    ctx.clock.set(T0 + ctx.config.discovery.intervalHours * HOUR)
    await s.tick()
    expect(calls).toMatchObject({ followup: 3, discovery: 2 })

    // force ignores intervals
    await s.tick({ force: true })
    expect(calls).toMatchObject({ followup: 4, discovery: 3 })
  })

  test("a summary written by runDiscovery itself is kept", async () => {
    const ctx = context()
    const { deps } = fakeDeps({
      runDiscovery: async (c) => {
        c.store.setKv(KV_DISCOVERY_LAST_RUN, { at: c.clock.now(), added: 7, existing: 3, skipped: 1, errors: 0 }, c.clock.now())
        return { added: [], existing: 3, skipped: [], errors: [] }
      },
    })
    await scheduler(ctx, deps).tick()
    expect(ctx.store.getKv<Record<string, number>>(KV_DISCOVERY_LAST_RUN)).toEqual({ at: T0, added: 7, existing: 3, skipped: 1, errors: 0 })
    expect(lastRunAt({ at: 5 })).toBe(5)
    expect(lastRunAt(9)).toBe(9)
    expect(lastRunAt("x")).toBeNull()
  })

  test("a failed discovery is retried after an hour, not every tick", async () => {
    const ctx = context()
    let n = 0
    const { deps } = fakeDeps({
      runDiscovery: async () => {
        n++
        throw new Error("search failed: 502")
      },
    })
    const s = scheduler(ctx, deps)
    const r = await s.tick()
    expect(stepOf(r, "discovery")).toMatchObject({ ok: false, detail: "search failed: 502" })
    expect(ctx.store.listErrors()[0]).toMatchObject({ scope: "scheduler.discovery", message: "search failed: 502" })
    expect(stepOf(r, "screening")?.ok).toBe(true) // later steps still run

    ctx.clock.advance(10 * MINUTE)
    await s.tick()
    expect(n).toBe(1)
    ctx.clock.set(T0 + DISCOVERY_RETRY_MS)
    await s.tick()
    expect(n).toBe(2)
  })

  test("follow-up can be disabled; your PRs are still synced for caps and cooldowns", async () => {
    const ctx = context({ config: { followup: { enabled: false } } })
    const { deps, calls } = fakeDeps()
    const s = scheduler(ctx, deps)
    const r = await s.tick({ force: true })
    expect(calls.followup).toBe(0)
    expect(calls.externalSync).toBe(1)
    expect(stepOf(r, "followup")!.detail).toBe("disabled in config; external PR sync: 1 change(s)")

    // GitHub paused: nothing at all
    ctx.store.setKv(GITHUB_PAUSED_KEY, T0 + HOUR, T0)
    const paused = await s.tick({ force: true })
    expect(stepOf(paused, "followup")!.detail).toBe("disabled in config")
    expect(calls.externalSync).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// rate limits, kill switch, tasks
// ---------------------------------------------------------------------------

describe("Scheduler.tick: GitHub pause and tasks", () => {
  test("a paused GitHub skips API steps but still advances due tasks", async () => {
    const ctx = context()
    ctx.store.setKv(GITHUB_PAUSED_KEY, T0 + 10 * MINUTE, T0)
    ctx.store.saveTask(taskRecord("task_due"))
    const { deps, calls } = fakeDeps()
    const r = await scheduler(ctx, deps).tick({ force: true })
    expect(calls).toMatchObject({ followup: 0, discovery: 0, screening: 0, select: 0, advanced: ["task_due"] })
    for (const name of ["followup", "discovery", "screening", "selection"]) {
      expect(stepOf(r, name)!.detail).toContain("GitHub paused until")
    }
    expect(stepOf(r, "task task_due")!.detail).toContain("prepare → baseline")
  })

  test("RateLimitError pauses GitHub and skips the remaining GitHub steps", async () => {
    const ctx = context()
    const resetAt = T0 + 20 * MINUTE
    ctx.store.saveTask(taskRecord("task_due"))
    const { deps, calls } = fakeDeps({
      runScreening: async () => {
        throw new RateLimitError("secondary rate limit", resetAt, "core", true)
      },
    })
    const r = await scheduler(ctx, deps).tick()
    expect(calls).toMatchObject({ followup: 1, discovery: 1, select: 0, advanced: ["task_due"] })
    expect(stepOf(r, "screening")).toMatchObject({ ok: false })
    expect(stepOf(r, "screening")!.detail).toContain("rate limited")
    expect(stepOf(r, "selection")!.detail).toContain("GitHub paused until")
    expect(ctx.store.getKv<number>(GITHUB_PAUSED_KEY)).toBe(resetAt)
    expect(ctx.store.listAudit({ action: "scheduler.pause" })).toHaveLength(1)
  })

  test("KilledError stops the tick", async () => {
    const ctx = context()
    ctx.store.saveTask(taskRecord("task_due"))
    const { deps, calls } = fakeDeps({
      runFollowup: async () => {
        throw new KilledError()
      },
    })
    const r = await scheduler(ctx, deps).tick()
    expect(stepOf(r, "followup")).toMatchObject({ ok: false })
    expect(calls).toMatchObject({ discovery: 0, screening: 0, select: 0, advanced: [] })
    expect(r.steps).toHaveLength(1)
  })

  test("the kill switch engaged mid-tick stops before the next step", async () => {
    const ctx = context()
    const { deps, calls } = fakeDeps({
      runDiscovery: async (c) => {
        c.kill.engage("stop now", c.clock.now())
        return { added: [], existing: 0, skipped: [], errors: [] }
      },
    })
    const r = await scheduler(ctx, deps).tick()
    expect(calls.screening).toBe(0)
    expect(r.steps.at(-1)).toMatchObject({ step: "screening", ok: false })
  })

  test("advances each due task exactly once per tick, sequentially", async () => {
    const ctx = context()
    ctx.store.saveTask(taskRecord("task_a", { nextRunAt: T0 - MINUTE }))
    ctx.store.saveTask(taskRecord("task_b", { status: "waiting", nextRunAt: T0 }))
    ctx.store.saveTask(taskRecord("task_later", { nextRunAt: T0 + HOUR }))
    ctx.store.saveTask(taskRecord("task_done", { status: "done", stage: "done" }))
    let inFlight = 0
    let maxInFlight = 0
    const { deps, calls } = fakeDeps()
    const inner = deps.advanceTask!
    deps.advanceTask = async (c, t, d) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      const out = await inner(c, t, d)
      inFlight--
      return out
    }
    await scheduler(ctx, deps).tick()
    expect(calls.advanced).toEqual(["task_a", "task_b"])
    expect(maxInFlight).toBe(1)
  })

  test("the pipeline receives the injected stage deps", async () => {
    const ctx = context()
    ctx.store.saveTask(taskRecord("task_a"))
    let received: unknown = null
    const marker = async () => {
      throw new Error("not used")
    }
    const { deps } = fakeDeps({
      prepareWorkspace: marker,
      advanceTask: async (_c, t, d) => {
        received = d?.prepareWorkspace
        return t
      },
    })
    await scheduler(ctx, deps).tick()
    expect(received).toBe(marker)
  })
})

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

describe("Scheduler.tick: selection", () => {
  test("does not select when caps forbid new work", async () => {
    const ctx = context()
    const { deps, calls } = fakeDeps({ canStartAnyTask: () => ({ ok: false, reason: "approval queue full: 3 pending item(s) (max 3)" }) })
    const r = await scheduler(ctx, deps).tick()
    expect(calls.select).toBe(0)
    expect(stepOf(r, "selection")!.detail).toContain("approval queue full")
    expect(ctx.store.listTasks()).toHaveLength(0)
  })

  test("starts a contribution task when caps allow and an issue is found", async () => {
    const ctx = context()
    const repo = repoRecord()
    const issue = issueRecord()
    ctx.store.saveRepo(repo)
    ctx.store.upsertIssue(issue)
    const { deps, calls } = fakeDeps({
      selectNextIssue: async () => {
        calls.select++
        return { repo, issue }
      },
    })
    const r = await scheduler(ctx, deps).tick()
    expect(calls.canStart).toBe(1)
    expect(calls.select).toBe(1)
    const tasks = ctx.store.listTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ kind: "contribution", issueId: issue.id, stage: "prepare", status: "active" })
    expect(stepOf(r, "selection")!.detail).toBe(`started ${tasks[0]!.id} for ${issue.id}`)
    expect(ctx.store.listAudit({ action: "task.start" })).toHaveLength(1)
    // the new task is advanced on a later tick, not this one
    expect(calls.advanced).toEqual([])
  })

  test("nothing new is started without an LLM host", async () => {
    const ctx = context({ llm: null })
    const { deps, calls } = fakeDeps()
    const r = await scheduler(ctx, deps).tick()
    expect(calls.select).toBe(0)
    expect(stepOf(r, "selection")!.detail).toContain("no LLM host")
  })

  test("with the default (real) caps, a full approval queue blocks selection", async () => {
    const ctx = context({ llm: new FakeLlm() })
    for (let i = 0; i < ctx.config.caps.maxPendingQueueItems; i++) {
      ctx.store.insertQueueItem({
        kind: "pr",
        status: "pending",
        repo: `acme/r${i}`,
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
        digest: "0123456789abcdef",
        createdAt: T0,
        updatedAt: T0,
        decidedAt: null,
        decisionReason: null,
        submittedUrl: null,
        error: null,
        data: {},
      })
    }
    const { deps, calls } = fakeDeps()
    delete deps.canStartAnyTask
    const r = await scheduler(ctx, deps).tick()
    expect(calls.select).toBe(0)
    expect(stepOf(r, "selection")!.detail).toContain("approval queue full")
  })
})

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

describe("Scheduler lifecycle", () => {
  test("holder ids are unique per instance and include the pid", () => {
    const ctx = context()
    const a = scheduler(ctx, {})
    const b = scheduler(ctx, {})
    expect(a.holderId).toStartWith(`${process.pid}-`)
    expect(a.holderId).not.toBe(b.holderId)
    expect(scheduler(ctx, {}, "fixed").holderId).toBe("fixed")
  })

  test("start/stop with a process-wide single-instance guard", async () => {
    const ctx = context()
    const { deps } = fakeDeps()
    const a = scheduler(ctx, deps, "A")
    const b = scheduler(ctx, deps, "B")

    expect(a.running).toBe(false)
    a.start()
    expect(a.running).toBe(true)
    expect(runningScheduler(ctx.paths.stateDir)).toBe(a)
    a.start() // no-op
    expect(a.running).toBe(true)

    b.start() // refused: another Scheduler runs for this state dir in this process
    expect(b.running).toBe(false)

    await a.tick()
    expect(ctx.store.getLease("scheduler")?.holder).toBe("A")
    await a.stop()
    expect(a.running).toBe(false)
    expect(ctx.store.getLease("scheduler")).toBeNull()
    expect(runningScheduler(ctx.paths.stateDir)).toBeNull()

    b.start()
    expect(b.running).toBe(true)
    await b.stop()
    expect(b.running).toBe(false)
  })

  test("the loop ticks on its own after start()", async () => {
    const ctx = context()
    const { deps, calls } = fakeDeps()
    const s = scheduler(ctx, deps)
    s.start()
    await new Promise((r) => setTimeout(r, 1500))
    expect(calls.screening).toBe(1)
    expect(ctx.store.getKv<number>(KV_LAST_TICK)).toBe(T0)
    await s.stop()
  })

  test("ticks never overlap", async () => {
    const ctx = context()
    const gate = deferred()
    let inFlight = 0
    let maxInFlight = 0
    const { deps, calls } = fakeDeps({
      runScreening: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        if (calls.screening++ === 0) await gate.promise
        inFlight--
        return { screened: [], errors: [] }
      },
    })
    const s = scheduler(ctx, deps)
    const first = s.tick()
    const second = s.tick({ force: true })
    await Promise.resolve()
    gate.resolve()
    const [r1, r2] = await Promise.all([first, second])
    expect(maxInFlight).toBe(1)
    expect(calls.screening).toBe(2)
    expect(r1.leader && r2.leader).toBe(true)
  })

  test("stop() waits for the in-flight tick and then releases the lease", async () => {
    const ctx = context()
    const gate = deferred()
    const { deps } = fakeDeps({
      runScreening: async () => {
        await gate.promise
        return { screened: [], errors: [] }
      },
    })
    const s = scheduler(ctx, deps, "A")
    s.start()
    const ticking = s.tick()
    await new Promise((r) => setTimeout(r, 10))
    let stopped = false
    const stopping = s.stop().then(() => (stopped = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(stopped).toBe(false)
    expect(ctx.store.getLease("scheduler")?.holder).toBe("A")
    gate.resolve()
    await stopping
    await ticking
    expect(stopped).toBe(true)
    expect(ctx.store.getLease("scheduler")).toBeNull()
    expect(s.running).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// interrupting the in-flight stage
// ---------------------------------------------------------------------------

/** Resolves when the signal aborts, or after `maxMs` at the latest (a missing abort fails the test instead of hanging the run). */
function waitForAbort(signal?: AbortSignal, maxMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) return resolve()
    const timer = setTimeout(resolve, maxMs)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

describe("Scheduler: interrupting the in-flight stage", () => {
  test("stop() aborts the running stage (instead of waiting hours for it), then releases lease and claim", async () => {
    const ctx = context()
    ctx.store.saveTask(taskRecord("task_long"))
    let received: { signal?: AbortSignal; holder?: string } | undefined
    const started = deferred()
    const { deps } = fakeDeps({
      advanceTask: async (_c, t, _d, opts) => {
        received = opts
        started.resolve()
        await waitForAbort(opts?.signal)
        return t
      },
    })
    const s = scheduler(ctx, deps, "A")
    const ticking = s.tick()
    await started.promise
    expect(received?.holder).toBe("A")
    expect(received?.signal?.aborted).toBe(false)
    expect(ctx.store.taskClaimHolder("task_long")).toBe("A")
    await s.stop()
    expect(received?.signal?.aborted).toBe(true)
    await ticking
    expect(ctx.store.getLease("scheduler")).toBeNull()
    expect(ctx.store.taskClaimHolder("task_long")).toBeNull()
  })

  test("engaging the kill switch aborts the running stage within the poll interval", async () => {
    const ctx = context()
    ctx.store.saveTask(taskRecord("task_long"))
    let reason: unknown = null
    const { deps } = fakeDeps({
      advanceTask: async (c, t, _d, opts) => {
        c.kill.engage("stop spending", c.clock.now())
        await waitForAbort(opts?.signal)
        reason = opts?.signal?.reason
        return t
      },
    })
    const s = new Scheduler(ctx, { deps, killPollMs: 10 })
    schedulers.push(s)
    const r = await s.tick()
    expect((reason as Error).message).toBe("kill switch engaged")
    expect(r.steps.at(-1)).toMatchObject({ ok: false, detail: "kill switch engaged; stopping tick" })
  })

  test("a failed lease renewal (another scheduler took over after a sleep) aborts the running stage", async () => {
    const ctx = context()
    ctx.store.saveTask(taskRecord("task_long"))
    let reason: unknown = null
    const { deps } = fakeDeps({
      advanceTask: async (c, t, _d, opts) => {
        ctx.clock.advance(c.config.scheduler.leaseSeconds * 1000 + 1)
        expect(c.store.tryAcquireLease("scheduler", "B", 300_000, c.clock.now())).toBe(true)
        await waitForAbort(opts?.signal)
        reason = opts?.signal?.reason
        return t
      },
    })
    const s = new Scheduler(ctx, { deps, heartbeatMs: 10, holderId: "A" })
    schedulers.push(s)
    const r = await s.tick()
    expect((reason as Error).message).toBe("lost the scheduler lease")
    expect(r.steps.at(-1)!.detail).toContain("tick ended early")
    expect(ctx.store.getLease("scheduler")?.holder).toBe("B")
  })

  test("a task claimed by another scheduler is skipped; claims are released after each stage", async () => {
    const ctx = context()
    ctx.store.saveTask(taskRecord("task_a"))
    ctx.store.saveTask(taskRecord("task_b"))
    ctx.store.claimTask("task_b", "other", 60_000, T0)
    const { deps, calls } = fakeDeps()
    const r = await scheduler(ctx, deps, "A").tick()
    expect(calls.advanced).toEqual(["task_a"])
    expect(stepOf(r, "task task_b")!.detail).toContain("claimed by another oss-scout scheduler")
    expect(ctx.store.taskClaimHolder("task_a")).toBeNull()
    expect(ctx.store.taskClaimHolder("task_b")).toBe("other")
  })
})

// ---------------------------------------------------------------------------
// housekeeping
// ---------------------------------------------------------------------------

function queueRow(over: Partial<Omit<QueueItem, "id">> = {}): Omit<QueueItem, "id"> {
  return {
    kind: "pr",
    status: "pending",
    repo: "acme/widget",
    issueUrl: "https://github.com/acme/widget/issues/42",
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
    digest: "0123456789abcdef",
    createdAt: T0,
    updatedAt: T0,
    decidedAt: null,
    decisionReason: null,
    submittedUrl: null,
    error: null,
    data: {},
    ...over,
  }
}

describe("Scheduler.tick: maintenance", () => {
  test("once per day: prunes old workspaces (keeping those still needed), the HTTP cache and the audit log", async () => {
    const ctx = context()
    ctx.store.saveTask(taskRecord("task_running", { nextRunAt: T0 + HOUR, data: { reuseTaskId: "task_orig" } }))
    ctx.store.insertQueueItem(queueRow({ taskId: "task_queued", data: { workspaceTaskId: "task_ws" } }))
    const submitted = ctx.store.insertQueueItem(queueRow({ status: "submitted", taskId: "task_pr", repo: "acme/other" }))
    ctx.store.upsertPr({
      id: "acme/other#5",
      repo: "acme/other",
      number: 5,
      url: "https://github.com/acme/other/pull/5",
      queueItemId: submitted.id,
      branch: null,
      headRepo: null,
      state: "open",
      openedAt: T0,
      closedAt: null,
      mergedAt: null,
      lastPolledAt: null,
      lastSeenActivityAt: null,
      data: {},
    })
    ctx.store.insertQueueItem(queueRow({ status: "rejected", taskId: "task_rejected" }))
    ctx.store.setHttpCache("GET old", { etag: null, lastModified: null, body: "" }, T0 - 15 * DAY)
    ctx.store.setHttpCache("GET new", { etag: null, lastModified: null, body: "" }, T0 - DAY)
    let seen: { keepTaskIds: Set<string>; olderThanMs: number } | null = null
    const { deps } = fakeDeps({
      pruneWorkspaces: (_c, opts) => {
        seen = opts
        return { removed: ["task_rejected"] }
      },
    })
    const s = scheduler(ctx, deps)
    const r = await s.tick()
    expect([...seen!.keepTaskIds].sort()).toEqual(["task_orig", "task_pr", "task_queued", "task_running", "task_ws"])
    expect(seen!.olderThanMs).toBe(7 * DAY)
    expect(stepOf(r, "maintenance")!.detail).toContain("pruned 1 workspace(s), 1 cached response(s), 0 audit row(s)")
    expect(ctx.store.getHttpCache("GET old")).toBeNull()
    expect(ctx.store.getHttpCache("GET new")).not.toBeNull()
    expect(ctx.store.listAudit({ action: "maintenance.prune" })[0]!.details.workspaces).toEqual(["task_rejected"])

    seen = null
    ctx.clock.advance(HOUR)
    await s.tick()
    expect(seen).toBeNull()
    ctx.clock.advance(DAY)
    await s.tick()
    expect(seen).not.toBeNull()
  })

  test("open queue items whose repo is no longer allowed are superseded; the issue is never picked again", async () => {
    const ctx = context({ config: { repos: { deny: ["acme/*"] } } })
    ctx.store.upsertIssue(issueRecord())
    const blocked = ctx.store.insertQueueItem(queueRow({ data: { issueId: "acme/widget#42" } }))
    const fine = ctx.store.insertQueueItem(queueRow({ repo: "other/lib", issueUrl: null }))
    const { deps } = fakeDeps()
    const r = await scheduler(ctx, deps).tick()
    expect(stepOf(r, "maintenance")!.detail).toContain("superseded 1 queue item(s)")
    expect(ctx.store.getQueueItem(blocked.id)!.status).toBe("superseded")
    expect(ctx.store.getQueueItem(fine.id)!.status).toBe("pending")
    expect(ctx.store.getIssue("acme/widget#42")!.status).toBe("skipped")
    expect(ctx.store.isIssueSticky("acme/widget#42")).toBe(true)
  })
})
