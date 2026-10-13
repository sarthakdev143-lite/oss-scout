import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IssueRecord, QueueItem, RepoRecord, TaskRecord, TrackedPr } from "../src/core/types.ts"
import { openDatabase, SCHEMA_VERSION } from "../src/state/db.ts"
import { Store } from "../src/state/store.ts"
import { clearRegisteredSecrets, registerSecret } from "../src/util/redact.ts"

const SECRET = "very-private-secret-value-0042"
const GH_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function repo(over: Partial<RepoRecord> = {}): RepoRecord {
  return {
    fullName: "acme/widget",
    source: "dependency",
    sourceDetail: "npm:widget (used by me/app)",
    status: "eligible",
    score: 0.8,
    reasons: ["active maintainers", "CI present"],
    skipReason: null,
    policy: {
      ai: { classification: "none_found", evidence: [], requiresDisclosure: false, notes: [] },
      contributingFile: "CONTRIBUTING.md",
      contributingExcerpt: "Be nice",
      codeOfConductFile: null,
      prTemplatePath: ".github/pull_request_template.md",
      prTemplate: "## Summary",
      requiresSignoff: true,
      requiresCla: false,
      requiresIssueFirst: false,
      reservesGoodFirstIssues: false,
      commitConvention: "conventional",
      notes: ["note"],
    },
    metrics: null,
    discoveredAt: 1000,
    screenedAt: 2000,
    nextScreenAt: 5000,
    ...over,
  }
}

function issue(over: Partial<IssueRecord> = {}): IssueRecord {
  const number = over.number ?? 42
  const repoName = over.repo ?? "acme/widget"
  return {
    id: `${repoName}#${number}`,
    repo: repoName,
    number,
    title: "Crash on zero timeout",
    url: `https://github.com/${repoName}/issues/${number}`,
    body: "steps",
    labels: ["bug", "good first issue"],
    createdAt: "2026-01-05T09:00:00Z",
    updatedAt: "2026-01-10T09:00:00Z",
    comments: 2,
    kind: "bug",
    status: "candidate",
    score: 0.7,
    reasons: ["clear repro"],
    skipReason: null,
    fetchedAt: 3000,
    ...over,
  }
}

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    kind: "contribution",
    repo: "acme/widget",
    issueId: "acme/widget#42",
    prId: null,
    stage: "prepare",
    status: "active",
    attempts: 0,
    failures: 0,
    nextRunAt: 1000,
    lastError: null,
    abortReason: null,
    workspace: "/tmp/ws/task_1",
    branch: "oss-scout/42-crash",
    tokensUsed: 0,
    costUsd: 0,
    createdAt: 100,
    updatedAt: 100,
    data: { baseBranch: "main", attemptsLog: [], nested: { list: [1, 2, 3] } },
    ...over,
  }
}

function queueItem(over: Partial<Omit<QueueItem, "id">> = {}): Omit<QueueItem, "id"> {
  return {
    kind: "pr",
    status: "pending",
    repo: "acme/widget",
    issueUrl: "https://github.com/acme/widget/issues/42",
    prUrl: null,
    taskId: "task_1",
    title: "fix: handle zero timeout",
    body: "Body. Prepared with AI assistance.",
    diff: "diff --git a/x b/x",
    testOutput: "ok 1 tests",
    critic: { verdict: "approve", confidence: 0.9, reasons: ["small"], requiredChanges: [], model: "p/m", raw: "{}" },
    verification: { passed: true, checks: [{ name: "tests", status: "pass", detail: "1 passed" }] },
    branch: "oss-scout/42-crash",
    workspace: "/tmp/ws/task_1",
    baseBranch: "main",
    digest: "abcdef0123456789",
    createdAt: 100,
    updatedAt: 100,
    decidedAt: null,
    decisionReason: null,
    submittedUrl: null,
    error: null,
    data: { cla: false, plannedActions: ["fork", "push"] },
    ...over,
  }
}

function trackedPr(over: Partial<TrackedPr> = {}): TrackedPr {
  return {
    id: "acme/widget#101",
    repo: "acme/widget",
    number: 101,
    url: "https://github.com/acme/widget/pull/101",
    queueItemId: 1,
    branch: "oss-scout/42-crash",
    headRepo: "me/widget",
    state: "open",
    openedAt: 1000,
    closedAt: null,
    mergedAt: null,
    lastPolledAt: null,
    lastSeenActivityAt: null,
    data: { reviews: 0 },
    ...over,
  }
}

