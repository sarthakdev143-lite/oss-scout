import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import type { ConfigInput } from "../src/config/schema.ts"
import type { AttemptLog, IssueKind, IssueRecord, ProjectInfo, RepoPolicy, RepoRecord, TaskRecord } from "../src/core/types.ts"
import {
  aiAttributionTrailers,
  aiToolName,
  appendTrailers,
  crashReason,
  fallbackCommitMessage,
  INTERRUPTED_REASON,
  reproCheckpointOf,
  parseFinalizeFields,
  parseFinalizeResponse,
  runImplementation,
  sanitizeCommitMessage,
  shortenSubject,
  type ImplementationDeps,
  type ImplementationInput,
} from "../src/implement/implementer.ts"
import type { AgentRunRequest, AgentRunResult, Usage } from "../src/llm/host.ts"
import { AI_POLICY_FLAG_NOTES, type AiPolicyFlag } from "../src/screening/policy.ts"
import type { GitIdentity, GitPaths, SafeGit } from "../src/workspace/git.ts"
import { SandboxUnavailableError } from "../src/workspace/sandbox.ts"
import { sanitizeWorkTree } from "../src/workspace/workspace.ts"
import { fakeExec, FakeLlm, makeTestContext, type TestContext } from "./helpers/fakes.ts"

// ---------------------------------------------------------------------------
// A tiny on-disk repository with a snapshot-based `git diff`
// ---------------------------------------------------------------------------

function walk(root: string, dir = root, out = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = lstatSync(full)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) walk(root, full, out)
    else out.set(relative(root, full).replace(/\\/g, "/"), readFileSync(full, "utf8"))
  }
  return out
}

const linesOf = (s: string) => (s.endsWith("\n") ? s.slice(0, -1) : s).split("\n")

function unifiedDiff(base: Map<string, string>, now: Map<string, string>): string {
  const paths = [...new Set([...base.keys(), ...now.keys()])].sort()
  let out = ""
  for (const p of paths) {
    const a = base.get(p)
    const b = now.get(p)
    if (a === b) continue
    out += `diff --git a/${p} b/${p}\n`
    if (a === undefined) {
      const nl = linesOf(b!)
      out += `new file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${nl.length} @@\n${nl.map((l) => `+${l}\n`).join("")}`
    } else if (b === undefined) {
      const ol = linesOf(a)
      out += `deleted file mode 100644\n--- a/${p}\n+++ /dev/null\n@@ -1,${ol.length} +0,0 @@\n${ol.map((l) => `-${l}\n`).join("")}`
    } else {
      const ol = linesOf(a)
      const nl = linesOf(b)
      out += `--- a/${p}\n+++ b/${p}\n@@ -1,${ol.length} +1,${nl.length} @@\n${ol.map((l) => `-${l}\n`).join("")}${nl.map((l) => `+${l}\n`).join("")}`
    }
  }
  return out
}

