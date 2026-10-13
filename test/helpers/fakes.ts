/**
 * Shared test doubles. Every module test builds its AppContext with `makeTestContext()` and
 * overrides only what it needs. Nothing here touches the network, Docker, or real tokens.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseConfig, type ConfigInput, type OssScoutConfig } from "../../src/config/schema.ts"
import type { AppContext } from "../../src/core/context.ts"
import {
  isWriteAuthorization,
  WriteForbiddenError,
  type CreatePullInput,
  type GitHubApi,
  type WriteAuthorization,
} from "../../src/github/api.ts"
import type {
  GhComment,
  GhCommit,
  GhIssue,
  GhPull,
  GhRepo,
  GhReview,
  GhTimelineEvent,
  GhUser,
  RateLimitInfo,
} from "../../src/github/types.ts"
import type { AgentRunRequest, AgentRunResult, GenerateRequest, GenerateResult, LlmHost } from "../../src/llm/host.ts"
import { KillSwitch } from "../../src/scheduler/killswitch.ts"
import { openDatabase } from "../../src/state/db.ts"
import { Store } from "../../src/state/store.ts"
import { FakeClock } from "../../src/util/clock.ts"
import type { Exec, ExecResult } from "../../src/util/exec.ts"
import { nullLogger } from "../../src/util/log.ts"
import { resolvePaths } from "../../src/util/paths.ts"
import type { Sandbox, SandboxAvailability, SandboxRunRequest, SandboxRunResult } from "../../src/workspace/sandbox.ts"

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

type Handlers = { [K in keyof GitHubApi]?: GitHubApi[K] }

export interface RecordedWrite {
  method: "createFork" | "createPull" | "createIssueComment"
  repo: string
  payload: unknown
  auth: WriteAuthorization
}

/**
 * In-memory GitHubApi. Unconfigured read methods throw "unexpected call" so tests notice
 * unplanned traffic. Writes are recorded in `writes` and validate the WriteAuthorization.
 */
export class FakeGitHub implements GitHubApi {
  readonly calls: Array<{ method: string; args: unknown[] }> = []
  readonly writes: RecordedWrite[] = []
  allowWrites = true

  constructor(private handlers: Handlers = {}) {}

  set(handlers: Handlers): this {
    this.handlers = { ...this.handlers, ...handlers }
    return this
  }

  private call<K extends keyof GitHubApi>(method: K, args: unknown[]): any {
    this.calls.push({ method, args })
    const h = this.handlers[method] as ((...a: unknown[]) => unknown) | undefined
    if (!h) throw new Error(`FakeGitHub: unexpected call ${String(method)}(${JSON.stringify(args).slice(0, 200)})`)
    return h(...args)
  }

  getAuthenticatedUser() {
    return this.call("getAuthenticatedUser", [])
  }
  tokenInfo() {
    return this.call("tokenInfo", [])
  }
  listOwnRepos(...a: Parameters<GitHubApi["listOwnRepos"]>) {
    return this.call("listOwnRepos", a)
  }
  getRepo(...a: Parameters<GitHubApi["getRepo"]>) {
    return this.call("getRepo", a)
  }
  getFileContent(...a: Parameters<GitHubApi["getFileContent"]>) {
    return this.call("getFileContent", a)
  }
  listDirectory(...a: Parameters<GitHubApi["listDirectory"]>) {
    return this.call("listDirectory", a)
  }
  getTree(...a: Parameters<GitHubApi["getTree"]>) {
    return this.call("getTree", a)
  }
  getCommunityProfile(...a: Parameters<GitHubApi["getCommunityProfile"]>) {
    return this.call("getCommunityProfile", a)
  }
  searchRepositories(...a: Parameters<GitHubApi["searchRepositories"]>) {
    return this.call("searchRepositories", a)
  }
  searchIssues(...a: Parameters<GitHubApi["searchIssues"]>) {
    return this.call("searchIssues", a)
  }
  getIssue(...a: Parameters<GitHubApi["getIssue"]>) {
    return this.call("getIssue", a)
  }
  listIssueComments(...a: Parameters<GitHubApi["listIssueComments"]>) {
    return this.call("listIssueComments", a)
  }
  listIssueTimeline(...a: Parameters<GitHubApi["listIssueTimeline"]>) {
    return this.call("listIssueTimeline", a)
  }
  listPulls(...a: Parameters<GitHubApi["listPulls"]>) {
    return this.call("listPulls", a)
  }
  getPull(...a: Parameters<GitHubApi["getPull"]>) {
    return this.call("getPull", a)
  }
  listPullReviews(...a: Parameters<GitHubApi["listPullReviews"]>) {
    return this.call("listPullReviews", a)
  }
  listPullReviewComments(...a: Parameters<GitHubApi["listPullReviewComments"]>) {
    return this.call("listPullReviewComments", a)
  }
  listCommits(...a: Parameters<GitHubApi["listCommits"]>) {
    return this.call("listCommits", a)
  }
  rateLimitSnapshot(): RateLimitInfo[] {
    const h = this.handlers.rateLimitSnapshot
    return h ? h() : []
  }

