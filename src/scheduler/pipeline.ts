import { existsSync } from "node:fs"
import { audit, recordError, type AppContext } from "../core/context.ts"
import type {
  CommandRun,
  CommitConvention,
  CriticVerdict,
  ImplementationOutput,
  IssueRecord,
  ProjectInfo,
  RepoRecord,
  TaskRecord,
  TaskStage,
  TaskStatus,
  TrackedPr,
  VerificationReport,
} from "../core/types.ts"
import { criticAccepts, runCritic } from "../critic/critic.ts"
import { runImplementation, type ImplementationOutcome } from "../implement/implementer.ts"
import { totalTokens, ZERO_USAGE, type Usage } from "../llm/host.ts"
import { buildPrBody } from "../queue/prbody.ts"
import { ApprovalQueue, type EnqueueInput } from "../queue/queue.ts"
import { AI_POLICY_FLAG_NOTES, aiPolicyFlags } from "../screening/policy.ts"
import { MINUTE } from "../util/clock.ts"
import { errorMessage } from "../util/log.ts"
import { makeId } from "../util/text.ts"
import { runVerificationGate } from "../verify/gate.ts"
import { SandboxUnavailableError } from "../workspace/sandbox.ts"
import { branchNameFor, openWorkspace, prepareWorkspace, runProjectCommand } from "../workspace/workspace.ts"
import { checkBudget, checkBudgetWith, recordUsage, type BudgetDecision } from "./budget.ts"
import { repoBlockReason } from "./eligibility.ts"

/** Minimal queue surface the enqueue stage needs. */
export interface TaskQueue {
  enqueue(input: EnqueueInput): { id: number }
}

/** Stage implementations, injectable for tests. Defaults are the real modules. */
export interface PipelineDeps {
  prepareWorkspace: typeof prepareWorkspace
  openWorkspace: typeof openWorkspace
  runProjectCommand: typeof runProjectCommand
  runImplementation: typeof runImplementation
  runVerificationGate: typeof runVerificationGate
  runCritic: typeof runCritic
  buildPrBody: typeof buildPrBody
  criticAccepts: typeof criticAccepts
  createQueue: (ctx: AppContext) => TaskQueue
  checkBudget: typeof checkBudget
  checkBudgetWith: typeof checkBudgetWith
  recordUsage: typeof recordUsage
}

export const defaultPipelineDeps: PipelineDeps = {
  prepareWorkspace,
  openWorkspace,
  runProjectCommand,
  runImplementation,
  runVerificationGate,
  runCritic,
  buildPrBody,
  criticAccepts,
  createQueue: (ctx) => new ApprovalQueue(ctx),
  checkBudget,
  checkBudgetWith,
  recordUsage,
}

/** kv key: epoch ms until which all GitHub API work is paused (rate limit). */
export const GITHUB_PAUSED_KEY = "github.pausedUntil"
/** Consecutive unexpected failures before a task is marked failed. */
export const MAX_TASK_FAILURES = 5
/** Failed dependency installs before the task is aborted. */
export const MAX_INSTALL_FAILURES = 3
/** Retry delay while an external dependency (LLM host, sandbox) is missing. */
export const EXTERNAL_RETRY_MS = 30 * MINUTE

export const LLM_UNAVAILABLE = "LLM host unavailable (oss-scout must run inside opencode for implementation)"
export const MISSING_RECORDS = "repo/issue no longer in database"
export const INTERRUPTED = "interrupted (scheduler stopping, kill switch engaged or scheduler lease lost); resumes on a later tick"

/** Per-call options of advanceTask (passed by the scheduler). */
export interface AdvanceOptions {
  /**
   * Aborted when the scheduler stops, the kill switch is engaged or the lease is lost: the running stage
   * (agent session, sandbox run, critic) is interrupted and the task waits without counting a failure.
   */
  signal?: AbortSignal
  /**
   * Holder of the task's claim (the scheduler's lease holder id). Every save is refused once another
   * scheduler has taken the claim over, so a holder that lost its lease cannot overwrite the task.
   */
  holder?: string
}

/** State shared by advanceTask and the stage it runs. */
interface StageRun {
  signal: AbortSignal | undefined
  /** The most recently persisted version of the task during this stage (progress, usage). */
  latest: TaskRecord
  /** Persist a progress snapshot (claim-aware). Returns false when the claim was lost. */
  save(task: TaskRecord): boolean
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const strOf = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)
const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

function subjectOf(task: TaskRecord): string {
  return task.issueId ?? task.prId ?? task.repo
}

function runPassed(run: CommandRun): boolean {
  return run.exitCode === 0 && !run.timedOut
}

function describeRun(run: CommandRun): string {
  return `exit ${run.exitCode}${run.timedOut ? " (timed out)" : ""}`
}

/** Exponential backoff delay in ms for the n-th consecutive failure (n >= 1). */
export function backoffDelayMs(failures: number, config: AppContext["config"]): number {
  const { backoffBaseSeconds, backoffMaxSeconds } = config.scheduler
  const exp = Math.max(0, failures - 1)
  return Math.min(backoffMaxSeconds, backoffBaseSeconds * 2 ** exp) * 1000
}