class FakeRepo {
  readonly base: Map<string, string>
  readonly commits: Array<{ message: string; author: GitIdentity; signoff: boolean }> = []
  /** Only resume tests allow a reset; everywhere else the implementer must never reset. */
  allowReset = false
  readonly resets: string[] = []
  constructor(
    readonly workTree: string,
    files: Record<string, string>,
  ) {
    for (const [p, c] of Object.entries(files)) this.write(p, c)
    this.base = walk(workTree)
  }
  write(path: string, content: string): void {
    const full = join(this.workTree, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  read(path: string): string {
    const full = join(this.workTree, path)
    return existsSync(full) ? readFileSync(full, "utf8") : ""
  }
  remove(path: string): void {
    unlinkSync(join(this.workTree, path))
  }
  /** Only the SafeGit methods the implementer uses. */
  git(): SafeGit {
    const fake = {
      diffAgainst: async (_sha: string) => unifiedDiff(this.base, walk(this.workTree)),
      diffCommits: async (_from: string, _to: string) => unifiedDiff(this.base, walk(this.workTree)),
      commitAll: async (message: string, author: GitIdentity, signoff: boolean) => {
        this.commits.push({ message, author, signoff })
        return `c0ffee${this.commits.length}`
      },
      headSha: async () => "base000",
      listFiles: async () => [...walk(this.workTree).keys()],
      resetHard: async (sha: string) => {
        if (!this.allowReset) throw new Error("the implementer must not reset the work tree")
        this.resets.push(sha)
        for (const p of walk(this.workTree).keys()) if (!this.base.has(p)) this.remove(p)
        for (const [p, c] of this.base) this.write(p, c)
      },
    }
    return fake as unknown as SafeGit
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SRC = "src/client.ts"
const TEST = "test/client.test.ts"
const BUGGY = "export function make(timeout: number) {\n  return controller.abort()\n}\n"
const FIXED = "export function make(timeout: number) {\n  if (timeout === 0) return null // FIXED\n  return controller.abort()\n}\n"
const BASE_TEST = 'test("basic", () => expect(make(5)).toBeDefined())\n'
const REPRO_TEST = BASE_TEST + 'test("zero timeout", () => expect(make(0)).toBeNull()) // REPRO\n'
const PASSING_TEST = BASE_TEST + 'test("positive timeout", () => expect(make(1)).toBeDefined())\n'

const policy: RepoPolicy = {
  ai: { classification: "none_found", evidence: [], requiresDisclosure: false, notes: [] },
  contributingFile: "CONTRIBUTING.md",
  contributingExcerpt: "Write tests.",
  codeOfConductFile: null,
  prTemplatePath: null,
  prTemplate: null,
  requiresSignoff: false,
  requiresCla: false,
  requiresIssueFirst: false,
  reservesGoodFirstIssues: false,
  commitConvention: "conventional",
  notes: [],
}

const nodeProject: ProjectInfo = {
  ecosystem: "node",
  packageManager: "npm",
  image: "node:22-bookworm",
  install: "npm ci",
  test: "npm test",
  lint: "npm run lint",
  testFilePatterns: ["**/*.test.ts"],
  notes: [],
}

function issueOf(kind: IssueKind = "bug"): IssueRecord {
  return {
    id: "acme/widget#42",
    repo: "acme/widget",
    number: 42,
    title: "Crash when options.timeout is 0",
    url: "https://github.com/acme/widget/issues/42",
    body: "TypeError when timeout is 0",
    labels: [kind],
    createdAt: "",
    updatedAt: "",
    comments: 0,
    kind,
    status: "selected",
    score: 0.8,
    reasons: [],
    skipReason: null,
    fetchedAt: 0,
  }
}

const isTestPath = (p: string) => /(^|\/)test\/|\.test\.ts$/.test(p)

interface Harness {
  ctx: TestContext
  repo: FakeRepo
  taskDir: string
  progress: Array<{ attemptsUsed: number; attemptsLog: AttemptLog[]; sessionId: string | null; usage: Usage }>
  input: ImplementationInput
  deps: ImplementationDeps
  /** Scripted agent turns; each runAgent call consumes one. */
  turns: Array<(req: AgentRunRequest) => Partial<AgentRunResult> | void>
}

let h: Harness

function setup(
  opts: {
    kind?: IssueKind
    project?: Partial<ProjectInfo>
    config?: ConfigInput
    files?: Record<string, string>
    policy?: Partial<RepoPolicy>
    budgetGuard?: (u: Usage) => string | null
    attemptsUsed?: number
  } = {},
): Harness {
  const ctx = makeTestContext({ config: opts.config ?? {}, login: "octo", exec: fakeExec() })
  const taskDir = mkdtempSync(join(tmpdir(), "oss-scout-impl-"))
  const workTree = join(taskDir, "repo")
  const repo = new FakeRepo(workTree, opts.files ?? { [SRC]: BUGGY, [TEST]: BASE_TEST, "README.md": "# widget\n" })
  const project = { ...nodeProject, ...(opts.project ?? {}) }
  const paths: GitPaths = { taskDir, workTree, gitDir: join(taskDir, "..", "gitdir"), hooksDir: join(taskDir, "hooks"), globalConfig: join(taskDir, "gc") }
  const repoRecord: RepoRecord = {
    fullName: "acme/widget",
    source: "dependency",
    sourceDetail: null,
    status: "eligible",
    score: 0.8,
    reasons: [],
    skipReason: null,
    policy: { ...policy, ...(opts.policy ?? {}) },
    metrics: null,
    discoveredAt: 0,
    screenedAt: 0,
    nextScreenAt: null,
  }
  const task: TaskRecord = {
    id: "task_1",
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
    workspace: taskDir,
    branch: "oss-scout/42-crash",
    tokensUsed: 0,
    costUsd: 0,
    createdAt: 0,
    updatedAt: 0,
    data: {},
  }
  const progress: Harness["progress"] = []
  const turns: Harness["turns"] = []

  // Sandbox semantics: the suite fails while the repro test exists and the source is unfixed.
  ctx.sandbox.responder = (req) => {
    const src = readFileSync(join(req.workTree, SRC), "utf8")
    const testFile = existsSync(join(req.workTree, TEST)) ? readFileSync(join(req.workTree, TEST), "utf8") : ""
    if (req.command === "npm run lint") {
      return src.includes("LINT-ERROR") ? { exitCode: 1, output: "src/client.ts:2 lint error" } : { output: "lint ok" }
    }
    if (req.command.includes("hang")) return { exitCode: 137, timedOut: true, output: "killed" }
    if (testFile.includes("REPRO") && !src.includes("FIXED")) {
      return { exitCode: 1, output: "FAIL test/client.test.ts > zero timeout\nTypeError: Cannot read properties of undefined (reading 'abort')" }
    }
    return { exitCode: 0, output: "PASS 2 tests" }
  }
  ctx.llm.agentResponder = (req) => {
    const turn = turns.shift()
    if (!turn) throw new Error(`unexpected agent turn: ${req.title}`)
    return turn(req) ?? {}
  }

  const deps: ImplementationDeps = {
    isTestFile: (p) => isTestPath(p),
    sanitize: (c, p) => sanitizeWorkTree(c, p),
    // Stand-in for workspace.runProjectCommand: same contract, routed through ctx.sandbox.
    runCommand: async (c, { paths: p, project: proj, label, command, taskId }) => {
      const r = await c.sandbox.run({
        workTree: p.workTree,
        gitDir: p.gitDir,
        command,
        image: proj.image,
        network: "none",
        timeoutMs: 60_000,
        label: `oss-scout-${taskId}-${label}`,
      })
      return { label, command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, outputTail: r.output, network: "none", at: c.clock.now() }
    },
  }

  const input: ImplementationInput = {
    task,
    workspace: { taskDir, paths, git: repo.git(), project, branch: "oss-scout/42-crash", baseBranch: "main", baseSha: "base000", convention: "conventional" },
    repo: repoRecord,
    issue: issueOf(opts.kind ?? "bug"),
    attemptsUsed: opts.attemptsUsed ?? 0,
    budgetGuard: opts.budgetGuard ?? (() => null),
    onProgress: (u) => progress.push(u),
  }
  return { ctx, repo, taskDir, progress, input, deps, turns }
}

const finalizeJson = (over: Record<string, unknown> = {}) =>
  "Done.\n```json\n" +
  JSON.stringify({
    summary: "Return early for a zero timeout instead of aborting an undefined controller.",
    commitMessage: "fix(client): handle zero timeout\n\nAvoid dereferencing the controller when timeout is 0.",
    prTitle: "Handle zero timeout in make()",
    prBody: "## What\nReturn early for timeout 0.\n\n## Testing\nRegression test added; npm test passes.",
    testFiles: ["./repo/test/client.test.ts", "test/does-not-exist.test.ts"],
    ...over,
  }) +
  "\n```"

const writeRepro = () => {
  h.repo.write(TEST, REPRO_TEST)
  return { text: "Added zero timeout test" }
}
const writeFix = () => {
  h.repo.write(SRC, FIXED)
  return { text: "Fixed make() for timeout 0" }
}
const finalize = (over: Record<string, unknown> = {}) => () => ({ text: finalizeJson(over) })

beforeEach(() => {
  h = undefined as unknown as Harness
})
afterEach(() => {
  if (!h) return
  h.ctx.cleanup()
  rmSync(h.taskDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runImplementation: bug with reproduction", () => {
  test("reproduce fails → fix passes → finalize → commit", async () => {
    h = setup()
    h.turns.push(writeRepro, writeFix, finalize())
    const out = await runImplementation(h.ctx, h.input, h.deps)
    if (!out.ok) throw new Error(out.reason)

    // Agent sessions: located in the task dir (never the clone), one session reused, preamble once.
    const runs = h.ctx.llm.agentRuns
    expect(runs.map((r) => r.title)).toEqual([
      "oss-scout acme/widget#42 reproduce",
      "oss-scout acme/widget#42 fix",
      "oss-scout acme/widget#42 finalize",
    ])
    expect(runs.every((r) => r.directory === h.taskDir)).toBe(true)
    expect(runs[0]!.sessionId).toBeNull()
    expect(runs[1]!.sessionId).toBe("ses_1")
    expect(runs[2]!.sessionId).toBe("ses_1")
    expect(runs[0]!.prompt).toContain("You CANNOT run commands")
    expect(runs[0]!.prompt).toContain("Phase 1 of 2")
    expect(runs[1]!.prompt).not.toContain("You CANNOT run commands")
    expect(runs[1]!.prompt).toContain("Phase 2 of 2")
    expect(runs[2]!.prompt).toContain("ONLY a JSON object")
    expect(runs[0]!.timeoutMs).toBe(30 * 60_000)

    // Sandbox: test (fails), test + lint (pass). Nothing ran on the host.
    expect(h.ctx.sandbox.runs.map((r) => r.command)).toEqual(["npm test", "npm test", "npm run lint"])
    expect((h.ctx.exec as ReturnType<typeof fakeExec>).calls).toEqual([])

    // Commit with the agent's message, default author, no sign-off.
    expect(h.repo.commits).toEqual([
      {
        message: "fix(client): handle zero timeout\n\nAvoid dereferencing the controller when timeout is 0.",
        author: { name: "octo", email: "octo@users.noreply.github.com" },
        signoff: false,
      },
    ])

    const o = out.output
    expect(o.reproduced).toBe(true)
    expect(o.prTitle).toBe("Handle zero timeout in make()")
    expect(o.prBody).toContain("Regression test added")
    expect(o.testFiles).toEqual([TEST])
    expect(o.commitSha).toBe("c0ffee1")
    expect(o.baseSha).toBe("base000")
    expect(o.diffStat.files.map((f) => f.path).sort()).toEqual([SRC, TEST])
    expect(o.diff).toContain("FIXED")
    expect(o.finalTestRun).toMatchObject({ label: "test", exitCode: 0 })
    expect(o.finalLintRun).toMatchObject({ label: "lint", exitCode: 0 })
    expect(out.attemptsUsed).toBe(0)
    expect(out.usage).toMatchObject({ inputTokens: 3000, outputTokens: 600 })

    // Progress was persisted with the session id and attempt logs.
    const last = h.progress.at(-1)!
    expect(last.sessionId).toBe("ses_1")
    expect(last.attemptsLog.map((a) => [a.phase, a.ok])).toEqual([
      ["reproduce", true],
      ["fix", true],
    ])
  })

  test("a passing test does not reproduce → retry with feedback", async () => {
    h = setup()
    h.turns.push(
      () => {
        h.repo.write(TEST, PASSING_TEST)
      },
      writeRepro,
      writeFix,
      finalize(),
    )
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out.ok).toBe(true)
    expect(out.attemptsUsed).toBe(1)
    const retry = h.ctx.llm.agentRuns[1]!.prompt
    expect(retry).toContain("does not reproduce the bug")
    expect(retry).toContain("PASS 2 tests")
    expect(h.ctx.llm.agentRuns[1]!.title).toBe("oss-scout acme/widget#42 reproduce")
  })

  test("gives up after maxAttempts with the last failure", async () => {
    h = setup({ config: { implementation: { maxAttempts: 3 } } })
    for (let i = 0; i < 3; i++) h.turns.push(() => void h.repo.write(TEST, PASSING_TEST + `// try ${i}\n`))
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out).toMatchObject({
      ok: false,
      retryable: false,
      attemptsUsed: 3,
      reason: "gave up after 3 attempts: the test passes; it does not reproduce the bug",
    })
    expect(h.ctx.llm.agentRuns).toHaveLength(3)
    expect(h.repo.commits).toEqual([])
  })

  test("resumed with attempts already exhausted gives up without calling the LLM", async () => {
    h = setup({ attemptsUsed: 3 })
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out).toMatchObject({ ok: false, retryable: false, attemptsUsed: 3 })
    expect(h.ctx.llm.agentRuns).toHaveLength(0)
  })

  test("non-test changes in the reproduce phase fail the attempt", async () => {
    h = setup()
    h.turns.push(
      () => {
        h.repo.write(TEST, REPRO_TEST)
        h.repo.write(SRC, FIXED)
      },
      () => {
        h.repo.write(SRC, BUGGY)
      },
      writeFix,
      finalize(),
    )
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out.ok).toBe(true)
    expect(out.attemptsUsed).toBe(1)
    expect(h.ctx.llm.agentRuns[1]!.prompt).toContain(`Revert your changes to: ${SRC}`)
    // The rejected attempt never reached the sandbox.
    expect(h.ctx.sandbox.runs.map((r) => r.command)).toEqual(["npm test", "npm test", "npm run lint"])
  })

  test("no changes at all count as a failed attempt", async () => {
    h = setup()
    h.turns.push(() => ({ text: "I looked around." }), writeRepro, writeFix, finalize())
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out.ok).toBe(true)
    expect(out.attemptsUsed).toBe(1)
    expect(h.ctx.llm.agentRuns[1]!.prompt).toContain("No changes were made")
  })

  test("failing fix → retry prompt carries the test output tail", async () => {
    h = setup()
    h.turns.push(
      writeRepro,
      () => void h.repo.write(SRC, BUGGY.replace("abort()", "abort() // still broken")),
      writeFix,
      finalize(),
    )
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out.ok).toBe(true)
    expect(out.attemptsUsed).toBe(1)
    const retry = h.ctx.llm.agentRuns[2]!.prompt
    expect(retry).toContain("did not succeed")
    expect(retry).toContain("Test failed (exit 1)")
    expect(retry).toContain("reading 'abort'")
  })