  private checkWrite(auth: WriteAuthorization) {
    if (!this.allowWrites) throw new WriteForbiddenError("writes disabled in FakeGitHub")
    if (!isWriteAuthorization(auth)) throw new WriteForbiddenError("missing WriteAuthorization")
  }
  async createFork(auth: WriteAuthorization, fullName: string): Promise<GhRepo> {
    this.checkWrite(auth)
    this.writes.push({ method: "createFork", repo: fullName, payload: null, auth })
    const h = this.handlers.createFork
    if (h) return h(auth, fullName)
    const [, name] = fullName.split("/")
    return ghRepo({ full_name: `me/${name}`, owner: ghUser("me"), fork: true })
  }
  async createPull(auth: WriteAuthorization, fullName: string, input: CreatePullInput): Promise<GhPull> {
    this.checkWrite(auth)
    this.writes.push({ method: "createPull", repo: fullName, payload: input, auth })
    const h = this.handlers.createPull
    if (h) return h(auth, fullName, input)
    return ghPull({ number: 101, title: input.title, body: input.body, html_url: `https://github.com/${fullName}/pull/101` })
  }
  async createIssueComment(auth: WriteAuthorization, fullName: string, number: number, body: string): Promise<GhComment> {
    this.checkWrite(auth)
    this.writes.push({ method: "createIssueComment", repo: fullName, payload: { number, body }, auth })
    const h = this.handlers.createIssueComment
    if (h) return h(auth, fullName, number, body)
    return ghComment({ body, user: ghUser("me") })
  }
}

// ---------------------------------------------------------------------------
// Sandbox / LLM / exec
// ---------------------------------------------------------------------------

export class FakeSandbox implements Sandbox {
  readonly kind = "fake"
  readonly runs: SandboxRunRequest[] = []
  availability: SandboxAvailability = { ok: true, reason: null, runtime: "fake", version: "1.0" }
  /** Return value per run; default exit 0. */
  responder: (req: SandboxRunRequest) => Partial<SandboxRunResult> = () => ({})
  async available() {
    return this.availability
  }
  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    this.runs.push(req)
    const r = this.responder(req)
    return { exitCode: 0, output: "", timedOut: false, durationMs: 5, ...r }
  }
}

export class FakeLlm implements LlmHost {
  readonly kind = "fake" as const
  readonly agentRuns: AgentRunRequest[] = []
  readonly generations: GenerateRequest[] = []
  agentResponder: (req: AgentRunRequest) => Partial<AgentRunResult> | Promise<Partial<AgentRunResult>> = () => ({})
  generateResponder: (req: GenerateRequest) => string | Promise<string> = () => ""
  async runAgent(req: AgentRunRequest): Promise<AgentRunResult> {
    this.agentRuns.push(req)
    const r = await this.agentResponder(req)
    return {
      sessionId: req.sessionId ?? `ses_${this.agentRuns.length}`,
      text: "",
      usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.01, estimated: false },
      outcome: "succeeded",
      error: null,
      ...r,
    }
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.generations.push(req)
    const text = await this.generateResponder(req)
    return { text, usage: { inputTokens: 500, outputTokens: 100, costUsd: 0.005, estimated: false } }
  }
}

