import { createHash } from "node:crypto"
import { relative } from "node:path"
import { parseModelRef } from "../config/schema.ts"
import type { AppContext } from "../core/context.ts"
import type {
  AttemptLog,
  CommandRun,
  CommitConvention,
  DiffStat,
  ImplementationOutput,
  IssueKind,
  IssueRecord,
  RepoPolicy,
  RepoRecord,
  TaskRecord,
} from "../core/types.ts"
import { addUsage, ZERO_USAGE, type AgentRunResult, type LlmHost, type Usage } from "../llm/host.ts"
import { hasAiPolicyFlag } from "../screening/policy.ts"
import { tail } from "../util/exec.ts"
import { errorMessage } from "../util/log.ts"
import { redact } from "../util/redact.ts"
import { parseUnifiedDiff } from "../verify/diff.ts"
import { readWorkTreeFile, WorkTreeIntegrityError } from "../workspace/hygiene.ts"
import { isTestFile } from "../workspace/project.ts"
import { SandboxInterruptedError } from "../workspace/sandbox.ts"
import { runProjectCommand, sanitizeWorkTree, type PreparedWorkspace } from "../workspace/workspace.ts"
import {
  buildFinalizePrompt,
  buildFixPrompt,
  buildPreamble,
  buildReproducePrompt,
  buildResumeNote,
  buildRetryPrompt,
  extractJsonObject,
  reproductionApplies,
  type PromptContext,
} from "./prompts.ts"

export interface ImplementationInput {
  task: TaskRecord
  workspace: Pick<PreparedWorkspace, "taskDir" | "paths" | "git" | "project" | "branch" | "baseBranch" | "baseSha" | "convention">
  repo: RepoRecord
  issue: IssueRecord | null
  /** Review feedback to address (follow-up fixes). */
  feedback?: string | null
  /** Attempts already consumed (resume). */
  attemptsUsed: number
  /** Called before every LLM call with usage so far in this run; non-null = stop with that reason. */
  budgetGuard: (usageSoFar: Usage) => string | null
  /** Persist progress (attempt logs, session id) so a crash can resume. */
  onProgress: (update: { attemptsUsed: number; attemptsLog: AttemptLog[]; sessionId: string | null; usage: Usage }) => void
  /** Aborted by the scheduler (stop/reload) or the kill switch: stop ASAP, interrupt the agent and sandbox runs. */
  signal?: AbortSignal
}

export type ImplementationOutcome =
  | { ok: true; output: ImplementationOutput; usage: Usage; attemptsUsed: number }
  | {
      ok: false
      reason: string
      /** true = transient (sandbox/LLM infra/budget-per-day/interrupted): retry later. false = give up on this task. */
      retryable: boolean
      usage: Usage
      attemptsUsed: number
    }

type Failure = Extract<ImplementationOutcome, { ok: false }>

/** Collaborators from the workspace module; injectable for tests. */
export interface ImplementationDeps {
  runCommand: typeof runProjectCommand
  isTestFile: typeof isTestFile
  /** Remove planted nested repositories / escaping links; throws WorkTreeIntegrityError on a suspicious link. */
  sanitize: (ctx: AppContext, paths: ImplementationInput["workspace"]["paths"]) => unknown
}

const defaultDeps: ImplementationDeps = { runCommand: runProjectCommand, isTestFile, sanitize: sanitizeWorkTree }

/** Reason reported when the kill switch or the scheduler's AbortSignal stopped the run (retryable). */
export const INTERRUPTED_REASON = "interrupted (kill switch / scheduler stop)"

/** How often the kill switch file is polled while an agent session or sandbox run is in flight. */
const KILL_POLL_MS = 2000

type Phase = "reproduce" | "fix" | "finalize"

interface Evaluation {
  ok: boolean
  /** One line for logs and the give-up reason. */
  summary: string
  /** Full text handed to the agent on retry (may contain command output). */
  feedback: string
  runs: CommandRun[]
  test: CommandRun | null
  lint: CommandRun | null
}

/** A reproduction test confirmed to fail, with the sha256 of its content at that moment. */
export interface ReproTest {
  path: string
  sha256: string
}

/**
 * AttemptLog entries of a successful reproduce phase also carry the reproduction tests (path +
 * content hash). They are persisted with the attempts log, so a resumed run can verify that the
 * test is still exactly the one that failed and continue with the fix phase.
 */