  test("lint failure fails the attempt even when tests pass", async () => {
    h = setup()
    h.turns.push(writeRepro, () => void h.repo.write(SRC, FIXED + "// LINT-ERROR\n"), writeFix, finalize())
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out.ok).toBe(true)
    expect(out.attemptsUsed).toBe(1)
    expect(h.ctx.llm.agentRuns[2]!.prompt).toContain("lint error")
  })

  test("deleting the reproduction test in the fix phase is rejected", async () => {
    h = setup()
    h.turns.push(
      writeRepro,
      () => void h.repo.write(TEST, BASE_TEST),
      () => {
        h.repo.write(TEST, REPRO_TEST)
        h.repo.write(SRC, FIXED)
      },
      finalize(),
    )
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out.ok).toBe(true)
    expect(out.attemptsUsed).toBe(1)
    expect(h.ctx.llm.agentRuns[2]!.prompt).toContain("Restore the reproduction test")
  })

  test("reverting every change in the fix phase is reported as an empty change", async () => {
    h = setup({ kind: "enhancement" })
    h.turns.push(
      () => void h.repo.write(SRC, FIXED),
      () => void h.repo.write(SRC, BUGGY),
      () => {
        h.repo.write(SRC, FIXED)
        h.repo.write(TEST, PASSING_TEST)
      },
      finalize(),
    )
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out.ok).toBe(true)
    expect(out.attemptsUsed).toBe(1)
    expect(h.ctx.llm.agentRuns[2]!.prompt).toContain("All changes were reverted")
  })

  test("agent timeout counts an attempt; the session continues", async () => {
    h = setup()
    h.turns.push(() => ({ outcome: "timeout", error: "session exceeded 30m" }), writeRepro, writeFix, finalize())
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out.ok).toBe(true)
    expect(out.attemptsUsed).toBe(1)
    expect(h.ctx.llm.agentRuns[1]!.sessionId).toBe("ses_1")
    expect(h.ctx.llm.agentRuns[1]!.prompt).toContain("timed out")
  })

  test("interrupted session is a retryable infrastructure failure", async () => {
    h = setup()
    h.turns.push(() => ({ outcome: "interrupted", error: "server restarted" }))
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out).toMatchObject({ ok: false, retryable: true, attemptsUsed: 0 })
    if (!out.ok) expect(out.reason).toContain("interrupted")
    expect(out.usage.inputTokens).toBe(1000)
  })

  test("an exception from the LLM host is a retryable failure", async () => {
    h = setup()
    h.turns.push(() => {
      throw new Error("connection refused")
    })
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out).toMatchObject({ ok: false, retryable: true, reason: "agent session error: connection refused" })
  })

  test("SandboxUnavailableError propagates to the pipeline", async () => {
    h = setup()
    h.turns.push(writeRepro)
    const deps: ImplementationDeps = {
      ...h.deps,
      runCommand: async () => {
        throw new SandboxUnavailableError("docker CLI not found")
      },
    }
    await expect(runImplementation(h.ctx, h.input, deps)).rejects.toBeInstanceOf(SandboxUnavailableError)
    // Usage of the agent run was persisted before the failure.
    expect(h.progress.at(-1)!.usage.inputTokens).toBe(1000)
  })

  test("files edited during finalize are re-verified before committing", async () => {
    h = setup()
    h.turns.push(writeRepro, writeFix, () => {
      h.repo.write("README.md", "# widget\n\nZero timeout returns null.\n")
      return { text: finalizeJson() }
    })
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out.ok).toBe(true)
    expect(h.ctx.sandbox.runs.map((r) => r.command)).toEqual(["npm test", "npm test", "npm run lint", "npm test", "npm run lint"])
    if (out.ok) expect(out.output.diff).toContain("Zero timeout returns null.")
  })
})

