import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ConfigInput } from "../src/config/schema.ts"
import type { AppContext } from "../src/core/context.ts"
import type {
  CommandRun,
  CriticVerdict,
  ImplementationOutput,
  IssueRecord,
  ProjectInfo,
  RepoMetrics,
  RepoPolicy,
  RepoRecord,
  TaskRecord,
  TrackedPr,
  VerificationReport,
} from "../src/core/types.ts"
import { KilledError, RateLimitError } from "../src/github/api.ts"
import type { ImplementationInput, ImplementationOutcome } from "../src/implement/implementer.ts"
import type { Usage } from "../src/llm/host.ts"
import type { EnqueueInput } from "../src/queue/queue.ts"
import { nextUtcMidnight } from "../src/scheduler/budget.ts"
import { AI_POLICY_FLAG_NOTES } from "../src/screening/policy.ts"
import {
  abortFollowupTasksForPr,
  advanceTask,
  backoffDelayMs,
  EXTERNAL_RETRY_MS,
  GITHUB_PAUSED_KEY,
  INTERRUPTED,
  LLM_UNAVAILABLE,
  startContributionTask,
  startFollowupFixTask,
  type PipelineDeps,
} from "../src/scheduler/pipeline.ts"
import { DAY, MINUTE, utcDay } from "../src/util/clock.ts"
import type { GitPaths, SafeGit } from "../src/workspace/git.ts"
import type { PreparedWorkspace } from "../src/workspace/workspace.ts"
import { SandboxUnavailableError } from "../src/workspace/sandbox.ts"
import { makeTestContext, type TestContext } from "./helpers/fakes.ts"

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0)
const REPO = "acme/widget"
const ISSUE_ID = "acme/widget#42"

function policy(over: Partial<RepoPolicy> = {}): RepoPolicy {
  return {
    ai: { classification: "none_found", evidence: [], requiresDisclosure: false, notes: [] },
    contributingFile: "CONTRIBUTING.md",
    contributingExcerpt: "Run npm test.",
    codeOfConductFile: null,
    prTemplatePath: null,
    prTemplate: null,
    requiresSignoff: false,
    requiresCla: true,
    requiresIssueFirst: false,
    reservesGoodFirstIssues: false,
    commitConvention: "conventional",
    notes: ["Run npm test before sending"],
    ...over,
  }
}

function metrics(over: Partial<RepoMetrics> = {}): RepoMetrics {
  return {
    stars: 1200,
    forks: 150,
    archived: false,
    disabled: false,
    isFork: false,
    license: "MIT",
    defaultBranch: "main",
    language: "TypeScript",
    topics: [],
    pushedAt: null,
    hasIssues: true,
    pullRequestsEnabled: true,
    prCreationPolicy: "all",
    allowForking: true,
    webCommitSignoffRequired: false,
    lastMaintainerActivityAt: null,
    outsidePrSample: 10,
    outsidePrMerged: 6,
    outsideMergeRate: 0.6,
    medianFirstResponseHours: 12,
    firstResponseSample: 5,
    openPrCount: 3,
    staleOpenPrCount: 0,
    hasCi: true,
    ciProviders: ["github-actions"],
    ...over,
  }
}

function repoRecord(over: Partial<RepoRecord> = {}): RepoRecord {
  return {
    fullName: REPO,
    source: "search",
    sourceDetail: "search: topic:react",
    status: "eligible",
    score: 0.8,
    reasons: ["active maintainers"],
    skipReason: null,
    policy: policy(),
    metrics: null,
    discoveredAt: T0,
    screenedAt: T0,
    nextScreenAt: T0 + DAY,
    ...over,
  }
}

function issueRecord(over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: ISSUE_ID,
    repo: REPO,
    number: 42,
    title: "Crash when options.timeout is 0",
    url: "https://github.com/acme/widget/issues/42",
    body: "Steps to reproduce: createClient({ timeout: 0 })",
    labels: ["bug"],
    createdAt: "2026-01-05T09:00:00Z",
    updatedAt: "2026-01-10T09:00:00Z",
    comments: 2,
    kind: "bug",
    status: "selected",
    score: 0.82,
    reasons: ["clear reproduction steps"],
    skipReason: null,
    fetchedAt: T0,
    ...over,
  }
}

function project(over: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    ecosystem: "node",
    packageManager: "npm",
    image: "node:22-bookworm",
    install: "npm ci",
    test: "npm test",
    lint: null,
    testFilePatterns: [],
    notes: [],
    ...over,
  }
}

function run(label: CommandRun["label"], exitCode = 0, over: Partial<CommandRun> = {}): CommandRun {
  return {
    label,
    command: label === "install" ? "npm ci" : label === "lint" ? "npm run lint" : "npm test",
    exitCode,
    timedOut: false,
    durationMs: 1200,
    outputTail: `${label} output (exit ${exitCode})`,
    network: label === "install" ? "bridge" : "none",
    at: T0,
    ...over,
  }
}

function implOutput(over: Partial<ImplementationOutput> = {}): ImplementationOutput {
  return {
    summary: "Guard against a zero timeout before creating the abort controller.",
    commitMessage: "fix: handle zero timeout",
    prTitle: "fix: handle zero timeout",
    prBody: "## Summary\nHandle `timeout: 0` without crashing.",
    testFiles: ["test/timeout.test.ts"],
    reproduced: true,
    diff: "diff --git a/src/client.ts b/src/client.ts\n--- a/src/client.ts\n+++ b/src/client.ts\n@@ -1 +1 @@\n-a\n+b\n",
    diffStat: { files: [], additions: 1, deletions: 1 },
    commitSha: "c0ffee1",
    baseSha: "base123",
    finalTestRun: run("test"),
    finalLintRun: run("lint"),
    ...over,
  }
}

const APPROVE: CriticVerdict = {
  verdict: "approve",
  confidence: 0.9,
  reasons: ["focused fix with a regression test"],
  requiredChanges: [],
  model: "fake/critic",
  raw: "{}",
}

const USAGE: Usage = { inputTokens: 1000, outputTokens: 200, costUsd: 0.01, estimated: false }
const CRITIC_USAGE: Usage = { inputTokens: 500, outputTokens: 100, costUsd: 0.005, estimated: false }

// ---------------------------------------------------------------------------
// harness: every collaborator is a fake
// ---------------------------------------------------------------------------

/** Branch resets the pipeline asked for (follow-up fixes in a reused workspace). */
const resets: string[] = []
const fakeGit = {
  resetHard: async (ref: string) => {
    resets.push(ref)
  },
} as unknown as SafeGit

function pathsFor(ctx: AppContext, taskId: string): GitPaths {
  const taskDir = join(ctx.paths.workspacesDir, taskId)
  return {
    taskDir,
    workTree: join(taskDir, "repo"),
    gitDir: join(ctx.paths.gitDirsDir, taskId),
    hooksDir: ctx.paths.emptyHooksDir,
    globalConfig: ctx.paths.emptyGitConfig,
  }
}