type ReproAttemptLog = AttemptLog & { reproTests?: ReproTest[] }

const OUTPUT_TAIL_CHARS = 4000
const SUBJECT_MAX = 72

/** Thrown at checkpoints when the run was interrupted; turned into a retryable outcome. */
class Interrupted extends Error {
  constructor() {
    super(INTERRUPTED_REASON)
    this.name = "ImplementationInterrupted"
  }
}

function isNamed(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name
}

/** The reproduction tests recorded by the most recent successful reproduce phase, if any. */
export function reproCheckpointOf(log: AttemptLog[]): ReproTest[] | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i] as ReproAttemptLog
    if (entry.phase !== "reproduce" || !entry.ok) continue
    const tests = entry.reproTests
    if (!Array.isArray(tests) || tests.length === 0) return null
    const valid = tests.every((t) => t && typeof t.path === "string" && t.path && typeof t.sha256 === "string" && /^[0-9a-f]{64}$/.test(t.sha256))
    return valid ? tests.map((t) => ({ path: t.path, sha256: t.sha256 })) : null
  }
  return null
}

/**
 * Exit codes that mean the test command crashed or could not run, not that a test failed:
 * 125-127 (runtime error, not executable, not found), >= 128 (killed by a signal, e.g. OOM),
 * and pytest's 2-5 (interrupted/collection error, internal error, usage error, no tests).
 */
export function crashReason(run: Pick<CommandRun, "exitCode" | "command">): string | null {
  const code = run.exitCode
  if (code === 125 || code === 126 || code === 127) return "the test command could not run"
  if (code >= 128) return "the test run was killed (for example out of memory)"
  if (/\bpytest\b/.test(run.command) && code >= 2 && code <= 5) {
    return "pytest reported a collection, usage or internal error (or collected no tests)"
  }
  return null
}

/**
 * Reproduce → fix → verify loop. The LLM (via ctx.llm.runAgent, located in the task dir, no shell)
 * edits files under repo/; every test/lint run happens in the sandbox. Up to
 * config.implementation.maxAttempts attempts, then gives up with a recorded reason. On success the
 * change is committed locally on the task branch (never pushed).
 *
 * The kill switch and `input.signal` are checked before every LLM call, every sandbox run and
 * between phases, and abort an in-flight agent session or sandbox run; the outcome is then a
 * retryable INTERRUPTED_REASON failure.
 */
export async function runImplementation(
  ctx: AppContext,
  input: ImplementationInput,
  deps: Partial<ImplementationDeps> = {},
): Promise<ImplementationOutcome> {
  if (!ctx.llm) return { ok: false, reason: "LLM host unavailable", retryable: true, usage: ZERO_USAGE, attemptsUsed: input.attemptsUsed }
  return new ImplementationRun(ctx, ctx.llm, input, { ...defaultDeps, ...deps }).execute()
}

class ImplementationRun {
  private usage: Usage = ZERO_USAGE
  private attemptsUsed: number
  private readonly attemptsLog: AttemptLog[]
  private sessionId: string | null = null
  private lastFailure: string | null = null
  private lastAgentText = ""
  /** Reproduction tests confirmed to fail (with content hashes); the fix phase must keep them byte-identical. */
  private repro: ReproTest[] = []
  /** Appended once to the next prompt after resuming over leftover edits. */
  private resumeNote: string | null = null
  private readonly prompt: PromptContext
  private readonly kind: IssueKind
  private readonly isFollowup: boolean
  private readonly abort = new AbortController()
  private killTimer: ReturnType<typeof setInterval> | null = null
  private readonly onExternalAbort = () => this.abort.abort()

  constructor(
    private readonly ctx: AppContext,
    private readonly llm: LlmHost,
    private readonly input: ImplementationInput,
    private readonly deps: ImplementationDeps,
  ) {
    this.attemptsUsed = input.attemptsUsed
    this.attemptsLog = [...(input.task.data.attemptsLog ?? [])]
    this.kind = input.issue?.kind ?? "other"
    const rel = relative(input.workspace.taskDir, input.workspace.paths.workTree).replace(/\\/g, "/")
    this.prompt = {
      repo: input.repo,
      issue: input.issue,
      project: input.workspace.project,
      policy: input.repo.policy,
      convention: input.workspace.convention,
      config: ctx.config,
      workTreeRel: rel && !rel.startsWith("..") ? rel : "repo",
      feedback: input.feedback ?? input.task.data.feedback ?? null,
    }
    this.isFollowup = input.task.kind !== "contribution" || !!this.prompt.feedback
  }