describe("runImplementation: guards", () => {
  test("LLM host missing → retryable", async () => {
    h = setup()
    const ctx = { ...h.ctx, llm: null } as unknown as TestContext
    const out = await runImplementation(ctx, h.input, h.deps)
    expect(out).toMatchObject({ ok: false, retryable: true, reason: "LLM host unavailable" })
  })

  test("no test command for a code change → not retryable, no LLM call", async () => {
    h = setup({ project: { test: null } })
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out).toMatchObject({ ok: false, retryable: false, reason: "no test command detected; cannot verify a code change" })
    expect(h.ctx.llm.agentRuns).toHaveLength(0)
  })

  test("daily budget stop is retryable and happens before any LLM call", async () => {
    h = setup({ budgetGuard: () => "daily token budget exhausted" })
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out).toMatchObject({ ok: false, retryable: true, reason: "daily token budget exhausted" })
    expect(h.ctx.llm.agentRuns).toHaveLength(0)
  })

  test("per-task budget stop is not retryable and sees accumulated usage", async () => {
    const seen: number[] = []
    h = setup({
      budgetGuard: (u) => {
        seen.push(u.inputTokens)
        return u.inputTokens >= 1000 ? "task token budget exceeded" : null
      },
    })
    h.turns.push(writeRepro)
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out).toMatchObject({ ok: false, retryable: false, reason: "task token budget exceeded" })
    expect(h.ctx.llm.agentRuns).toHaveLength(1)
    expect(seen).toEqual([0, 1000])
  })

  test("budget guard is consulted before the finalize call too", async () => {
    let calls = 0
    h = setup({ budgetGuard: () => (++calls === 3 ? "task cost budget exceeded" : null) })
    h.turns.push(writeRepro, writeFix)
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out).toMatchObject({ ok: false, reason: "task cost budget exceeded" })
    expect(h.repo.commits).toEqual([])
  })
})

describe("runImplementation: other issue kinds", () => {
  test("docs issue: fix phase only, lint run, no reproduction, finalize fallbacks", async () => {
    h = setup({ kind: "docs", project: { test: null } })
    h.turns.push(
      () => void h.repo.write("README.md", "# widget\n\nSet `timeout: 0` to disable timeouts.\n"),
      () => ({ text: "I could not produce JSON, sorry." }),
    )
    const out = await runImplementation(h.ctx, h.input, h.deps)
    if (!out.ok) throw new Error(out.reason)
    expect(h.ctx.llm.agentRuns.map((r) => r.title)).toEqual(["oss-scout acme/widget#42 fix", "oss-scout acme/widget#42 finalize"])
    expect(h.ctx.llm.agentRuns[0]!.prompt).toContain("documentation change")
    expect(h.ctx.sandbox.runs.map((r) => r.command)).toEqual(["npm run lint"])
    const o = out.output
    expect(o.reproduced).toBeNull()
    expect(o.finalTestRun).toBeNull()
    expect(o.finalLintRun).toMatchObject({ exitCode: 0 })
    expect(o.prTitle).toBe("Crash when options.timeout is 0")
    expect(o.commitMessage).toBe("docs: crash when options.timeout is 0")
    expect(o.prBody).toBe(o.summary)
    expect(o.testFiles).toEqual([])
  })

  test("docs issue with a test command still runs the tests", async () => {
    h = setup({ kind: "docs" })
    h.turns.push(() => void h.repo.write("README.md", "# widget\n\nMore docs.\n"), finalize({ testFiles: [] }))
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out.ok).toBe(true)
    expect(h.ctx.sandbox.runs.map((r) => r.command)).toEqual(["npm test", "npm run lint"])
  })

  test("enhancement: no reproduce phase, reproduced null", async () => {
    h = setup({ kind: "enhancement" })
    h.turns.push(() => {
      h.repo.write(SRC, FIXED)
      h.repo.write(TEST, PASSING_TEST)
    }, finalize())
    const out = await runImplementation(h.ctx, h.input, h.deps)
    if (!out.ok) throw new Error(out.reason)
    expect(h.ctx.llm.agentRuns[0]!.title).toBe("oss-scout acme/widget#42 fix")
    expect(out.output.reproduced).toBeNull()
  })

  test("bug without required reproduction: reproduced false", async () => {
    h = setup({ config: { implementation: { requireReproduction: false } } })
    h.turns.push(() => {
      h.repo.write(SRC, FIXED)
      h.repo.write(TEST, REPRO_TEST)
    }, finalize())
    const out = await runImplementation(h.ctx, h.input, h.deps)
    if (!out.ok) throw new Error(out.reason)
    expect(out.output.reproduced).toBe(false)
  })

  test("sign-off, configured author, model/agent and commit message sanitizing", async () => {
    h = setup({
      policy: { requiresSignoff: true },
      config: { implementation: { authorName: "Jane Dev", authorEmail: "jane@example.org", model: "anthropic/claude-x", agent: "build" } },
    })
    h.turns.push(
      writeRepro,
      writeFix,
      finalize({
        commitMessage:
          "fix(client): handle a zero timeout in make() without dereferencing an undefined abort controller instance\n\nBody.\n\nCo-authored-by: Claude <noreply@anthropic.com>\nSigned-off-by: Bot <bot@x>",
      }),
    )
    const out = await runImplementation(h.ctx, h.input, h.deps)
    if (!out.ok) throw new Error(out.reason)
    const commit = h.repo.commits[0]!
    expect(commit.signoff).toBe(true)
    expect(commit.author).toEqual({ name: "Jane Dev", email: "jane@example.org" })
    const [subject] = commit.message.split("\n")
    expect(subject!.length).toBeLessThanOrEqual(72)
    expect(commit.message).not.toMatch(/co-authored-by|signed-off-by/i)
    expect(commit.message).toContain("Body.")
    expect(h.ctx.llm.agentRuns[0]!.model).toEqual({ providerID: "anthropic", modelID: "claude-x" })
    expect(h.ctx.llm.agentRuns[0]!.agent).toBe("build")
  })
})