let store: Store

beforeEach(() => {
  store = new Store(openDatabase(":memory:"))
})

afterEach(() => {
  clearRegisteredSecrets()
  try {
    store.db.close()
  } catch {}
})

// ---------------------------------------------------------------------------
// repos
// ---------------------------------------------------------------------------

describe("repos", () => {
  test("upsertRepoCandidate inserts once and never overwrites (case-insensitive)", () => {
    const a = store.upsertRepoCandidate({ fullName: "Acme/Widget", source: "search", sourceDetail: "search: topic:react" }, 10)
    expect(a.created).toBe(true)
    expect(a.repo).toMatchObject({
      fullName: "Acme/Widget",
      status: "candidate",
      reasons: [],
      score: null,
      policy: null,
      metrics: null,
      discoveredAt: 10,
      nextScreenAt: 10,
    })
    const b = store.upsertRepoCandidate({ fullName: "acme/widget", source: "dependency", sourceDetail: "npm:x" }, 99)
    expect(b.created).toBe(false)
    expect(b.repo.source).toBe("search")
    expect(store.getRepo("ACME/WIDGET")?.fullName).toBe("Acme/Widget")
  })

  test("saveRepo round-trips JSON columns and updates on conflict", () => {
    const rec = repo()
    store.saveRepo(rec)
    expect(store.getRepo("acme/widget")).toEqual(rec)
    const updated = repo({ status: "skipped", skipReason: "archived", score: 0.1, reasons: ["archived"], policy: null, nextScreenAt: null })
    store.saveRepo(updated)
    expect(store.getRepo("acme/widget")).toEqual(updated)
    expect(store.getRepo("nobody/here")).toBeNull()
  })

  test("listRepos filters by status, due time, limit and orders by score", () => {
    store.saveRepo(repo({ fullName: "a/one", status: "eligible", score: 0.5, nextScreenAt: 100, discoveredAt: 3 }))
    store.saveRepo(repo({ fullName: "a/two", status: "eligible", score: 0.9, nextScreenAt: 900, discoveredAt: 1 }))
    store.saveRepo(repo({ fullName: "a/three", status: "candidate", score: null, nextScreenAt: null, discoveredAt: 2 }))
    store.saveRepo(repo({ fullName: "a/four", status: "skipped", score: 0.2, nextScreenAt: 50, discoveredAt: 4 }))

    expect(store.listRepos().map((r) => r.fullName)).toEqual(["a/two", "a/three", "a/one", "a/four"])
    expect(store.listRepos({ status: "eligible", orderBy: "score" }).map((r) => r.fullName)).toEqual(["a/two", "a/one"])
    expect(store.listRepos({ status: ["eligible", "candidate"], orderBy: "score" }).map((r) => r.fullName)).toEqual([
      "a/two",
      "a/one",
      "a/three",
    ])
    expect(store.listRepos({ dueForScreenAt: 500 }).map((r) => r.fullName).sort()).toEqual(["a/four", "a/one", "a/three"])
    expect(store.listRepos({ orderBy: "score", limit: 2 }).map((r) => r.fullName)).toEqual(["a/two", "a/one"])
    expect(store.countRepos()).toEqual({ candidate: 1, eligible: 2, skipped: 1 })
  })
})

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

