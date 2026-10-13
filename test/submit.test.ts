import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ConfigInput } from "../src/config/schema.ts"
import { replyBanReason } from "../src/followup/followup.ts"
import type { IssueRecord, QueueItem, RepoRecord, TrackedPr } from "../src/core/types.ts"
import { GitHubError, isWriteAuthorization, RateLimitError } from "../src/github/api.ts"
import type { GhComment, GhTimelineEvent } from "../src/github/types.ts"
import { computeDigest, hasDisclosure } from "../src/queue/prbody.ts"
import { ApprovalQueue, digest8, humanTextNotice, SUBMISSION_LEASE_MS, type EnqueueInput } from "../src/queue/queue.ts"
import { capsSnapshot } from "../src/scheduler/caps.ts"
import { AI_POLICY_FLAG_NOTES, type AiPolicyFlag } from "../src/screening/policy.ts"
import {
  approveQueueItem,
  approveQueueItemWith,
  DRY_RUN_PREFIX,
  type GitPusher,
  type SubmitDeps,
} from "../src/queue/submit.ts"
import type { GitPaths } from "../src/workspace/git.ts"
import type { ExecResult } from "../src/util/exec.ts"
import {
  crossRefPr,
  FakeGitHub,
  ghComment,
  ghIssue,
  ghPull,
  ghRepo,
  ghUser,
  makeTestContext,
  type TestContext,
} from "./helpers/fakes.ts"

const TOKEN = "ghp_testtoken000000000000000000000000"
const BRANCH = "oss-scout/42-zero-timeout"
/** The reviewed commit recorded at enqueue (data.commitSha): what approval pushes. */
const SHA = "0123456789abcdef0123456789abcdef01234567"

let ctx: TestContext | null = null
afterEach(() => {
  ctx?.cleanup()
  ctx = null
})

interface PushCall {
  paths: GitPaths
  remoteUrl: string
  localRef: string
  remoteBranch: string
  token: string
}

function fakeGit(result: Partial<ExecResult> = {}): { deps: Partial<SubmitDeps>; pushes: PushCall[] } {
  const pushes: PushCall[] = []
  const deps: Partial<SubmitDeps> = {
    makeGit: (paths): GitPusher => ({
      push: async (remoteUrl, localRef, remoteBranch, token) => {
        pushes.push({ paths, remoteUrl, localRef, remoteBranch, token })
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1, ...result }
      },
    }),
  }
  return { deps, pushes }
}

/** GitHub where the issue is open and unclaimed, no fork exists yet and no PR exists for the head. */
function freshGitHub(): FakeGitHub {
  return new FakeGitHub({
    getIssue: async (_repo, n) => ghIssue({ number: n }),
    listIssueTimeline: async () => [],
    getRepo: async (name) => {
      throw new GitHubError(`Not Found: ${name}`, 404)
    },
    listPulls: async () => [],
    searchIssues: async () => [],
  })
}

function setup(opts: { config?: ConfigInput; github?: FakeGitHub; writeToken?: string | null } = {}): {
  c: TestContext
  q: ApprovalQueue
} {
  ctx = makeTestContext({
    config: opts.config,
    github: opts.github ?? freshGitHub(),
    ...(opts.writeToken !== undefined ? { writeToken: opts.writeToken } : {}),
  })
  return { c: ctx, q: new ApprovalQueue(ctx) }
}

function prInput(over: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    kind: "pr",
    repo: "acme/widget",
    issueUrl: "https://github.com/acme/widget/issues/42",
    prUrl: null,
    taskId: "task_1",
    title: "fix: handle zero timeout",
    body: "Handle zero timeout.\n\nFixes #42",
    diff: "diff --git a/x b/x\n+fix\n",
    testOutput: "ok",
    critic: { verdict: "approve", confidence: 0.9, reasons: [], requiredChanges: [], model: null, raw: "" },
    verification: { passed: true, checks: [] },
    branch: BRANCH,
    workspace: "/ws/task_1",
    baseBranch: "main",
    data: { issueId: "acme/widget#42", commitSha: SHA },
    ...over,
  }
}

function issueRecord(): IssueRecord {
  return {
    id: "acme/widget#42",
    repo: "acme/widget",
    number: 42,
    title: "Crash",
    url: "https://github.com/acme/widget/issues/42",
    body: "",
    labels: [],
    createdAt: "2026-01-05T09:00:00Z",
    updatedAt: "2026-01-10T09:00:00Z",
    comments: 0,
    kind: "bug",
    status: "selected",
    score: 0.8,
    reasons: [],
    skipReason: null,
    fetchedAt: 0,
  }
}