function aiWithFlags(...flags: AiPolicyFlag[]): RepoPolicy["ai"] {
  return {
    classification: "disclosure_required",
    evidence: [],
    requiresDisclosure: true,
    notes: flags.map((f) => `ai:${f}: ${AI_POLICY_FLAG_NOTES[f]}`),
  }
}

describe("runImplementation: AI attribution trailers required by the repo", () => {
  test("assisted_by_trailer: commit carries Assisted-by naming opencode and the model; never a co-author", async () => {
    h = setup({
      policy: { ai: aiWithFlags("assisted_by_trailer", "no_ai_coauthor_trailer"), requiresSignoff: true },
      config: { implementation: { model: "anthropic/claude-x" } },
    })
    h.turns.push(
      writeRepro,
      writeFix,
      finalize({
        commitMessage:
          "fix(client): handle zero timeout\n\nBody.\n\nAssisted-by: Claude\nCo-authored-by: Claude <noreply@anthropic.com>",
      }),
    )
    const out = await runImplementation(h.ctx, h.input, h.deps)
    if (!out.ok) throw new Error(out.reason)
    const commit = h.repo.commits[0]!
    expect(commit.message).toBe("fix(client): handle zero timeout\n\nBody.\n\nAssisted-by: opencode (anthropic/claude-x)")
    expect(commit.message).not.toMatch(/co-authored-by|generated-by/i)
    expect(commit.signoff).toBe(true)
    // The recorded output matches what was committed.
    expect(out.output.commitMessage).toBe(commit.message)
    // The agent learned the repo's rules in the preamble.
    expect(h.ctx.llm.agentRuns[0]!.prompt).toContain(AI_POLICY_FLAG_NOTES.assisted_by_trailer)
  })

  test("generated_by_trailer without a configured model; fallback commit message", async () => {
    h = setup({ kind: "docs", project: { test: null }, policy: { ai: aiWithFlags("generated_by_trailer") } })
    h.turns.push(() => void h.repo.write("README.md", "# widget\n\nDocs.\n"), () => ({ text: "no json" }))
    const out = await runImplementation(h.ctx, h.input, h.deps)
    if (!out.ok) throw new Error(out.reason)
    expect(h.repo.commits[0]!.message).toBe("docs: crash when options.timeout is 0\n\nGenerated-by: opencode")
  })

  test("no AI trailer when the repo does not ask for one (agent-written ones are stripped)", async () => {
    h = setup({ policy: { ai: aiWithFlags("disclosure_required") } })
    h.turns.push(writeRepro, writeFix, finalize({ commitMessage: "fix(client): handle zero timeout\n\nAssisted-by: Copilot" }))
    const out = await runImplementation(h.ctx, h.input, h.deps)
    if (!out.ok) throw new Error(out.reason)
    expect(h.repo.commits[0]!.message).toBe("fix(client): handle zero timeout")
  })
})

describe("AI attribution helpers", () => {
  test("aiToolName", () => {
    expect(aiToolName(null)).toBe("opencode")
    expect(aiToolName("  ")).toBe("opencode")
    expect(aiToolName("openai/gpt-x#high")).toBe("opencode (openai/gpt-x#high)")
  })

  test("aiAttributionTrailers follows the flags", () => {
    const base = { ...policy }
    expect(aiAttributionTrailers(null, "a/b")).toEqual([])
    expect(aiAttributionTrailers(base, "a/b")).toEqual([])
    expect(aiAttributionTrailers({ ...base, ai: aiWithFlags("no_ai_coauthor_trailer") }, "a/b")).toEqual([])
    expect(aiAttributionTrailers({ ...base, ai: aiWithFlags("assisted_by_trailer", "generated_by_trailer") }, "a/b")).toEqual([
      "Assisted-by: opencode (a/b)",
      "Generated-by: opencode (a/b)",
    ])
  })

  test("appendTrailers starts a trailer block or joins the existing one", () => {
    expect(appendTrailers("fix: a", [])).toBe("fix: a")
    expect(appendTrailers("fix: a", ["Assisted-by: opencode"])).toBe("fix: a\n\nAssisted-by: opencode")
    expect(appendTrailers("fix: a\n\nBody text.\n", ["Assisted-by: opencode"])).toBe("fix: a\n\nBody text.\n\nAssisted-by: opencode")
    expect(appendTrailers("fix: a\n\nBody.\n\nRefs: #12", ["Assisted-by: opencode"])).toBe("fix: a\n\nBody.\n\nRefs: #12\nAssisted-by: opencode")
  })

  test("sanitizeCommitMessage strips agent-written AI trailers", () => {
    expect(sanitizeCommitMessage("fix: a\n\nBody.\n\nAssisted-by: X\ngenerated-by: Y", "f")).toBe("fix: a\n\nBody.")
  })
})