describe("issues", () => {
  test("upsertIssue round-trips and updates fields", () => {
    const rec = issue()
    store.upsertIssue(rec)
    expect(store.getIssue(rec.id)).toEqual(rec)
    store.upsertIssue(issue({ title: "New title", comments: 5, labels: ["docs"] }))
    expect(store.getIssue(rec.id)).toMatchObject({ title: "New title", comments: 5, labels: ["docs"] })
  })

  test("selected and done issues keep their status unless forced", () => {
    store.upsertIssue(issue({ status: "selected" }))
    store.upsertIssue(issue({ status: "candidate", score: 0.1 }))
    expect(store.getIssue("acme/widget#42")).toMatchObject({ status: "selected", score: 0.1 })

    store.setIssueStatus("acme/widget#42", "done")
    store.upsertIssue(issue({ status: "skipped", skipReason: "stale" }))
    expect(store.getIssue("acme/widget#42")?.status).toBe("done")

    store.upsertIssue(issue({ status: "candidate" }), { force: true })
    expect(store.getIssue("acme/widget#42")?.status).toBe("candidate")

    store.upsertIssue(issue({ status: "skipped", skipReason: "claimed" }))
    expect(store.getIssue("acme/widget#42")).toMatchObject({ status: "skipped", skipReason: "claimed" })
  })

  test("setIssueStatus sets and clears skip reasons", () => {
    store.upsertIssue(issue())
    store.setIssueStatus("acme/widget#42", "skipped", "has linked PR")
    expect(store.getIssue("acme/widget#42")).toMatchObject({ status: "skipped", skipReason: "has linked PR" })
    store.setIssueStatus("acme/widget#42", "candidate")
    expect(store.getIssue("acme/widget#42")).toMatchObject({ status: "candidate", skipReason: null })
  })

  test("listIssues filters by repo, status, min score, limit; ordered by score", () => {
    store.upsertIssue(issue({ number: 1, score: 0.4 }))
    store.upsertIssue(issue({ number: 2, score: 0.9 }))
    store.upsertIssue(issue({ number: 3, score: null, status: "skipped" }))
    store.upsertIssue(issue({ repo: "other/repo", number: 4, score: 0.95 }))
    expect(store.listIssues({ repo: "acme/widget" }).map((i) => i.number)).toEqual([2, 1, 3])
    expect(store.listIssues({ status: "candidate" }).map((i) => i.number)).toEqual([4, 2, 1])
    expect(store.listIssues({ status: ["skipped"] }).map((i) => i.number)).toEqual([3])
    expect(store.listIssues({ minScore: 0.5 }).map((i) => i.number)).toEqual([4, 2])
    expect(store.listIssues({ limit: 1 }).map((i) => i.number)).toEqual([4])
  })
})

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