/** Exec double: records argv, answers via responder. */
export function fakeExec(responder: (argv: string[]) => Partial<ExecResult> = () => ({})): Exec & { calls: string[][] } {
  const calls: string[][] = []
  const fn = (async (argv: string[]) => {
    calls.push(argv)
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1, ...responder(argv) }
  }) as Exec & { calls: string[][] }
  fn.calls = calls
  return fn
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface TestContext extends AppContext {
  github: FakeGitHub
  githubWriter: FakeGitHub
  clock: FakeClock
  sandbox: FakeSandbox
  llm: FakeLlm
  /** Temp state dir; removed by cleanup(). */
  cleanup(): void
}

export function testConfig(input: ConfigInput = {}): OssScoutConfig {
  return parseConfig(input)
}

/**
 * Build a full AppContext backed by an in-memory SQLite DB, a temp state dir, FakeClock
 * (2026-01-15T12:00:00Z), FakeGitHub (same instance for reads and writes unless overridden),
 * FakeSandbox and FakeLlm.
 */
export function makeTestContext(
  opts: {
    config?: ConfigInput
    github?: FakeGitHub
    githubWriter?: FakeGitHub
    exec?: Exec
    fetch?: typeof fetch
    login?: string
    writeToken?: string | null
    llm?: FakeLlm | null
  } = {},
): TestContext {
  const stateDir = mkdtempSync(join(tmpdir(), "oss-scout-test-"))
  const config = testConfig({ stateDir, ...(opts.config ?? {}) })
  const paths = resolvePaths(stateDir)
  const store = new Store(openDatabase(":memory:"))
  const github = opts.github ?? new FakeGitHub()
  const ctx = {
    config,
    paths,
    store,
    github,
    githubWriter: opts.githubWriter ?? github,
    clock: new FakeClock(),
    log: nullLogger,
    kill: new KillSwitch(paths.killFile),
    fetch:
      opts.fetch ??
      ((async (input: unknown) => {
        throw new Error(`unexpected fetch ${String(input)}`)
      }) as unknown as typeof fetch),
    exec: opts.exec ?? fakeExec(),
    sandbox: new FakeSandbox(),
    llm: opts.llm === undefined ? new FakeLlm() : opts.llm,
    secrets: {
      writeToken: () => (opts.writeToken === undefined ? "ghp_testtoken000000000000000000000000" : opts.writeToken),
      hasReadToken: () => true,
    },
    login: async () => opts.login ?? "me",
    cleanup: () => {
      try {
        store.db.close()
      } catch {}
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
  return ctx as unknown as TestContext
}

/**
 * Remove a test's temp dir. bun:sqlite statements that only the GC finalizes keep a closed database
 * file open on Windows (EBUSY), and the GC scans the stack conservatively, so collect and retry. A
 * temp dir that still cannot be removed is left behind (cleanup only; it does not affect what the
 * test checked).
 */
export async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    Bun.gc(true)
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== "EBUSY" && code !== "EPERM") throw err
      if (attempt >= 20) return
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

// ---------------------------------------------------------------------------
// GitHub fixture builders
// ---------------------------------------------------------------------------

export function ghUser(login: string, type = "User"): GhUser {
  return { login, id: login.length * 1000 + login.charCodeAt(0), type }
}

export function ghRepo(over: Partial<GhRepo> = {}): GhRepo {
  const full = over.full_name ?? "acme/widget"
  const [owner, name] = full.split("/") as [string, string]
  return {
    id: 1,
    name,
    full_name: full,
    owner: ghUser(owner, "Organization"),
    private: false,
    fork: false,
    archived: false,
    disabled: false,
    html_url: `https://github.com/${full}`,
    clone_url: `https://github.com/${full}.git`,
    description: "A widget library",
    stargazers_count: 1200,
    forks_count: 150,
    open_issues_count: 40,
    pushed_at: "2026-01-14T10:00:00Z",
    updated_at: "2026-01-14T10:00:00Z",
    default_branch: "main",
    language: "TypeScript",
    topics: ["react"],
    has_issues: true,
    has_pull_requests: true,
    pull_request_creation_policy: "all",
    allow_forking: true,
    web_commit_signoff_required: false,
    license: { key: "mit", name: "MIT License", spdx_id: "MIT" },
    ...over,
  }
}

export function ghIssue(over: Partial<GhIssue> = {}): GhIssue {
  const n = over.number ?? 42
  return {
    number: n,
    title: "Crash when options.timeout is 0",
    body:
      "### Steps to reproduce\n1. call `createClient({ timeout: 0 })`\n2. call `client.get('/x')`\n\n### Expected\nNo timeout.\n\n### Actual\n`TypeError: Cannot read properties of undefined (reading 'abort')`\n\nVersion: 3.2.1",
    state: "open",
    html_url: `https://github.com/acme/widget/issues/${n}`,
    user: ghUser("reporter"),
    labels: [{ name: "bug" }, { name: "good first issue" }],
    assignees: [],
    comments: 2,
    locked: false,
    author_association: "NONE",
    created_at: "2026-01-05T09:00:00Z",
    updated_at: "2026-01-10T09:00:00Z",
    ...over,
  }
}

export function ghComment(over: Partial<GhComment> = {}): GhComment {
  return {
    id: over.id ?? 9001,
    body: "Thanks for the report, confirmed.",
    user: ghUser("maintainer"),
    author_association: "MEMBER",
    created_at: "2026-01-06T09:00:00Z",
    updated_at: "2026-01-06T09:00:00Z",
    ...over,
  }
}

export function ghPull(over: Partial<GhPull> = {}): GhPull {
  const n = over.number ?? 7
  return {
    number: n,
    title: "Fix something",
    body: "",
    state: "closed",
    draft: false,
    html_url: `https://github.com/acme/widget/pull/${n}`,
    user: ghUser("contributor"),
    author_association: "CONTRIBUTOR",
    created_at: "2026-01-01T09:00:00Z",
    updated_at: "2026-01-03T09:00:00Z",
    closed_at: "2026-01-03T09:00:00Z",
    merged_at: "2026-01-03T09:00:00Z",
    head: { ref: "fix", sha: "abc", repo: { full_name: "contributor/widget" } },
    base: { ref: "main" },
    ...over,
  }
}

export function ghReview(over: Partial<GhReview> = {}): GhReview {
  return {
    id: over.id ?? 501,
    user: ghUser("maintainer"),
    body: "Looks good, one nit.",
    state: "COMMENTED",
    submitted_at: "2026-01-12T09:00:00Z",
    author_association: "MEMBER",
    ...over,
  }
}

export function ghCommit(over: Partial<GhCommit> & { message?: string; date?: string } = {}): GhCommit {
  const { message, date, ...rest } = over
  return {
    sha: "deadbeef",
    commit: {
      message: message ?? "fix: handle zero timeout",
      author: { name: "Maint", email: "m@example.com", date: date ?? "2026-01-13T09:00:00Z" },
      committer: { name: "Maint", email: "m@example.com", date: date ?? "2026-01-13T09:00:00Z" },
    },
    author: ghUser("maintainer"),
    committer: ghUser("maintainer"),
    ...rest,
  }
}

export function crossRefPr(over: { number?: number; state?: "open" | "closed"; merged?: boolean } = {}): GhTimelineEvent {
  return {
    event: "cross-referenced",
    created_at: "2026-01-08T09:00:00Z",
    source: {
      type: "issue",
      issue: {
        number: over.number ?? 77,
        state: over.state ?? "open",
        pull_request: { merged_at: over.merged ? "2026-01-09T09:00:00Z" : null },
        repository: { full_name: "acme/widget" },
      },
    },
  }
}