describe("parseFinalizeResponse", () => {
  test("fenced JSON", () => {
    expect(parseFinalizeResponse(finalizeJson())).toMatchObject({
      prTitle: "Handle zero timeout in make()",
      testFiles: ["./repo/test/client.test.ts", "test/does-not-exist.test.ts"],
    })
  })

  test("bare JSON with braces inside strings and surrounding prose", () => {
    const text = 'Summary below {not json}\n{"summary":" s ","commitMessage":"fix: a {b}","prTitle":"T\\n2","prBody":"B","testFiles":[1,"x.test.ts"]} bye'
    expect(parseFinalizeResponse(text)).toEqual({ summary: "s", commitMessage: "fix: a {b}", prTitle: "T 2", prBody: "B", testFiles: ["x.test.ts"] })
  })

  test("missing testFiles defaults to []", () => {
    expect(parseFinalizeResponse('{"summary":"s","commitMessage":"c","prTitle":"t","prBody":"b"}')?.testFiles).toEqual([])
  })

  test("unusable → null", () => {
    expect(parseFinalizeResponse("no json")).toBeNull()
    expect(parseFinalizeResponse('{"summary":"s","commitMessage":"c","prTitle":"t"}')).toBeNull()
    expect(parseFinalizeResponse('{"summary":"s","commitMessage":"","prTitle":"t","prBody":"b"}')).toBeNull()
    expect(parseFinalizeResponse('{"summary":1,"commitMessage":"c","prTitle":"t","prBody":"b"}')).toBeNull()
  })

  test("partial fields are still available for fallbacks", () => {
    expect(parseFinalizeFields('{"prTitle":"Only a title"}')).toEqual({ prTitle: "Only a title" })
  })
})

describe("commit message helpers", () => {
  test("fallbackCommitMessage follows the convention and trims to 72", () => {
    expect(fallbackCommitMessage("conventional", "bug", "Crash when options.timeout is 0")).toBe("fix: crash when options.timeout is 0")
    expect(fallbackCommitMessage("conventional", "tests", "Add tests for parser")).toBe("test: add tests for parser")
    expect(fallbackCommitMessage("conventional", "bug", "fix(parser): Crash on empty input.")).toBe("fix: crash on empty input")
    expect(fallbackCommitMessage("none", "bug", "crash when timeout is 0")).toBe("Crash when timeout is 0")
    const long = fallbackCommitMessage("conventional", "enhancement", "Support " + "very ".repeat(30) + "long titles")
    expect(long.length).toBeLessThanOrEqual(72)
    expect(long.startsWith("feat: support very")).toBe(true)
  })

  test("sanitizeCommitMessage", () => {
    expect(sanitizeCommitMessage("", "fallback")).toBe("fallback")
    expect(sanitizeCommitMessage("Signed-off-by: x <y>", "fallback")).toBe("fallback")
    expect(sanitizeCommitMessage("fix: a\r\n\r\n\r\n\r\nbody", "f")).toBe("fix: a\n\nbody")
  })

  test("shortenSubject cuts at a word boundary", () => {
    expect(shortenSubject("a".repeat(80)).length).toBe(72)
    expect(shortenSubject("word ".repeat(20))).toMatch(/^(word )*word$/)
  })
})

// ---------------------------------------------------------------------------
// Kill switch / scheduler stop (durability-3)
// ---------------------------------------------------------------------------

describe("runImplementation: interruption", () => {
  test("the kill switch engaged during an agent session stops the run: no more sessions, sandbox runs or commits", async () => {
    h = setup()
    h.turns.push(() => {
      h.repo.write(TEST, REPRO_TEST)
      h.ctx.kill.engage("operator", 0)
      return { text: "added test" }
    })
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out).toMatchObject({ ok: false, retryable: true, reason: INTERRUPTED_REASON, attemptsUsed: 0 })
    expect(h.ctx.llm.agentRuns).toHaveLength(1)
    expect(h.ctx.sandbox.runs).toHaveLength(0)
    expect(h.repo.commits).toEqual([])
    // Usage of the interrupted session is still reported and persisted.
    expect(out.usage.inputTokens).toBe(1000)
    expect(h.progress.at(-1)!.usage.inputTokens).toBe(1000)
  })

  test("an already engaged kill switch or aborted signal means no LLM call at all", async () => {
    h = setup()
    h.ctx.kill.engage("operator", 0)
    expect(await runImplementation(h.ctx, h.input, h.deps)).toMatchObject({ ok: false, retryable: true, reason: INTERRUPTED_REASON })
    h.ctx.kill.release()
    const ac = new AbortController()
    ac.abort()
    expect(await runImplementation(h.ctx, { ...h.input, signal: ac.signal }, h.deps)).toMatchObject({ ok: false, reason: INTERRUPTED_REASON })
    expect(h.ctx.llm.agentRuns).toHaveLength(0)
  })

  test("the scheduler's signal reaches the agent session and the sandbox run, and aborting it stops the run", async () => {
    h = setup()
    const ac = new AbortController()
    let sandboxSignal: AbortSignal | undefined
    const deps: ImplementationDeps = {
      ...h.deps,
      runCommand: async (c, args) => {
        sandboxSignal = args.signal
        ac.abort() // e.g. Scheduler.stop() while the test suite runs
        return h.deps.runCommand(c, args)
      },
    }
    h.turns.push(writeRepro)
    const out = await runImplementation(h.ctx, { ...h.input, signal: ac.signal }, deps)
    expect(out).toMatchObject({ ok: false, retryable: true, reason: INTERRUPTED_REASON })
    const agentSignal = h.ctx.llm.agentRuns[0]!.signal
    expect(agentSignal).toBeInstanceOf(AbortSignal)
    expect(agentSignal!.aborted).toBe(true)
    expect(sandboxSignal).toBe(agentSignal)
    // The interrupted test run is not evaluated: no attempt consumed, nothing logged for it.
    expect(h.ctx.llm.agentRuns).toHaveLength(1)
    expect(h.progress.at(-1)!.attemptsLog).toEqual([])
  })

  test("a host error while the run is being stopped is reported as an interruption", async () => {
    h = setup()
    const ac = new AbortController()
    h.turns.push(() => {
      ac.abort()
      throw new Error("session aborted")
    })
    const out = await runImplementation(h.ctx, { ...h.input, signal: ac.signal }, h.deps)
    expect(out).toMatchObject({ ok: false, retryable: true, reason: INTERRUPTED_REASON })
  })
})

// ---------------------------------------------------------------------------
// The fix must be a real fix (pipeline-logic-2)
// ---------------------------------------------------------------------------