function trackedPr(over: Partial<TrackedPr> = {}): TrackedPr {
  return {
    id: "acme/widget#101",
    repo: "acme/widget",
    number: 101,
    url: "https://github.com/acme/widget/pull/101",
    queueItemId: 1,
    branch: BRANCH,
    headRepo: "me/widget",
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

const approve = (c: TestContext, item: QueueItem, deps: Partial<SubmitDeps>, digest = digest8(item)) =>
  approveQueueItemWith(c, { id: item.id, digest, via: "cli" }, deps)

describe("dry-run", () => {
  test("approves, records planned actions, writes nothing", async () => {
    const { c, q } = setup()
    const item = q.enqueue(prInput())
    const git = fakeGit()
    const res = await approve(c, item, git.deps)
    expect(res.ok).toBe(true)
    expect(res.status).toBe("approved")
    expect(res.message.startsWith(DRY_RUN_PREFIX)).toBe(true)
    expect(res.url).toBeNull()
    expect(c.github.writes).toHaveLength(0)
    expect(git.pushes).toHaveLength(0)
    expect(c.github.calls.map((x) => x.method)).toEqual(["getIssue", "listIssueTimeline"])

    const saved = c.store.getQueueItem(item.id)!
    expect(saved.status).toBe("approved")
    expect(saved.decidedAt).toBe(c.clock.now())
    expect(saved.data.dryRun).toBe(true)
    const planned = saved.data.plannedActions as string[]
    expect(planned).toEqual(res.actions)
    expect(planned.join("\n")).toContain("ensure fork me/widget of acme/widget")
    expect(planned.join("\n")).toContain(`https://github.com/me/widget.git as ${BRANCH}`)
    expect(planned.join("\n")).toContain(`head me:${BRANCH} -> base main`)
    expect(planned.join("\n")).toContain('"fix: handle zero timeout"')
    const a = c.store.listAudit({ action: "queue.approve" })[0]!
    expect(a.actor).toBe("human")
    expect(a.details).toMatchObject({ via: "cli", mode: "dry-run" })
  })

  test("re-approval after switching to queue mode actually submits", async () => {
    const { c, q } = setup()
    const item = q.enqueue(prInput())
    const git = fakeGit()
    await approve(c, item, git.deps)
    ;(c.config as { mode: string }).mode = "queue"
    const res = await approve(c, item, git.deps)
    expect(res.status).toBe("submitted")
    expect(c.store.getQueueItem(item.id)!.data.dryRun).toBeUndefined()
    expect(c.github.writes.map((w) => w.method)).toEqual(["createFork", "createPull"])
  })

  test("reply plan names the comment target", async () => {
    const { c, q } = setup()
    const item = q.enqueue(
      prInput({ kind: "reply", issueUrl: null, prUrl: "https://github.com/acme/widget/pull/101", taskId: null, data: { prNumber: 101 } }),
    )
    const res = await approve(c, item, fakeGit().deps)
    expect(res.ok).toBe(true)
    expect(res.actions[0]).toContain("post a comment on acme/widget#101")
    expect(c.github.writes).toHaveLength(0)
  })
})

describe("refusals (nothing is written)", () => {
  test("digest mismatch, short digest, and case-insensitive match", async () => {
    const { c, q } = setup()
    const item = q.enqueue(prInput())
    const wrong = await approve(c, item, {}, "deadbeef")
    expect(wrong.ok).toBe(false)
    expect(wrong.status).toBe("pending")
    expect(wrong.message).toContain("digest mismatch")
    expect(wrong.message).not.toContain(digest8(item))
    expect((await approve(c, item, {}, item.digest.slice(0, 7))).message).toContain("at least")
    expect((await approve(c, item, {}, "zzzzzzzz")).ok).toBe(false)
    expect(c.store.getQueueItem(item.id)!.status).toBe("pending")
    expect((await approve(c, item, {}, digest8(item).toUpperCase())).ok).toBe(true)
    expect(c.github.writes).toHaveLength(0)
    expect(c.store.listAudit({ action: "queue.approve" }).filter((a) => a.decision === "refused")).toHaveLength(3)
  })

  test("full digest works; edited item needs the new digest", async () => {
    const { c, q } = setup()
    const item = q.enqueue(prInput())
    const edited = q.editBody(item.id, "Different body", "human")
    expect((await approve(c, item, {})).ok).toBe(false)
    expect((await approveQueueItemWith(c, { id: edited.id, digest: edited.digest, via: "command" }, {})).ok).toBe(true)
  })

  test("content modified outside the queue (digest no longer matches) is refused", async () => {
    const { c, q } = setup()
    const item = q.enqueue(prInput())
    c.store.saveQueueItem({ ...item, body: "tampered" })
    const res = await approve(c, item, {})
    expect(res.ok).toBe(false)
    expect(res.message).toContain("no longer matches its digest")
  })

  test("kill switch refuses approvals", async () => {
    const { c, q } = setup({ config: { mode: "queue" } })
    const item = q.enqueue(prInput())
    c.kill.engage("manual stop", c.clock.now())
    const git = fakeGit()
    const res = await approve(c, item, git.deps)
    expect(res.ok).toBe(false)
    expect(res.message).toContain("kill switch")
    expect(c.store.getQueueItem(item.id)!.status).toBe("pending")
    expect(c.github.writes).toHaveLength(0)
    expect(git.pushes).toHaveLength(0)
  })

  test("caps refuse (open PR in the repo, case-insensitive) and leave the item pending", async () => {
    const { c, q } = setup({ config: { mode: "queue" } })
    c.store.upsertPr(trackedPr({ id: "ACME/Widget#5", repo: "ACME/Widget", number: 5, data: { external: true } }))
    const item = q.enqueue(prInput())
    const res = await approve(c, item, fakeGit().deps)
    expect(res.ok).toBe(false)
    expect(res.status).toBe("pending")
    expect(res.message).toContain("cap reached")
    expect(c.github.writes).toHaveLength(0)
  })

  test("weekly cap refuses", async () => {
    const { c, q } = setup({ config: { mode: "queue", caps: { maxSubmittedPrsPerWeek: 1 } } })
    const old = q.enqueue(prInput({ repo: "other/repo" }))
    c.store.saveQueueItem({ ...old, status: "submitted", decidedAt: c.clock.now() - 1000 })
    const item = q.enqueue(prInput())
    const res = await approve(c, item, fakeGit().deps)
    expect(res.message).toContain("weekly PR cap")
  })

  test("submitted / rejected items cannot be approved; an interrupted approval can be resumed", async () => {
    const { c, q } = setup()
    const a = q.enqueue(prInput())
    c.store.saveQueueItem({ ...a, status: "submitted" })
    expect((await approve(c, a, {})).message).toContain("submitted")
    const r = q.enqueue(prInput({ repo: "other/thing" }))
    c.store.saveQueueItem({ ...r, status: "rejected" })
    expect((await approve(c, r, {})).message).toContain("rejected")
    // "approved" without dryRun and not running in this process = interrupted submission → resumable
    const b = q.enqueue(prInput())
    c.store.saveQueueItem({ ...b, status: "approved", data: { ...b.data } })
    const resumed = await approve(c, b, {})
    expect(resumed.ok).toBe(true)
    expect(resumed.message).toContain("DRY-RUN")
    expect((await approveQueueItem(c, { id: 999, digest: "deadbeef", via: "cli" })).message).toContain("not found")
    expect(c.github.writes).toHaveLength(0)
  })

  test('approval via "tool" is impossible by type and refused at runtime', async () => {
    const { c, q } = setup({ config: { mode: "queue" } })
    const item = q.enqueue(prInput())
    // @ts-expect-error — via cannot be "tool": LLM tools can never approve
    const res = await approveQueueItem(c, { id: item.id, digest: digest8(item), via: "tool" })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('"tool"')
    expect(c.store.getQueueItem(item.id)!.status).toBe("pending")
    expect(c.github.writes).toHaveLength(0)
  })
})

function repoWithFlags(fullName: string, ...flags: AiPolicyFlag[]): RepoRecord {
  return {
    fullName,
    source: "search",
    sourceDetail: null,
    status: "eligible",
    score: 0.8,
    reasons: [],
    skipReason: null,
    policy: {
      ai: {
        classification: "disclosure_required",
        evidence: [],
        requiresDisclosure: true,
        notes: flags.map((f) => `ai:${f}: ${AI_POLICY_FLAG_NOTES[f]}`),
      },
      contributingFile: null,
      contributingExcerpt: null,
      codeOfConductFile: null,
      prTemplatePath: null,
      prTemplate: null,
      requiresSignoff: false,
      requiresCla: false,
      requiresIssueFirst: false,
      reservesGoodFirstIssues: false,
      commitConvention: "unknown",
      notes: [],
    },
    metrics: null,
    discoveredAt: 0,
    screenedAt: 0,
    nextScreenAt: null,
  }
}

describe("repository AI rules", () => {
  const humanText = (over: Partial<EnqueueInput> = {}) =>
    prInput({
      data: {
        issueId: "acme/widget#42",
        commitSha: SHA,
        aiPolicyFlags: ["human_written_text_only"],
        aiPolicyNotes: [AI_POLICY_FLAG_NOTES.human_written_text_only],
        requiresHumanText: true,
      },
      ...over,
    })

  test("human-written PR text required: dry-run approval refused until the human edits the body", async () => {
    const { c, q } = setup()
    const item = q.enqueue(humanText())
    const res = await approve(c, item, fakeGit().deps)
    expect(res.ok).toBe(false)
    expect(res.status).toBe("pending")
    expect(res.message).toBe(humanTextNotice(item.id))
    expect(res.message).toContain("written by you")
    expect(c.store.getQueueItem(item.id)!.status).toBe("pending")
    expect(c.github.calls).toHaveLength(0)
    const refused = c.store.listAudit({ action: "queue.approve" }).filter((a) => a.decision === "refused")
    expect(refused).toHaveLength(1)

    // An LLM/tool edit does not count as human-written.
    const toolEdit = q.editBody(item.id, "Body rewritten by a tool.", "scout")
    expect((await approve(c, toolEdit, {})).message).toBe(humanTextNotice(item.id))

    const edited = q.editBody(item.id, "In my own words: zero timeouts no longer crash.", "human")
    const ok = await approve(c, edited, fakeGit().deps)
    expect(ok.ok).toBe(true)
    expect(ok.message.startsWith(DRY_RUN_PREFIX)).toBe(true)
  })

  test("human-written PR text required: queue mode refuses before any write or push", async () => {
    const { c, q } = setup({ config: { mode: "queue" } })
    const item = q.enqueue(humanText())
    const git = fakeGit()
    const res = await approve(c, item, git.deps)
    expect(res.ok).toBe(false)
    expect(res.message).toContain("Edit the body")
    expect(c.github.writes).toHaveLength(0)
    expect(git.pushes).toHaveLength(0)

    // Editing PR_BODY.md and syncing as the human unlocks it.
    writeFileSync(join(q.itemDir(item.id), "PR_BODY.md"), "My own description.\n")
    const synced = q.syncFromFiles(item.id, "human")
    const done = await approve(c, synced, git.deps)
    expect(done.status).toBe("submitted")
    const pr = c.github.writes.find((w) => w.method === "createPull")!.payload as { body: string }
    expect(pr.body).toContain("My own description.")
    expect(hasDisclosure(pr.body, c.config.disclosure.line)).toBe(true)
  })

  test("the human-text requirement applies to PR items only", async () => {
    const { c, q } = setup()
    const reply = q.enqueue(
      prInput({
        kind: "reply",
        issueUrl: null,
        prUrl: "https://github.com/acme/widget/pull/101",
        taskId: null,
        data: { prNumber: 101, requiresHumanText: true },
      }),
    )
    expect((await approve(c, reply, fakeGit().deps)).ok).toBe(true)
  })

  test("one AI-assisted PR at a time: refused while you have an open PR in the repo", async () => {
    const { c, q } = setup({ config: { mode: "queue", caps: { maxOpenPrsPerRepo: 3 } } })
    c.store.saveRepo(repoWithFlags("acme/widget", "one_ai_pr_at_a_time"))
    c.store.upsertPr(trackedPr({ id: "acme/widget#5", number: 5 }))
    const item = q.enqueue(prInput())
    const git = fakeGit()
    const res = await approve(c, item, git.deps)
    expect(res.ok).toBe(false)
    expect(res.status).toBe("pending")
    expect(res.message).toContain("allows one AI-assisted PR at a time")
    expect(c.github.writes).toHaveLength(0)
    expect(git.pushes).toHaveLength(0)

    // Without the flag the per-repo cap (3) allows it.
    c.store.saveRepo(repoWithFlags("acme/widget", "disclosure_required"))
    expect((await approve(c, item, git.deps)).status).toBe("submitted")
  })
})

describe("repository AI rules: review replies", () => {
  const replyItem = (q: ApprovalQueue) =>
    q.enqueue(
      prInput({
        kind: "reply",
        issueUrl: null,
        prUrl: "https://github.com/acme/widget/pull/101",
        taskId: null,
        body: "Thanks! Updated.",
        diff: "",
        branch: null,
        baseBranch: null,
        data: { prNumber: 101, prId: "acme/widget#101" },
      }),
    )

  for (const flag of ["no_ai_review_replies", "human_written_text_only"] as const) {
    for (const mode of ["dry-run", "queue"] as const) {
      test(`${flag} (${mode}): a drafted reply is refused and audited; nothing touches GitHub`, async () => {
        const { c, q } = setup({ config: { mode } })
        const repo = repoWithFlags("acme/widget", flag)
        c.store.saveRepo(repo)
        const item = replyItem(q)
        const git = fakeGit()
        const res = await approve(c, item, git.deps)
        expect(res.ok).toBe(false)
        expect(res.status).toBe("pending")
        expect(res.message).toContain(replyBanReason(repo.policy!.ai)!)
        expect(res.message).toContain("Answer the review on GitHub yourself (https://github.com/acme/widget/pull/101)")
        expect(res.message).toContain(`/oss-reject ${item.id}`)
        expect(c.store.getQueueItem(item.id)!.status).toBe("pending")
        expect(c.github.calls).toHaveLength(0)
        expect(c.github.writes).toHaveLength(0)
        expect(git.pushes).toHaveLength(0)
        const refused = c.store.listAudit({ action: "queue.approve" }).filter((a) => a.decision === "refused")
        expect(refused).toHaveLength(1)
        expect(refused[0]!.actor).toBe("human")
        expect(refused[0]!.reasons[0]).toContain("yourself")
      })
    }
  }

  test("other AI rules do not block replies; the reply ban does not block PR items", async () => {
    const { c, q } = setup()
    c.store.saveRepo(repoWithFlags("acme/widget", "one_ai_pr_at_a_time"))
    const reply = replyItem(q)
    expect((await approve(c, reply, fakeGit().deps)).ok).toBe(true)

    c.store.saveRepo(repoWithFlags("acme/widget", "no_ai_review_replies"))
    const prItem = q.enqueue(prInput())
    const res = await approve(c, prItem, fakeGit().deps)
    expect(res.ok).toBe(true)
    expect(res.message.startsWith(DRY_RUN_PREFIX)).toBe(true)
  })
})

describe("freshness → superseded", () => {
  test("issue closed", async () => {
    const gh = freshGitHub().set({ getIssue: async () => ghIssue({ state: "closed", state_reason: "completed" }) })
    const { c, q } = setup({ github: gh, config: { mode: "queue" } })
    c.store.upsertIssue(issueRecord())
    const item = q.enqueue(prInput())
    const res = await approve(c, item, fakeGit().deps)
    expect(res.ok).toBe(false)
    expect(res.status).toBe("superseded")
    expect(res.message).toContain("was closed (completed)")
    expect(c.store.getQueueItem(item.id)!.status).toBe("superseded")
    expect(c.store.getIssue("acme/widget#42")!.status).toBe("skipped")
    expect(c.github.writes).toHaveLength(0)
  })

  test("issue assigned to someone else (self-assignment is fine)", async () => {
    const gh = freshGitHub().set({ getIssue: async () => ghIssue({ assignees: [ghUser("Me"), ghUser("alice")] }) })
    const { c, q } = setup({ github: gh })
    const res = await approve(c, q.enqueue(prInput()), {})
    expect(res.status).toBe("superseded")
    expect(res.message).toContain("@alice")
    expect(res.message).not.toContain("@Me")
  })

  test("deleted issue (404) supersedes; other read errors refuse without change", async () => {
    const gh = freshGitHub().set({
      getIssue: async () => {
        throw new GitHubError("Not Found", 404)
      },
    })
    const { c, q } = setup({ github: gh })
    expect((await approve(c, q.enqueue(prInput()), {})).status).toBe("superseded")
    gh.set({
      getIssue: async () => {
        throw new Error("network down")
      },
    })
    const item = q.enqueue(prInput())
    const res = await approve(c, item, {})
    expect(res.status).toBe("pending")
    expect(res.message).toContain("network down")
    gh.set({
      getIssue: async () => {
        throw new RateLimitError("rate limited", Date.UTC(2026, 0, 15, 13), "core", false)
      },
    })
    expect((await approve(c, item, {})).message).toContain("2026-01-15T13:00:00.000Z")
    expect(c.store.getQueueItem(item.id)!.status).toBe("pending")
  })

  test("open linked PR by someone else supersedes; my own linked PR does not", async () => {
    const otherPr: GhTimelineEvent = crossRefPr({ number: 77, state: "open" })
    ;(otherPr.source!.issue as Record<string, unknown>).user = ghUser("bob")
    const gh = freshGitHub().set({ listIssueTimeline: async () => [otherPr] })
    const { c, q } = setup({ github: gh })
    const res = await approve(c, q.enqueue(prInput()), {})
    expect(res.status).toBe("superseded")
    expect(res.message).toContain("acme/widget#77 by @bob")

    const mine = crossRefPr({ number: 78, state: "open" })
    ;(mine.source!.issue as Record<string, unknown>).user = ghUser("me")
    const closed = crossRefPr({ number: 79, state: "closed" })
    const elsewhere: GhTimelineEvent = {
      event: "cross-referenced",
      source: { type: "issue", issue: { number: 5, state: "open", pull_request: {}, repository: { full_name: "fan/blog" } } },
    }
    gh.set({ listIssueTimeline: async () => [mine, closed, elsewhere] })
    expect((await approve(c, q.enqueue(prInput()), {})).ok).toBe(true)
  })

  test("manually connected PR: author resolved via getPull", async () => {
    const connected: GhTimelineEvent = { event: "connected", subject: { type: "pull_request", number: 88, state: "open" } }
    const gh = freshGitHub().set({
      listIssueTimeline: async () => [connected],
      getPull: async (_r, n) => ghPull({ number: n, state: "open", merged_at: null, user: ghUser("carol") }),
    })
    const { c, q } = setup({ github: gh })
    const res = await approve(c, q.enqueue(prInput()), {})
    expect(res.status).toBe("superseded")
    expect(res.message).toContain("#88 by @carol")

    const disconnected: GhTimelineEvent = { event: "disconnected", subject: { type: "pull_request", number: 88 } }
    gh.set({ listIssueTimeline: async () => [connected, disconnected] })
    expect((await approve(c, q.enqueue(prInput()), {})).ok).toBe(true)
  })
})

describe("queue mode", () => {
  test("happy path: fork, push (fake), PR with disclosure, tracked, issue done, audited", async () => {
    const { c, q } = setup({ config: { mode: "queue" } })
    c.store.upsertIssue(issueRecord())
    const item = q.enqueue(prInput())
    const git = fakeGit()
    const res = await approve(c, item, git.deps)

    expect(res.ok).toBe(true)
    expect(res.status).toBe("submitted")
    expect(res.url).toBe("https://github.com/acme/widget/pull/101")

    const [fork, pull] = c.github.writes
    expect(c.github.writes).toHaveLength(2)
    expect(fork!.method).toBe("createFork")
    expect(fork!.repo).toBe("acme/widget")
    expect(pull!.method).toBe("createPull")
    const payload = pull!.payload as { title: string; body: string; head: string; base: string; draft: boolean; maintainerCanModify: boolean }
    expect(payload.head).toBe(`me:${BRANCH}`)
    expect(payload.base).toBe("main")
    expect(payload.title).toBe(item.title)
    expect(payload.draft).toBe(false)
    expect(payload.maintainerCanModify).toBe(true)
    expect(hasDisclosure(payload.body, c.config.disclosure.line)).toBe(true)
    for (const w of c.github.writes) {
      expect(isWriteAuthorization(w.auth)).toBe(true)
      expect(w.auth.queueItemId).toBe(item.id)
      expect(w.auth.via).toBe("cli")
    }

    expect(git.pushes).toHaveLength(1)
    const push = git.pushes[0]!
    expect(push.remoteUrl).toBe("https://github.com/me/widget.git")
    expect(push.remoteUrl).not.toContain(TOKEN)
    // exactly the reviewed commit, never the branch tip
    expect(push.localRef).toBe(SHA)
    expect(push.remoteBranch).toBe(BRANCH)
    expect(push.token).toBe(TOKEN)
    expect(push.paths.gitDir).toBe(join(c.paths.gitDirsDir, "task_1"))
    expect(push.paths.workTree).toBe(join(c.paths.workspacesDir, "task_1", "repo"))

    const saved = c.store.getQueueItem(item.id)!
    expect(saved).toMatchObject({ status: "submitted", submittedUrl: res.url, prUrl: res.url, error: null })
    const tracked = c.store.getPr("acme/widget#101")!
    expect(tracked).toMatchObject({ state: "open", queueItemId: item.id, branch: BRANCH, headRepo: "me/widget", openedAt: c.clock.now() })
    expect(c.store.getIssue("acme/widget#42")!.status).toBe("done")

    const writesAudit = c.store.listAudit({ action: "github.write", limit: 10 })
    expect(writesAudit.map((a) => a.details.action).sort()).toEqual(["createFork", "createPull", "git.push"])
    expect(writesAudit.every((a) => a.decision === "ok")).toBe(true)
    expect(c.store.listAudit({ action: "github.write.attempt" })).toHaveLength(3)
    expect(JSON.stringify(c.store.listAudit({ limit: 100 }))).not.toContain(TOKEN)
    expect(c.store.listAudit({ action: "queue.submit" })[0]!.decision).toBe("submitted")
  })

  test("reuses an existing fork of the upstream", async () => {
    const gh = freshGitHub().set({
      getRepo: async (name) => ghRepo({ full_name: name, fork: true, owner: ghUser("me"), parent: { full_name: "acme/widget" } }),
    })
    const { c, q } = setup({ github: gh, config: { mode: "queue" } })
    const res = await approve(c, q.enqueue(prInput()), fakeGit().deps)
    expect(res.ok).toBe(true)
    expect(c.github.writes.map((w) => w.method)).toEqual(["createPull"])
    expect(res.actions).toContain("reused fork me/widget")
  })

  test("a same-named repo that is not a fork of the upstream gets a new fork (GitHub picks the name)", async () => {
    const gh = freshGitHub().set({
      getRepo: async (name) => ghRepo({ full_name: name, fork: false, owner: ghUser("me") }),
      createFork: async () => ghRepo({ full_name: "me/widget-1", fork: true, owner: ghUser("me") }),
    })
    const { c, q } = setup({ github: gh, config: { mode: "queue" } })
    const git = fakeGit()
    await approve(c, q.enqueue(prInput()), git.deps)
    expect(git.pushes[0]!.remoteUrl).toBe("https://github.com/me/widget-1.git")
    expect((c.github.writes[1]!.payload as { head: string }).head).toBe(`me:${BRANCH}`)
  })

  test("existing PR for the head → treated as submitted, no second PR", async () => {
    const existing = ghPull({ number: 55, state: "open", merged_at: null, closed_at: null, html_url: "https://github.com/acme/widget/pull/55" })
    const gh = freshGitHub().set({ listPulls: async () => [existing] })
    const { c, q } = setup({ github: gh, config: { mode: "queue" } })
    const item = q.enqueue(prInput())
    const res = await approve(c, item, fakeGit().deps)
    expect(res).toMatchObject({ ok: true, status: "submitted", url: "https://github.com/acme/widget/pull/55" })
    expect(c.github.writes.map((w) => w.method)).toEqual(["createFork"])
    const call = c.github.calls.find((x) => x.method === "listPulls")!
    expect(call.args[1]).toMatchObject({ head: `me:${BRANCH}`, state: "all" })
    expect(c.store.getPr("acme/widget#55")!.queueItemId).toBe(item.id)
  })

  test("fine-grained PAT 403 on createPull → failed with compare URL and file locations; retry succeeds", async () => {
    const gh = freshGitHub().set({
      createPull: async () => {
        throw new GitHubError("Resource not accessible by personal access token", 403, "pull_requests=write")
      },
    })
    const { c, q } = setup({ github: gh, config: { mode: "queue" } })
    const item = q.enqueue(prInput())
    const res = await approve(c, item, fakeGit().deps)
    expect(res.ok).toBe(false)
    expect(res.status).toBe("failed")
    expect(res.message).toContain(`https://github.com/acme/widget/compare/main...me:${BRANCH}?expand=1`)
    expect(res.message).toContain("Fine-grained personal access tokens cannot open PRs")
    expect(res.message).toContain(join(q.itemDir(item.id), "PR_BODY.md"))
    expect(res.message).toContain("OSS_SCOUT_WRITE_TOKEN")
    const saved = c.store.getQueueItem(item.id)!
    expect(saved.status).toBe("failed")
    expect(saved.error).toContain("compare")
    expect(c.store.listAudit({ action: "github.write" }).some((a) => a.decision === "failed")).toBe(true)

    // retry after fixing the token: fork already exists now
    gh.set({
      createPull: undefined,
      getRepo: async (name) => ghRepo({ full_name: name, fork: true, parent: { full_name: "acme/widget" } }),
    })
    const retry = await approve(c, saved, fakeGit().deps)
    expect(retry.status).toBe("submitted")
  })

  test("push failure → failed with token hint, no PR, token never in the message", async () => {
    const { c, q } = setup({ config: { mode: "queue" } })
    const item = q.enqueue(prInput())
    const git = fakeGit({ exitCode: 128, stderr: `remote: Permission to me/widget.git denied (${TOKEN}).\nfatal: 403` })
    const res = await approve(c, item, git.deps)
    expect(res.status).toBe("failed")
    expect(res.message).toContain("git push to me/widget failed (exit code 128)")
    expect(res.message).toContain("Contents: write")
    expect(res.message).not.toContain(TOKEN)
    expect(c.store.getQueueItem(item.id)!.error).not.toContain(TOKEN)
    expect(c.github.writes.map((w) => w.method)).toEqual(["createFork"])
  })

  test("no write token → failed before pushing", async () => {
    const { c, q } = setup({ config: { mode: "queue" }, writeToken: null })
    const git = fakeGit()
    const res = await approve(c, q.enqueue(prInput()), git.deps)
    expect(res.status).toBe("failed")
    expect(res.message).toContain("no token available")
    expect(git.pushes).toHaveLength(0)
    expect(c.github.writes.map((w) => w.method)).toEqual(["createFork"])
  })

  test("rate limit during submission → failed with retry guidance", async () => {
    const gh = freshGitHub().set({
      createPull: async () => {
        throw new RateLimitError("secondary rate limit", Date.UTC(2026, 0, 15, 12, 5), "core", true)
      },
    })
    const { c, q } = setup({ github: gh, config: { mode: "queue" } })
    const item = q.enqueue(prInput())
    const res = await approve(c, item, fakeGit().deps)
    expect(res.status).toBe("failed")
    expect(res.message).toContain("secondary rate limit")
    expect(res.message).toContain("2026-01-15T12:05:00.000Z")
    expect(res.message).toContain(`/oss-approve ${item.id} ${digest8(item)}`)
  })

  test("writer refusing writes (WriteForbiddenError) → failed, nothing recorded", async () => {
    const { c, q } = setup({ config: { mode: "queue" } })
    c.github.allowWrites = false
    const res = await approve(c, q.enqueue(prInput()), fakeGit().deps)
    expect(res.status).toBe("failed")
    expect(res.message).toContain("write refused")
    expect(c.github.writes).toHaveLength(0)
  })

  test("reply: posts one comment with the reply disclosure", async () => {
    const gh = freshGitHub().set({
      createIssueComment: async (_a, _r, n, body) => ghComment({ body, html_url: `https://github.com/acme/widget/pull/${n}#issuecomment-1` }),
    })
    const { c, q } = setup({ github: gh, config: { mode: "queue" } })
    const item = q.enqueue(
      prInput({
        kind: "reply",
        issueUrl: null,
        prUrl: "https://github.com/acme/widget/pull/101",
        taskId: null,
        body: "Thanks! Updated.",
        diff: "",
        branch: null,
        baseBranch: null,
        data: { prNumber: 101, prId: "acme/widget#101" },
      }),
    )
    const git = fakeGit()
    const res = await approve(c, item, git.deps)
    expect(res).toMatchObject({ ok: true, status: "submitted", url: "https://github.com/acme/widget/pull/101#issuecomment-1" })
    expect(c.github.writes).toHaveLength(1)
    const w = c.github.writes[0]!
    expect(w.method).toBe("createIssueComment")
    const payload = w.payload as { number: number; body: string }
    expect(payload.number).toBe(101)
    expect(hasDisclosure(payload.body, c.config.disclosure.replyLine)).toBe(true)
    expect(git.pushes).toHaveLength(0)
    expect(c.github.calls.some((x) => x.method === "getIssue")).toBe(false)
  })

  test("fix: pushes to the PR head branch of your fork; refuses foreign repos and closed PRs", async () => {
    const gh = freshGitHub().set({ getPull: async (_r, n) => ghPull({ number: n, state: "open", merged_at: null, closed_at: null }) })
    const { c, q } = setup({ github: gh, config: { mode: "queue" } })
    c.store.upsertPr(trackedPr())
    const fixInput = (data: Record<string, unknown>) =>
      prInput({
        kind: "fix",
        issueUrl: null,
        prUrl: "https://github.com/acme/widget/pull/101",
        taskId: "task_fix",
        title: "Follow-up fix for acme/widget#101",
        body: "Address review: rename option",
        branch: "oss-scout/42-zero-timeout-fix",
        baseBranch: null,
        data: { commitSha: SHA, ...data },
      })
    const git = fakeGit()
    const ok = await approve(c, q.enqueue(fixInput({ prNumber: 101, remoteBranch: BRANCH })), git.deps)
    expect(ok).toMatchObject({ ok: true, status: "submitted", url: "https://github.com/acme/widget/pull/101" })
    expect(git.pushes[0]).toMatchObject({
      remoteUrl: "https://github.com/me/widget.git",
      localRef: SHA,
      remoteBranch: BRANCH,
    })
    expect(c.github.writes).toHaveLength(0)

    const foreign = await approve(c, q.enqueue(fixInput({ prNumber: 101, headRepo: "acme/widget" })), git.deps)
    expect(foreign.status).toBe("failed")
    expect(foreign.message).toContain("not a repository owned by me")
    expect(git.pushes).toHaveLength(1)

    gh.set({ getPull: async (_r, n) => ghPull({ number: n }) })
    const closed = await approve(c, q.enqueue(fixInput({ prNumber: 101 })), git.deps)
    expect(closed.status).toBe("superseded")
    expect(closed.message).toContain("merged")
    expect(git.pushes).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// exact-commit binding
// ---------------------------------------------------------------------------

const PR_URL = "https://github.com/acme/widget/pull/101"

function openPullGitHub(): FakeGitHub {
  return freshGitHub().set({ getPull: async (_r, n) => ghPull({ number: n, state: "open", merged_at: null, closed_at: null }) })
}

function fixInput(data: Record<string, unknown> = {}): EnqueueInput {
  return prInput({
    kind: "fix",
    issueUrl: null,
    prUrl: PR_URL,
    taskId: "task_fix",
    title: "Follow-up fix for acme/widget#101",
    body: "Address review: rename option",
    branch: BRANCH,
    baseBranch: null,
    data: { prNumber: 101, prId: "acme/widget#101", headRepo: "me/widget", remoteBranch: BRANCH, workspaceTaskId: "task_1", commitSha: SHA, ...data },
  })
}

describe("exact reviewed commit", () => {
  test("the dry-run plan names the reviewed commit for PR and fix items", async () => {
    const { c, q } = setup({ github: openPullGitHub() })
    const pr = await approve(c, q.enqueue(prInput()), fakeGit().deps)
    expect(pr.actions.join("\n")).toContain(`push commit ${SHA.slice(0, 12)} (the reviewed commit)`)
    const fix = await approve(c, q.enqueue(fixInput()), fakeGit().deps)
    expect(fix.actions[0]).toContain(`push commit ${SHA.slice(0, 12)} (the reviewed commit) to https://github.com/me/widget.git as ${BRANCH}`)
  })

  test("a later commit on the shared branch never leaks: the fix pushes its own commit by sha", async () => {
    const { c, q } = setup({ github: openPullGitHub(), config: { mode: "queue" } })
    c.store.upsertPr(trackedPr())
    const first = q.enqueue(fixInput({ commitSha: "1".repeat(40) }))
    const git = fakeGit()
    const res = await approve(c, first, git.deps)
    expect(res.status).toBe("submitted")
    expect(git.pushes).toHaveLength(1)
    expect(git.pushes[0]).toMatchObject({ localRef: "1".repeat(40), remoteBranch: BRANCH, remoteUrl: "https://github.com/me/widget.git" })
    expect(git.pushes[0]!.paths.gitDir).toBe(join(c.paths.gitDirsDir, "task_1"))
    const push = c.store.listAudit({ action: "github.write" }).find((a) => a.details.action === "git.push")!
    expect(push.details.commit).toBe("1".repeat(40))
  })

  test("queue mode refuses PR and fix items without a valid recorded commit; nothing is written or pushed", async () => {
    const { c, q } = setup({ github: openPullGitHub(), config: { mode: "queue" } })
    c.store.upsertPr(trackedPr())
    const git = fakeGit()
    const bad = [
      q.enqueue(prInput({ data: { issueId: "acme/widget#42" } })),
      q.enqueue(prInput({ data: { issueId: "acme/widget#42", commitSha: BRANCH } })),
      q.enqueue(prInput({ data: { issueId: "acme/widget#42", commitSha: "c0ffee1" } })),
      q.enqueue(fixInput({ commitSha: null })),
    ]
    for (const item of bad) {
      const res = await approve(c, item, git.deps)
      expect(res.ok).toBe(false)
      expect(res.status).toBe("pending")
      expect(res.message).toContain("no recorded commit")
      expect(c.store.getQueueItem(item.id)!.status).toBe("pending")
    }
    expect(git.pushes).toHaveLength(0)
    expect(c.github.writes).toHaveLength(0)
  })

  test("the digest binds the commit: a commit swapped after review is refused", async () => {
    const { c, q } = setup({ config: { mode: "queue" } })
    const item = q.enqueue(prInput())
    expect(item.digest).toBe(computeDigest(item))
    expect(item.digest).not.toBe(computeDigest({ ...item, commitSha: null }))
    c.store.saveQueueItem({ ...item, data: { ...item.data, commitSha: "f".repeat(40) } })
    const git = fakeGit()
    const res = await approve(c, item, git.deps)
    expect(res.ok).toBe(false)
    expect(res.message).toContain("no longer matches its digest")
    expect(git.pushes).toHaveLength(0)
    expect(c.github.writes).toHaveLength(0)
  })

  test("an item queued before digests covered the commit is re-bound and must be reviewed again", async () => {
    const { c, q } = setup({ config: { mode: "queue" } })
    const item = q.enqueue(prInput())
    const legacy = computeDigest({ ...item, commitSha: null })
    c.store.saveQueueItem({ ...item, digest: legacy })
    const git = fakeGit()
    const res = await approve(c, { ...item, digest: legacy }, git.deps)
    expect(res.ok).toBe(false)
    expect(res.status).toBe("pending")
    expect(res.message).toContain("Review it again")
    expect(res.message).not.toContain(item.digest.slice(0, 8))
    const rebound = c.store.getQueueItem(item.id)!
    expect(rebound.digest).toBe(computeDigest(rebound))
    expect(rebound.digest).not.toBe(legacy)
    expect(c.store.listAudit({ action: "queue.digest_rebind" })).toHaveLength(1)
    expect(git.pushes).toHaveLength(0)

    const ok = await approve(c, rebound, git.deps)
    expect(ok.status).toBe("submitted")
    expect(git.pushes[0]!.localRef).toBe(SHA)
  })
})

// ---------------------------------------------------------------------------
// concurrency: the caps check and the approval are one atomic step
// ---------------------------------------------------------------------------

describe("concurrent approvals", () => {
  const slowGitHub = () =>
    freshGitHub().set({
      getIssue: async (repo, n) => {
        await new Promise((r) => setTimeout(r, 15))
        return ghIssue({ number: n, html_url: `https://github.com/${repo}/issues/${n}` })
      },
    })
  const itemIn = (q: ApprovalQueue, repo: string) =>
    q.enqueue(prInput({ repo, issueUrl: `https://github.com/${repo}/issues/42`, data: { issueId: `${repo}#42`, commitSha: SHA } }))

  test("two approvals racing for the last weekly slot (CLI + slash command): exactly one PR is opened", async () => {
    const { c, q } = setup({ github: slowGitHub(), config: { mode: "queue", caps: { maxSubmittedPrsPerWeek: 1 } } })
    const a = itemIn(q, "acme/a")
    const b = itemIn(q, "acme/b")
    const git = fakeGit()
    const [ra, rb] = await Promise.all([
      approveQueueItemWith(c, { id: a.id, digest: digest8(a), via: "cli" }, git.deps),
      approveQueueItemWith(c, { id: b.id, digest: digest8(b), via: "command" }, git.deps),
    ])
    expect([ra.status, rb.status].sort()).toEqual(["pending", "submitted"])
    expect([ra, rb].find((r) => !r.ok)!.message).toContain("weekly PR cap")
    expect(c.github.writes.filter((w) => w.method === "createPull")).toHaveLength(1)
    expect(git.pushes).toHaveLength(1)
  })

  test("two approvals racing for the per-repo slot: one PR", async () => {
    const { c, q } = setup({ github: slowGitHub(), config: { mode: "queue" } })
    const a = itemIn(q, "acme/widget")
    const b = q.enqueue(prInput({ issueUrl: "https://github.com/acme/widget/issues/43", data: { issueId: "acme/widget#43", commitSha: SHA } }))
    const git = fakeGit()
    const [ra, rb] = await Promise.all([approve(c, a, git.deps), approve(c, b, git.deps)])
    expect([ra.status, rb.status].sort()).toEqual(["pending", "submitted"])
    expect([ra, rb].find((r) => !r.ok)!.message).toContain("open PR cap")
  })

  test("the same item approved twice at once is submitted once", async () => {
    const { c, q } = setup({ github: slowGitHub(), config: { mode: "queue" } })
    const item = q.enqueue(prInput())
    const git = fakeGit()
    const results = await Promise.all([approve(c, item, git.deps), approve(c, item, git.deps)])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(c.store.getQueueItem(item.id)!.status).toBe("submitted")
    expect(results.find((r) => !r.ok)!.message).toMatch(/changed while it was being approved|being submitted right now/)
    expect(c.github.writes.filter((w) => w.method === "createPull")).toHaveLength(1)
  })

  test("a submission running in another process blocks re-approval and reject until its lease expires; it counts toward caps", async () => {
    const { c, q } = setup({ config: { mode: "queue" } })
    const item = q.enqueue(prInput())
    c.store.saveQueueItem({ ...item, status: "approved", data: { ...item.data, submittingAt: c.clock.now() } })
    const git = fakeGit()
    const busy = await approve(c, item, git.deps)
    expect(busy.ok).toBe(false)
    expect(busy.message).toContain("being submitted right now")
    expect(busy.message).toContain("approve again after")
    expect(() => q.reject(item.id, "x", "human")).toThrow("running right now")
    const snap = capsSnapshot(c.store, c.config, c.clock.now())
    expect(snap.submittedLast7Days).toBe(1)
    expect(snap.inFlightByRepo).toEqual({ "acme/widget": 1 })
    expect(git.pushes).toHaveLength(0)

    c.clock.advance(SUBMISSION_LEASE_MS)
    expect(q.reject(item.id, "gave up on it", "human").status).toBe("rejected")
  })
})

// ---------------------------------------------------------------------------
// interrupted submissions are never stuck
// ---------------------------------------------------------------------------

describe("interrupted submissions", () => {
  const interrupt = (c: TestContext, item: QueueItem) =>
    c.store.saveQueueItem({ ...item, status: "approved", data: { ...item.data, submittingAt: c.clock.now() - SUBMISSION_LEASE_MS - 1 } })

  test("a PR the interrupted submission had already opened is adopted: no write, no cap refusal", async () => {
    const pull = ghPull({
      number: 55,
      state: "open",
      merged_at: null,
      closed_at: null,
      html_url: "https://github.com/acme/widget/pull/55",
      head: { ref: BRANCH, sha: SHA, repo: { full_name: "me/widget" } },
    })
    const gh = freshGitHub().set({
      listPulls: async () => [pull],
      // the external sync already saw the PR (as "yours, opened outside oss-scout")
      searchIssues: async () => [
        ghIssue({
          number: 55,
          html_url: "https://github.com/acme/widget/pull/55",
          repository_url: "https://api.github.com/repos/acme/widget",
          pull_request: { html_url: "https://github.com/acme/widget/pull/55" },
        }),
      ],
    })
    const { c, q } = setup({ github: gh, config: { mode: "queue" } })
    c.store.upsertIssue(issueRecord())
    const item = q.enqueue(prInput())
    interrupt(c, item)
    const git = fakeGit()
    const res = await approve(c, item, git.deps)
    expect(res).toMatchObject({ ok: true, status: "submitted", url: "https://github.com/acme/widget/pull/55" })
    expect(c.github.writes).toHaveLength(0)
    expect(git.pushes).toHaveLength(0)
    const tracked = c.store.getPr("acme/widget#55")!
    expect(tracked.queueItemId).toBe(item.id)
    expect(tracked.data.external).toBeUndefined()
    expect(c.store.getIssue("acme/widget#42")!.status).toBe("done")
    expect(c.store.getQueueItem(item.id)!.data.submittingAt).toBeUndefined()
  })

  test("an interrupted submission that now hits a cap moves to failed (out of the caps) and can be rejected", async () => {
    const { c, q } = setup({ config: { mode: "queue", caps: { maxSubmittedPrsPerWeek: 1 } } })
    const old = q.enqueue(prInput({ repo: "other/repo" }))
    c.store.saveQueueItem({ ...old, status: "submitted", decidedAt: c.clock.now() - 1000 })
    const item = q.enqueue(prInput())
    interrupt(c, item)
    const res = await approve(c, item, fakeGit().deps)
    expect(res.ok).toBe(false)
    expect(res.status).toBe("failed")
    expect(res.message).toContain("weekly PR cap")
    expect(res.message).toContain(`/oss-reject ${item.id}`)
    expect(c.store.getQueueItem(item.id)!.status).toBe("failed")
    expect(capsSnapshot(c.store, c.config, c.clock.now()).inFlightByRepo).toEqual({})
    expect(q.reject(item.id, "not this week", "human").status).toBe("rejected")
  })

  test("an interrupted item whose issue went stale is superseded instead of staying approved", async () => {
    const gh = freshGitHub().set({ getIssue: async () => ghIssue({ state: "closed", state_reason: "completed" }) })
    const { c, q } = setup({ github: gh, config: { mode: "queue" } })
    const item = q.enqueue(prInput())
    interrupt(c, item)
    const res = await approve(c, item, fakeGit().deps)
    expect(res.status).toBe("superseded")
    expect(c.store.getQueueItem(item.id)!.status).toBe("superseded")
  })
})

// ---------------------------------------------------------------------------
// the repo is re-checked at approval
// ---------------------------------------------------------------------------

function repoRecord(over: Partial<RepoRecord> = {}): RepoRecord {
  return { ...repoWithFlags("acme/widget"), ...over }
}

describe("repo no longer allowed at approval", () => {
  const prohibited = repoRecord({
    policy: {
      ...repoWithFlags("acme/widget").policy!,
      ai: { classification: "prohibited", evidence: [], requiresDisclosure: false, notes: [] },
    },
  })
  const cases: Array<{ name: string; config?: ConfigInput; repo: RepoRecord; reason: string }> = [
    { name: "re-screened to an AI ban", repo: prohibited, reason: "AI policy prohibits" },
    { name: "skipped by a re-screen", repo: repoRecord({ status: "skipped", skipReason: "no maintainer activity in 180 days" }), reason: "is now skipped" },
    { name: "deny-listed in config", config: { repos: { deny: ["acme/*"] } }, repo: repoRecord(), reason: "denied by config" },
  ]
  for (const k of cases) {
    test(`PR item, ${k.name}: superseded, issue skipped for good, nothing touches GitHub`, async () => {
      const { c, q } = setup({ config: { mode: "queue", ...(k.config ?? {}) } })
      c.store.saveRepo(k.repo)
      c.store.upsertIssue(issueRecord())
      const item = q.enqueue(prInput())
      const git = fakeGit()
      const res = await approve(c, item, git.deps)
      expect(res.ok).toBe(false)
      expect(res.status).toBe("superseded")
      expect(res.message).toContain(k.reason)
      expect(c.store.getQueueItem(item.id)!.status).toBe("superseded")
      expect(c.store.getIssue("acme/widget#42")!.status).toBe("skipped")
      expect(c.store.isIssueSticky("acme/widget#42")).toBe(true)
      expect(c.github.calls).toHaveLength(0)
      expect(c.github.writes).toHaveLength(0)
      expect(git.pushes).toHaveLength(0)
    })
  }

  test("follow-ups on your open PR: an AI ban blocks fix and reply items; a skip for other reasons does not", async () => {
    const { c, q } = setup({ github: openPullGitHub(), config: { mode: "queue" } })
    c.store.upsertPr(trackedPr())
    c.store.saveRepo(repoRecord({ status: "skipped", skipReason: "merge rate too low" }))
    const git = fakeGit()
    expect((await approve(c, q.enqueue(fixInput()), git.deps)).status).toBe("submitted")

    c.store.saveRepo(prohibited)
    const fix = await approve(c, q.enqueue(fixInput()), git.deps)
    expect(fix.status).toBe("superseded")
    const reply = q.enqueue(fixInput({ commitSha: undefined }))
    c.store.saveQueueItem({ ...reply, kind: "reply", digest: computeDigest({ ...reply, kind: "reply" }) })
    const replied = await approve(c, c.store.getQueueItem(reply.id)!, git.deps)
    expect(replied.status).toBe("superseded")
    expect(git.pushes).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// live look at your PRs in the repo at approval (queue mode)
// ---------------------------------------------------------------------------

describe("approval-time PR lookup", () => {
  test("a PR you opened by hand in the repo blocks the approval (per-repo cap) even before the periodic sync", async () => {
    const gh = freshGitHub().set({
      searchIssues: async () => [
        ghIssue({
          number: 9,
          state: "open",
          html_url: "https://github.com/acme/widget/pull/9",
          repository_url: "https://api.github.com/repos/acme/widget",
          pull_request: { html_url: "https://github.com/acme/widget/pull/9" },
        }),
      ],
    })
    const { c, q } = setup({ github: gh, config: { mode: "queue" } })
    const git = fakeGit()
    const res = await approve(c, q.enqueue(prInput()), git.deps)
    expect(res.ok).toBe(false)
    expect(res.status).toBe("pending")
    expect(res.message).toContain("open PR cap")
    expect(c.github.calls.find((x) => x.method === "searchIssues")!.args[0]).toBe("is:pr author:me repo:acme/widget")
    expect(c.store.getPr("acme/widget#9")).toMatchObject({ state: "open", data: { external: true } })
    expect(git.pushes).toHaveLength(0)
  })

  test("a PR of yours merged 3 days ago starts the cooldown", async () => {
    const gh = freshGitHub().set({
      searchIssues: async () => [
        ghIssue({
          number: 8,
          state: "closed",
          closed_at: "2026-01-12T12:00:00Z",
          html_url: "https://github.com/acme/widget/pull/8",
          repository_url: "https://api.github.com/repos/acme/widget",
          pull_request: { html_url: "https://github.com/acme/widget/pull/8", merged_at: "2026-01-12T12:00:00Z" },
        }),
      ],
    })
    const { c, q } = setup({ github: gh, config: { mode: "queue" } })
    const res = await approve(c, q.enqueue(prInput()), fakeGit().deps)
    expect(res.ok).toBe(false)
    expect(res.message).toContain("cooldown until 2026-02-11")
    expect(c.store.getPr("acme/widget#8")).toMatchObject({ state: "merged", mergedAt: Date.UTC(2026, 0, 12, 12) })
  })

  test("a failing lookup refuses the approval (nothing written)", async () => {
    const gh = freshGitHub().set({
      searchIssues: async () => {
        throw new Error("search unavailable")
      },
    })
    const { c, q } = setup({ github: gh, config: { mode: "queue" } })
    const res = await approve(c, q.enqueue(prInput()), fakeGit().deps)
    expect(res.ok).toBe(false)
    expect(res.message).toContain("could not check your pull requests in acme/widget")
    expect(c.github.writes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// reply retries never post twice
// ---------------------------------------------------------------------------

describe("reply retries", () => {
  test("GitHub accepted the comment but the response timed out: the retry finds it and does not post again", async () => {
    const posted: GhComment[] = []
    const gh = freshGitHub().set({
      createIssueComment: async (_a, _r, n, body) => {
        posted.push(ghComment({ id: 77, body, user: ghUser("me"), created_at: "2026-01-15T12:00:01Z", html_url: `${PR_URL}#issuecomment-77` }))
        throw new GitHubError("Gateway Timeout", 504)
      },
      listIssueComments: async () => [ghComment({ id: 70, body: "unrelated", user: ghUser("maintainer") }), ...posted],
    })
    const { c, q } = setup({ github: gh, config: { mode: "queue" } })
    const item = q.enqueue(
      prInput({ kind: "reply", issueUrl: null, prUrl: PR_URL, taskId: null, body: "Thanks! Updated.", diff: "", branch: null, baseBranch: null, data: { prNumber: 101, prId: "acme/widget#101" } }),
    )
    const first = await approve(c, item, fakeGit().deps)
    expect(first.status).toBe("failed")
    expect(c.store.getQueueItem(item.id)!.data.replyAttemptAt).toBe(c.clock.now())
    expect(c.github.writes).toHaveLength(1)

    gh.set({
      createIssueComment: async () => {
        throw new Error("must not post twice")
      },
    })
    c.clock.advance(60_000)
    const retry = await approve(c, c.store.getQueueItem(item.id)!, fakeGit().deps)
    expect(retry).toMatchObject({ ok: true, status: "submitted", url: `${PR_URL}#issuecomment-77` })
    expect(retry.actions[0]).toContain("already posted by an earlier attempt")
    expect(c.github.writes).toHaveLength(1)
  })

  test("a first attempt does not look for earlier comments", async () => {
    const { c, q } = setup({ config: { mode: "queue" } })
    const item = q.enqueue(
      prInput({ kind: "reply", issueUrl: null, prUrl: PR_URL, taskId: null, body: "Thanks!", diff: "", branch: null, baseBranch: null, data: { prNumber: 101 } }),
    )
    expect((await approve(c, item, fakeGit().deps)).status).toBe("submitted")
    expect(c.github.calls.some((x) => x.method === "listIssueComments")).toBe(false)
  })
})