  private get cfg() {
    return this.ctx.config.implementation
  }

  async execute(): Promise<ImplementationOutcome> {
    this.watch()
    try {
      return await this.loop()
    } catch (err) {
      if (err instanceof Interrupted || err instanceof SandboxInterruptedError || isNamed(err, "SandboxInterruptedError")) {
        return this.interruptedOutcome()
      }
      if (err instanceof WorkTreeIntegrityError || isNamed(err, "WorkTreeIntegrityError")) {
        this.progress()
        return this.fail(`work tree integrity check failed: ${errorMessage(err)}`, false)
      }
      // Anything that failed because the run was being torn down is an interruption, not an error.
      if (this.interrupted()) return this.interruptedOutcome()
      throw err
    } finally {
      this.unwatch()
    }
  }

  private async loop(): Promise<ImplementationOutcome> {
    const project = this.input.workspace.project
    if (!project.test && this.kind !== "docs") return this.fail("no test command detected; cannot verify a code change", false)

    const needRepro = this.input.task.kind === "contribution" && reproductionApplies(this.prompt)
    const requiresSourceChange = needRepro || (!this.isFollowup && this.kind === "enhancement")
    let { phase, retry, verified } = await this.resume(needRepro, requiresSourceChange)

    for (;;) {
      this.checkpoint()
      if (phase !== "finalize" && this.attemptsUsed >= this.cfg.maxAttempts) return this.giveUp()
      const stop = this.guard()
      if (stop) return stop

      // Sandboxed code ran since the last agent turn: neutralize anything it planted first.
      this.deps.sanitize(this.ctx, this.input.workspace.paths)
      const before = await this.diff()
      let promptText =
        phase === "finalize"
          ? buildFinalizePrompt(this.prompt, before)
          : retry
            ? buildRetryPrompt(this.prompt, phase, retry)
            : phase === "reproduce"
              ? buildReproducePrompt(this.prompt)
              : buildFixPrompt(this.prompt)
      if (this.resumeNote && phase !== "finalize") promptText = `${promptText}\n\n${this.resumeNote}`
      this.resumeNote = null
      const agent = await this.runAgent(phase, promptText)
      if ("reason" in agent) return agent

      if (phase === "finalize") {
        // The agent was told not to edit files; if it did anyway, re-verify before committing.
        if ((await this.diff()) === before) return this.commit(agent, verified, needRepro)
        const recheck = await this.evaluateFix(before, requiresSourceChange)
        this.record("fix", recheck)
        if (recheck.ok) return this.commit(agent, recheck, needRepro)
        this.failAttempt(recheck)
        phase = "fix"
        retry = recheck.feedback
        continue
      }

      const result =
        agent.outcome !== "succeeded"
          ? this.agentFailure(agent)
          : phase === "reproduce"
            ? await this.evaluateReproduce(before)
            : await this.evaluateFix(before, requiresSourceChange)
      this.record(phase, result)
      if (!result.ok) {
        this.failAttempt(result)
        retry = result.feedback
        continue
      }
      this.lastAgentText = agent.text
      retry = null
      if (phase === "reproduce") phase = "fix"
      else {
        verified = result
        phase = "finalize"
      }
    }
  }

