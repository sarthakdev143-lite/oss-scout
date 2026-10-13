import { afterEach, describe, expect, test } from "bun:test"
import type { ConfigInput } from "../src/config/schema.ts"
import type { RepoRecord } from "../src/core/types.ts"
import { GitHubError, KilledError, RateLimitError } from "../src/github/api.ts"
import type { GhComment, GhCommit, GhContentEntry, GhPull, GhRepo, GhReview } from "../src/github/types.ts"
import {
  detectCommitConventionFromSubjects,
  dueRepos,
  policyDocCandidates,
  RESCREEN,
  runScreening,
  screenRepo,
  screenRepoOutcome,
} from "../src/screening/screen.ts"
import { DAY, HOUR } from "../src/util/clock.ts"
import { FakeGitHub, ghComment, ghCommit, ghPull, ghRepo, ghReview, ghUser, makeTestContext, type TestContext } from "./helpers/fakes.ts"

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0) // FakeClock default
const iso = (ms: number) => new Date(ms).toISOString()
const daysAgo = (d: number) => iso(NOW - d * DAY)

// ---------------------------------------------------------------------------
// Fixture: an in-memory "repo filesystem" served through listDirectory/getFileContent
// ---------------------------------------------------------------------------

type Files = Record<string, string>

function listDir(files: Files, dir: string): GhContentEntry[] | null {
  const prefix = dir ? `${dir}/` : ""
  const entries = new Map<string, GhContentEntry>()
  for (const p of Object.keys(files)) {
    if (!p.startsWith(prefix)) continue
    const rest = p.slice(prefix.length)
    const [name, ...deeper] = rest.split("/")
    if (!name) continue
    const type = deeper.length > 0 ? "dir" : "file"
    entries.set(name, { type, name, path: prefix + name, size: type === "file" ? files[p]!.length : 0, sha: "0" })
  }
  if (dir && entries.size === 0) return null
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
}

interface RepoFixture {
  repo: GhRepo
  files: Files
  closed?: GhPull[]
  open?: GhPull[]
  commits?: GhCommit[]
  comments?: Record<number, GhComment[]>
  reviews?: Record<number, GhReview[]>
}

/** FakeGitHub serving the given repos (anything else: 404 / null). */
function fakeGitHub(fixtures: RepoFixture[], orgFiles: Record<string, Files> = {}): FakeGitHub {
  const byName = new Map(fixtures.map((f) => [f.repo.full_name.toLowerCase(), f]))
  const filesOf = (name: string): Files | null => byName.get(name.toLowerCase())?.files ?? orgFiles[name] ?? null
  return new FakeGitHub({
    getRepo: async (name) => {
      const f = byName.get(name.toLowerCase())
      if (!f) throw new GitHubError("Not Found", 404)
      return f.repo
    },
    listDirectory: async (name, path) => {
      const files = filesOf(name)
      return files ? listDir(files, path) : null
    },
    getFileContent: async (name, path) => filesOf(name)?.[path] ?? null,
    listPulls: async (name, opts) => {
      const f = byName.get(name.toLowerCase())!
      return (opts?.state === "closed" ? f.closed : f.open) ?? []
    },
    listCommits: async (name) => byName.get(name.toLowerCase())!.commits ?? [],
    listIssueComments: async (name, n) => byName.get(name.toLowerCase())!.comments?.[n] ?? [],
    listPullReviews: async (name, n) => byName.get(name.toLowerCase())!.reviews?.[n] ?? [],
  })
}

const HEALTHY_FILES: Files = {
  "CONTRIBUTING.md": "# Contributing\n\nPlease open an issue first so we can discuss the change.\n\nRun `npm test` before sending a PR.",
  "CODE_OF_CONDUCT.md": "# Code of Conduct\n\nBe kind.",
  "README.md": "# Widget\n\nA widget library.",
  ".github/workflows/ci.yml": "on: [push]",
  ".github/pull_request_template.md": "## What\n\n## Why\n\n- [ ] Tests added",
  "src/index.ts": "export {}",
}