interface Harness {
  ctx: TestContext
  deps: Partial<PipelineDeps>
  prepared: Array<Parameters<PipelineDeps["prepareWorkspace"]>[1]>
  opened: string[]
  commands: Array<{ label: string; command: string; taskId: string }>
  implInputs: ImplementationInput[]
  gateInputs: Array<Parameters<PipelineDeps["runVerificationGate"]>[0]>
  criticInputs: Array<Parameters<PipelineDeps["runCritic"]>[1]>
  enqueued: EnqueueInput[]
  /** Overridable behaviors. */
  commandResult: (label: CommandRun["label"]) => CommandRun | Promise<CommandRun>
  implementation: (input: ImplementationInput) => ImplementationOutcome | Promise<ImplementationOutcome>
  gate: () => VerificationReport
  critic: () => CriticVerdict
}

const contexts: TestContext[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const c of contexts.splice(0)) c.cleanup()
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  resets.length = 0
})

function harness(opts: { llm?: null; config?: ConfigInput } = {}): Harness {
  const ctx = makeTestContext({ ...(opts.llm === null ? { llm: null } : {}), ...(opts.config ? { config: opts.config } : {}) })
  contexts.push(ctx)
  ctx.store.saveRepo(repoRecord())
  ctx.store.upsertIssue(issueRecord())

  const h: Harness = {
    ctx,
    deps: {},
    prepared: [],
    opened: [],
    commands: [],
    implInputs: [],
    gateInputs: [],
    criticInputs: [],
    enqueued: [],
    commandResult: (label) => run(label),
    implementation: () => ({ ok: true, output: implOutput(), usage: USAGE, attemptsUsed: 1 }),
    gate: () => ({ passed: true, checks: [{ name: "tests pass", status: "pass", detail: "npm test exit 0" }] }),
    critic: () => APPROVE,
  }

  h.deps = {
    prepareWorkspace: async (c, input): Promise<PreparedWorkspace> => {
      h.prepared.push(input)
      const paths = pathsFor(c, input.task.id)
      return {
        taskDir: paths.taskDir,
        paths,
        git: fakeGit,
        project: project(),
        branch: input.branch,
        baseBranch: input.baseBranch,
        baseSha: "base123",
        convention: "conventional",
      }
    },
    openWorkspace: (c, task) => {
      h.opened.push(task.id)
      return { paths: pathsFor(c, task.id), git: fakeGit }
    },
    runProjectCommand: async (_c, input) => {
      h.commands.push({ label: input.label, command: input.command, taskId: input.taskId })
      return h.commandResult(input.label)
    },
    runImplementation: async (_c, input) => {
      h.implInputs.push(input)
      return h.implementation(input)
    },
    runVerificationGate: (input) => {
      h.gateInputs.push(input)
      return h.gate()
    },
    runCritic: async (_c, input) => {
      h.criticInputs.push(input)
      return { verdict: h.critic(), usage: CRITIC_USAGE }
    },
    buildPrBody: (input) =>
      [input.drafted, input.closingReference && input.issue ? `Fixes #${input.issue.number}` : "", `Testing: ${input.testSummary}`, `---\n${input.disclosureLine}`]
        .filter(Boolean)
        .join("\n\n"),
    criticAccepts: (v, config) => v.verdict === "approve" && v.confidence >= config.critic.minConfidence && v.requiredChanges.length === 0,
    createQueue: (c) => ({
      enqueue: (input) => {
        h.enqueued.push(input)
        const now = c.clock.now()
        return c.store.insertQueueItem({
          kind: input.kind,
          status: "pending",
          repo: input.repo,
          issueUrl: input.issueUrl,
          prUrl: input.prUrl,
          taskId: input.taskId,
          title: input.title,
          body: input.body,
          diff: input.diff,
          testOutput: input.testOutput,
          critic: input.critic,
          verification: input.verification,
          branch: input.branch,
          workspace: input.workspace,
          baseBranch: input.baseBranch,
          digest: "abcdef0123456789abcdef",
          createdAt: now,
          updatedAt: now,
          decidedAt: null,
          decisionReason: null,
          submittedUrl: null,
          error: null,
          data: input.data ?? {},
        })
      },
    }),
  }
  return h
}

function start(h: Harness): TaskRecord {
  return startContributionTask(h.ctx, h.ctx.store.getRepo(REPO)!, h.ctx.store.getIssue(ISSUE_ID)!)
}

/** Task positioned at `stage` with the data earlier stages would have produced. */
function taskAt(h: Harness, stage: TaskRecord["stage"], over: Partial<TaskRecord> = {}): TaskRecord {
  const base = start(h)
  const data: TaskRecord["data"] = { project: project(), baseBranch: "main", baseSha: "base123", convention: "conventional" }
  const order = ["prepare", "baseline", "implement", "verify", "critic", "enqueue", "done"]
  const idx = order.indexOf(stage)
  if (idx >= order.indexOf("verify")) data.implementation = implOutput()
  if (idx >= order.indexOf("critic")) {
    data.prTitle = "fix: handle zero timeout"
    data.prBody = `body\n\n---\n${h.ctx.config.disclosure.line}`
    data.verification = { passed: true, checks: [] }
  }
  if (idx >= order.indexOf("enqueue")) data.critic = APPROVE
  const task: TaskRecord = {
    ...base,
    stage,
    workspace: join(h.ctx.paths.workspacesDir, base.id),
    branch: "oss-scout/42-crash-when-options-timeout-is-0",
    data: { ...data, ...(over.data ?? {}) },
    ...over,
  }
  if (over.data) task.data = { ...data, ...over.data }
  h.ctx.store.saveTask(task)
  return task
}

async function step(h: Harness, task: TaskRecord): Promise<TaskRecord> {
  return advanceTask(h.ctx, task, h.deps)
}

function audits(h: Harness, action: string) {
  return h.ctx.store.listAudit({ action })
}

// ---------------------------------------------------------------------------
// task creation
// ---------------------------------------------------------------------------

describe("startContributionTask", () => {
  test("creates a durable task at stage prepare and audits the decision", () => {
    const h = harness()
    const task = start(h)
    expect(task.id).toMatch(/^task_/)
    expect(task).toMatchObject({
      kind: "contribution",
      repo: REPO,
      issueId: ISSUE_ID,
      prId: null,
      stage: "prepare",
      status: "active",
      attempts: 0,
      failures: 0,
      nextRunAt: T0,
      data: {},
    })
    expect(h.ctx.store.getTask(task.id)).toEqual(task)
    const [entry] = audits(h, "task.start")
    expect(entry?.subject).toBe(ISSUE_ID)
    expect(entry?.reasons).toContain("score 0.82")
    expect(entry?.reasons).toContain("clear reproduction steps")
    expect(entry?.details.taskId).toBe(task.id)
  })
})

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