  /**
   * Where to start. A fresh run starts at reproduce (bugs) or fix. A resumed run (attempts were
   * logged before) looks at the work tree:
   *  - clean tree: start over (the earlier edits are gone);
   *  - reproduction flow: continue with the fix phase only when the reproduction tests recorded by
   *    the last successful reproduce phase are still byte-identical; otherwise the leftover edits
   *    cannot be attributed to a phase, so the tree is reset to baseSha and reproduction restarts;
   *  - fix flow: keep the edits and continue the fix phase.
   * When the log ends with a verified fix, the leftover change is re-verified in the sandbox (no LLM
   * call) and goes straight to finalize when it still passes. A resumed run always starts a fresh
   * agent session, told that its predecessor's edits are in place.
   */
  private async resume(
    needRepro: boolean,
    requiresSourceChange: boolean,
  ): Promise<{ phase: Phase; retry: string | null; verified: Evaluation | null }> {
    const start: Phase = needRepro ? "reproduce" : "fix"
    const fresh = { phase: start, retry: null, verified: null }
    if (this.attemptsLog.length === 0 && this.input.attemptsUsed === 0) return fresh

    this.deps.sanitize(this.ctx, this.input.workspace.paths)
    const diff = await this.diff()
    if (parseUnifiedDiff(diff).files.length === 0) return fresh

    if (needRepro) {
      const checkpoint = reproCheckpointOf(this.attemptsLog)
      const intact = checkpoint !== null && checkpoint.every((t) => this.hashOf(t.path) === t.sha256)
      if (!intact) {
        this.ctx.log.info("implement: resuming over unattributable edits; resetting the work tree", { task: this.input.task.id })
        await this.input.workspace.git.resetHard(this.input.workspace.baseSha)
        return fresh
      }
      this.repro = checkpoint
    }

    this.resumeNote = buildResumeNote(this.prompt, diff, this.repro.map((t) => t.path))
    const last = this.attemptsLog.at(-1)
    if (!(last?.phase === "fix" && last.ok)) return { phase: "fix", retry: null, verified: null }

    // The previous run had a verified change: re-verify it (sandbox only) before finalizing.
    const recheck = await this.evaluateFix(null, requiresSourceChange)
    this.record("fix", recheck)
    if (recheck.ok) return { phase: "finalize", retry: null, verified: recheck }
    return { phase: "fix", retry: recheck.feedback, verified: null }
  }

  // -------------------------------------------------------------------------
  // interruption (kill switch, scheduler stop)
  // -------------------------------------------------------------------------

  private watch(): void {
    const signal = this.input.signal
    if (signal) {
      if (signal.aborted) this.abort.abort()
      else signal.addEventListener("abort", this.onExternalAbort, { once: true })
    }
    // The kill switch is a file: poll it so an in-flight session or sandbox run is aborted too.
    const timer = setInterval(() => {
      if (this.ctx.kill.isEngaged()) this.abort.abort()
    }, KILL_POLL_MS)
    ;(timer as { unref?: () => void }).unref?.()
    this.killTimer = timer
  }

  private unwatch(): void {
    if (this.killTimer) clearInterval(this.killTimer)
    this.killTimer = null
    this.input.signal?.removeEventListener("abort", this.onExternalAbort)
  }

  private interrupted(): boolean {
    if (this.abort.signal.aborted) return true
    if (this.ctx.kill.isEngaged()) {
      this.abort.abort()
      return true
    }
    return false
  }

  /** Throws Interrupted when the kill switch is engaged or the scheduler aborted the run. */
  private checkpoint(): void {
    if (this.interrupted()) throw new Interrupted()
  }

  private interruptedOutcome(): Failure {
    this.ctx.log.info("implement: interrupted", { task: this.input.task.id })
    this.progress()
    return this.fail(INTERRUPTED_REASON, true)
  }

  // -------------------------------------------------------------------------
  // agent + bookkeeping
  // -------------------------------------------------------------------------

  private async runAgent(phase: Phase, prompt: string): Promise<AgentRunResult | Failure> {
    this.checkpoint()
    const issue = this.input.issue
    const ref = issue ? `${this.input.repo.fullName}#${issue.number}` : (this.input.task.prId ?? this.input.repo.fullName)
    let res: AgentRunResult
    try {
      res = await this.llm.runAgent({
        title: `oss-scout ${ref} ${phase}`,
        directory: this.input.workspace.taskDir,
        prompt: this.sessionId ? prompt : `${buildPreamble(this.prompt)}\n\n${prompt}`,
        model: parseModelRef(this.cfg.model),
        agent: this.cfg.agent,
        timeoutMs: this.cfg.sessionTimeoutMinutes * 60_000,
        sessionId: this.sessionId,
        signal: this.abort.signal,
      })
    } catch (err) {
      this.progress()
      if (this.interrupted()) throw new Interrupted()
      return this.fail(`agent session error: ${errorMessage(err)}`, true)
    }
    this.usage = addUsage(this.usage, res.usage)
    if (res.sessionId) this.sessionId = res.sessionId
    this.progress()
    this.checkpoint()
    if (res.outcome === "interrupted") {
      return this.fail(`agent session interrupted${res.error ? `: ${redact(res.error)}` : ""}`, true)
    }
    return res
  }