function outsidePr(n: number, createdDaysAgo: number, merged: boolean): GhPull {
  return ghPull({
    number: n,
    user: ghUser(`contrib${n}`),
    author_association: "CONTRIBUTOR",
    created_at: daysAgo(createdDaysAgo),
    updated_at: daysAgo(createdDaysAgo - 1),
    closed_at: daysAgo(createdDaysAgo - 1),
    merged_at: merged ? daysAgo(createdDaysAgo - 1) : null,
  })
}

function healthyFixture(over: Partial<RepoFixture> = {}): RepoFixture {
  const closed = [
    ...Array.from({ length: 10 }, (_, i) => outsidePr(100 + i, 3 + i * 2, i < 7)),
    ghPull({ number: 200, author_association: "MEMBER", user: ghUser("maint"), merged_at: daysAgo(1) }),
  ]
  const open = [
    ghPull({ number: 300, state: "open", user: ghUser("newbie"), author_association: "FIRST_TIME_CONTRIBUTOR", created_at: daysAgo(4), updated_at: daysAgo(2), closed_at: null, merged_at: null }),
    ghPull({ number: 301, state: "open", user: ghUser("old"), author_association: "NONE", created_at: daysAgo(200), updated_at: daysAgo(150), closed_at: null, merged_at: null }),
  ]
  const comments: Record<number, GhComment[]> = {}
  for (const pr of [...closed, ...open]) {
    comments[pr.number] = [ghComment({ created_at: iso(Date.parse(pr.created_at) + 5 * HOUR), user: ghUser("maint"), author_association: "MEMBER" })]
  }
  return {
    repo: ghRepo(),
    files: HEALTHY_FILES,
    closed,
    open,
    commits: ["fix: a", "feat(core): b", "docs: c", "chore: d", "fix!: e", "refactor: f"].map((m, i) => ghCommit({ message: m, date: daysAgo(i + 1) })),
    comments,
    reviews: {},
    ...over,
  }
}

const contexts: TestContext[] = []
function ctxWith(github: FakeGitHub, config: ConfigInput = {}): TestContext {
  const ctx = makeTestContext({ github, config })
  contexts.push(ctx)
  return ctx
}
afterEach(() => {
  while (contexts.length) contexts.pop()!.cleanup()
})

const methods = (gh: FakeGitHub) => gh.calls.map((c) => c.method)

// ---------------------------------------------------------------------------