function isNamed(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name
}

function rateLimitResetAt(err: unknown): number | null {
  if (!isNamed(err, "RateLimitError")) return null
  return numOf((err as { resetAt?: unknown }).resetAt)
}

/** Task with the given patch applied, moved to `stage` and runnable now (failures reset). */
function advanceTo(ctx: AppContext, task: TaskRecord, stage: TaskStage, patch: Partial<TaskRecord> = {}): TaskRecord {
  const status: TaskStatus = stage === "done" ? "done" : "active"
  return { ...task, ...patch, stage, status, nextRunAt: ctx.clock.now(), failures: 0, lastError: null }
}

function waitUntil(task: TaskRecord, until: number, reason: string): TaskRecord {
  return { ...task, status: "waiting", nextRunAt: until, lastError: reason }
}

/**
 * Terminal abort: records the reason, audits it, and skips the issue (contribution tasks) for good
 * (sticky: the issue is never picked again).
 */
function abortTask(ctx: AppContext, task: TaskRecord, reason: string, details: Record<string, unknown> = {}): TaskRecord {
  audit(ctx, "scout", "task.abort", subjectOf(task), "skip", [reason], { taskId: task.id, stage: task.stage, kind: task.kind, ...details })
  if (task.kind === "contribution" && task.issueId) ctx.store.setIssueStatus(task.issueId, "skipped", reason, { sticky: true })
  ctx.log.info("task aborted", { task: task.id, stage: task.stage, reason })
  return { ...task, status: "aborted", abortReason: reason, lastError: null, nextRunAt: ctx.clock.now() }
}

/** The stage was interrupted (stop, kill switch, lost lease): wait without counting a failure. */
function interruptedWait(ctx: AppContext, task: TaskRecord, detail: string | null = null): TaskRecord {
  return waitUntil(task, ctx.clock.now(), detail ? `${INTERRUPTED}: ${detail}` : INTERRUPTED)
}

/** failures++ with exponential backoff; MAX_TASK_FAILURES consecutive failures → failed (terminal). */
function backoff(ctx: AppContext, task: TaskRecord, reason: string, status: "active" | "waiting" = "active"): TaskRecord {
  const now = ctx.clock.now()
  const failures = task.failures + 1
  if (failures >= MAX_TASK_FAILURES) {
    const why = `gave up after ${failures} consecutive failures: ${reason}`
    audit(ctx, "scout", "task.fail", subjectOf(task), "fail", [why], { taskId: task.id, stage: task.stage, kind: task.kind })
    if (task.kind === "contribution" && task.issueId) {
      ctx.store.setIssueStatus(task.issueId, "skipped", `task failed: ${reason}`, { sticky: true })
    }
    ctx.log.warn("task failed", { task: task.id, stage: task.stage, reason })
    return { ...task, failures, status: "failed", lastError: reason, nextRunAt: now }
  }
  return { ...task, failures, status, lastError: reason, nextRunAt: now + backoffDelayMs(failures, ctx.config) }
}

/** An external dependency failed AFTER LLM budget was spent: counts as a failure, retried in 30 min. */
function externalFailure(ctx: AppContext, task: TaskRecord, reason: string): TaskRecord {
  if (task.failures + 1 >= MAX_TASK_FAILURES) return backoff(ctx, task, reason, "waiting")
  return { ...task, failures: task.failures + 1, status: "waiting", lastError: reason, nextRunAt: ctx.clock.now() + EXTERNAL_RETRY_MS }
}

function budgetBlocked(ctx: AppContext, task: TaskRecord, decision: BudgetDecision): TaskRecord {
  const reason = decision.reason ?? "LLM budget spent"
  if (decision.scope === "task") return abortTask(ctx, task, reason)
  return waitUntil(task, decision.retryAt ?? ctx.clock.now() + EXTERNAL_RETRY_MS, reason)
}

/** Record LLM usage once (skipped when nothing was used). */
function withUsage(ctx: AppContext, d: PipelineDeps, task: TaskRecord, usage: Usage): TaskRecord {
  if (totalTokens(usage) <= 0 && !(usage.costUsd > 0)) return task
  return d.recordUsage(ctx.store, task, usage, ctx.clock.now()) ?? task
}

const nonNeg = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)

/** Usage in `total` that is not yet in `recorded` (component-wise, never negative). */
export function usageDelta(total: Usage, recorded: Usage): Usage {
  return {
    inputTokens: nonNeg(total.inputTokens - recorded.inputTokens),
    outputTokens: nonNeg(total.outputTokens - recorded.outputTokens),
    costUsd: nonNeg(total.costUsd - recorded.costUsd),
    estimated: total.estimated,
  }
}

function maxUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    costUsd: Math.max(a.costUsd, b.costUsd),
    estimated: a.estimated || b.estimated,
  }
}