describe("runImplementation: reproduction integrity", () => {
  const WEAKENED = REPRO_TEST.replace("toBeNull()", "toBeDefined()")

  test("weakening the reproduction test in the fix phase is rejected, never accepted as a fix", async () => {
    h = setup({ config: { implementation: { maxAttempts: 2 } } })
    h.turns.push(writeRepro, () => void h.repo.write(TEST, WEAKENED), () => void h.repo.write(TEST, WEAKENED + "// again\n"))
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out).toMatchObject({ ok: false, retryable: false, attemptsUsed: 2 })
    if (!out.ok) expect(out.reason).toContain("the reproduction test was changed after it failed: test/client.test.ts")
    expect(h.ctx.llm.agentRuns[2]!.prompt).toContain("Restore it exactly as it was at the end of phase 1")
    expect(h.repo.commits).toEqual([])
    // The weakened test never even reached the sandbox.
    expect(h.ctx.sandbox.runs.map((r) => r.command)).toEqual(["npm test"])
  })

  test("skipping the reproduction test is a change to it, so it is rejected too; restoring it and fixing the source succeeds", async () => {
    h = setup()
    h.turns.push(
      writeRepro,
      () => void h.repo.write(TEST, REPRO_TEST.replace('test("zero timeout"', 'test.skip("zero timeout"')),
      () => {
        h.repo.write(TEST, REPRO_TEST)
        h.repo.write(SRC, FIXED)
      },
      finalize(),
    )
    const out = await runImplementation(h.ctx, h.input, h.deps)
    if (!out.ok) throw new Error(out.reason)
    expect(out.attemptsUsed).toBe(1)
    expect(out.output.reproduced).toBe(true)
    expect(out.output.diffStat.files.map((f) => f.path).sort()).toEqual([SRC, TEST])
  })

  test("the successful reproduce attempt records the test's content hash for resume", async () => {
    h = setup()
    h.turns.push(writeRepro, writeFix, finalize())
    await runImplementation(h.ctx, h.input, h.deps)
    const log = h.progress.at(-1)!.attemptsLog
    const checkpoint = reproCheckpointOf(log)
    expect(checkpoint).toHaveLength(1)
    expect(checkpoint![0]!.path).toBe(TEST)
    expect(checkpoint![0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(reproCheckpointOf([])).toBeNull()
  })

  test("a crashing test run (OOM kill, command not found) is not a reproduction", async () => {
    h = setup()
    let call = 0
    const base = h.ctx.sandbox.responder
    h.ctx.sandbox.responder = (req) => (++call === 1 ? { exitCode: 137, output: "Killed" } : base(req))
    h.turns.push(writeRepro, () => void h.repo.write(TEST, REPRO_TEST + "// retry\n"), writeFix, finalize())
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out.ok).toBe(true)
    expect(out.attemptsUsed).toBe(1)
    expect(h.progress.at(-1)!.attemptsLog[0]).toMatchObject({ phase: "reproduce", ok: false })
    expect(h.progress.at(-1)!.attemptsLog[0]!.summary).toContain("crashed (exit 137)")
    expect(h.ctx.llm.agentRuns[1]!.prompt).toContain("That is not a failing test")
  })

  test("crashReason: runtime/signal exits and pytest's non-failure exit codes", () => {
    expect(crashReason({ exitCode: 1, command: "npm test" })).toBeNull()
    expect(crashReason({ exitCode: 2, command: "npm test" })).toBeNull()
    expect(crashReason({ exitCode: 125, command: "npm test" })).not.toBeNull()
    expect(crashReason({ exitCode: 126, command: "npm test" })).not.toBeNull()
    expect(crashReason({ exitCode: 127, command: "npm test" })).not.toBeNull()
    expect(crashReason({ exitCode: 137, command: "npm test" })).not.toBeNull()
    expect(crashReason({ exitCode: 1, command: ". .oss-scout-venv/bin/activate && python -m pytest -q -x" })).toBeNull()
    for (const code of [2, 3, 4, 5]) expect(crashReason({ exitCode: code, command: "python -m pytest -q" })).toContain("pytest")
  })

  test("an enhancement that changes only tests is not accepted", async () => {
    h = setup({ kind: "enhancement" })
    h.turns.push(() => void h.repo.write(TEST, PASSING_TEST), () => void h.repo.write(SRC, FIXED), finalize())
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out.ok).toBe(true)
    expect(out.attemptsUsed).toBe(1)
    expect(h.progress.at(-1)!.attemptsLog[0]!.summary).toContain("only test files changed")
    expect(h.ctx.llm.agentRuns[1]!.prompt).toContain("Make the change in the source code")
  })

  test("a tests issue may change test files only", async () => {
    h = setup({ kind: "tests" })
    h.turns.push(() => void h.repo.write(TEST, PASSING_TEST), finalize())
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out.ok).toBe(true)
    expect(out.attemptsUsed).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Follow-up fixes (pipeline-logic-3)
// ---------------------------------------------------------------------------

describe("runImplementation: follow-up fixes", () => {
  test("a follow-up fix on a bug PR reports reproduction as not applicable (null), not as missing", async () => {
    h = setup()
    const task = { ...h.input.task, kind: "followup_fix" as const, prId: "acme/widget#7", data: { feedback: "Please rename `make` to `create`." } }
    h.turns.push(() => void h.repo.write(SRC, FIXED.replace("make", "create")), finalize())
    const out = await runImplementation(h.ctx, { ...h.input, task, feedback: task.data.feedback }, h.deps)
    if (!out.ok) throw new Error(out.reason)
    expect(h.ctx.llm.agentRuns.map((r) => r.title.split(" ").at(-1))).toEqual(["fix", "finalize"])
    expect(out.output.reproduced).toBeNull()
    expect(out.output.testFiles).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Resume over leftover edits (pipeline-logic-4)
// ---------------------------------------------------------------------------

describe("runImplementation: resume", () => {
  /** First run: reproduce + fix verified, then the daily budget stops it before finalize. */
  async function interruptedBeforeFinalize(): Promise<{ attemptsLog: AttemptLog[]; attemptsUsed: number }> {
    let calls = 0
    h = setup({ budgetGuard: () => (++calls === 3 ? "daily token budget exhausted" : null) })
    h.turns.push(writeRepro, writeFix)
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out).toMatchObject({ ok: false, retryable: true, reason: "daily token budget exhausted" })
    const last = h.progress.at(-1)!
    return { attemptsLog: last.attemptsLog, attemptsUsed: last.attemptsUsed }
  }

  function resumed(state: { attemptsLog: AttemptLog[]; attemptsUsed: number }): ImplementationInput {
    return {
      ...h.input,
      task: { ...h.input.task, attempts: state.attemptsUsed, data: { attemptsLog: state.attemptsLog, sessionId: "ses_1" } },
      attemptsUsed: state.attemptsUsed,
      budgetGuard: () => null,
    }
  }

  test("a verified fix left in the tree is re-verified in the sandbox and finalized: no new attempt, no repeated phases", async () => {
    const state = await interruptedBeforeFinalize()
    const agentBefore = h.ctx.llm.agentRuns.length
    const sandboxBefore = h.ctx.sandbox.runs.length
    h.turns.push(finalize())
    const out = await runImplementation(h.ctx, resumed(state), h.deps)
    if (!out.ok) throw new Error(out.reason)
    const runs = h.ctx.llm.agentRuns.slice(agentBefore)
    expect(runs.map((r) => r.title)).toEqual(["oss-scout acme/widget#42 finalize"])
    // A fresh session: the preamble is sent again.
    expect(runs[0]!.sessionId).toBeNull()
    expect(runs[0]!.prompt).toContain("You CANNOT run commands")
    expect(h.ctx.sandbox.runs.slice(sandboxBefore).map((r) => r.command)).toEqual(["npm test", "npm run lint"])
    expect(out.attemptsUsed).toBe(0)
    expect(out.output.reproduced).toBe(true)
    expect(h.repo.resets).toEqual([])
    expect(h.repo.commits).toHaveLength(1)
  })

  test("interrupted during the fix phase: continues the fix phase with the reproduction test locked", async () => {
    h = setup()
    // First run: reproduction confirmed, then the agent session errors mid-fix with a partial edit.
    h.turns.push(writeRepro, () => {
      h.repo.write(SRC, BUGGY.replace("abort()", "abort() // wip"))
      throw new Error("connection reset")
    })
    const first = await runImplementation(h.ctx, h.input, h.deps)
    expect(first).toMatchObject({ ok: false, retryable: true })
    const state = { attemptsLog: h.progress.at(-1)!.attemptsLog, attemptsUsed: h.progress.at(-1)!.attemptsUsed }
    const agentBefore = h.ctx.llm.agentRuns.length
    h.turns.push(writeFix, finalize())
    const out = await runImplementation(h.ctx, resumed(state), h.deps)
    if (!out.ok) throw new Error(out.reason)
    const runs = h.ctx.llm.agentRuns.slice(agentBefore)
    expect(runs.map((r) => r.title.split(" ").at(-1))).toEqual(["fix", "finalize"])
    expect(runs[0]!.prompt).toContain("Resuming interrupted work")
    expect(runs[0]!.prompt).toContain("// wip")
    expect(runs[0]!.prompt).toContain("Keep it exactly as it is")
    expect(out.attemptsUsed).toBe(0)
    expect(out.output.reproduced).toBe(true)
    expect(h.repo.resets).toEqual([])
  })

  test("leftover edits that cannot be attributed (reproduction test changed) are reset to baseSha before reproducing again", async () => {
    const state = await interruptedBeforeFinalize()
    // Someone (a later interrupted session) changed the reproduction test after it was confirmed.
    h.repo.write(TEST, REPRO_TEST + "// edited later\n")
    h.repo.allowReset = true
    const agentBefore = h.ctx.llm.agentRuns.length
    h.turns.push(writeRepro, writeFix, finalize())
    const out = await runImplementation(h.ctx, resumed(state), h.deps)
    if (!out.ok) throw new Error(out.reason)
    expect(h.repo.resets).toEqual(["base000"])
    const runs = h.ctx.llm.agentRuns.slice(agentBefore)
    expect(runs.map((r) => r.title.split(" ").at(-1))).toEqual(["reproduce", "fix", "finalize"])
    expect(runs[0]!.prompt).not.toContain("Resuming interrupted work")
    expect(out.output.diff).not.toContain("edited later")
  })

  test("a resumed run with a clean work tree simply starts over", async () => {
    h = setup({ attemptsUsed: 1 })
    h.turns.push(writeRepro, writeFix, finalize())
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out.ok).toBe(true)
    expect(h.ctx.llm.agentRuns[0]!.title).toBe("oss-scout acme/widget#42 reproduce")
  })

  test("fix-only flow (enhancement): leftover edits are kept and the fix phase continues", async () => {
    h = setup({ kind: "enhancement", attemptsUsed: 1 })
    h.repo.write(SRC, FIXED)
    h.turns.push(() => void h.repo.write(TEST, PASSING_TEST), finalize())
    const out = await runImplementation(h.ctx, h.input, h.deps)
    if (!out.ok) throw new Error(out.reason)
    expect(h.ctx.llm.agentRuns[0]!.title).toBe("oss-scout acme/widget#42 fix")
    expect(h.ctx.llm.agentRuns[0]!.prompt).toContain("Resuming interrupted work")
    expect(out.output.diffStat.files.map((f) => f.path).sort()).toEqual([SRC, TEST])
  })
})

// ---------------------------------------------------------------------------
// Work-tree hygiene before agent turns (isolation-1 / isolation-3)
// ---------------------------------------------------------------------------

describe("runImplementation: work-tree hygiene", () => {
  test("a nested .git planted by a test run is removed before the next agent turn", async () => {
    h = setup()
    let planted = false
    const base = h.ctx.sandbox.responder
    h.ctx.sandbox.responder = (req) => {
      if (!planted) {
        planted = true
        mkdirSync(join(req.workTree, "build-cache", ".git"), { recursive: true })
        writeFileSync(join(req.workTree, "build-cache", ".git", "HEAD"), "ref: refs/heads/main\n")
      }
      return base(req)
    }
    let seenNested: boolean | null = null
    h.turns.push(writeRepro, () => {
      seenNested = existsSync(join(h.repo.workTree, "build-cache", ".git"))
      return writeFix()
    }, finalize())
    const out = await runImplementation(h.ctx, h.input, h.deps)
    expect(out.ok).toBe(true)
    expect(seenNested === false).toBe(true)
    const audits = h.ctx.store.db.query("SELECT action FROM audit WHERE action = 'workspace.sanitize'").all()
    expect(audits.length).toBeGreaterThan(0)
  })

  test("a link escaping the work tree outside artifact dirs aborts the task (not retryable)", async () => {
    h = setup()
    const outside = mkdtempSync(join(tmpdir(), "oss-scout-outside-"))
    try {
      writeFileSync(join(outside, "host-file.txt"), "host data")
      let linked = false
      const base = h.ctx.sandbox.responder
      h.ctx.sandbox.responder = (req) => {
        if (!linked) {
          linked = tryLink(outside, join(req.workTree, "docs-link"))
        }
        return base(req)
      }
      h.turns.push(writeRepro, writeFix, finalize())
      const out = await runImplementation(h.ctx, h.input, h.deps)
      if (!linked) return // links cannot be created on this machine
      expect(out).toMatchObject({ ok: false, retryable: false })
      if (!out.ok) expect(out.reason).toContain("links pointing outside the work tree")
      expect(existsSync(join(h.repo.workTree, "docs-link"))).toBe(false)
      expect(readFileSync(join(outside, "host-file.txt"), "utf8")).toBe("host data")
      // Only the reproduce session ran; the agent never got a turn with the link in place.
      expect(h.ctx.llm.agentRuns).toHaveLength(1)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

/** Directory link (junction on Windows, symlink elsewhere); false when the platform refuses. */
function tryLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir")
    return true
  } catch {
    return false
  }
}

describe("FakeLlm sanity", () => {
  test("FakeLlm records requests", async () => {
    const llm = new FakeLlm()
    await llm.runAgent({ title: "t", directory: "d", prompt: "p", timeoutMs: 1 })
    expect(llm.agentRuns).toHaveLength(1)
  })
})