  private guard(): Failure | null {
    const reason = this.input.budgetGuard(this.usage)
    // Daily budgets reset, so stopping on one is transient; per-task budgets are final.
    return reason ? this.fail(reason, /day|daily/i.test(reason)) : null
  }

  private fail(reason: string, retryable: boolean): Failure {
    return { ok: false, reason, retryable, usage: this.usage, attemptsUsed: this.attemptsUsed }
  }

  private giveUp(): Failure {
    const last = this.lastFailure ?? [...this.attemptsLog].reverse().find((a) => !a.ok)?.summary ?? "attempt limit reached"
    return this.fail(`gave up after ${this.attemptsUsed} attempts: ${last}`, false)
  }

  private failAttempt(result: Evaluation): void {
    this.attemptsUsed++
    this.lastFailure = result.summary
    this.progress()
  }

  private record(phase: "reproduce" | "fix" | "finalize", result: Evaluation): void {
    const entry: ReproAttemptLog = {
      attempt: this.attemptsLog.length + 1,
      phase: phase === "reproduce" ? "reproduce" : "fix",
      ok: result.ok,
      summary: result.summary,
      runs: result.runs,
      at: this.ctx.clock.now(),
    }
    if (phase === "reproduce" && result.ok) entry.reproTests = this.repro.map((t) => ({ ...t }))
    this.attemptsLog.push(entry)
    this.progress()
  }

  private progress(): void {
    this.input.onProgress({
      attemptsUsed: this.attemptsUsed,
      attemptsLog: [...this.attemptsLog],
      sessionId: this.sessionId,
      usage: this.usage,
    })
  }

  private diff(): Promise<string> {
    return this.input.workspace.git.diffAgainst(this.input.workspace.baseSha)
  }

  private isTest(path: string): boolean {
    return this.deps.isTestFile(path, this.input.workspace.project)
  }

  /** sha256 of a work-tree file's content (no links followed); null when unreadable. */
  private hashOf(path: string): string | null {
    const buf = readWorkTreeFile(this.input.workspace.paths.workTree, path)
    return buf ? createHash("sha256").update(buf).digest("hex") : null
  }

  private async runCommand(label: "test" | "lint", command: string): Promise<CommandRun> {
    this.checkpoint()
    const run = await this.deps.runCommand(this.ctx, {
      paths: this.input.workspace.paths,
      project: this.input.workspace.project,
      label,
      command,
      taskId: this.input.task.id,
      signal: this.abort.signal,
    })
    // An aborted run's result says nothing about the change.
    this.checkpoint()
    return run
  }

  // -------------------------------------------------------------------------
  // phase evaluation
  // -------------------------------------------------------------------------

  private agentFailure(agent: AgentRunResult): Evaluation {
    const what = agent.outcome === "timeout" ? "the agent session timed out" : "the agent session failed"
    const detail = agent.error ? `: ${redact(agent.error)}` : ""
    return {
      ok: false,
      summary: `${what}${detail}`,
      feedback: `${what}${detail}. Continue the task: finish your edits under ./${this.prompt.workTreeRel} and keep them minimal.`,
      runs: [],
      test: null,
      lint: null,
    }
  }