describe("screenRepo", () => {
  test("healthy repo is eligible with metrics, policy, reasons, audit and no writes", async () => {
    const gh = fakeGitHub([healthyFixture()])
    const ctx = ctxWith(gh)
    ctx.store.upsertRepoCandidate({ fullName: "acme/widget", source: "dependency", sourceDetail: "npm:widget" }, NOW - DAY)

    const rec = await screenRepo(ctx, "acme/widget")

    expect(rec.status).toBe("eligible")
    expect(rec.skipReason).toBeNull()
    expect(rec.score!).toBeGreaterThanOrEqual(0.55)
    expect(rec.source).toBe("dependency")
    expect(rec.sourceDetail).toBe("npm:widget")
    expect(rec.discoveredAt).toBe(NOW - DAY)
    expect(rec.screenedAt).toBe(NOW)
    expect(rec.nextScreenAt).toBe(NOW + 14 * DAY)
    expect(rec.reasons).toContain("+ outside PR merge rate 70% (n=10)")
    expect(rec.reasons).toContain("+ CI: github-actions")

    const m = rec.metrics!
    expect(m.outsidePrSample).toBe(10)
    expect(m.outsidePrMerged).toBe(7)
    expect(m.medianFirstResponseHours).toBe(5)
    expect(m.openPrCount).toBe(2)
    expect(m.staleOpenPrCount).toBe(1)
    expect(m.ciProviders).toEqual(["github-actions"])
    expect(m.lastMaintainerActivityAt).not.toBeNull()

    const p = rec.policy!
    expect(p.ai.classification).toBe("none_found")
    expect(p.contributingFile).toBe("CONTRIBUTING.md")
    expect(p.codeOfConductFile).toBe("CODE_OF_CONDUCT.md")
    expect(p.prTemplatePath).toBe(".github/pull_request_template.md")
    expect(p.requiresIssueFirst).toBe(true)
    expect(p.commitConvention).toBe("conventional")

    expect(ctx.store.getRepo("acme/widget")).toEqual(rec)
    const [entry] = ctx.store.listAudit({ action: "repo.screen" })
    expect(entry!.decision).toBe("eligible")
    expect(entry!.subject).toBe("acme/widget")
    expect(entry!.reasons).toEqual(rec.reasons)
    expect(entry!.details.score).toBe(rec.score)

    // bounded, read-only traffic
    expect(gh.writes).toEqual([])
    const ms = methods(gh)
    expect(ms.filter((x) => x === "listIssueComments").length).toBeLessThanOrEqual(8)
    expect(ms.filter((x) => x === "listPullReviews").length).toBeLessThanOrEqual(8)
    expect(ms.length).toBeLessThan(40)
    const closedCall = gh.calls.find((c) => c.method === "listPulls" && (c.args[1] as { state?: string }).state === "closed")!
    expect(closedCall.args[1]).toMatchObject({ state: "closed", sort: "updated", direction: "desc", max: 100 })
    const commitsCall = gh.calls.find((c) => c.method === "listCommits")!
    expect(commitsCall.args[1]).toMatchObject({ since: daysAgo(90), max: 30 })
  })

  test("AI-prohibited repo is skipped with evidence before any PR/commit fetches", async () => {
    const files = { ...HEALTHY_FILES, "CONTRIBUTING.md": "# Contributing\n\n## AI policy\n\nWe do not accept contributions generated by LLMs or AI tools." }
    const gh = fakeGitHub([healthyFixture({ files })])
    const ctx = ctxWith(gh)

    const rec = await screenRepo(ctx, "acme/widget")

    expect(rec.status).toBe("skipped")
    expect(rec.skipReason).toContain("AI policy prohibits AI-generated contributions")
    expect(rec.skipReason).toContain("CONTRIBUTING.md")
    expect(rec.policy!.ai.classification).toBe("prohibited")
    expect(rec.policy!.ai.evidence[0]).toMatchObject({ file: "CONTRIBUTING.md", rule: "prohibit" })
    expect(rec.policy!.ai.evidence[0]!.excerpt).toContain("We do not accept contributions generated by LLMs")
    expect(rec.nextScreenAt).toBe(NOW + RESCREEN.prohibitedDays * DAY)
    expect(methods(gh)).not.toContain("listPulls")
    expect(methods(gh)).not.toContain("listCommits")

    const [entry] = ctx.store.listAudit({ action: "repo.screen" })
    expect(entry!.decision).toBe("skip")
    expect(entry!.reasons[0]).toBe(rec.skipReason!)
    expect(entry!.details.aiPolicy).toBe("prohibited")
  })

  test("AI ban in a PR template checkbox skips the repo", async () => {
    const files = { ...HEALTHY_FILES, ".github/pull_request_template.md": "## Checklist\n\n- [ ] I did not use AI to write this pull request" }
    const ctx = ctxWith(fakeGitHub([healthyFixture({ files })]))
    const rec = await screenRepo(ctx, "acme/widget")
    expect(rec.status).toBe("skipped")
    expect(rec.policy!.ai.evidence[0]!.file).toBe(".github/pull_request_template.md")
    expect(rec.policy!.ai.evidence[0]!.rule).toBe("no_ai_certification")
  })

  test("AI policy kept in the owner's .github repository applies (restricted)", async () => {
    const orgFiles = {
      "acme/.github": {
        ".github/AI_POLICY.md": "We support using AI as tools for coding.\n\nWe do not allow autonomous agents to be used for contributing to our projects.",
        "profile/README.md": "# Acme",
      },
    }
    const ctx = ctxWith(fakeGitHub([healthyFixture()], orgFiles))
    const rec = await screenRepo(ctx, "acme/widget")
    expect(rec.status).toBe("skipped")
    expect(rec.policy!.ai.classification).toBe("restricted")
    expect(rec.skipReason).toContain("no_autonomous_agents")
    expect(rec.policy!.ai.evidence[0]!.file).toBe("acme/.github/.github/AI_POLICY.md")
    expect(rec.nextScreenAt).toBe(NOW + RESCREEN.skippedDays * DAY)
  })

  test("owner .github defaults supply a missing contributing guide and PR template", async () => {
    const files = { ".github/workflows/ci.yml": "on: [push]", "src/a.ts": "" }
    const orgFiles = {
      "acme/.github": {
        "CONTRIBUTING.md": "# Contributing\n\nPlease sign the CLA.",
        ".github/PULL_REQUEST_TEMPLATE.md": "## Summary",
      },
    }
    const ctx = ctxWith(fakeGitHub([healthyFixture({ files })], orgFiles))
    const rec = await screenRepo(ctx, "acme/widget")
    expect(rec.policy!.contributingFile).toBe("acme/.github/CONTRIBUTING.md")
    expect(rec.policy!.prTemplatePath).toBe("acme/.github/.github/PULL_REQUEST_TEMPLATE.md")
    expect(rec.policy!.requiresCla).toBe(true)
  })

  test("archived repo is skipped from the repo object alone", async () => {
    const gh = fakeGitHub([healthyFixture({ repo: ghRepo({ archived: true }) })])
    const ctx = ctxWith(gh)
    const rec = await screenRepo(ctx, "acme/widget")
    expect(rec.status).toBe("skipped")
    expect(rec.skipReason).toBe("repository is archived")
    expect(rec.metrics!.archived).toBe(true)
    expect(rec.policy).toBeNull()
    expect(rec.score).toBeNull()
    expect(rec.nextScreenAt).toBe(NOW + RESCREEN.skippedDays * DAY)
    expect(methods(gh)).toEqual(["getRepo"])
  })

  test("PRs restricted to collaborators / too few stars are skipped without further calls", async () => {
    const gh1 = fakeGitHub([healthyFixture({ repo: ghRepo({ pull_request_creation_policy: "collaborators_only" }) })])
    expect((await screenRepo(ctxWith(gh1), "acme/widget")).skipReason).toBe("pull requests are restricted to collaborators")
    const gh2 = fakeGitHub([healthyFixture({ repo: ghRepo({ stargazers_count: 12 }) })])
    expect((await screenRepo(ctxWith(gh2), "acme/widget")).skipReason).toBe("stars 12 below minimum 100")
    expect(methods(gh2)).toEqual(["getRepo"])
  })

  test("denied by config: skipped without any API call", async () => {
    const gh = fakeGitHub([healthyFixture()])
    const ctx = ctxWith(gh, { repos: { deny: ["acme/*"] } })
    const rec = await screenRepo(ctx, "acme/widget")
    expect(rec.status).toBe("skipped")
    expect(rec.skipReason).toBe("denied by config (repos.deny: acme/*)")
    expect(gh.calls).toEqual([])
    expect(ctx.store.listAudit({ action: "repo.screen" })[0]!.decision).toBe("skip")
  })

  test("not in the allow list: skipped without any API call", async () => {
    const gh = fakeGitHub([healthyFixture()])
    const rec = await screenRepo(ctxWith(gh, { repos: { allow: ["other/*"] } }), "acme/widget")
    expect(rec.skipReason).toBe("not in repos.allow")
    expect(gh.calls).toEqual([])
  })

  test("invalid repository name: skipped without any API call", async () => {
    const gh = fakeGitHub([])
    const rec = await screenRepo(ctxWith(gh), "not-a-repo")
    expect(rec.status).toBe("skipped")
    expect(rec.skipReason).toContain("invalid repository name")
    expect(gh.calls).toEqual([])
  })

  test("rate limit propagates and leaves the record untouched", async () => {
    const gh = fakeGitHub([healthyFixture()])
    gh.set({
      listPulls: async () => {
        throw new RateLimitError("GitHub core rate limit exhausted", NOW + HOUR, "core", false)
      },
    })
    const ctx = ctxWith(gh)
    ctx.store.upsertRepoCandidate({ fullName: "acme/widget", source: "search", sourceDetail: null }, NOW - DAY)
    await expect(screenRepo(ctx, "acme/widget")).rejects.toBeInstanceOf(RateLimitError)
    const rec = ctx.store.getRepo("acme/widget")!
    expect(rec.status).toBe("candidate")
    expect(rec.nextScreenAt).toBe(NOW - DAY)
    expect(ctx.store.listErrors()).toEqual([])
  })

  test("kill switch error propagates", async () => {
    const gh = new FakeGitHub({
      getRepo: async () => {
        throw new KilledError()
      },
    })
    await expect(screenRepo(ctxWith(gh), "acme/widget")).rejects.toBeInstanceOf(KilledError)
  })

  test("other errors are recorded; the repo stays a candidate and is retried in a day", async () => {
    const gh = fakeGitHub([healthyFixture()])
    gh.set({
      getFileContent: async () => {
        throw new Error("socket hang up")
      },
    })
    const ctx = ctxWith(gh)
    ctx.store.upsertRepoCandidate({ fullName: "acme/widget", source: "search", sourceDetail: null }, NOW - DAY)
    const out = await screenRepoOutcome(ctx, "acme/widget")
    expect(out.error).toBe("socket hang up")
    expect(out.record.status).toBe("candidate")
    expect(out.record.nextScreenAt).toBe(NOW + DAY)
    expect(ctx.store.getRepo("acme/widget")!.nextScreenAt).toBe(NOW + DAY)
    expect(ctx.store.listErrors()[0]!.message).toBe("screening acme/widget failed: socket hang up")
    expect(ctx.store.listAudit({ action: "repo.screen" })[0]!.decision).toBe("error")
    // screenRepo resolves (does not throw) for non-fatal errors
    expect((await screenRepo(ctx, "acme/widget")).status).toBe("candidate")
  })

  test("errors never leak tokens into the error log", async () => {
    const gh = fakeGitHub([healthyFixture()])
    gh.set({
      getFileContent: async () => {
        throw new Error("request failed: Authorization: token ghp_abcdefghijklmnopqrstuvwxyz0123456789")
      },
    })
    const ctx = ctxWith(gh)
    const out = await screenRepoOutcome(ctx, "acme/widget")
    expect(out.error).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789")
    expect(JSON.stringify(ctx.store.listErrors())).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789")
  })

  test("repository not found (404) is skipped for a long time", async () => {
    const ctx = ctxWith(fakeGitHub([]))
    const rec = await screenRepo(ctx, "gone/repo")
    expect(rec.status).toBe("skipped")
    expect(rec.skipReason).toBe("repository not found or not accessible")
    expect(rec.nextScreenAt).toBe(NOW + RESCREEN.prohibitedDays * DAY)
  })

  test("moved repository: skipped and the new name becomes a candidate", async () => {
    const gh = fakeGitHub([healthyFixture({ repo: ghRepo({ full_name: "newco/widget" }) })])
    gh.set({ getRepo: async () => ghRepo({ full_name: "newco/widget" }) })
    const ctx = ctxWith(gh)
    const rec = await screenRepo(ctx, "acme/widget")
    expect(rec.skipReason).toBe("repository moved to newco/widget")
    expect(ctx.store.getRepo("newco/widget")!.status).toBe("candidate")
    expect(ctx.store.getRepo("newco/widget")!.sourceDetail).toBe("moved from acme/widget")
  })

  test("no CI: skipped before PR fetches; allowed when requireCi is off", async () => {
    const files = { ...HEALTHY_FILES }
    delete files[".github/workflows/ci.yml"]
    const gh = fakeGitHub([healthyFixture({ files })])
    const rec = await screenRepo(ctxWith(gh), "acme/widget")
    expect(rec.skipReason).toBe("no CI configuration detected")
    expect(methods(gh)).not.toContain("listPulls")

    const rec2 = await screenRepo(ctxWith(fakeGitHub([healthyFixture({ files })]), { screening: { requireCi: false } }), "acme/widget")
    expect(rec2.status).toBe("eligible")
    expect(rec2.reasons).toContain("- no CI detected")
  })

  test("root CI markers are detected without extra calls", async () => {
    const files: Files = { ...HEALTHY_FILES, ".travis.yml": "language: node_js", Jenkinsfile: "pipeline {}" }
    delete files[".github/workflows/ci.yml"]
    const rec = await screenRepo(ctxWith(fakeGitHub([healthyFixture({ files })])), "acme/widget")
    expect(rec.metrics!.ciProviders).toEqual(["jenkins", "travis-ci"])
  })

  test("inactive maintainers: hard skip with reason", async () => {
    const old = (n: number) => ({ ...outsidePr(n, 200, true), merged_at: daysAgo(199), closed_at: daysAgo(199), updated_at: daysAgo(199) })
    const fx = healthyFixture({
      repo: ghRepo({ pushed_at: daysAgo(100) }),
      closed: [old(1), old(2)],
      open: [],
      commits: [],
      comments: { 1: [ghComment({ created_at: daysAgo(199) })], 2: [] },
    })
    const rec = await screenRepo(ctxWith(fakeGitHub([fx])), "acme/widget")
    expect(rec.status).toBe("skipped")
    expect(rec.skipReason).toMatch(/^no maintainer activity in 45 days/)
    expect(rec.score).not.toBeNull()
  })

  test("abandoned repo with only bot pushes/commits/merges is skipped despite a fresh pushed_at", async () => {
    const dependabot = ghUser("dependabot[bot]", "Bot")
    const botCommit = (i: number) =>
      ghCommit({
        message: `build(deps): bump dep${i}`,
        date: daysAgo(i + 1),
        author: dependabot,
        committer: ghUser("web-flow"),
      })
    const fx = healthyFixture({
      repo: ghRepo({ pushed_at: daysAgo(1) }),
      closed: [ghPull({ number: 9, user: dependabot, author_association: "NONE", merged_at: daysAgo(2), closed_at: daysAgo(2) })],
      open: [],
      commits: [1, 2, 3].map((i) => {
        const c = botCommit(i)
        return { ...c, commit: { ...c.commit, author: { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com", date: daysAgo(i + 1) } } }
      }),
      comments: {},
    })
    const rec = await screenRepo(ctxWith(fakeGitHub([fx])), "acme/widget")
    expect(rec.status).toBe("skipped")
    expect(rec.skipReason).toBe("no maintainer activity found")
    expect(rec.metrics!.lastMaintainerActivityAt).toBeNull()
    expect(rec.metrics!.pushedAt).toBe(daysAgo(1))
  })

  test("first response: author replies, bots and pending reviews are not maintainer responses", async () => {
    const pr = outsidePr(7, 10, false)
    const t0 = Date.parse(pr.created_at)
    const fx = healthyFixture({
      closed: [pr],
      open: [],
      comments: {
        7: [
          ghComment({ id: 1, user: pr.user, author_association: "CONTRIBUTOR", created_at: iso(t0 + HOUR) }),
          ghComment({ id: 2, user: ghUser("ci-bot[bot]", "Bot"), author_association: "MEMBER", created_at: iso(t0 + 2 * HOUR) }),
          ghComment({ id: 3, user: ghUser("drive-by"), author_association: "NONE", created_at: iso(t0 + 3 * HOUR) }),
        ],
      },
      reviews: {
        7: [
          ghReview({ id: 10, state: "PENDING", submitted_at: iso(t0 + 4 * HOUR) }),
          ghReview({ id: 11, state: "CHANGES_REQUESTED", user: ghUser("maint"), author_association: "COLLABORATOR", submitted_at: iso(t0 + 30 * HOUR) }),
        ],
      },
    })
    const rec = await screenRepo(ctxWith(fakeGitHub([fx]), { screening: { minScore: 0 } }), "acme/widget")
    expect(rec.metrics!.firstResponseSample).toBe(1)
    expect(rec.metrics!.medianFirstResponseHours).toBe(30)
  })

  test("PR template from a PULL_REQUEST_TEMPLATE directory", async () => {
    const files = { ...HEALTHY_FILES }
    delete files[".github/pull_request_template.md"]
    files[".github/PULL_REQUEST_TEMPLATE/bugfix.md"] = "## Bug"
    files[".github/PULL_REQUEST_TEMPLATE/default.md"] = "## Default"
    const rec = await screenRepo(ctxWith(fakeGitHub([healthyFixture({ files })])), "acme/widget")
    expect(rec.policy!.prTemplatePath).toBe(".github/PULL_REQUEST_TEMPLATE/default.md")
    expect(rec.policy!.prTemplate).toBe("## Default")
  })

  test("good-first-issue reservation is recorded on the policy", async () => {
    const files = { ...HEALTHY_FILES, "CONTRIBUTING.md": "# Contributing\n\nIssues labelled good first issue are reserved for first-time contributors." }
    const rec = await screenRepo(ctxWith(fakeGitHub([healthyFixture({ files })])), "acme/widget")
    expect(rec.status).toBe("eligible")
    expect(rec.policy!.reservesGoodFirstIssues).toBe(true)
  })
})

describe("policyDocCandidates", () => {
  const ref = (path: string, type: GhContentEntry["type"] = "file") => ({ path, name: path.split("/").pop()!, type })
  test("canonical paths in priority order, plus AI-policy files and variants, case-insensitive", () => {
    const files = [
      ref("README.md"),
      ref("contributing.rst"),
      ref("AGENTS.md"),
      ref(".github", "dir"),
      ref(".github/CODE_OF_CONDUCT.md"),
      ref(".github/HOWTOAI.md"),
      ref("docs/ai_policy.md"),
      ref("src", "dir"),
    ]
    expect(policyDocCandidates(files)).toEqual(["docs/ai_policy.md", ".github/HOWTOAI.md", "contributing.rst", ".github/CODE_OF_CONDUCT.md", "AGENTS.md", "README.md"])
  })
  test("bounded", () => {
    const files = Array.from({ length: 30 }, (_, i) => ref(`dir${i}/AI_POLICY.md`)).concat([ref("AI.md"), ref("README.md")])
    expect(policyDocCandidates(files).length).toBe(10)
    expect(policyDocCandidates(files, 4).length).toBe(4)
  })
})

describe("detectCommitConventionFromSubjects", () => {
  test("conventional / none / unknown", () => {
    expect(detectCommitConventionFromSubjects(["fix: a", "feat(x): b", "docs: c", "chore!: d", "Merge pull request #1", "test: e"])).toBe("conventional")
    expect(detectCommitConventionFromSubjects(["Fix a bug", "Add feature", "Update docs", "Bump deps", "fix: one"])).toBe("none")
    expect(detectCommitConventionFromSubjects(["fix: a", "feat: b"])).toBe("unknown")
  })
})

// ---------------------------------------------------------------------------

describe("runScreening", () => {
  /** Seed repos; every repo is outside repos.allow so screening needs no GitHub calls and records order. */
  function seeded(maxPerTick: number) {
    const gh = new FakeGitHub()
    const ctx = ctxWith(gh, { repos: { allow: ["nobody/*"] }, screening: { maxPerTick } })
    const save = (fullName: string, status: RepoRecord["status"], nextScreenAt: number) => {
      const { repo } = ctx.store.upsertRepoCandidate({ fullName, source: "search", sourceDetail: null }, NOW - 10 * DAY)
      ctx.store.saveRepo({ ...repo, status, nextScreenAt, screenedAt: status === "candidate" ? null : NOW - 20 * DAY })
    }
    ctx.store.upsertRepoCandidate({ fullName: "c/second", source: "search", sourceDetail: null }, NOW - 2 * HOUR)
    ctx.store.upsertRepoCandidate({ fullName: "c/first", source: "search", sourceDetail: null }, NOW - 3 * HOUR)
    save("c/later", "candidate", NOW + DAY) // not due
    save("e/due", "eligible", NOW - DAY)
    save("e/overdue", "eligible", NOW - 5 * DAY)
    save("e/fresh", "eligible", NOW + 5 * DAY) // not due
    save("s/due", "skipped", NOW - 30 * DAY)
    return { gh, ctx }
  }

  test("new candidates first, then overdue eligible, then skipped; limited to maxPerTick", async () => {
    const { ctx, gh } = seeded(3)
    const r = await runScreening(ctx)
    expect(r.errors).toEqual([])
    expect(r.screened.map((x) => x.fullName)).toEqual(["c/first", "c/second", "e/overdue"])
    expect(gh.calls).toEqual([])
  })

  test("larger limit covers every due repo exactly once", async () => {
    const { ctx } = seeded(10)
    const r = await runScreening(ctx)
    expect(r.screened.map((x) => x.fullName)).toEqual(["c/first", "c/second", "e/overdue", "e/due", "s/due"])
    // screened repos are no longer due
    expect(dueRepos(ctx, NOW, 10)).toEqual([])
  })

  test("per-repo errors are collected and do not stop the tick", async () => {
    const gh = fakeGitHub([healthyFixture()])
    gh.set({
      getRepo: async (name) => {
        if (name === "broken/repo") throw new Error("boom")
        return ghRepo()
      },
    })
    const ctx = ctxWith(gh, { screening: { maxPerTick: 5 } })
    ctx.store.upsertRepoCandidate({ fullName: "broken/repo", source: "search", sourceDetail: null }, NOW - 2 * DAY)
    ctx.store.upsertRepoCandidate({ fullName: "acme/widget", source: "search", sourceDetail: null }, NOW - DAY)
    const r = await runScreening(ctx)
    expect(r.errors).toEqual(["broken/repo: boom"])
    expect(r.screened.map((x) => x.fullName)).toEqual(["acme/widget"])
    expect(ctx.store.getRepo("broken/repo")!.status).toBe("candidate")
  })

  test("rate limit stops the tick", async () => {
    const gh = new FakeGitHub({
      getRepo: async () => {
        throw new RateLimitError("secondary rate limit", NOW + HOUR, "core", true)
      },
    })
    const ctx = ctxWith(gh)
    ctx.store.upsertRepoCandidate({ fullName: "a/b", source: "search", sourceDetail: null }, NOW - DAY)
    ctx.store.upsertRepoCandidate({ fullName: "a/c", source: "search", sourceDetail: null }, NOW - DAY)
    await expect(runScreening(ctx)).rejects.toBeInstanceOf(RateLimitError)
    expect(gh.calls.length).toBe(1)
  })

  test("kill switch: nothing is screened", async () => {
    const gh = new FakeGitHub()
    const ctx = ctxWith(gh)
    ctx.store.upsertRepoCandidate({ fullName: "a/b", source: "search", sourceDetail: null }, NOW - DAY)
    ctx.kill.engage("test", NOW)
    await expect(runScreening(ctx)).rejects.toBeInstanceOf(KilledError)
    expect(gh.calls).toEqual([])
    expect(ctx.store.getRepo("a/b")!.status).toBe("candidate")
  })

  test("nothing due: no work", async () => {
    const ctx = ctxWith(new FakeGitHub())
    expect(await runScreening(ctx)).toEqual({ screened: [], errors: [] })
  })
})