function isSandboxUnavailable(err: unknown): boolean {
  return err instanceof SandboxUnavailableError || isNamed(err, "SandboxUnavailableError")
}

/** Did the implementation stop because it was interrupted (scheduler stop, kill switch, lost lease)? */
function wasInterrupted(outcome: ImplementationOutcome, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (outcome as { interrupted?: unknown }).interrupted === true
}

/**
 * Why a task must not continue before its next stage (null = it may): the repo is now denied by config,
 * its AI policy blocks AI contributions or (contributions) it was skipped by a re-screen; a follow-up
 * fix's PR was merged or closed meanwhile.
 */
function preStageBlock(ctx: AppContext, task: TaskRecord): string | null {
  const blocked = repoBlockReason(ctx, task.repo, task.kind === "contribution" ? "contribution" : "followup")
  if (blocked) return blocked
  if (task.kind === "followup_fix" && task.prId) {
    const pr = ctx.store.getPr(task.prId)
    if (pr && pr.state !== "open") return `pull request ${pr.id} was ${pr.state}; the follow-up fix is no longer needed`
  }
  return null
}

function loadRecords(ctx: AppContext, task: TaskRecord): { repo: RepoRecord; issue: IssueRecord | null } | null {
  const repo = ctx.store.getRepo(task.repo)
  const issue = task.issueId ? ctx.store.getIssue(task.issueId) : null
  if (!repo) return null
  if (task.kind === "contribution" && !issue) return null
  return { repo, issue }
}

function reuseTaskIdOf(task: TaskRecord): string | null {
  return task.kind === "followup_fix" ? strOf(task.data.reuseTaskId) : null
}

/** Open the task's workspace (the original task's one when a follow-up fix reuses it). */
function openTaskWorkspace(ctx: AppContext, task: TaskRecord, d: PipelineDeps): ReturnType<typeof openWorkspace> {
  const reuse = reuseTaskIdOf(task)
  return d.openWorkspace(ctx, reuse ? { ...task, id: reuse } : task)
}

function testOutputOf(impl: ImplementationOutput): string {
  const parts: string[] = []
  for (const run of [impl.finalTestRun, impl.finalLintRun]) {
    if (!run) continue
    parts.push(`$ ${run.command}\n(${run.label}: ${describeRun(run)}, sandboxed, network ${run.network})\n${run.outputTail}`)
  }
  return parts.join("\n\n") || "(no test run: documentation-only change)"
}

function testSummaryOf(impl: ImplementationOutput): string {
  const run = impl.finalTestRun
  if (!run) return "No automated tests apply (documentation-only change)."
  return `${run.command} → exit ${run.exitCode}${run.timedOut ? " (timed out)" : ""} (sandboxed, network ${run.network})`
}

// ---------------------------------------------------------------------------
// task creation
// ---------------------------------------------------------------------------

function newTask(now: number, fields: Pick<TaskRecord, "id" | "kind" | "repo" | "issueId" | "prId"> & Partial<TaskRecord>): TaskRecord {
  return {
    stage: "prepare",
    status: "active",
    attempts: 0,
    failures: 0,
    nextRunAt: now,
    lastError: null,
    abortReason: null,
    workspace: null,
    branch: null,
    tokensUsed: 0,
    costUsd: 0,
    createdAt: now,
    updatedAt: now,
    data: {},
    ...fields,
  }
}

/** Create a durable contribution task (stage "prepare") for a selected issue; audits the decision. */
export function startContributionTask(ctx: AppContext, repo: RepoRecord, issue: IssueRecord): TaskRecord {
  const now = ctx.clock.now()
  const task = newTask(now, { id: makeId("task", now, issue.id), kind: "contribution", repo: repo.fullName, issueId: issue.id, prId: null })
  ctx.store.saveTask(task)
  const score = issue.score === null ? "unscored" : `score ${issue.score.toFixed(2)}`
  audit(ctx, "scout", "task.start", issue.id, "start", [score, ...issue.reasons], {
    taskId: task.id,
    repo: repo.fullName,
    kind: issue.kind,
    title: issue.title,
    score: issue.score,
  })
  ctx.log.info("task started", { task: task.id, issue: issue.id })
  return task
}

/** The task that produced a tracked PR (pr.queueItemId → queue item → taskId → task). */
function originalTaskOf(ctx: AppContext, pr: TrackedPr): TaskRecord | null {
  if (pr.queueItemId === null) return null
  const item = ctx.store.getQueueItem(pr.queueItemId)
  return item?.taskId ? ctx.store.getTask(item.taskId) : null
}