describe("tasks", () => {
  test("saveTask round-trips data JSON and updates on conflict", () => {
    const rec = task()
    store.saveTask(rec)
    expect(store.getTask("task_1")).toEqual(rec)
    const next = task({ stage: "implement", status: "waiting", attempts: 2, failures: 1, tokensUsed: 1234, costUsd: 0.5, updatedAt: 200, data: { sessionId: "ses_1" } })
    store.saveTask(next)
    expect(store.getTask("task_1")).toEqual(next)
    expect(store.getTask("missing")).toBeNull()
  })

  test("errors and data are redacted before persisting", () => {
    registerSecret(SECRET)
    store.saveTask(
      task({
        lastError: `push failed with ${SECRET}`,
        abortReason: `token ${GH_TOKEN} rejected`,
        data: { log: `Authorization: Bearer ${SECRET}`, writeToken: "abc", fine: "ok" },
      }),
    )
    const t = store.getTask("task_1")!
    expect(t.lastError).toBe("push failed with [REDACTED]")
    expect(t.abortReason).toBe("token [REDACTED] rejected")
    expect(t.data).toEqual({ log: "Authorization: Bearer [REDACTED]", writeToken: "[REDACTED]", fine: "ok" })
    const raw = JSON.stringify(store.db.query("SELECT * FROM tasks").all())
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain(GH_TOKEN)
  })

  test("listTasks filters by status, kind, repo, due time and limit", () => {
    store.saveTask(task({ id: "t1", nextRunAt: 300, status: "active" }))
    store.saveTask(task({ id: "t2", nextRunAt: 100, status: "waiting" }))
    store.saveTask(task({ id: "t3", nextRunAt: 200, status: "done", kind: "followup_fix", repo: "other/repo" }))
    store.saveTask(task({ id: "t4", nextRunAt: 50, status: "aborted" }))
    expect(store.listTasks().map((t) => t.id)).toEqual(["t4", "t2", "t3", "t1"])
    expect(store.listTasks({ status: ["active", "waiting"] }).map((t) => t.id)).toEqual(["t2", "t1"])
    expect(store.listTasks({ status: "active", dueAt: 250 }).map((t) => t.id)).toEqual([])
    expect(store.listTasks({ dueAt: 250 }).map((t) => t.id)).toEqual(["t4", "t2", "t3"])
    expect(store.listTasks({ kind: "followup_fix" }).map((t) => t.id)).toEqual(["t3"])
    expect(store.listTasks({ repo: "acme/widget", limit: 2 }).map((t) => t.id)).toEqual(["t4", "t2"])
    expect(store.listTasks({ repo: "ACME/WIDGET" })).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------

describe("approval queue", () => {
  test("insert assigns ids and round-trips JSON columns", () => {
    const a = store.insertQueueItem(queueItem())
    const b = store.insertQueueItem(queueItem({ kind: "reply", critic: null, verification: null, diff: "" }))
    expect(b.id).toBe(a.id + 1)
    const { id, ...rest } = a
    expect(rest).toEqual(queueItem())
    expect(store.getQueueItem(b.id)).toMatchObject({ kind: "reply", critic: null, verification: null })
    expect(store.getQueueItem(9999)).toBeNull()
  })

  test("saveQueueItem updates every field", () => {
    const item = store.insertQueueItem(queueItem())
    const changed: QueueItem = {
      ...item,
      status: "submitted",
      decidedAt: 500,
      decisionReason: "looks good",
      submittedUrl: "https://github.com/acme/widget/pull/101",
      prUrl: "https://github.com/acme/widget/pull/101",
      updatedAt: 600,
      data: { plannedActions: [] },
    }
    store.saveQueueItem(changed)
    expect(store.getQueueItem(item.id)).toEqual(changed)
  })

  test("test output, error and data are redacted", () => {
    registerSecret(SECRET)
    const item = store.insertQueueItem(
      queueItem({ testOutput: `env SECRET=${SECRET}`, error: `failed: ${GH_TOKEN}`, data: { note: SECRET, apiKey: "xyz" } }),
    )
    expect(item.testOutput).toBe("env SECRET=[REDACTED]")
    expect(item.error).toBe("failed: [REDACTED]")
    expect(item.data).toEqual({ note: "[REDACTED]", apiKey: "[REDACTED]" })
  })

  test("listQueue filters and countQueue counts every status", () => {
    store.insertQueueItem(queueItem())
    store.insertQueueItem(queueItem({ status: "approved", repo: "other/repo" }))
    store.insertQueueItem(queueItem({ kind: "reply", status: "pending" }))
    store.insertQueueItem(queueItem({ status: "rejected" }))
    expect(store.listQueue().map((q) => q.id)).toEqual([1, 2, 3, 4])
    expect(store.listQueue({ status: "pending" }).map((q) => q.id)).toEqual([1, 3])
    expect(store.listQueue({ status: ["approved", "rejected"] }).map((q) => q.id)).toEqual([2, 4])
    expect(store.listQueue({ repo: "other/repo" }).map((q) => q.id)).toEqual([2])
    expect(store.listQueue({ kind: "reply" }).map((q) => q.id)).toEqual([3])
    expect(store.listQueue({ limit: 2 }).map((q) => q.id)).toEqual([1, 2])
    expect(store.countQueue()).toEqual({ pending: 2, approved: 1, submitted: 0, rejected: 1, failed: 0, superseded: 0 })
  })
})

// ---------------------------------------------------------------------------
// tracked PRs
// ---------------------------------------------------------------------------

describe("tracked PRs", () => {
  test("upsertPr round-trips and keeps known branch/head/queue id when later updates omit them", () => {
    const pr = trackedPr()
    store.upsertPr(pr)
    expect(store.getPr(pr.id)).toEqual(pr)
    store.upsertPr(
      trackedPr({ queueItemId: null, branch: null, headRepo: null, state: "merged", mergedAt: 9000, closedAt: 9000, lastPolledAt: 9100, lastSeenActivityAt: "2026-01-20T00:00:00Z", data: { reviews: 2 } }),
    )
    expect(store.getPr(pr.id)).toEqual(
      trackedPr({ state: "merged", mergedAt: 9000, closedAt: 9000, lastPolledAt: 9100, lastSeenActivityAt: "2026-01-20T00:00:00Z", data: { reviews: 2 } }),
    )
    expect(store.getPr("ACME/WIDGET#101")?.number).toBe(101)
    expect(store.getPr("x/y#1")).toBeNull()
  })

  test("listPrs filters by state and repo, ordered by openedAt", () => {
    store.upsertPr(trackedPr({ id: "a/b#2", repo: "a/b", number: 2, openedAt: 20 }))
    store.upsertPr(trackedPr({ id: "a/b#1", repo: "a/b", number: 1, openedAt: 10, state: "closed" }))
    store.upsertPr(trackedPr({ id: "c/d#3", repo: "c/d", number: 3, openedAt: 30, state: "merged" }))
    expect(store.listPrs().map((p) => p.id)).toEqual(["a/b#1", "a/b#2", "c/d#3"])
    expect(store.listPrs({ state: "open" }).map((p) => p.id)).toEqual(["a/b#2"])
    expect(store.listPrs({ state: ["closed", "merged"] }).map((p) => p.id)).toEqual(["a/b#1", "c/d#3"])
    expect(store.listPrs({ repo: "a/b" }).map((p) => p.id)).toEqual(["a/b#1", "a/b#2"])
  })
})

// ---------------------------------------------------------------------------
// audit + errors
// ---------------------------------------------------------------------------

describe("audit and errors", () => {
  test("audit entries round-trip and filter", () => {
    store.audit({ ts: 10, actor: "scout", action: "repo.skip", subject: "a/b", decision: "skip", reasons: ["archived"], details: { score: 0.1 } })
    store.audit({ ts: 20, actor: "human", action: "queue.approve", subject: "queue:1", decision: "approve" })
    store.audit({ ts: 30, actor: "scout", action: "repo.screen", subject: "a/b", decision: "eligible" })
    const all = store.listAudit()
    expect(all.map((a) => a.ts)).toEqual([30, 20, 10])
    expect(all[2]).toMatchObject({ actor: "scout", action: "repo.skip", subject: "a/b", decision: "skip", reasons: ["archived"], details: { score: 0.1 } })
    expect(all[1]).toMatchObject({ reasons: [], details: {} })
    expect(store.listAudit({ action: "queue.approve" }).map((a) => a.ts)).toEqual([20])
    expect(store.listAudit({ actionPrefix: "repo." }).map((a) => a.ts)).toEqual([30, 10])
    expect(store.listAudit({ subject: "a/b", sinceTs: 15 }).map((a) => a.ts)).toEqual([30])
    expect(store.listAudit({ limit: 1 }).map((a) => a.ts)).toEqual([30])
  })

  test("audit redacts registered secrets, token shapes and secret-looking keys", () => {
    registerSecret(SECRET)
    store.audit({
      ts: 1,
      actor: "system",
      action: "github.write",
      subject: null,
      decision: null,
      reasons: [`used ${SECRET}`, `and ${GH_TOKEN}`],
      details: { header: `Authorization: Bearer ${SECRET}`, password: "hunter22", nested: { msg: SECRET } },
    })
    const [e] = store.listAudit()
    expect(e!.reasons).toEqual(["used [REDACTED]", "and [REDACTED]"])
    expect(e!.details).toEqual({ header: "Authorization: Bearer [REDACTED]", password: "[REDACTED]", nested: { msg: "[REDACTED]" } })
    expect(JSON.stringify(store.db.query("SELECT * FROM audit").all())).not.toContain(SECRET)
  })

  test("recordError redacts and keeps the table bounded", () => {
    registerSecret(SECRET)
    store.recordError("github", `request failed ${SECRET}`, { token: SECRET, url: `https://x:${SECRET}@github.com` }, 5)
    const [e] = store.listErrors()
    expect(e).toMatchObject({ ts: 5, scope: "github", message: "request failed [REDACTED]" })
    expect(JSON.stringify(e!.details)).not.toContain(SECRET)
    for (let i = 0; i < 510; i++) store.recordError("loop", `e${i}`, {}, i)
    const count = store.db.query("SELECT COUNT(*) AS n FROM errors").get() as { n: number }
    expect(count.n).toBe(500)
    expect(store.listErrors(3).map((x) => x.message)).toEqual(["e509", "e508", "e507"])
  })
})

// ---------------------------------------------------------------------------
// usage, kv, leases, http cache, transactions
// ---------------------------------------------------------------------------

describe("usage", () => {
  test("accumulates per day; negative values are clamped; tokens rounded", () => {
    expect(store.getUsage("2026-01-15")).toEqual({ tokens: 0, costUsd: 0, calls: 0 })
    store.addUsage("2026-01-15", 1000.4, 0.25)
    store.addUsage("2026-01-15", 500, 0.5)
    store.addUsage("2026-01-15", -50, -1)
    store.addUsage("2026-01-16", 7, 0.01)
    const day = store.getUsage("2026-01-15")
    expect(day.tokens).toBe(1500)
    expect(day.costUsd).toBeCloseTo(0.75, 10)
    expect(day.calls).toBe(3)
    expect(store.getUsage("2026-01-16")).toEqual({ tokens: 7, costUsd: 0.01, calls: 1 })
  })
})

describe("kv", () => {
  test("set/get/overwrite/delete JSON values", () => {
    expect(store.getKv("missing")).toBeNull()
    store.setKv("cursor", { page: 2, seen: ["a/b"] }, 1)
    expect(store.getKv<{ page: number; seen: string[] }>("cursor")).toEqual({ page: 2, seen: ["a/b"] })
    store.setKv("cursor", 5, 2)
    expect(store.getKv<number>("cursor")).toBe(5)
    store.setKv("flag", false, 3)
    expect(store.getKv<boolean>("flag")).toBe(false)
    store.setKv("nothing", null, 3)
    expect(store.getKv("nothing")).toBeNull()
    store.deleteKv("cursor")
    expect(store.getKv("cursor")).toBeNull()
  })
})

describe("leases", () => {
  test("holder semantics, renewal, expiry and release", () => {
    expect(store.tryAcquireLease("scheduler", "a", 1000, 0)).toBe(true)
    expect(store.getLease("scheduler")).toEqual({ holder: "a", expiresAt: 1000 })
    expect(store.tryAcquireLease("scheduler", "b", 1000, 500)).toBe(false)
    expect(store.tryAcquireLease("scheduler", "a", 1000, 600)).toBe(true)
    expect(store.getLease("scheduler")).toEqual({ holder: "a", expiresAt: 1600 })
    expect(store.tryAcquireLease("scheduler", "b", 1000, 1599)).toBe(false)
    expect(store.tryAcquireLease("scheduler", "b", 1000, 1600)).toBe(true)
    expect(store.getLease("scheduler")?.holder).toBe("b")
    store.releaseLease("scheduler", "a")
    expect(store.getLease("scheduler")?.holder).toBe("b")
    store.releaseLease("scheduler", "b")
    expect(store.getLease("scheduler")).toBeNull()
    expect(store.tryAcquireLease("scheduler", "a", 10, 2000)).toBe(true)
    expect(store.tryAcquireLease("other", "b", 10, 2000)).toBe(true)
  })
})

describe("http cache", () => {
  test("set/get/overwrite/prune", () => {
    expect(store.getHttpCache("GET https://api.github.com/x")).toBeNull()
    store.setHttpCache("GET https://api.github.com/x", { etag: '"1"', lastModified: null, body: "{}" }, 100)
    expect(store.getHttpCache("GET https://api.github.com/x")).toEqual({ etag: '"1"', lastModified: null, body: "{}", fetchedAt: 100 })
    store.setHttpCache("GET https://api.github.com/x", { etag: null, lastModified: "Mon", body: "[1]" }, 200)
    expect(store.getHttpCache("GET https://api.github.com/x")).toEqual({ etag: null, lastModified: "Mon", body: "[1]", fetchedAt: 200 })
    store.setHttpCache("GET https://api.github.com/old", { etag: '"o"', lastModified: null, body: "" }, 50)
    store.pruneHttpCache(150)
    expect(store.getHttpCache("GET https://api.github.com/old")).toBeNull()
    expect(store.getHttpCache("GET https://api.github.com/x")).not.toBeNull()
  })
})

describe("transactions", () => {
  test("roll back every write when the callback throws", () => {
    expect(() =>
      store.transaction(() => {
        store.setKv("a", 1, 1)
        store.saveRepo(repo())
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(store.getKv("a")).toBeNull()
    expect(store.getRepo("acme/widget")).toBeNull()
    expect(store.transaction(() => (store.setKv("b", 2, 1), 42))).toBe(42)
    expect(store.getKv<number>("b")).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// persistence + migrations
// ---------------------------------------------------------------------------

describe("file database", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oss-scout-db-"))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  test("data persists across close/reopen; migrations are idempotent", () => {
    const file = join(dir, "nested", "state.db")
    const db1 = openDatabase(file)
    const s1 = new Store(db1)
    s1.saveRepo(repo())
    s1.saveTask(task())
    s1.setKv("k", { v: 1 }, 1)
    const qi = s1.insertQueueItem(queueItem())
    db1.close()

    const db2 = openDatabase(file)
    const s2 = new Store(db2)
    expect(s2.getRepo("acme/widget")).toEqual(repo())
    expect(s2.getTask("task_1")).toEqual(task())
    expect(s2.getKv<{ v: number }>("k")).toEqual({ v: 1 })
    expect(s2.getQueueItem(qi.id)?.title).toBe(qi.title)
    const version = db2.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
    expect(Number(version.value)).toBe(SCHEMA_VERSION)
    const metaRows = db2.query("SELECT COUNT(*) AS n FROM meta").get() as { n: number }
    expect(metaRows.n).toBe(1)
    db2.close()

    const db3 = openDatabase(file)
    expect(new Store(db3).getRepo("acme/widget")?.fullName).toBe("acme/widget")
    db3.close()
  })

  test("refuses a database from a newer schema version", () => {
    const file = join(dir, "future.db")
    const db = openDatabase(file)
    db.query("UPDATE meta SET value = $v WHERE key = 'schema_version'").run({ v: String(SCHEMA_VERSION + 5) })
    db.close()
    expect(() => openDatabase(file)).toThrow(/newer than this build supports/)
  })

  test("in-memory databases are independent", () => {
    const other = new Store(openDatabase(":memory:"))
    store.setKv("x", 1, 1)
    expect(other.getKv("x")).toBeNull()
    other.db.close()
  })
})

// ---------------------------------------------------------------------------
// sticky issue decisions, task claims, pruning, raw diffs, migration v2
// ---------------------------------------------------------------------------

describe("sticky issue decisions", () => {
  test("a sticky skip survives candidate refreshes (even forced ones); descriptive fields still update", () => {
    store.upsertIssue(issue({ status: "selected" }))
    expect(store.isIssueSticky("acme/widget#42")).toBe(false)
    store.setIssueStatus("acme/widget#42", "skipped", "rejected by human: wrong approach", { sticky: true })
    expect(store.isIssueSticky("acme/widget#42")).toBe(true)

    store.upsertIssue(issue({ status: "candidate", skipReason: null, title: "Renamed", score: 0.9 }))
    expect(store.getIssue("acme/widget#42")).toMatchObject({ status: "skipped", skipReason: "rejected by human: wrong approach", title: "Renamed", score: 0.9 })
    store.upsertIssue(issue({ status: "selected" }), { force: true })
    expect(store.getIssue("acme/widget#42")).toMatchObject({ status: "skipped", skipReason: "rejected by human: wrong approach" })

    // setIssueStatus without the option keeps the mark; sticky:false clears it
    store.setIssueStatus("acme/widget#42", "done")
    expect(store.isIssueSticky("acme/widget#42")).toBe(true)
    store.setIssueStatus("acme/widget#42", "candidate", null, { sticky: false })
    expect(store.isIssueSticky("acme/widget#42")).toBe(false)
    store.upsertIssue(issue({ status: "skipped", skipReason: "stale" }))
    expect(store.getIssue("acme/widget#42")?.status).toBe("skipped")
    expect(store.isIssueSticky("missing#1")).toBe(false)
  })
})

describe("task claims", () => {
  test("claim, renew, expiry takeover, release; saves are refused once the claim is lost", () => {
    store.saveTask(task())
    expect(store.claimTask("task_1", "A", 100, 1000)).toBe(true)
    expect(store.claimTask("task_1", "A", 100, 1050)).toBe(true) // own claim: renewed
    expect(store.claimTask("task_1", "B", 100, 1100)).toBe(false) // A holds it until 1150
    expect(store.renewTaskClaims("A", 100, 1140)).toBe(1) // now until 1240
    expect(store.claimTask("task_1", "B", 100, 1200)).toBe(false)
    expect(store.taskClaimHolder("task_1")).toBe("A")
    expect(store.saveTaskIfClaimed(task({ attempts: 1 }), "A")).toBe(true)

    // A's heartbeat stops (sleep): B takes the expired claim; A can no longer overwrite the task
    expect(store.claimTask("task_1", "B", 100, 1300)).toBe(true)
    expect(store.saveTaskIfClaimed(task({ attempts: 9 }), "A")).toBe(false)
    expect(store.getTask("task_1")?.attempts).toBe(1)
    store.releaseTaskClaim("task_1", "A") // not A's: no-op
    expect(store.taskClaimHolder("task_1")).toBe("B")
    store.releaseTaskClaim("task_1", "B")
    expect(store.taskClaimHolder("task_1")).toBeNull()
    expect(store.saveTaskIfClaimed(task({ attempts: 9 }), "A")).toBe(false) // released claims are not A's either

    // plain saves never touch the claim columns
    store.claimTask("task_1", "C", 100, 2000)
    store.saveTask(task({ attempts: 2 }))
    expect(store.taskClaimHolder("task_1")).toBe("C")
    expect(store.getTask("task_1")).toEqual(task({ attempts: 2 }))
  })
})

describe("pruning", () => {
  test("pruneHttpCache returns the number of dropped entries", () => {
    store.setHttpCache("GET a", { etag: null, lastModified: null, body: "" }, 10)
    store.setHttpCache("GET b", { etag: null, lastModified: null, body: "" }, 20)
    store.setHttpCache("GET c", { etag: null, lastModified: null, body: "" }, 30)
    expect(store.pruneHttpCache(25)).toBe(2)
    expect(store.getHttpCache("GET c")).not.toBeNull()
  })

  test("pruneAudit keeps the newest rows", () => {
    for (let i = 0; i < 10; i++) store.audit({ actor: "scout", action: `a.${i}`, ts: i })
    expect(store.pruneAudit(4)).toBe(6)
    expect(store.listAudit({ limit: 100 }).map((e) => e.action)).toEqual(["a.9", "a.8", "a.7", "a.6"])
    expect(store.pruneAudit(4)).toBe(0)
    expect(store.pruneAudit(100)).toBe(0)
  })
})

describe("transactionImmediate", () => {
  test("commits and rolls back like transaction()", () => {
    expect(store.transactionImmediate(() => (store.setKv("i", 1, 1), "ok"))).toBe("ok")
    expect(store.getKv<number>("i")).toBe(1)
    expect(() =>
      store.transactionImmediate(() => {
        store.setKv("j", 1, 1)
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(store.getKv("j")).toBeNull()
  })
})

describe("implementation diffs are stored as committed", () => {
  test("the diff keeps token-shaped text (the secrets gate must see it); the rest of the data is redacted", () => {
    registerSecret(SECRET)
    const diff = `diff --git a/x.ts b/x.ts\n+const token = "${GH_TOKEN}"\n+const url = "https://alice:pw@host"\n`
    store.saveTask(
      task({
        data: {
          implementation: {
            summary: `uses ${GH_TOKEN}`,
            commitMessage: "fix",
            prTitle: "fix",
            prBody: "body",
            testFiles: [],
            reproduced: null,
            diff,
            diffStat: { files: [], additions: 2, deletions: 0 },
            commitSha: "0".repeat(40),
            baseSha: "1".repeat(40),
            finalTestRun: null,
            finalLintRun: null,
          },
          log: `Authorization: Bearer ${SECRET}`,
        },
      }),
    )
    const t = store.getTask("task_1")!
    expect(t.data.implementation?.diff).toBe(diff)
    expect(t.data.implementation?.summary).toBe("uses [REDACTED]")
    expect(t.data.log).toBe("Authorization: Bearer [REDACTED]")

    // the rest of the task row is still redacted
    store.saveTask({ ...t, lastError: `push failed: ${GH_TOKEN}` })
    const again = store.getTask("task_1")!
    expect(again.lastError).toBe("push failed: [REDACTED]")
    expect(again.data.implementation?.diff).toBe(diff)

    // the queue item's diff column is the reviewed diff, verbatim; its test output and error are redacted
    const qi = store.insertQueueItem(queueItem({ diff, testOutput: `token ${GH_TOKEN}`, error: `failed with ${SECRET}` }))
    const loaded = store.getQueueItem(qi.id)!
    expect(loaded.diff).toBe(diff)
    expect(loaded.testOutput).toBe("token [REDACTED]")
    expect(loaded.error).toBe("failed with [REDACTED]")
  })
})

describe("migration v2", () => {
  test("a v1 database gains sticky issues and task claims; data is kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "oss-scout-db-"))
    try {
      const file = join(dir, "v1.db")
      const db = openDatabase(file)
      const s = new Store(db)
      s.upsertIssue(issue())
      s.saveTask(task())
      // roll the file back to the v1 schema
      db.exec(`DROP INDEX IF EXISTS http_cache_fetched;
               ALTER TABLE issues DROP COLUMN sticky;
               ALTER TABLE tasks DROP COLUMN claimed_by;
               ALTER TABLE tasks DROP COLUMN claim_expires_at;
               UPDATE meta SET value = '1' WHERE key = 'schema_version';`)
      db.close()

      const db2 = openDatabase(file)
      const s2 = new Store(db2)
      expect(SCHEMA_VERSION).toBe(2)
      expect((db2.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("2")
      expect(s2.getIssue("acme/widget#42")).toEqual(issue())
      expect(s2.isIssueSticky("acme/widget#42")).toBe(false)
      expect(s2.getTask("task_1")).toEqual(task())
      expect(s2.claimTask("task_1", "A", 10, 1)).toBe(true)
      db2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