describe("advanceTask: happy path", () => {
  test("prepare → baseline → implement → verify → critic → enqueue → done, one stage per call, one queue item", async () => {
    const h = harness()
    let task = start(h)
    const stages: string[] = [task.stage]
    for (let i = 0; i < 10 && task.status === "active"; i++) {
      task = await step(h, task)
      stages.push(task.stage)
      expect(h.ctx.store.getTask(task.id)).toEqual(task)
    }
    expect(stages).toEqual(["prepare", "baseline", "implement", "verify", "critic", "enqueue", "done"])
    expect(task.status).toBe("done")
    expect(task.failures).toBe(0)

    // prepare: upstream clone, default branch, task branch
    expect(h.prepared).toHaveLength(1)
    expect(h.prepared[0]!.cloneUrl).toBe("https://github.com/acme/widget.git")
    expect(h.prepared[0]!.baseBranch).toBe("main")
    expect(h.prepared[0]!.branch).toBe("oss-scout/42-crash-when-options-timeout-is-0")
    expect(task.workspace).toBe(join(h.ctx.paths.workspacesDir, task.id))
    expect(task.data.baseSha).toBe("base123")
    expect(task.data.convention).toBe("conventional")

    // baseline: install then test in the sandbox
    expect(h.commands.map((c) => c.label)).toEqual(["install", "test"])
    expect(task.data.baseline?.map((r) => r.label)).toEqual(["install", "test"])

    // implement: workspace view rebuilt from persisted data
    const implIn = h.implInputs[0]!
    expect(implIn.workspace.baseSha).toBe("base123")
    expect(implIn.workspace.branch).toBe(task.branch!)
    expect(implIn.workspace.taskDir).toBe(task.workspace!)
    expect(implIn.attemptsUsed).toBe(0)
    expect(implIn.issue?.id).toBe(ISSUE_ID)

    // usage recorded once for the implementation and once for the critic
    expect(task.tokensUsed).toBe(1200 + 600)
    expect(task.costUsd).toBeCloseTo(0.015)
    expect(h.ctx.store.getUsage(utcDay(T0))).toMatchObject({ tokens: 1800, calls: 2 })

    // verify: PR body carries the disclosure + closing reference + test summary
    const body = String(task.data.prBody)
    expect(body).toContain(h.ctx.config.disclosure.line)
    expect(body).toContain("Fixes #42")
    expect(body).toContain("npm test → exit 0 (sandboxed, network none)")
    expect(h.gateInputs[0]!.prBody).toBe(body)
    expect(h.gateInputs[0]!.issueKind).toBe("bug")

    // critic
    expect(h.criticInputs[0]!.prBody).toBe(body)
    expect(h.criticInputs[0]!.testOutput).toContain("npm test")
    const [review] = audits(h, "critic.review")
    expect(review).toMatchObject({ actor: "critic", decision: "approve" })

    // enqueue
    expect(h.enqueued).toHaveLength(1)
    const q = h.enqueued[0]!
    expect(q).toMatchObject({
      kind: "pr",
      repo: REPO,
      issueUrl: "https://github.com/acme/widget/issues/42",
      prUrl: null,
      taskId: task.id,
      title: "fix: handle zero timeout",
      body,
      branch: task.branch,
      workspace: task.workspace,
      baseBranch: "main",
    })
    expect(q.testOutput).toContain("npm test")
    expect(q.testOutput).toContain("npm run lint")
    expect(q.data).toMatchObject({ issueId: ISSUE_ID, requiresCla: true, requiresIssueFirst: false, requiresSignoff: false })
    expect(q.data?.policyNotes).toEqual(["Run npm test before sending"])
    expect(task.data.queueItemId).toBe(h.ctx.store.listQueue()[0]!.id)
    expect(h.ctx.store.listQueue()).toHaveLength(1)
    expect(audits(h, "task.done")).toHaveLength(1)

    // safety: nothing was written to GitHub
    expect(h.ctx.github.writes).toHaveLength(0)
    expect(h.ctx.github.calls).toHaveLength(0)
  })

  test("prepare uses the repo's default branch from metrics", async () => {
    const h = harness()
    h.ctx.store.saveRepo(repoRecord({ metrics: metrics({ defaultBranch: "develop" }) }))
    const task = await step(h, start(h))
    expect(h.prepared[0]!.baseBranch).toBe("develop")
    expect(task.data.baseBranch).toBe("develop")
  })

  test("waiting tasks become active again when their stage runs", async () => {
    const h = harness()
    const task = taskAt(h, "verify", { status: "waiting" })
    const next = await step(h, task)
    expect(next).toMatchObject({ stage: "critic", status: "active", lastError: null })
  })

  test("terminal tasks are returned unchanged", async () => {
    const h = harness()
    const task = taskAt(h, "verify", { status: "aborted", abortReason: "x" })
    expect(await step(h, task)).toBe(task)
    expect(h.gateInputs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

describe("advanceTask: enqueue idempotency", () => {
  test("an enqueue stage that already queued just finishes (no second item)", async () => {
    const h = harness()
    const task = taskAt(h, "enqueue")
    const done = await step(h, task)
    expect(done.status).toBe("done")
    expect(h.enqueued).toHaveLength(1)

    const again = await step(h, { ...done, stage: "enqueue", status: "active" })
    expect(again).toMatchObject({ stage: "done", status: "done", data: { queueItemId: done.data.queueItemId } })
    expect(h.enqueued).toHaveLength(1)
    expect(h.ctx.store.listQueue()).toHaveLength(1)
  })

  test("carries the repo's AI-policy flags, their notes and requiresHumanText into the queue item", async () => {
    const h = harness()
    const ai: RepoPolicy["ai"] = {
      classification: "disclosure_required",
      evidence: [],
      requiresDisclosure: true,
      notes: [
        "free-form note",
        `ai:human_written_text_only: ${AI_POLICY_FLAG_NOTES.human_written_text_only}`,
        `ai:assisted_by_trailer: ${AI_POLICY_FLAG_NOTES.assisted_by_trailer}`,
      ],
    }
    h.ctx.store.saveRepo(repoRecord({ policy: policy({ ai }) }))
    await step(h, taskAt(h, "enqueue"))
    const data = h.enqueued[0]!.data!
    expect(data.aiPolicy).toBe("disclosure_required")
    expect(data.aiPolicyFlags).toEqual(["human_written_text_only", "assisted_by_trailer"])
    expect(data.aiPolicyNotes).toEqual([AI_POLICY_FLAG_NOTES.human_written_text_only, AI_POLICY_FLAG_NOTES.assisted_by_trailer])
    expect(data.requiresHumanText).toBe(true)
  })

  test("no AI flags: empty lists and requiresHumanText false", async () => {
    const h = harness()
    await step(h, taskAt(h, "enqueue"))
    expect(h.enqueued[0]!.data).toMatchObject({ aiPolicy: "none_found", aiPolicyFlags: [], aiPolicyNotes: [], requiresHumanText: false })
  })

  test("a crash between enqueue and save adopts the existing queue item", async () => {
    const h = harness()
    const before = taskAt(h, "enqueue")
    const done = await step(h, before)
    // resume from the stale pre-enqueue record (as if the save never happened)
    const resumed = await step(h, before)
    expect(resumed.data.queueItemId).toBe(done.data.queueItemId)
    expect(h.enqueued).toHaveLength(1)
    expect(h.ctx.store.listQueue()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// waiting on external dependencies
// ---------------------------------------------------------------------------

describe("advanceTask: external dependencies", () => {
  test("sandbox unavailable → waiting 30 min without counting a failure", async () => {
    const h = harness()
    h.commandResult = () => {
      throw new SandboxUnavailableError("docker CLI not found")
    }
    const task = taskAt(h, "baseline")
    const next = await step(h, task)
    expect(next).toMatchObject({ stage: "baseline", status: "waiting", failures: 0, nextRunAt: T0 + EXTERNAL_RETRY_MS })
    expect(next.lastError).toContain("sandbox unavailable: docker CLI not found")
    expect(h.ctx.store.listErrors()).toHaveLength(0)
  })

  test("no LLM host → implementation waits", async () => {
    const h = harness({ llm: null })
    const next = await step(h, taskAt(h, "implement"))
    expect(next).toMatchObject({ stage: "implement", status: "waiting", failures: 0, lastError: LLM_UNAVAILABLE })
    expect(next.nextRunAt).toBe(T0 + 30 * MINUTE)
    expect(h.implInputs).toHaveLength(0)
  })

  test("no LLM host → critic waits", async () => {
    const h = harness({ llm: null })
    const next = await step(h, taskAt(h, "critic"))
    expect(next).toMatchObject({ stage: "critic", status: "waiting", lastError: LLM_UNAVAILABLE })
    expect(h.criticInputs).toHaveLength(0)
  })

  test("daily budget spent → waiting until the next UTC midnight", async () => {
    const h = harness()
    h.ctx.store.addUsage(utcDay(T0), h.ctx.config.budget.perDay.maxTokens, 0)
    const next = await step(h, taskAt(h, "implement"))
    expect(next).toMatchObject({ stage: "implement", status: "waiting", nextRunAt: nextUtcMidnight(T0) })
    expect(next.lastError).toContain("daily token budget spent")
    expect(h.implInputs).toHaveLength(0)
  })

  test("task budget spent → aborted", async () => {
    const h = harness()
    const task = taskAt(h, "critic", { tokensUsed: h.ctx.config.budget.perTask.maxTokens })
    const next = await step(h, task)
    expect(next.status).toBe("aborted")
    expect(next.abortReason).toContain("task token budget spent")
    expect(h.criticInputs).toHaveLength(0)
    expect(h.ctx.store.getIssue(ISSUE_ID)?.status).toBe("skipped")
  })

  test("injected budget check: day scope waits until retryAt", async () => {
    const h = harness()
    h.deps.checkBudget = () => ({ ok: false, scope: "day", retryAt: T0 + 5 * MINUTE, reason: "daily cost budget spent" })
    const next = await step(h, taskAt(h, "critic"))
    expect(next).toMatchObject({ status: "waiting", nextRunAt: T0 + 5 * MINUTE, lastError: "daily cost budget spent" })
  })
})

// ---------------------------------------------------------------------------
// implementation outcomes
// ---------------------------------------------------------------------------

describe("advanceTask: implement", () => {
  test("progress (attempts, attempt log, session id) is persisted immediately", async () => {
    const h = harness()
    let seenDuringRun: TaskRecord | null = null
    h.implementation = (input) => {
      input.onProgress({
        attemptsUsed: 1,
        attemptsLog: [{ attempt: 1, phase: "reproduce", ok: true, summary: "repro failed as expected", runs: [], at: T0 }],
        sessionId: "ses_1",
        usage: USAGE,
      })
      seenDuringRun = h.ctx.store.getTask(input.task.id)
      return { ok: true, output: implOutput(), usage: USAGE, attemptsUsed: 2 }
    }
    const next = await step(h, taskAt(h, "implement"))
    expect(seenDuringRun!.attempts).toBe(1)
    expect(seenDuringRun!.data.sessionId).toBe("ses_1")
    expect(seenDuringRun!.data.attemptsLog).toHaveLength(1)
    expect(next).toMatchObject({ stage: "verify", attempts: 2, tokensUsed: 1200 })
    expect(next.data.sessionId).toBe("ses_1")
    expect(next.data.implementation?.commitSha).toBe("c0ffee1")
  })

  test("the budget guard reports per-task overruns including pending usage", async () => {
    const h = harness()
    let guard: string | null = "unset"
    h.implementation = (input) => {
      guard = input.budgetGuard({ inputTokens: h.ctx.config.budget.perTask.maxTokens, outputTokens: 0, costUsd: 0, estimated: false })
      return { ok: true, output: implOutput(), usage: USAGE, attemptsUsed: 1 }
    }
    await step(h, taskAt(h, "implement"))
    expect(guard).toContain("task token budget spent")
  })

  test("non-retryable failure → aborted, issue skipped, audited", async () => {
    const h = harness()
    h.implementation = () => ({ ok: false, reason: "could not reproduce the bug after 3 attempts", retryable: false, usage: USAGE, attemptsUsed: 3 })
    const next = await step(h, taskAt(h, "implement"))
    expect(next).toMatchObject({ status: "aborted", abortReason: "could not reproduce the bug after 3 attempts", attempts: 3, tokensUsed: 1200 })
    const issue = h.ctx.store.getIssue(ISSUE_ID)!
    expect(issue.status).toBe("skipped")
    expect(issue.skipReason).toBe("could not reproduce the bug after 3 attempts")
    const [entry] = audits(h, "task.abort")
    expect(entry).toMatchObject({ decision: "skip", subject: ISSUE_ID, reasons: ["could not reproduce the bug after 3 attempts"] })
  })

  test("retryable failure → waiting with backoff (failures++)", async () => {
    const h = harness()
    h.implementation = () => ({ ok: false, reason: "agent session timed out", retryable: true, usage: USAGE, attemptsUsed: 1 })
    const next = await step(h, taskAt(h, "implement"))
    expect(next).toMatchObject({ stage: "implement", status: "waiting", failures: 1, lastError: "agent session timed out" })
    expect(next.nextRunAt).toBe(T0 + backoffDelayMs(1, h.ctx.config))
  })
})

// ---------------------------------------------------------------------------
// verify / critic
// ---------------------------------------------------------------------------

describe("advanceTask: verify and critic", () => {
  test("verification failure → aborted with the failing checks", async () => {
    const h = harness()
    h.gate = () => ({
      passed: false,
      checks: [
        { name: "tests pass", status: "pass", detail: "ok" },
        { name: "diff size", status: "fail", detail: "412 lines > 200" },
        { name: "secrets", status: "fail", detail: "possible token in src/a.ts" },
      ],
    })
    const next = await step(h, taskAt(h, "verify"))
    expect(next.status).toBe("aborted")
    expect(next.abortReason).toBe("verification gate failed: diff size (412 lines > 200); secrets (possible token in src/a.ts)")
    expect(next.data.verification?.passed).toBe(false)
    expect(h.criticInputs).toHaveLength(0)
  })

  test("the PR template is passed to the body builder and the gate", async () => {
    const h = harness()
    h.ctx.store.saveRepo(repoRecord({ policy: policy({ prTemplate: "## Description\n\n## Testing\n" }) }))
    let template = null as string | null
    const build = h.deps.buildPrBody!
    h.deps.buildPrBody = (input) => {
      template = input.template
      return build(input)
    }
    await step(h, taskAt(h, "verify"))
    expect(template).toBe("## Description\n\n## Testing\n")
    expect(h.gateInputs[0]!.prTemplate).toBe("## Description\n\n## Testing\n")
  })

  test("critic rejection → aborted with reasons and required changes; audited as reject", async () => {
    const h = harness()
    h.critic = () => ({
      verdict: "reject",
      confidence: 0.8,
      reasons: ["test does not fail without the fix"],
      requiredChanges: ["assert the thrown error"],
      model: "fake/critic",
      raw: "{}",
    })
    const next = await step(h, taskAt(h, "critic"))
    expect(next.status).toBe("aborted")
    expect(next.abortReason).toBe("critic rejected: test does not fail without the fix; required change: assert the thrown error")
    expect(next.data.critic?.verdict).toBe("reject")
    expect(next.tokensUsed).toBe(600)
    const [review] = audits(h, "critic.review")
    expect(review).toMatchObject({ actor: "critic", decision: "reject", reasons: ["test does not fail without the fix"] })
    expect(h.enqueued).toHaveLength(0)
  })

  test("a low-confidence approve is not enough", async () => {
    const h = harness()
    h.critic = () => ({ ...APPROVE, confidence: 0.4 })
    const next = await step(h, taskAt(h, "critic"))
    expect(next.status).toBe("aborted")
    expect(next.abortReason).toContain("confidence 0.40 below 0.70")
    expect(audits(h, "critic.review")[0]?.decision).toBe("reject")
  })
})

// ---------------------------------------------------------------------------
// baseline
// ---------------------------------------------------------------------------

describe("advanceTask: baseline", () => {
  test("a failing baseline test suite aborts the task", async () => {
    const h = harness()
    h.commandResult = (label) => run(label, label === "test" ? 1 : 0)
    const next = await step(h, taskAt(h, "baseline"))
    expect(next).toMatchObject({ status: "aborted", abortReason: "test suite fails before any change (baseline)" })
    expect(next.data.baseline).toHaveLength(2)
  })

  test("install failures back off and abort after three", async () => {
    const h = harness()
    h.commandResult = (label) => run(label, label === "install" ? 1 : 0)
    let task = taskAt(h, "baseline")
    task = await step(h, task)
    expect(task).toMatchObject({ status: "active", stage: "baseline", failures: 1 })
    expect(task.lastError).toContain("dependency install failed in sandbox")
    expect(task.nextRunAt).toBe(T0 + backoffDelayMs(1, h.ctx.config))
    task = await step(h, task)
    expect(task).toMatchObject({ status: "active", failures: 2 })
    task = await step(h, task)
    expect(task).toMatchObject({ status: "aborted", abortReason: "dependency install failed in sandbox" })
    expect(h.commands.filter((c) => c.label === "test")).toHaveLength(0)
  })

  test("no test command aborts code changes before touching the sandbox", async () => {
    const h = harness()
    const next = await step(h, taskAt(h, "baseline", { data: { project: project({ test: null }) } }))
    expect(next).toMatchObject({ status: "aborted", abortReason: "no test command detected" })
    expect(h.commands).toHaveLength(0)
  })

  test("docs issues may proceed without a test command", async () => {
    const h = harness()
    h.ctx.store.upsertIssue(issueRecord({ kind: "docs" }), { force: true })
    const next = await step(h, taskAt(h, "baseline", { data: { project: project({ test: null }) } }))
    expect(next).toMatchObject({ status: "active", stage: "implement" })
    expect(h.commands.map((c) => c.label)).toEqual(["install"])
  })

  test("missing repo/issue records abort the task", async () => {
    const h = harness()
    const task = start(h)
    h.ctx.store.db.query("DELETE FROM issues").run()
    const next = await step(h, task)
    expect(next).toMatchObject({ status: "aborted", abortReason: "repo/issue no longer in database" })
    expect(h.prepared).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// error handling
// ---------------------------------------------------------------------------

describe("advanceTask: errors", () => {
  test("RateLimitError → waiting until reset and GitHub paused", async () => {
    const h = harness()
    const resetAt = T0 + 15 * MINUTE
    h.deps.prepareWorkspace = async () => {
      throw new RateLimitError("API rate limit exceeded", resetAt, "core", false)
    }
    const next = await step(h, start(h))
    expect(next).toMatchObject({ stage: "prepare", status: "waiting", nextRunAt: resetAt, failures: 0 })
    expect(h.ctx.store.getKv<number>(GITHUB_PAUSED_KEY)).toBe(resetAt)
  })

  test("generic errors back off exponentially and fail the task after 5", async () => {
    const h = harness()
    h.deps.prepareWorkspace = async () => {
      throw new Error("git clone failed: connection reset")
    }
    let task = start(h)
    const delays: number[] = []
    for (let i = 1; i <= 4; i++) {
      task = await step(h, task)
      expect(task).toMatchObject({ status: "active", stage: "prepare", failures: i, lastError: "git clone failed: connection reset" })
      delays.push(task.nextRunAt - T0)
    }
    expect(delays).toEqual([60_000, 120_000, 240_000, 480_000])
    task = await step(h, task)
    expect(task).toMatchObject({ status: "failed", failures: 5 })
    expect(h.ctx.store.listErrors(10)).toHaveLength(5)
    expect(audits(h, "task.fail")).toHaveLength(1)
    expect(h.ctx.store.getIssue(ISSUE_ID)?.status).toBe("skipped")
    expect(h.ctx.store.isIssueSticky(ISSUE_ID)).toBe(true)
  })

  test("backoff is capped at backoffMaxSeconds", () => {
    const h = harness()
    expect(backoffDelayMs(30, h.ctx.config)).toBe(h.ctx.config.scheduler.backoffMaxSeconds * 1000)
  })

  test("a successful stage resets the failure counter", async () => {
    const h = harness()
    const task = taskAt(h, "verify", { failures: 3, lastError: "previous" })
    const next = await step(h, task)
    expect(next).toMatchObject({ stage: "critic", failures: 0, lastError: null })
  })

  test("KilledError leaves the task unchanged", async () => {
    const h = harness()
    h.deps.prepareWorkspace = async () => {
      throw new KilledError()
    }
    const task = start(h)
    const next = await step(h, task)
    expect(next).toEqual(task)
    expect(h.ctx.store.getTask(task.id)).toEqual(task)
  })

  test("kill switch engaged or mode off → unchanged, no stage runs", async () => {
    const h = harness()
    const task = start(h)
    h.ctx.kill.engage("testing", T0)
    expect(await step(h, task)).toBe(task)
    h.ctx.kill.release()

    const off = makeTestContext({ config: { mode: "off" } })
    contexts.push(off)
    expect(await advanceTask(off, task, h.deps)).toBe(task)
    expect(h.prepared).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// follow-up fixes
// ---------------------------------------------------------------------------

function trackedPr(over: Partial<TrackedPr> = {}): TrackedPr {
  return {
    id: "acme/widget#101",
    repo: REPO,
    number: 101,
    url: "https://github.com/acme/widget/pull/101",
    queueItemId: null,
    branch: "oss-scout/42-crash-when-options-timeout-is-0",
    headRepo: "me/widget",
    state: "open",
    openedAt: T0 - DAY,
    closedAt: null,
    mergedAt: null,
    lastPolledAt: null,
    lastSeenActivityAt: null,
    data: {},
    ...over,
  }
}

describe("follow-up fix tasks", () => {
  test("without a reusable workspace: clone the fork's PR branch and run the full pipeline into a fix item", async () => {
    const h = harness()
    const pr = trackedPr()
    let task = startFollowupFixTask(h.ctx, pr, "Please also handle negative timeouts.")
    expect(task).toMatchObject({ kind: "followup_fix", repo: REPO, prId: pr.id, stage: "prepare", branch: pr.branch, issueId: null })
    expect(task.data).toMatchObject({ feedback: "Please also handle negative timeouts.", headRepo: "me/widget", prNumber: 101 })
    expect(audits(h, "task.start")[0]?.subject).toBe(pr.id)

    for (let i = 0; i < 10 && task.status === "active"; i++) task = await step(h, task)
    expect(task.status).toBe("done")
    expect(h.prepared[0]).toMatchObject({ cloneUrl: "https://github.com/me/widget.git", branch: pr.branch, baseBranch: pr.branch, issue: null })
    expect(h.implInputs[0]!.feedback).toBe("Please also handle negative timeouts.")
    expect(h.criticInputs[0]!.feedback).toBe("Please also handle negative timeouts.")
    expect(h.gateInputs[0]!.prTemplate).toBeNull()

    const q = h.enqueued[0]!
    expect(q.kind).toBe("fix")
    expect(q.prUrl).toBe(pr.url)
    expect(q.data).toMatchObject({ prNumber: 101, headRepo: "me/widget", remoteBranch: pr.branch })
    expect(q.body).toContain(h.ctx.config.disclosure.line)
    expect(q.body).not.toContain("Fixes #")
    // aborting a follow-up never touches the original issue
    expect(h.ctx.store.getIssue(ISSUE_ID)?.status).toBe("selected")
  })

  test("reuses the original task's workspace when it still exists (starts at implement)", async () => {
    const h = harness()
    const workspace = mkdtempSync(join(tmpdir(), "oss-scout-ws-"))
    tempDirs.push(workspace)
    const original = taskAt(h, "done", { status: "done", workspace })
    const item = h.deps.createQueue!(h.ctx).enqueue({
      kind: "pr",
      repo: REPO,
      issueUrl: null,
      prUrl: null,
      taskId: original.id,
      title: "t",
      body: "b",
      diff: "",
      testOutput: "",
      critic: null,
      verification: null,
      branch: original.branch,
      workspace,
      baseBranch: "main",
    })
    const pr = trackedPr({ queueItemId: item.id })

    let task = startFollowupFixTask(h.ctx, pr, "Rename the helper.")
    expect(task).toMatchObject({ stage: "implement", workspace, branch: original.branch, issueId: ISSUE_ID })
    expect(task.data.reuseTaskId).toBe(original.id)
    expect(task.data.baseSha).toBe("c0ffee1") // diff against the PR head (the original commit)
    expect(task.data.project).toEqual(project())

    task = await step(h, task)
    expect(task.stage).toBe("verify")
    // the shared branch is reset to the PR head once, so leftovers of earlier follow-ups never carry over
    expect(resets).toEqual(["c0ffee1"])
    expect(task.data.branchReset).toBe(true)
    expect(h.opened).toEqual([original.id]) // the original workspace's paths
    expect(h.implInputs[0]!.workspace.baseSha).toBe("c0ffee1")
    expect(h.prepared).toHaveLength(0)
    expect(h.commands).toHaveLength(0)
  })

  test("falls back to a fresh clone when the reused workspace disappeared", async () => {
    const h = harness()
    const workspace = mkdtempSync(join(tmpdir(), "oss-scout-ws-"))
    const original = taskAt(h, "done", { status: "done", workspace })
    const item = h.deps.createQueue!(h.ctx).enqueue({
      kind: "pr",
      repo: REPO,
      issueUrl: null,
      prUrl: null,
      taskId: original.id,
      title: "t",
      body: "b",
      diff: "",
      testOutput: "",
      critic: null,
      verification: null,
      branch: original.branch,
      workspace,
      baseBranch: "main",
    })
    const task = startFollowupFixTask(h.ctx, trackedPr({ queueItemId: item.id }), "fix it")
    rmSync(workspace, { recursive: true, force: true })
    const next = await step(h, task)
    expect(next).toMatchObject({ stage: "prepare", status: "active", workspace: null })
    expect(next.data.reuseTaskId).toBeUndefined()
    expect(h.implInputs).toHaveLength(0)
  })

  test("a reused workspace skips the baseline stage", async () => {
    const h = harness()
    const task = taskAt(h, "baseline", { kind: "followup_fix", data: { reuseTaskId: "task_orig" } })
    const next = await step(h, task)
    expect(next.stage).toBe("implement")
    expect(h.commands).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// LLM usage is recorded as it is spent
// ---------------------------------------------------------------------------

describe("advanceTask: incremental usage accounting", () => {
  test("usage reported through onProgress survives a stage that throws (task and day totals)", async () => {
    const h = harness()
    h.implementation = (input) => {
      input.onProgress({ attemptsUsed: 1, attemptsLog: [], sessionId: "ses_1", usage: USAGE })
      throw new Error("git commit failed")
    }
    const next = await step(h, taskAt(h, "implement"))
    expect(next).toMatchObject({ stage: "implement", status: "active", failures: 1, tokensUsed: 1200, attempts: 1 })
    expect(next.costUsd).toBeCloseTo(0.01)
    expect(next.data.sessionId).toBe("ses_1")
    expect(h.ctx.store.getUsage(utcDay(T0))).toMatchObject({ tokens: 1200, calls: 1 })
    expect(h.ctx.store.getTask(next.id)!.tokensUsed).toBe(1200)
  })

  test("the final record adds only what onProgress had not recorded yet", async () => {
    const h = harness()
    h.implementation = (input) => {
      input.onProgress({ attemptsUsed: 0, attemptsLog: [], sessionId: "ses_1", usage: USAGE })
      input.onProgress({ attemptsUsed: 0, attemptsLog: [], sessionId: "ses_1", usage: USAGE }) // same total again: nothing new
      return { ok: true, output: implOutput(), usage: { ...USAGE, inputTokens: 3000, costUsd: 0.03 }, attemptsUsed: 1 }
    }
    const next = await step(h, taskAt(h, "implement"))
    expect(next.tokensUsed).toBe(3200)
    expect(next.costUsd).toBeCloseTo(0.03)
    expect(h.ctx.store.getUsage(utcDay(T0))).toMatchObject({ tokens: 3200, calls: 2 })
  })

  test("the budget guard counts already-recorded usage once", async () => {
    const h = harness({ config: { budget: { perTask: { maxTokens: 2000 } } } })
    const seen: Array<string | null> = []
    h.implementation = (input) => {
      input.onProgress({ attemptsUsed: 0, attemptsLog: [], sessionId: null, usage: USAGE }) // 1200 recorded
      // run total 1200 = all recorded, nothing pending: 1200 < 2000 (counting it twice would trip the cap)
      seen.push(input.budgetGuard(USAGE))
      // run total 2200: 1000 pending on top of the 1200 recorded → 2200 >= 2000
      seen.push(input.budgetGuard({ ...USAGE, inputTokens: 2000 }))
      return { ok: true, output: implOutput(), usage: USAGE, attemptsUsed: 1 }
    }
    await step(h, taskAt(h, "implement"))
    expect(seen[0]).toBeNull()
    expect(seen[1]).toContain("task token budget spent: 2200 of 2000")
  })

  test("the sandbox vanishing after an agent session spent budget counts as a failure (bounded), usage kept", async () => {
    const h = harness()
    h.implementation = (input) => {
      input.onProgress({ attemptsUsed: 0, attemptsLog: [], sessionId: "ses_1", usage: USAGE })
      throw new SandboxUnavailableError("docker daemon not running")
    }
    let task = await step(h, taskAt(h, "implement"))
    expect(task).toMatchObject({ stage: "implement", status: "waiting", failures: 1, tokensUsed: 1200, nextRunAt: T0 + EXTERNAL_RETRY_MS })
    expect(task.lastError).toContain("docker daemon not running")
    for (let i = 0; i < 4; i++) {
      h.ctx.clock.advance(EXTERNAL_RETRY_MS)
      task = await step(h, task)
    }
    expect(task.status).toBe("failed")
    expect(task.tokensUsed).toBe(5 * 1200)
    expect(h.ctx.store.getUsage(utcDay(T0)).tokens).toBe(5 * 1200)
  })

  test("no agent session starts while the sandbox is down", async () => {
    const h = harness()
    h.ctx.sandbox.availability = { ok: false, reason: "docker CLI not found", runtime: "docker", version: null }
    const next = await step(h, taskAt(h, "implement"))
    expect(next).toMatchObject({ stage: "implement", status: "waiting", failures: 0, nextRunAt: T0 + EXTERNAL_RETRY_MS })
    expect(next.lastError).toContain("docker CLI not found")
    expect(h.implInputs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// cancellation (scheduler stop, kill switch, lost lease)
// ---------------------------------------------------------------------------

describe("advanceTask: cancellation", () => {
  test("the signal reaches the implementer; an interrupted run waits without counting a failure", async () => {
    const h = harness()
    const ac = new AbortController()
    let received: AbortSignal | undefined
    h.implementation = (input) => {
      received = input.signal
      ac.abort()
      return { ok: false, reason: "agent session interrupted", retryable: true, usage: USAGE, attemptsUsed: 1 }
    }
    const next = await advanceTask(h.ctx, taskAt(h, "implement"), h.deps, { signal: ac.signal })
    expect(received).toBe(ac.signal)
    expect(next).toMatchObject({ stage: "implement", status: "waiting", failures: 0, nextRunAt: T0, tokensUsed: 1200, attempts: 1 })
    expect(next.lastError).toContain(INTERRUPTED)
    expect(h.ctx.store.getTask(next.id)).toEqual(next)
  })

  test("an outcome flagged `interrupted` waits too (never aborts the task or skips the issue)", async () => {
    const h = harness()
    h.implementation = () => ({ ok: false, reason: "stopped", retryable: false, usage: USAGE, attemptsUsed: 1, interrupted: true }) as ImplementationOutcome
    const next = await step(h, taskAt(h, "implement"))
    expect(next).toMatchObject({ status: "waiting", failures: 0 })
    expect(h.ctx.store.getIssue(ISSUE_ID)!.status).toBe("selected")
  })

  test("the critic gets the signal; an aborted critic call never rejects the task", async () => {
    const h = harness()
    const ac = new AbortController()
    let received: AbortSignal | undefined
    h.deps.runCritic = async (_c, _input, opts) => {
      received = opts?.signal
      ac.abort()
      throw new Error("The operation was aborted")
    }
    const next = await advanceTask(h.ctx, taskAt(h, "critic"), h.deps, { signal: ac.signal })
    expect(received).toBe(ac.signal)
    expect(next).toMatchObject({ stage: "critic", status: "waiting", failures: 0 })
    expect(h.ctx.store.listErrors()).toHaveLength(0)
    expect(audits(h, "task.abort")).toHaveLength(0)

    // a host that returns (garbage) instead of throwing after the abort is not trusted either
    const ac2 = new AbortController()
    h.deps.runCritic = async () => {
      ac2.abort()
      return { verdict: { verdict: "reject", confidence: 0, reasons: ["unparsable critic output"], requiredChanges: [], model: null, raw: "" }, usage: CRITIC_USAGE }
    }
    const again = await advanceTask(h.ctx, next, h.deps, { signal: ac2.signal })
    expect(again).toMatchObject({ stage: "critic", status: "waiting", tokensUsed: 600 })
    expect(audits(h, "task.abort")).toHaveLength(0)
  })

  test("an already aborted signal runs nothing", async () => {
    const h = harness()
    const ac = new AbortController()
    ac.abort()
    const task = taskAt(h, "verify")
    expect(await advanceTask(h.ctx, task, h.deps, { signal: ac.signal })).toBe(task)
    expect(h.gateInputs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// claims (two schedulers)
// ---------------------------------------------------------------------------

describe("advanceTask: task claims", () => {
  test("a holder that lost the claim to another scheduler cannot overwrite the task", async () => {
    const h = harness()
    const task = taskAt(h, "verify")
    h.ctx.store.claimTask(task.id, "B", 60_000, T0)
    const next = await advanceTask(h.ctx, task, h.deps, { holder: "A" })
    expect(next.stage).toBe("verify")
    expect(h.ctx.store.getTask(task.id)!.stage).toBe("verify")
  })

  test("the claim holder's result is saved", async () => {
    const h = harness()
    const task = taskAt(h, "verify")
    h.ctx.store.claimTask(task.id, "A", 60_000, T0)
    const next = await advanceTask(h.ctx, task, h.deps, { holder: "A" })
    expect(next.stage).toBe("critic")
    expect(h.ctx.store.getTask(task.id)!.stage).toBe("critic")
  })
})

// ---------------------------------------------------------------------------
// the repo is re-checked before every stage
// ---------------------------------------------------------------------------

describe("advanceTask: repo re-checked before every stage", () => {
  test("re-screened to skipped: the contribution is aborted before the stage, the issue is never picked again", async () => {
    const h = harness()
    const task = taskAt(h, "implement")
    h.ctx.store.saveRepo(repoRecord({ status: "skipped", skipReason: "AI policy prohibits AI-generated contributions" }))
    const next = await step(h, task)
    expect(next.status).toBe("aborted")
    expect(next.abortReason).toBe("acme/widget is now skipped: AI policy prohibits AI-generated contributions")
    expect(h.implInputs).toHaveLength(0)
    expect(h.ctx.store.getIssue(ISSUE_ID)!.status).toBe("skipped")
    expect(h.ctx.store.isIssueSticky(ISSUE_ID)).toBe(true)
  })

  test("a current AI ban or a deny-list entry aborts it too", async () => {
    const h = harness()
    h.ctx.store.saveRepo(repoRecord({ policy: policy({ ai: { classification: "prohibited", evidence: [], requiresDisclosure: false, notes: [] } }) }))
    const next = await step(h, taskAt(h, "enqueue"))
    expect(next.status).toBe("aborted")
    expect(next.abortReason).toContain("AI policy prohibits")
    expect(h.enqueued).toHaveLength(0)

    const d = harness({ config: { repos: { deny: ["acme/*"] } } })
    const denied = await step(d, taskAt(d, "verify"))
    expect(denied.abortReason).toContain("denied by config")
  })

  test("follow-up fixes: a skip for other reasons does not stop them; an AI ban does", async () => {
    const h = harness()
    const pr = trackedPr()
    h.ctx.store.upsertPr(pr)
    h.ctx.store.saveRepo(repoRecord({ status: "skipped", skipReason: "merge rate too low" }))
    const task = startFollowupFixTask(h.ctx, pr, "rename")
    const prepared = await step(h, task)
    expect(prepared.stage).toBe("baseline")
    h.ctx.store.saveRepo(repoRecord({ policy: policy({ ai: { classification: "restricted", evidence: [], requiresDisclosure: false, notes: [] } }) }))
    const blocked = await step(h, prepared)
    expect(blocked.status).toBe("aborted")
    expect(blocked.abortReason).toContain("AI policy restricts")
  })

  test("aborts and give-ups mark the issue sticky", async () => {
    const h = harness()
    h.gate = () => ({ passed: false, checks: [{ name: "diff size", status: "fail", detail: "too big" }] })
    await step(h, taskAt(h, "verify"))
    expect(h.ctx.store.isIssueSticky(ISSUE_ID)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// follow-up fixes: one reviewed commit per item, never after the PR ended
// ---------------------------------------------------------------------------

describe("follow-up fixes: PR state and exact commits", () => {
  test("a fix task whose PR was merged meanwhile is aborted before spending more and never enqueues", async () => {
    const h = harness()
    const pr = trackedPr()
    h.ctx.store.upsertPr(pr)
    const task = startFollowupFixTask(h.ctx, pr, "rename")
    h.ctx.store.upsertPr({ ...pr, state: "merged", mergedAt: T0, closedAt: T0 })
    const next = await step(h, task)
    expect(next.status).toBe("aborted")
    expect(next.abortReason).toContain("was merged")
    expect(h.prepared).toHaveLength(0)

    // even a task that reached enqueue does not queue a fix for an ended PR
    const late = taskAt(h, "enqueue", { kind: "followup_fix", prId: pr.id, issueId: null })
    h.ctx.store.upsertPr({ ...pr, state: "closed", closedAt: T0 })
    expect((await step(h, late)).status).toBe("aborted")
    expect(h.enqueued).toHaveLength(0)
  })

  test("enqueue records the exact commit, its base and the PR id on fix items", async () => {
    const h = harness()
    const pr = trackedPr()
    h.ctx.store.upsertPr(pr)
    let task = startFollowupFixTask(h.ctx, pr, "rename")
    for (let i = 0; i < 10 && task.status === "active"; i++) task = await step(h, task)
    expect(task.status).toBe("done")
    expect(h.enqueued[0]!.data).toMatchObject({ commitSha: "c0ffee1", baseSha: "base123", prId: pr.id, prNumber: 101 })
  })

  test("abortFollowupTasksForPr stops only that PR's active fix tasks", () => {
    const h = harness()
    const a = startFollowupFixTask(h.ctx, trackedPr(), "a")
    const b = startFollowupFixTask(h.ctx, trackedPr({ id: "acme/widget#102", number: 102 }), "b")
    expect(abortFollowupTasksForPr(h.ctx, "ACME/widget#101", "pull request acme/widget#101 was merged")).toEqual([a.id])
    expect(h.ctx.store.getTask(a.id)!.status).toBe("aborted")
    expect(h.ctx.store.getTask(b.id)!.status).toBe("active")
  })

  test("a new follow-up in the reused workspace starts from the last pushed fix commit", async () => {
    const h = harness()
    const workspace = mkdtempSync(join(tmpdir(), "oss-scout-ws-"))
    tempDirs.push(workspace)
    const original = taskAt(h, "done", { status: "done", workspace })
    const queue = h.deps.createQueue!(h.ctx)
    const prItem = queue.enqueue({
      kind: "pr",
      repo: REPO,
      issueUrl: null,
      prUrl: null,
      taskId: original.id,
      title: "t",
      body: "b",
      diff: "",
      testOutput: "",
      critic: null,
      verification: null,
      branch: original.branch,
      workspace,
      baseBranch: "main",
    })
    const pr = trackedPr({ queueItemId: prItem.id })
    const pushed = h.ctx.store.insertQueueItem({
      ...h.ctx.store.getQueueItem(prItem.id)!,
      kind: "fix",
      status: "submitted",
      decidedAt: T0,
      data: { prId: pr.id, commitSha: "a".repeat(40) },
    })
    expect(pushed.kind).toBe("fix")
    const task = startFollowupFixTask(h.ctx, pr, "second round")
    expect(task.data.baseSha).toBe("a".repeat(40))
    await step(h, task)
    expect(resets).toEqual(["a".repeat(40)])
  })
})

describe("advanceTask: sandbox interruption, work-tree integrity, gate task kind", () => {
  const named = (name: string, message: string) => Object.assign(new Error(message), { name })

  test("baseline sandbox runs get the stage signal; an interrupted run waits without a failure", async () => {
    const h = harness()
    const ac = new AbortController()
    const signals: Array<AbortSignal | undefined> = []
    h.deps.runProjectCommand = async (_c, input) => {
      signals.push(input.signal)
      ac.abort()
      throw named("SandboxInterruptedError", "sandbox run interrupted (kill switch / scheduler stop)")
    }
    const next = await advanceTask(h.ctx, taskAt(h, "baseline"), h.deps, { signal: ac.signal })
    expect(signals).toEqual([ac.signal])
    expect(next).toMatchObject({ stage: "baseline", status: "waiting", failures: 0, nextRunAt: T0 })
    expect(next.lastError).toContain(INTERRUPTED)
    expect(h.ctx.store.listErrors()).toHaveLength(0)

    // even without the scheduler's signal (e.g. the container was killed), it is not a failure
    h.deps.runProjectCommand = async () => {
      throw named("SandboxInterruptedError", "sandbox run interrupted")
    }
    expect(await step(h, next)).toMatchObject({ status: "waiting", failures: 0 })
  })

  test("a symlink escaping the work tree (WorkTreeIntegrityError) aborts the task for good", async () => {
    const h = harness()
    h.implementation = () => {
      throw named("WorkTreeIntegrityError", "src/link -> /etc/passwd escapes the work tree")
    }
    const next = await step(h, taskAt(h, "implement"))
    expect(next.status).toBe("aborted")
    expect(next.abortReason).toBe("src/link -> /etc/passwd escapes the work tree")
    expect(h.ctx.store.isIssueSticky(ISSUE_ID)).toBe(true)
    expect(audits(h, "task.abort")[0]!.details.integrity).toBe(true)
  })

  test("the verification gate learns the task kind (follow-up fixes skip reproduction)", async () => {
    const h = harness()
    await step(h, taskAt(h, "verify"))
    expect(h.gateInputs[0]!.taskKind).toBe("contribution")
    const fix = taskAt(h, "verify", { kind: "followup_fix", issueId: null })
    await step(h, fix)
    expect(h.gateInputs[1]!.taskKind).toBe("followup_fix")
  })
})