  private async evaluateReproduce(before: string): Promise<Evaluation> {
    const diff = await this.diff()
    const stat = parseUnifiedDiff(diff)
    if (diff === before || stat.files.length === 0) return noChanges("Add the reproduction test now.")
    const nonTest = stat.files.filter((f) => !this.isTest(f.path)).map((f) => f.path)
    if (nonTest.length) {
      const list = nonTest.join(", ")
      return failed(
        `non-test files changed in the reproduction phase: ${list}`,
        `Only test files may change in this phase. Revert your changes to: ${list}. Keep only the reproduction test.`,
      )
    }
    const tests = stat.files.filter((f) => f.status !== "deleted").map((f) => f.path)
    const hashed = tests.map((path) => ({ path, sha256: this.hashOf(path) }))
    const unreadable = hashed.filter((t) => t.sha256 === null).map((t) => t.path)
    if (unreadable.length) {
      const list = unreadable.join(", ")
      return failed(`the reproduction test file could not be read: ${list}`, `The test file ${list} must be a regular file in the repository. Write the test as a normal file.`)
    }
    const run = await this.runCommand("test", this.input.workspace.project.test!)
    if (run.timedOut) {
      return failed(
        `the test run timed out after ${seconds(run)}s`,
        `The test command timed out after ${seconds(run)}s. Make sure the new test cannot hang.\n\n${outputOf(run)}`,
        [run],
      )
    }
    if (run.exitCode === 0) {
      return failed(
        "the test passes; it does not reproduce the bug",
        `The test suite PASSES with your new test, so it does not reproduce the bug. Adjust the test so that it fails on the current code because of the bug.\n\n${outputOf(run)}`,
        [run],
      )
    }
    const crash = crashReason(run)
    if (crash) {
      return failed(
        `the test run crashed (exit ${run.exitCode}): ${crash}`,
        `The test command exited with code ${run.exitCode}: ${crash}. That is not a failing test. The new test must run and FAIL because of the bug (a wrong result or an unexpected error from the code under test), not because of a syntax error, a missing import, a crash or a usage error.\n\n${outputOf(run)}`,
        [run],
      )
    }
    this.repro = hashed.map((t) => ({ path: t.path, sha256: t.sha256! }))
    return { ok: true, summary: `reproduction test fails as expected (exit ${run.exitCode})`, feedback: "", runs: [run], test: run, lint: null }
  }

  /**
   * Fix-phase checks, then test + lint in the sandbox. `before` = the diff before the agent turn
   * (null: re-verify the current state). In the reproduction flow the reproduction tests must be
   * byte-identical to the version that failed, and (bugs with reproduction, enhancements) at least
   * one non-test file must change: editing or skipping the test is never a fix.
   */
  private async evaluateFix(before: string | null, requiresSourceChange: boolean): Promise<Evaluation> {
    const project = this.input.workspace.project
    const diff = await this.diff()
    const stat = parseUnifiedDiff(diff)
    if (before !== null && diff === before) return noChanges("Make the change now.")
    const removed: string[] = []
    const changed: string[] = []
    for (const t of this.repro) {
      const present = stat.files.some((f) => f.path === t.path && f.status !== "deleted")
      const hash = this.hashOf(t.path)
      if (!present || hash === null) removed.push(t.path)
      else if (hash !== t.sha256) changed.push(t.path)
    }
    if (removed.length) {
      const list = removed.join(", ")
      return failed(
        `the reproduction test was removed or reverted: ${list}`,
        `Restore the reproduction test in ${list}. It must stay part of the change; fix the source code instead.`,
      )
    }
    if (changed.length) {
      const list = changed.join(", ")
      return failed(
        `the reproduction test was changed after it failed: ${list}`,
        `The reproduction test in ${list} was changed after the sandbox confirmed that it fails. Restore it exactly as it was at the end of phase 1 and fix the source code instead.`,
      )
    }
    if (stat.files.length === 0) return failed("the change is empty", "All changes were reverted; the work tree matches the original code. Make the change now.")
    if (requiresSourceChange && !stat.files.some((f) => !this.isTest(f.path))) {
      return failed(
        "only test files changed; the change needs a source (non-test) change",
        "Only test files are changed. Make the change in the source code (non-test files); never change, skip or delete tests to make them pass.",
      )
    }
    const test = project.test ? await this.runCommand("test", project.test) : null
    const lint = project.lint ? await this.runCommand("lint", project.lint) : null
    const runs = [test, lint].filter((r): r is CommandRun => r !== null)
    const bad = runs.filter((r) => r.exitCode !== 0 || r.timedOut)
    if (bad.length === 0) {
      const what = runs.length ? runs.map((r) => `${r.label} passed`).join(", ") : "no test or lint command; change recorded"
      return { ok: true, summary: what, feedback: "", runs, test, lint }
    }
    const summary = bad.map((r) => (r.timedOut ? `${r.label} timed out` : `${r.label} failed (exit ${r.exitCode})`)).join("; ")
    return { ...failed(summary, `${capitalize(summary)}.\n\n${bad.map(outputOf).join("\n\n")}`, runs), test, lint }
  }

  // -------------------------------------------------------------------------
  // finalize + commit
  // -------------------------------------------------------------------------