/** Can a follow-up fix continue in the original task's workspace? */
function reusableWorkspace(original: TaskRecord | null): original is TaskRecord & { workspace: string } {
  return !!original && !!original.workspace && !!original.data.project && existsSync(original.workspace)
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/

/** Does a fix queue item belong to this tracked PR (data.prId, else repo + data.prNumber)? */
export function fixItemMatchesPr(item: { repo: string; data: Record<string, unknown> }, pr: Pick<TrackedPr, "id" | "repo" | "number">): boolean {
  const prId = item.data.prId
  if (typeof prId === "string") return prId.toLowerCase() === pr.id.toLowerCase()
  return item.data.prNumber === pr.number && item.repo.toLowerCase() === pr.repo.toLowerCase()
}

/** The commit of the newest submitted (pushed) follow-up fix for this PR, or null. */
function lastPushedFixCommit(ctx: AppContext, pr: TrackedPr): string | null {
  const pushed = ctx.store
    .listQueue({ kind: "fix", status: "submitted" })
    .filter((i) => fixItemMatchesPr(i, pr) && typeof i.data.commitSha === "string" && FULL_SHA_RE.test(i.data.commitSha))
    .sort((a, b) => (b.decidedAt ?? b.updatedAt) - (a.decidedAt ?? a.updatedAt) || b.id - a.id)
  return (pushed[0]?.data.commitSha as string | undefined) ?? null
}

/** Create a follow-up fix task for review feedback on one of your PRs. */
export function startFollowupFixTask(ctx: AppContext, pr: TrackedPr, feedback: string): TaskRecord {
  const now = ctx.clock.now()
  const original = originalTaskOf(ctx, pr)
  const base = {
    id: makeId("task", now, `${pr.id}:fix`),
    kind: "followup_fix" as const,
    repo: pr.repo,
    issueId: original?.issueId ?? null,
    prId: pr.id,
  }
  const prData = { feedback, headRepo: pr.headRepo, prNumber: pr.number, prUrl: pr.url, remoteBranch: pr.branch }
  let task: TaskRecord
  if (reusableWorkspace(original)) {
    const od = original.data
    // The PR head as oss-scout pushed it: the newest pushed follow-up fix, else the original commit. The
    // implement stage resets the branch to it, and the follow-up diff is computed against it.
    const headSha = lastPushedFixCommit(ctx, pr) ?? od.implementation?.commitSha ?? od.baseSha
    task = newTask(now, {
      ...base,
      stage: "implement",
      workspace: original.workspace,
      branch: original.branch ?? pr.branch,
      data: {
        ...prData,
        reuseTaskId: original.id,
        project: od.project,
        baseBranch: pr.branch ?? od.baseBranch,
        baseSha: headSha,
        convention: od.convention,
        baseline: od.baseline,
      },
    })
  } else {
    task = newTask(now, { ...base, branch: pr.branch, data: prData })
  }
  ctx.store.saveTask(task)
  audit(ctx, "scout", "task.start", pr.id, "start", ["follow-up fix for review feedback"], {
    taskId: task.id,
    kind: task.kind,
    reuseTaskId: task.data.reuseTaskId ?? null,
    stage: task.stage,
  })
  ctx.log.info("follow-up fix task started", { task: task.id, pr: pr.id, stage: task.stage })
  return task
}

// ---------------------------------------------------------------------------
// stages
// ---------------------------------------------------------------------------

async function stagePrepare(ctx: AppContext, task: TaskRecord, d: PipelineDeps): Promise<TaskRecord> {
  const records = loadRecords(ctx, task)
  if (!records) return abortTask(ctx, task, MISSING_RECORDS)
  const { repo, issue } = records

  let branch: string
  let baseBranch: string
  let cloneUrl: string
  if (task.kind === "followup_fix") {
    const headRepo = strOf(task.data.headRepo)
    if (!headRepo || !task.branch) return abortTask(ctx, task, "follow-up fix: the PR's fork or branch is unknown")
    branch = task.branch
    baseBranch = task.branch
    cloneUrl = `https://github.com/${headRepo}.git`
  } else {
    branch = branchNameFor(issue!)
    baseBranch = repo.metrics?.defaultBranch ?? "main"
    cloneUrl = `https://github.com/${repo.fullName}.git`
  }

  const ws = await d.prepareWorkspace(ctx, { task, repo, issue, branch, baseBranch, cloneUrl })
  return advanceTo(ctx, task, "baseline", {
    workspace: ws.taskDir,
    branch: ws.branch,
    data: { ...task.data, project: ws.project, baseBranch: ws.baseBranch, baseSha: ws.baseSha, convention: ws.convention },
  })
}

async function stageBaseline(ctx: AppContext, task: TaskRecord, d: PipelineDeps, run: StageRun): Promise<TaskRecord> {
  if (reuseTaskIdOf(task)) return advanceTo(ctx, task, "implement")
  const project = task.data.project
  if (!project) return advanceTo(ctx, task, "prepare")
  const issue = task.issueId ? ctx.store.getIssue(task.issueId) : null
  if (!project.test && issue?.kind !== "docs") return abortTask(ctx, task, "no test command detected")

  const { paths } = openTaskWorkspace(ctx, task, d)
  // Interrupted sandbox runs (stop, kill switch, lost lease) throw SandboxInterruptedError: the task waits.
  const signal = run.signal ? { signal: run.signal } : {}
  const runs: CommandRun[] = []
  const withRuns = (t: TaskRecord, extra: Record<string, unknown> = {}): TaskRecord => ({
    ...t,
    data: { ...t.data, baseline: [...runs], ...extra },
  })

  if (project.install) {
    const install = await d.runProjectCommand(ctx, { paths, project, label: "install", command: project.install, taskId: task.id, ...signal })
    runs.push(install)
    if (!runPassed(install)) {
      const n = (numOf(task.data.installFailures) ?? 0) + 1
      const t = withRuns(task, { installFailures: n })
      if (n >= MAX_INSTALL_FAILURES) return abortTask(ctx, t, "dependency install failed in sandbox", { exitCode: install.exitCode })
      return backoff(ctx, t, `dependency install failed in sandbox (${describeRun(install)}; attempt ${n} of ${MAX_INSTALL_FAILURES})`)
    }
  }
  if (project.test) {
    const test = await d.runProjectCommand(ctx, { paths, project, label: "test", command: project.test, taskId: task.id, ...signal })
    runs.push(test)
    if (!runPassed(test)) {
      return abortTask(ctx, withRuns(task), "test suite fails before any change (baseline)", { exitCode: test.exitCode })
    }
  }
  return advanceTo(ctx, withRuns(task), "implement")
}

/** The reused workspace is gone or incomplete: start over with a fresh clone of the PR branch. */
function dropReuse(ctx: AppContext, task: TaskRecord): TaskRecord {
  const { reuseTaskId: _r, project: _p, baseSha: _s, baseline: _b, convention: _c, ...data } = task.data
  ctx.log.info("follow-up fix: original workspace unusable; re-cloning the PR branch", { task: task.id })
  return advanceTo(ctx, task, "prepare", { workspace: null, branch: strOf(task.data.remoteBranch) ?? task.branch, data })
}

/** Rebuild the implementer's workspace view from persisted task data; null = data missing. */
function implementationWorkspace(ctx: AppContext, task: TaskRecord, d: PipelineDeps, project: ProjectInfo) {
  const baseSha = strOf(task.data.baseSha)
  if (!task.branch || !baseSha) return null
  const { paths, git } = openTaskWorkspace(ctx, task, d)
  const convention = (strOf(task.data.convention) ?? "unknown") as CommitConvention
  return {
    taskDir: paths.taskDir,
    paths,
    git,
    project,
    branch: task.branch,
    baseBranch: strOf(task.data.baseBranch) ?? task.branch,
    baseSha,
    convention,
  }
}

async function sandboxDown(ctx: AppContext): Promise<string | null> {
  try {
    const a = await ctx.sandbox.available()
    return a.ok ? null : (a.reason ?? `${a.runtime} unavailable`)
  } catch (err) {
    return errorMessage(err)
  }
}

async function stageImplement(ctx: AppContext, task: TaskRecord, d: PipelineDeps, run: StageRun): Promise<TaskRecord> {
  const now = ctx.clock.now()
  if (!ctx.llm) return waitUntil(task, now + EXTERNAL_RETRY_MS, LLM_UNAVAILABLE)
  const budget = d.checkBudget(ctx.store, ctx.config, task, now)
  if (!budget.ok) return budgetBlocked(ctx, task, budget)

  const records = loadRecords(ctx, task)
  if (!records) return abortTask(ctx, task, MISSING_RECORDS)
  if (reuseTaskIdOf(task) && !(task.workspace && existsSync(task.workspace))) return dropReuse(ctx, task)
  const project = task.data.project
  const workspace = project ? implementationWorkspace(ctx, task, d, project) : null
  if (!workspace) return reuseTaskIdOf(task) ? dropReuse(ctx, task) : advanceTo(ctx, task, "prepare")

  // An agent session spends LLM budget; never start one while the sandbox that must verify it is down.
  if (workspace.project.test || workspace.project.lint) {
    const down = await sandboxDown(ctx)
    if (down) return waitUntil(task, now + EXTERNAL_RETRY_MS, `sandbox unavailable: ${down}`)
  }

  let base = task
  if (reuseTaskIdOf(task) && task.data.branchReset !== true) {
    // A follow-up in the original workspace starts from the commit last pushed to the PR: earlier
    // follow-ups that were aborted (or rejected) may have left commits on the shared branch.
    await workspace.git.resetHard(workspace.baseSha)
    base = { ...task, data: { ...task.data, branchReset: true } }
    run.save(base)
  }

  // Usage is recorded as it is reported (onProgress), so a crash or a throwing stage loses nothing;
  // `recorded` is what this run already put into the day total and the task counters.
  let recorded: Usage = ZERO_USAGE
  let progress = base
  const account = (usage: Usage): void => {
    const delta = usageDelta(usage, recorded)
    recorded = maxUsage(recorded, usage)
    if (totalTokens(delta) <= 0 && !(delta.costUsd > 0)) return
    progress = d.recordUsage(ctx.store, progress, delta, ctx.clock.now()) ?? progress
  }

  let outcome: ImplementationOutcome
  try {
    outcome = await d.runImplementation(ctx, {
      task: base,
      workspace,
      repo: records.repo,
      issue: records.issue,
      feedback: strOf(task.data.feedback),
      attemptsUsed: base.attempts,
      budgetGuard: (usage) => d.checkBudgetWith(ctx.store, ctx.config, progress, usageDelta(usage, recorded), ctx.clock.now()).reason,
      onProgress: (u) => {
        ctx.store.transaction(() => {
          account(u.usage)
          const data = { ...progress.data, attemptsLog: u.attemptsLog, ...(u.sessionId ? { sessionId: u.sessionId } : {}) }
          progress = { ...progress, attempts: u.attemptsUsed, updatedAt: ctx.clock.now(), data }
          run.save(progress)
        })
      },
      ...(run.signal ? { signal: run.signal } : {}),
    })
  } catch (err) {
    // Spent LLM budget, then the sandbox vanished: count it, so a broken sandbox cannot burn the budget forever.
    if (isSandboxUnavailable(err) && totalTokens(recorded) > 0 && !run.signal?.aborted) {
      return externalFailure(ctx, run.latest, errorMessage(err))
    }
    throw err
  }

  let next: TaskRecord = progress
  ctx.store.transaction(() => {
    account(outcome.usage)
    next = { ...progress, attempts: outcome.attemptsUsed }
    run.save(next)
  })
  if (outcome.ok) return advanceTo(ctx, next, "verify", { data: { ...next.data, implementation: outcome.output } })
  if (wasInterrupted(outcome, run.signal) || ctx.kill.isEngaged()) return interruptedWait(ctx, next, outcome.reason)
  if (!outcome.retryable) return abortTask(ctx, next, outcome.reason, { attempts: next.attempts })
  const after = d.checkBudget(ctx.store, ctx.config, next, ctx.clock.now())
  if (!after.ok) return budgetBlocked(ctx, next, after)
  return backoff(ctx, next, outcome.reason, "waiting")
}

async function stageVerify(ctx: AppContext, task: TaskRecord, d: PipelineDeps): Promise<TaskRecord> {
  const impl = task.data.implementation
  if (!impl) return advanceTo(ctx, task, "implement")
  const project = task.data.project
  if (!project) return advanceTo(ctx, task, "prepare")
  const records = loadRecords(ctx, task)
  if (!records) return abortTask(ctx, task, MISSING_RECORDS)
  const { repo, issue } = records

  const isContribution = task.kind === "contribution"
  const template = isContribution ? (repo.policy?.prTemplate ?? null) : null
  const disclosureLine = ctx.config.disclosure.line
  const prTitle = impl.prTitle
  const prBody = d.buildPrBody({
    drafted: impl.prBody,
    issue,
    template,
    testSummary: testSummaryOf(impl),
    disclosureLine,
    closingReference: isContribution,
  })
  const report = d.runVerificationGate({
    implementation: impl,
    project,
    issueKind: issue?.kind ?? null,
    // follow-up fixes: no reproduction check, tests-added optional
    taskKind: task.kind,
    prTemplate: template,
    prBody,
    disclosureLine,
    config: ctx.config,
  })
  const next: TaskRecord = { ...task, data: { ...task.data, prTitle, prBody, verification: report } }
  if (!report.passed) {
    const failed = report.checks.filter((c) => c.status === "fail").map((c) => `${c.name} (${c.detail})`)
    return abortTask(ctx, next, `verification gate failed: ${failed.join("; ") || "no passing result"}`)
  }
  return advanceTo(ctx, next, "critic")
}

function criticRejection(verdict: CriticVerdict, minConfidence: number): string {
  const parts = [...verdict.reasons]
  for (const change of verdict.requiredChanges) parts.push(`required change: ${change}`)
  if (verdict.verdict === "approve" && verdict.confidence < minConfidence) {
    parts.push(`confidence ${verdict.confidence.toFixed(2)} below ${minConfidence.toFixed(2)}`)
  }
  return `critic rejected: ${parts.join("; ") || verdict.verdict}`
}

async function stageCritic(ctx: AppContext, task: TaskRecord, d: PipelineDeps, run: StageRun): Promise<TaskRecord> {
  const now = ctx.clock.now()
  if (!ctx.llm) return waitUntil(task, now + EXTERNAL_RETRY_MS, LLM_UNAVAILABLE)
  const budget = d.checkBudget(ctx.store, ctx.config, task, now)
  if (!budget.ok) return budgetBlocked(ctx, task, budget)

  const impl = task.data.implementation
  const verification = task.data.verification
  const prTitle = strOf(task.data.prTitle)
  const prBody = strOf(task.data.prBody)
  if (!impl) return advanceTo(ctx, task, "implement")
  if (!verification || !prTitle || !prBody) return advanceTo(ctx, task, "verify")
  const records = loadRecords(ctx, task)
  if (!records) return abortTask(ctx, task, MISSING_RECORDS)
  const { repo, issue } = records

  const { verdict, usage } = await d.runCritic(
    ctx,
    {
      repo,
      issue,
      policy: repo.policy,
      diff: impl.diff,
      prTitle,
      prBody,
      testOutput: testOutputOf(impl),
      verification,
      feedback: strOf(task.data.feedback),
    },
    run.signal ? { signal: run.signal } : {},
  )
  const used = withUsage(ctx, d, task, usage)
  if (run.signal?.aborted) {
    run.save(used)
    return interruptedWait(ctx, used)
  }
  const next: TaskRecord = { ...used, data: { ...used.data, critic: verdict } }
  const accepted = d.criticAccepts(verdict, ctx.config)
  audit(ctx, "critic", "critic.review", subjectOf(task), accepted ? "approve" : "reject", verdict.reasons, {
    taskId: task.id,
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    requiredChanges: verdict.requiredChanges,
    model: verdict.model,
  })
  if (!accepted) return abortTask(ctx, next, criticRejection(verdict, ctx.config.critic.minConfidence))
  return advanceTo(ctx, next, "enqueue")
}

function finishTask(ctx: AppContext, task: TaskRecord, queueItemId: number): TaskRecord {
  audit(ctx, "scout", "task.done", subjectOf(task), "queued", [`queue item #${queueItemId}`], { taskId: task.id, queueItemId })
  ctx.log.info("task queued for approval", { task: task.id, queueItemId })
  return advanceTo(ctx, task, "done", { data: { ...task.data, queueItemId } })
}

async function stageEnqueue(ctx: AppContext, task: TaskRecord, d: PipelineDeps): Promise<TaskRecord> {
  const known = numOf(task.data.queueItemId)
  if (known !== null) return advanceTo(ctx, task, "done")
  // Crash between enqueue and save: adopt the existing item instead of queueing a duplicate.
  const existing = ctx.store.listQueue({ repo: task.repo }).find((i) => i.taskId === task.id)
  if (existing) return finishTask(ctx, task, existing.id)

  const impl = task.data.implementation
  const verification: VerificationReport | undefined = task.data.verification
  const critic: CriticVerdict | undefined = task.data.critic
  const prTitle = strOf(task.data.prTitle)
  const prBody = strOf(task.data.prBody)
  if (!impl) return advanceTo(ctx, task, "implement")
  if (!verification || !prTitle || !prBody) return advanceTo(ctx, task, "verify")
  if (!critic) return advanceTo(ctx, task, "critic")

  const repo = ctx.store.getRepo(task.repo)
  const issue = task.issueId ? ctx.store.getIssue(task.issueId) : null
  const policy = repo?.policy ?? null
  const isFix = task.kind === "followup_fix"
  if (isFix && task.prId) {
    // Never queue a fix for a PR that was merged or closed while the task ran.
    const pr = ctx.store.getPr(task.prId)
    if (pr && pr.state !== "open") return abortTask(ctx, task, `pull request ${pr.id} was ${pr.state}; the follow-up fix is no longer needed`)
  }
  const prNumber = numOf(task.data.prNumber)
  const prUrl = isFix ? (strOf(task.data.prUrl) ?? (prNumber !== null ? `https://github.com/${task.repo}/pull/${prNumber}` : null)) : null
  const policyNotes = policy?.notes ?? []
  // Fine-grained AI-policy rules the human must see (and, for human-written text, act on) before approving.
  const aiFlags = policy ? [...new Set(aiPolicyFlags(policy.ai))] : []
  const item = d.createQueue(ctx).enqueue({
    kind: isFix ? "fix" : "pr",
    repo: task.repo,
    issueUrl: issue?.url ?? null,
    prUrl,
    taskId: task.id,
    title: prTitle,
    body: prBody,
    diff: impl.diff,
    testOutput: testOutputOf(impl),
    critic,
    verification,
    branch: task.branch,
    workspace: task.workspace,
    baseBranch: strOf(task.data.baseBranch),
    data: {
      issueId: task.issueId,
      requiresCla: policy?.requiresCla ?? false,
      requiresIssueFirst: policy?.requiresIssueFirst ?? false,
      requiresSignoff: policy?.requiresSignoff ?? false,
      policyNotes,
      notes: policyNotes,
      aiPolicy: policy ? policy.ai.classification : null,
      aiPolicyFlags: aiFlags,
      aiPolicyNotes: aiFlags.map((f) => AI_POLICY_FLAG_NOTES[f]),
      requiresHumanText: aiFlags.includes("human_written_text_only"),
      summary: impl.summary,
      // Approval pushes exactly this commit (never the branch tip); the digest binds to it.
      commitSha: impl.commitSha,
      baseSha: impl.baseSha,
      workspaceTaskId: reuseTaskIdOf(task) ?? task.id,
      ...(isFix
        ? { prId: task.prId, prNumber, headRepo: strOf(task.data.headRepo), remoteBranch: strOf(task.data.remoteBranch) ?? task.branch }
        : {}),
    },
  })
  return finishTask(ctx, task, item.id)
}

type Stage = (ctx: AppContext, task: TaskRecord, d: PipelineDeps, run: StageRun) => Promise<TaskRecord>

const STAGES: Record<Exclude<TaskStage, "done">, Stage> = {
  prepare: stagePrepare,
  baseline: stageBaseline,
  implement: stageImplement,
  verify: stageVerify,
  critic: stageCritic,
  enqueue: stageEnqueue,
}

/**
 * Map a thrown error to the task's next state; null = leave the task unchanged (kill switch).
 * Repo code that planted a symlink escaping the work tree (WorkTreeIntegrityError) aborts the task for
 * good; an interrupted stage (SandboxInterruptedError, or the scheduler's signal) waits without a failure.
 */
function handleStageError(ctx: AppContext, task: TaskRecord, err: unknown, signal?: AbortSignal): TaskRecord | null {
  const now = ctx.clock.now()
  const message = errorMessage(err)
  if (isNamed(err, "KilledError")) return null
  if (isNamed(err, "WorkTreeIntegrityError")) return abortTask(ctx, task, message, { integrity: true })
  if (isNamed(err, "SandboxInterruptedError") || signal?.aborted) return interruptedWait(ctx, task, message)
  const resetAt = rateLimitResetAt(err)
  if (resetAt !== null) {
    const until = Math.max(resetAt, now, ctx.store.getKv<number>(GITHUB_PAUSED_KEY) ?? 0)
    ctx.store.setKv(GITHUB_PAUSED_KEY, until, now)
    ctx.log.warn("GitHub rate limit: pausing GitHub work", { task: task.id, until: new Date(until).toISOString() })
    return waitUntil(task, until, `GitHub rate limit: ${message}`)
  }
  if (isSandboxUnavailable(err)) return waitUntil(task, now + EXTERNAL_RETRY_MS, message)
  recordError(ctx, "task", `${task.id} (${task.stage}): ${message}`, { taskId: task.id, stage: task.stage, repo: task.repo })
  return backoff(ctx, task, message)
}

/**
 * Run exactly ONE stage of a task (prepare → baseline → implement → verify → critic → enqueue),
 * persist the result, and return the updated task. Errors become backoff (failures++), aborts
 * are recorded with reasons and audited. Safe to call again after a crash (stages are idempotent).
 *
 * Before every stage the repo is re-checked (deny list, AI policy, skipped by a re-screen) and a
 * follow-up fix's PR must still be open; otherwise the task is aborted with the reason. `opts.signal`
 * interrupts the running stage (the task then waits without a failure); `opts.holder` makes every
 * save conditional on still holding the task's claim.
 */
export async function advanceTask(
  ctx: AppContext,
  task: TaskRecord,
  deps: Partial<PipelineDeps> = {},
  opts: AdvanceOptions = {},
): Promise<TaskRecord> {
  if (ctx.kill.isEngaged() || ctx.config.mode === "off") return task
  if (task.status !== "active" && task.status !== "waiting") return task
  if (opts.signal?.aborted) return task
  const d: PipelineDeps = { ...defaultPipelineDeps, ...deps }
  const running: TaskRecord = { ...task, status: "active" }
  const holder = opts.holder ?? null
  const persist = (t: TaskRecord): boolean => {
    if (holder !== null) return ctx.store.saveTaskIfClaimed(t, holder)
    ctx.store.saveTask(t)
    return true
  }
  const run: StageRun = {
    signal: opts.signal,
    latest: running,
    save(t) {
      run.latest = t
      return persist(t)
    },
  }

  let next: TaskRecord | null
  try {
    if (task.stage === "done") {
      next = advanceTo(ctx, running, "done")
    } else {
      const blocked = preStageBlock(ctx, running)
      next = blocked ? abortTask(ctx, running, blocked) : await STAGES[task.stage](ctx, running, d, run)
    }
  } catch (err) {
    next = handleStageError(ctx, run.latest, err, opts.signal)
  }
  if (next === null) return ctx.store.getTask(task.id) ?? task

  const saved: TaskRecord = { ...next, updatedAt: ctx.clock.now() }
  if (!persist(saved)) {
    ctx.log.warn("task claim lost to another scheduler; result not saved", { task: task.id, stage: task.stage, holder })
    return ctx.store.getTask(task.id) ?? task
  }
  if (saved.stage !== task.stage || saved.status !== task.status) {
    ctx.log.debug("task advanced", { task: task.id, from: task.stage, to: saved.stage, status: saved.status })
  }
  return saved
}

/**
 * Abort the active/waiting follow-up fix tasks of a PR (it was merged or closed): no further LLM spend,
 * nothing queued. Returns the aborted task ids.
 */
export function abortFollowupTasksForPr(ctx: AppContext, prId: string, reason: string): string[] {
  const out: string[] = []
  for (const t of ctx.store.listTasks({ kind: "followup_fix", status: ["active", "waiting"] })) {
    if ((t.prId ?? "").toLowerCase() !== prId.toLowerCase()) continue
    ctx.store.saveTask({ ...abortTask(ctx, t, reason), updatedAt: ctx.clock.now() })
    out.push(t.id)
  }
  return out
}