  private async commit(agent: AgentRunResult, verified: Evaluation | null, needRepro: boolean): Promise<ImplementationOutcome> {
    this.checkpoint()
    const ws = this.input.workspace
    const fields = agent.outcome === "succeeded" ? parseFinalizeFields(agent.text) : {}
    const title = this.input.issue?.title ?? "Address review feedback"
    const summary = fields.summary ?? (this.lastAgentText.trim() ? truncateText(this.lastAgentText.trim(), 1500) : title)
    const commitMessage = appendTrailers(
      sanitizeCommitMessage(fields.commitMessage ?? "", fallbackCommitMessage(ws.convention, this.kind, title)),
      aiAttributionTrailers(this.input.repo.policy, this.cfg.model),
    )
    const prTitle = fields.prTitle ?? title
    const prBody = fields.prBody ?? summary

    const author = await this.author()
    this.deps.sanitize(this.ctx, ws.paths)
    const commitSha = await ws.git.commitAll(commitMessage, author, this.input.repo.policy?.requiresSignoff ?? false)
    // Exactly what was committed (base..commit, raw): this is what is reviewed, scanned and pushed.
    const diff = await ws.git.diffCommits(ws.baseSha, commitSha)
    const diffStat = parseUnifiedDiff(diff)
    const testFiles = this.testFilesOf(diffStat, fields.testFiles ?? [])
    this.progress()

    const output: ImplementationOutput = {
      summary,
      commitMessage,
      prTitle,
      prBody,
      testFiles,
      // null = not applicable: docs/tests/enhancements, and follow-up fixes (the original PR covered it).
      reproduced: needRepro ? true : !this.isFollowup && this.kind === "bug" ? false : null,
      diff,
      diffStat,
      commitSha,
      baseSha: ws.baseSha,
      finalTestRun: verified?.test ?? null,
      finalLintRun: verified?.lint ?? null,
    }
    return { ok: true, output, usage: this.usage, attemptsUsed: this.attemptsUsed }
  }

  private async author(): Promise<{ name: string; email: string }> {
    const { authorName, authorEmail } = this.cfg
    if (authorName && authorEmail) return { name: authorName, email: authorEmail }
    const login = await this.ctx.login()
    return { name: authorName ?? login, email: authorEmail ?? `${login}@users.noreply.github.com` }
  }

  private testFilesOf(stat: DiffStat, claimed: string[]): string[] {
    const changed = stat.files.filter((f) => f.status !== "deleted").map((f) => f.path)
    const prefix = `${this.prompt.workTreeRel}/`
    const normalized = claimed.map((p) => {
      let s = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "")
      if (s.startsWith(prefix)) s = s.slice(prefix.length)
      return s
    })
    const fromAgent = normalized.filter((p) => changed.includes(p))
    const detected = changed.filter((p) => this.isTest(p))
    return [...new Set([...fromAgent, ...detected])]
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function failed(summary: string, feedback: string, runs: CommandRun[] = []): Evaluation {
  return { ok: false, summary, feedback, runs, test: null, lint: null }
}

function noChanges(hint: string): Evaluation {
  return failed("no changes were made", `No changes were made under the repository work tree. ${hint}`)
}

function seconds(run: CommandRun): number {
  return Math.round(run.durationMs / 1000)
}

function outputOf(run: CommandRun): string {
  const status = run.timedOut ? "timed out" : `exit ${run.exitCode}`
  return `Output of \`${run.command}\` (${status}, last part):\n${tail(redact(run.outputTail), OUTPUT_TAIL_CHARS)}`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function truncateText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
}

/** Shorten to `max` characters at a word boundary when possible. */
export function shortenSubject(subject: string, max = SUBJECT_MAX): string {
  const s = subject.replace(/\s+/g, " ").trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const space = cut.lastIndexOf(" ")
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,:;-]+$/, "")
}

const CONVENTIONAL_TYPE: Record<IssueKind, string> = {
  bug: "fix",
  docs: "docs",
  tests: "test",
  enhancement: "feat",
  other: "fix",
}

/** Commit message used when the implementer's JSON has none, e.g. "fix: handle zero timeout". */
export function fallbackCommitMessage(convention: CommitConvention, kind: IssueKind, title: string): string {
  const clean = title.replace(/\s+/g, " ").trim().replace(/\.$/, "") || "Update"
  if (convention === "conventional") {
    const stripped = clean.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "")
    const subject = stripped.charAt(0).toLowerCase() + stripped.slice(1)
    return shortenSubject(`${CONVENTIONAL_TYPE[kind]}: ${subject}`)
  }
  return shortenSubject(clean.charAt(0).toUpperCase() + clean.slice(1))
}

/**
 * Normalize an agent-written commit message: subject ≤ 72 chars, no Co-authored-by / Signed-off-by /
 * Assisted-by / Generated-by trailers (sign-off is added by git only when the repo requires it, AI
 * trailers only via aiAttributionTrailers), collapsed blank lines.
 */
export function sanitizeCommitMessage(message: string, fallback: string): string {
  const lines = message
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => !/^\s*(co-authored-by|signed-off-by|assisted-by|generated-by)\s*:/i.test(l))
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()
  if (!text) return fallback
  const [subject = "", ...rest] = text.split("\n")
  const body = rest.join("\n").trim()
  const short = shortenSubject(subject)
  if (!short) return fallback
  return body ? `${short}\n\n${body}` : short
}

/** The AI tool named in attribution trailers: "opencode", plus the implementation model when configured. */
export function aiToolName(model: string | null): string {
  const m = model?.replace(/\s+/g, " ").trim()
  return m ? `opencode (${m})` : "opencode"
}

/**
 * Commit trailers the repo's AI policy asks for: "Assisted-by: <tool>" (flag assisted_by_trailer) and
 * "Generated-by: <tool>" (flag generated_by_trailer). Never an AI Co-authored-by trailer.
 */
export function aiAttributionTrailers(policy: RepoPolicy | null, model: string | null): string[] {
  if (!policy) return []
  const tool = aiToolName(model)
  const out: string[] = []
  if (hasAiPolicyFlag(policy.ai, "assisted_by_trailer")) out.push(`Assisted-by: ${tool}`)
  if (hasAiPolicyFlag(policy.ai, "generated_by_trailer")) out.push(`Generated-by: ${tool}`)
  return out
}

const TRAILER_LINE_RE = /^[A-Za-z][A-Za-z0-9-]*:\s/

/** Append git trailers to a commit message, joining its trailer block when the body already ends with one. */
export function appendTrailers(message: string, trailers: string[]): string {
  if (trailers.length === 0) return message
  const text = message.trimEnd()
  const paragraphs = text.split("\n\n")
  // The subject line is never a trailer block, even when it reads like one ("fix: …").
  const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1]! : null
  const joins = last !== null && last.split("\n").every((l) => TRAILER_LINE_RE.test(l))
  return `${text}${joins ? "\n" : "\n\n"}${trailers.join("\n")}`
}

interface FinalizeFields {
  summary?: string
  commitMessage?: string
  prTitle?: string
  prBody?: string
  testFiles?: string[]
}

const FINALIZE_KEYS = ["summary", "commitMessage", "prTitle", "prBody", "testFiles"]

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

/** Whatever valid fields the implementer's final JSON has. */
export function parseFinalizeFields(text: string): FinalizeFields {
  const obj = extractJsonObject(text, (o) => FINALIZE_KEYS.some((k) => k in o))
  if (!obj) return {}
  const out: FinalizeFields = {}
  const summary = nonEmptyString(obj.summary)
  const commitMessage = nonEmptyString(obj.commitMessage)
  const prTitle = nonEmptyString(obj.prTitle)
  const prBody = nonEmptyString(obj.prBody)
  if (summary) out.summary = summary
  if (commitMessage) out.commitMessage = commitMessage
  if (prTitle) out.prTitle = prTitle.replace(/\s+/g, " ")
  if (prBody) out.prBody = prBody
  if (Array.isArray(obj.testFiles)) {
    out.testFiles = obj.testFiles.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
  }
  return out
}

/** Parse the implementer's final JSON block ({summary, commitMessage, prTitle, prBody, testFiles}). null if unusable. */
export function parseFinalizeResponse(text: string): {
  summary: string
  commitMessage: string
  prTitle: string
  prBody: string
  testFiles: string[]
} | null {
  const f = parseFinalizeFields(text)
  if (!f.summary || !f.commitMessage || !f.prTitle || !f.prBody) return null
  return { summary: f.summary, commitMessage: f.commitMessage, prTitle: f.prTitle, prBody: f.prBody, testFiles: f.testFiles ?? [] }
}
