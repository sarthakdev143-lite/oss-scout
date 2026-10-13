import { describe, expect, test } from "bun:test"
import type { ConfigInput } from "../src/config/schema.ts"
import type { RepoMetrics, RepoPolicy } from "../src/core/types.ts"
import type { GhCommit } from "../src/github/types.ts"
import {
  computeMetrics,
  isBotGitIdentity,
  isBotUser,
  isMaintainerAssociation,
  isOutsideContributor,
  repoHardSkips,
  SCORE_WEIGHTS,
  scoreRepo,
  type HealthInputs,
} from "../src/screening/health.ts"
import { classifyAiPolicy, emptyRepoPolicy } from "../src/screening/policy.ts"
import { DAY, HOUR } from "../src/util/clock.ts"
import { ghCommit, ghPull, ghRepo, ghUser, testConfig } from "./helpers/fakes.ts"

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()
const daysAgo = (d: number) => iso(NOW - d * DAY)

function metrics(over: Partial<RepoMetrics> = {}): RepoMetrics {
  return {
    stars: 5000,
    forks: 300,
    archived: false,
    disabled: false,
    isFork: false,
    license: "MIT",
    defaultBranch: "main",
    language: "TypeScript",
    topics: [],
    pushedAt: daysAgo(1),
    hasIssues: true,
    pullRequestsEnabled: true,
    prCreationPolicy: "all",
    allowForking: true,
    webCommitSignoffRequired: false,
    lastMaintainerActivityAt: daysAgo(1),
    outsidePrSample: 20,
    outsidePrMerged: 14,
    outsideMergeRate: 0.7,
    medianFirstResponseHours: 12,
    firstResponseSample: 8,
    openPrCount: 20,
    staleOpenPrCount: 2,
    hasCi: true,
    ciProviders: ["github-actions"],
    ...over,
  }
}

function policy(over: Partial<RepoPolicy> = {}): RepoPolicy {
  return {
    ...emptyRepoPolicy(ghRepo()),
    contributingFile: "CONTRIBUTING.md",
    contributingExcerpt: "Run tests.",
    prTemplatePath: ".github/pull_request_template.md",
    prTemplate: "## What",
    ...over,
  }
}

const config = (screening: NonNullable<ConfigInput["screening"]> = {}) => testConfig({ screening })
const score = (m: RepoMetrics, p: RepoPolicy = policy(), c = config()) => scoreRepo(m, p, c, NOW)

describe("isOutsideContributor", () => {
  test("outside associations count", () => {
    for (const a of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN", "contributor"]) {
      expect(isOutsideContributor(a, ghUser("someone"))).toBe(true)
    }
  })
  test("maintainers, bots, missing data do not", () => {
    for (const a of ["OWNER", "MEMBER", "COLLABORATOR"]) expect(isOutsideContributor(a, ghUser("m"))).toBe(false)
    expect(isOutsideContributor("NONE", ghUser("renovate", "Bot"))).toBe(false)
    expect(isOutsideContributor("CONTRIBUTOR", ghUser("dependabot[bot]"))).toBe(false)
    expect(isOutsideContributor("NONE", null)).toBe(false)
    expect(isOutsideContributor(undefined, ghUser("x"))).toBe(false)
  })
  test("helpers", () => {
    expect(isBotUser(ghUser("github-actions[bot]"))).toBe(true)
    expect(isBotUser(ghUser("renovate-bot"))).toBe(true)
    expect(isBotUser(ghUser("k8s-ci-robot"))).toBe(true)
    expect(isBotUser(ghUser("alice"))).toBe(false)
    expect(isBotUser(ghUser("talbot"))).toBe(false)
    expect(isBotUser(ghUser("web-flow"))).toBe(false)
    expect(isBotUser(null)).toBe(false)
    expect(isBotGitIdentity({ name: "dependabot[bot]", email: "x@example.com" })).toBe(true)
    expect(isBotGitIdentity({ name: "Release", email: "41898282+github-actions[bot]@users.noreply.github.com" })).toBe(true)
    expect(isBotGitIdentity({ name: "github-actions", email: "action@github.com" })).toBe(true)
    expect(isBotGitIdentity({ name: "Renovate Bot", email: "bot@renovateapp.com" })).toBe(true)
    expect(isBotGitIdentity({ name: "GitHub", email: "noreply@github.com" })).toBe(false)
    expect(isBotGitIdentity({ name: "Alice", email: "alice@example.com" })).toBe(false)
    expect(isBotGitIdentity(null)).toBe(false)
    expect(isMaintainerAssociation("member")).toBe(true)
    expect(isMaintainerAssociation("CONTRIBUTOR")).toBe(false)
  })
})

describe("computeMetrics", () => {
  const base = (over: Partial<HealthInputs> = {}): HealthInputs => ({
    repo: ghRepo({ pushed_at: daysAgo(3) }),
    closedPulls: [],
    openPulls: [],
    firstResponses: [],
    recentCommits: [],
    ciProviders: [],
    now: NOW,
    ...over,
  })

  test("repo fields: license normalisation, PR settings defaults", () => {
    const m = computeMetrics(base())
    expect(m.license).toBe("MIT")
    expect(m.pullRequestsEnabled).toBe(true)
    expect(m.prCreationPolicy).toBe("all")
    expect(m.allowForking).toBe(true)
    expect(m.stars).toBe(1200)

    const noAssert = computeMetrics(base({ repo: ghRepo({ license: { key: "other", name: "Other", spdx_id: "NOASSERTION" } }) }))
    expect(noAssert.license).toBeNull()
    expect(computeMetrics(base({ repo: ghRepo({ license: null }) })).license).toBeNull()

    const legacy = ghRepo()
    delete legacy.has_pull_requests
    delete legacy.allow_forking
    delete legacy.pull_request_creation_policy
    const lm = computeMetrics(base({ repo: legacy }))
    expect(lm.pullRequestsEnabled).toBe(true)
    expect(lm.allowForking).toBe(true)
    expect(lm.prCreationPolicy).toBeNull()

    const off = computeMetrics(
      base({ repo: ghRepo({ has_pull_requests: false, allow_forking: false, pull_request_creation_policy: "collaborators_only", archived: true, fork: true }) }),
    )
    expect(off.pullRequestsEnabled).toBe(false)
    expect(off.allowForking).toBe(false)
    expect(off.prCreationPolicy).toBe("collaborators_only")
    expect(off.archived).toBe(true)
    expect(off.isFork).toBe(true)
  })

  test("outside PR merge rate ignores maintainers and bots", () => {
    const closed = [
      ghPull({ number: 1, author_association: "CONTRIBUTOR", merged_at: daysAgo(5) }),
      ghPull({ number: 2, author_association: "NONE", merged_at: daysAgo(6) }),
      ghPull({ number: 3, author_association: "FIRST_TIME_CONTRIBUTOR", merged_at: daysAgo(7) }),
      ghPull({ number: 4, author_association: "NONE", merged_at: null }),
      ghPull({ number: 5, author_association: "MEMBER", merged_at: daysAgo(2) }),
      ghPull({ number: 6, author_association: "NONE", user: ghUser("dependabot[bot]", "Bot"), merged_at: daysAgo(2) }),
    ]
    const m = computeMetrics(base({ closedPulls: closed }))
    expect(m.outsidePrSample).toBe(4)
    expect(m.outsidePrMerged).toBe(3)
    expect(m.outsideMergeRate).toBe(0.75)
    expect(computeMetrics(base()).outsideMergeRate).toBeNull()
  })

  test("median first response counts unanswered PRs with their age", () => {
    const opened = NOW - 100 * HOUR
    const m = computeMetrics(
      base({
        firstResponses: [
          { openedAt: iso(opened), firstResponseAt: iso(opened + 2 * HOUR) },
          { openedAt: iso(opened), firstResponseAt: iso(opened + 10 * HOUR) },
          { openedAt: iso(opened), firstResponseAt: null },
          { openedAt: "not a date", firstResponseAt: null },
        ],
      }),
    )
    expect(m.firstResponseSample).toBe(3)
    expect(m.medianFirstResponseHours).toBe(10)
    expect(computeMetrics(base()).medianFirstResponseHours).toBeNull()
  })

  test("stale open PRs: no update for 90+ days", () => {
    const m = computeMetrics(
      base({
        openPulls: [
          ghPull({ number: 1, state: "open", updated_at: daysAgo(120), merged_at: null, closed_at: null }),
          ghPull({ number: 2, state: "open", updated_at: daysAgo(10), merged_at: null, closed_at: null }),
          ghPull({ number: 3, state: "open", updated_at: daysAgo(90), merged_at: null, closed_at: null }),
        ],
      }),
    )
    expect(m.openPrCount).toBe(3)
    expect(m.staleOpenPrCount).toBe(2)
  })

  test("last maintainer activity is the latest of human merges, commits and responses", () => {
    const m = computeMetrics(
      base({
        repo: ghRepo({ pushed_at: daysAgo(20) }),
        closedPulls: [ghPull({ merged_at: daysAgo(10) })],
        recentCommits: [ghCommit({ date: daysAgo(8) })],
        firstResponses: [{ openedAt: daysAgo(9), firstResponseAt: daysAgo(4) }],
      }),
    )
    expect(m.lastMaintainerActivityAt).toBe(daysAgo(4))
    const none = computeMetrics(base({ repo: ghRepo({ pushed_at: null }) }))
    expect(none.lastMaintainerActivityAt).toBeNull()
  })

  test("pushes alone are not maintainer activity (any branch, including bot branches)", () => {
    const m = computeMetrics(base({ repo: ghRepo({ pushed_at: daysAgo(1) }) }))
    expect(m.lastMaintainerActivityAt).toBeNull()
    expect(m.pushedAt).toBe(daysAgo(1))
  })

  test("bot commits and bot-authored PR merges are ignored; human commits landed by bots count at author date", () => {
    const dependabot = ghUser("dependabot[bot]", "Bot")
    const botCommit = (date: string, over: Partial<GhCommit> = {}) =>
      ghCommit({
        date,
        author: dependabot,
        committer: ghUser("web-flow"),
        commit: {
          message: "build(deps): bump x",
          author: { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com", date },
          committer: { name: "GitHub", email: "noreply@github.com", date },
        },
        ...over,
      })
    const workflowCommit = ghCommit({
      date: daysAgo(1),
      author: null,
      committer: null,
      commit: {
        message: "chore: regenerate docs",
        author: { name: "github-actions", email: "action@github.com", date: daysAgo(1) },
        committer: { name: "github-actions", email: "action@github.com", date: daysAgo(1) },
      },
    })
    const renovateUser = ghCommit({ date: daysAgo(1), author: ghUser("renovate-bot"), committer: ghUser("renovate-bot") })
    const m = computeMetrics(
      base({
        repo: ghRepo({ pushed_at: daysAgo(1) }),
        closedPulls: [ghPull({ user: dependabot, author_association: "NONE", merged_at: daysAgo(2) })],
        recentCommits: [botCommit(daysAgo(2)), workflowCommit, renovateUser],
      }),
    )
    expect(m.lastMaintainerActivityAt).toBeNull()

    // A maintainer's commit that a merge-queue bot landed: counts when the human wrote it.
    const queued = ghCommit({
      author: ghUser("maint"),
      committer: ghUser("mergify[bot]", "Bot"),
      commit: {
        message: "fix: thing",
        author: { name: "Maint", email: "m@example.com", date: daysAgo(30) },
        committer: { name: "mergify[bot]", email: "37929162+mergify[bot]@users.noreply.github.com", date: daysAgo(1) },
      },
    })
    const human = computeMetrics(base({ recentCommits: [botCommit(daysAgo(1)), queued], closedPulls: [ghPull({ merged_at: daysAgo(40) })] }))
    expect(human.lastMaintainerActivityAt).toBe(daysAgo(30))
  })

  test("CI providers are deduplicated and sorted", () => {
    const m = computeMetrics(base({ ciProviders: ["travis-ci", "github-actions", "travis-ci", ""] }))
    expect(m.ciProviders).toEqual(["github-actions", "travis-ci"])
    expect(m.hasCi).toBe(true)
    expect(computeMetrics(base()).hasCi).toBe(false)
  })
})

describe("scoreRepo", () => {
  test("healthy repo: eligible, high score, readable reasons", () => {
    const r = score(metrics())
    expect(r.hardSkip).toBeNull()
    expect(r.score).toBeGreaterThan(0.8)
    expect(r.score).toBeLessThanOrEqual(1)
    expect(r.reasons).toContain("+ outside PR merge rate 70% (n=20)")
    expect(r.reasons).toContain("+ CI: github-actions")
    expect(r.reasons).toContain("+ last maintainer activity 1 day ago")
    expect(r.reasons).toContain("+ median first maintainer response 12h (n=8)")
    expect(r.reasons).toContain("+ contributing guide: CONTRIBUTING.md")
    expect(r.reasons.some((x) => x.startsWith("skip:"))).toBe(false)
  })

  test("weights sum to 1", () => {
    const sum = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9)
  })

  const hardSkipCases: Array<[string, RepoMetrics, string, ReturnType<typeof config>?]> = [
    ["archived", metrics({ archived: true }), "repository is archived"],
    ["disabled", metrics({ disabled: true }), "repository is disabled"],
    ["fork", metrics({ isFork: true }), "repository is a fork"],
    ["PRs disabled", metrics({ pullRequestsEnabled: false }), "pull requests are disabled"],
    ["collaborators only", metrics({ prCreationPolicy: "collaborators_only" }), "pull requests are restricted to collaborators"],
    ["forking disabled", metrics({ allowForking: false }), "forking is disabled"],
    ["too few stars", metrics({ stars: 40 }), "stars 40 below minimum 100"],
    ["too many stars", metrics({ stars: 90_000 }), "stars 90000 above maximum 50000", config({ maxStars: 50_000 })],
    ["no license", metrics({ license: null }), "no recognized license"],
    ["license not allowed", metrics({ license: "GPL-3.0" }), "license GPL-3.0 not in allowedLicenses", config({ allowedLicenses: ["MIT", "Apache-2.0"] })],
    ["no CI", metrics({ hasCi: false, ciProviders: [] }), "no CI configuration detected"],
    ["inactive maintainers", metrics({ lastMaintainerActivityAt: daysAgo(60), pushedAt: daysAgo(60) }), "no maintainer activity in 45 days (last 2025-11-16)"],
    ["no maintainer activity at all", metrics({ lastMaintainerActivityAt: null }), "no maintainer activity found"],
    [
      "low outside merge rate",
      metrics({ outsidePrSample: 20, outsidePrMerged: 2, outsideMergeRate: 0.1 }),
      "outside PR merge rate 10% (n=20) below minimum 25%",
    ],
  ]
  for (const [name, m, reason, c] of hardSkipCases) {
    test(`hard skip: ${name}`, () => {
      const r = score(m, policy(), c ?? config())
      expect(r.hardSkip).toBe(reason)
      expect(r.reasons[0]).toBe(`skip: ${reason}`)
    })
  }

  test("abandoned repo kept 'fresh' by bot pushes (Dependabot/Renovate) is still hard-skipped", () => {
    const dependabot = ghUser("dependabot[bot]", "Bot")
    const botCommit = ghCommit({
      date: daysAgo(3),
      author: dependabot,
      committer: dependabot,
      commit: {
        message: "build(deps): bump lodash",
        author: { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com", date: daysAgo(3) },
        committer: { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com", date: daysAgo(3) },
      },
    })
    const m = computeMetrics({
      repo: ghRepo({ pushed_at: daysAgo(3) }),
      closedPulls: [ghPull({ user: dependabot, author_association: "NONE", merged_at: daysAgo(3) })],
      openPulls: [],
      firstResponses: [],
      recentCommits: [botCommit],
      ciProviders: ["github-actions"],
      now: NOW,
    })
    expect(m.lastMaintainerActivityAt).toBeNull()
    const r = score(m)
    expect(r.hardSkip).toBe("no maintainer activity found")
    // the push is only a weak score signal, clearly labelled
    expect(r.reasons).toContain("- no human maintainer activity found (last push 3 days ago, possibly automated)")

    // an old push gives no credit at all; a recent one only a little
    const pushed = score(metrics({ lastMaintainerActivityAt: null, pushedAt: daysAgo(3) }))
    const stale = score(metrics({ lastMaintainerActivityAt: null, pushedAt: daysAgo(90) }))
    const active = score(metrics({ lastMaintainerActivityAt: daysAgo(3), pushedAt: daysAgo(3) }))
    expect(stale.reasons).toContain("- no maintainer activity found")
    expect(stale.score).toBeLessThan(pushed.score)
    expect(pushed.score).toBeLessThan(active.score - 0.2)
    expect(pushed.hardSkip).toBe("no maintainer activity found")
  })

  test("hard skip: AI policy prohibited (with evidence)", () => {
    const ai = classifyAiPolicy([{ path: "CONTRIBUTING.md", text: "## AI policy\n\nWe do not accept AI-generated contributions." }])
    const r = score(metrics(), policy({ ai }))
    expect(r.hardSkip).toContain("AI policy prohibits")
    expect(r.hardSkip).toContain("CONTRIBUTING.md")
  })

  test("hard skip: AI policy restricted", () => {
    const ai = classifyAiPolicy([{ path: "AI_POLICY.md", text: "We do not allow autonomous agents to be used for contributing." }])
    expect(score(metrics(), policy({ ai })).hardSkip).toContain("AI policy restricts")
  })

  test("unclear-restrictive AI policy skips only when configured", () => {
    const ai = classifyAiPolicy([{ path: "CONTRIBUTING.md", text: "## Use of AI tools\n\nWe have concerns and decide case by case." }])
    expect(score(metrics(), policy({ ai })).hardSkip).toContain("unclear")
    expect(score(metrics(), policy({ ai }), config({ skipUnclearRestrictivePolicy: false })).hardSkip).toBeNull()
  })

  test("toggles: license and CI requirements can be turned off", () => {
    expect(score(metrics({ license: null }), policy(), config({ requireLicense: false })).hardSkip).toBeNull()
    expect(score(metrics({ hasCi: false, ciProviders: [] }), policy(), config({ requireCi: false })).hardSkip).toBeNull()
    expect(score(metrics({ license: "mit" }), policy(), config({ allowedLicenses: ["MIT"] })).hardSkip).toBeNull()
  })

  test("low merge rate with a small sample is penalised but not a hard skip", () => {
    const r = score(metrics({ outsidePrSample: 4, outsidePrMerged: 0, outsideMergeRate: 0 }))
    expect(r.hardSkip).toBeNull()
    expect(r.reasons).toContain("- outside PR merge rate 0% (n=4)")
  })

  test("structural skips come before the AI policy skip; all reasons are listed", () => {
    const ai = classifyAiPolicy([{ path: "CONTRIBUTING.md", text: "## AI policy\n\nWe do not accept AI-generated contributions." }])
    const r = score(metrics({ archived: true, stars: 10 }), policy({ ai }))
    expect(r.hardSkip).toBe("repository is archived")
    expect(r.reasons.filter((x) => x.startsWith("skip:")).length).toBe(3)
    expect(r.reasons[1]).toContain("AI policy prohibits")
  })

  test("score below minimum becomes a hard skip with a readable reason", () => {
    const weak = metrics({
      lastMaintainerActivityAt: daysAgo(40),
      outsidePrSample: 6,
      outsidePrMerged: 1,
      outsideMergeRate: 1 / 6,
      medianFirstResponseHours: 30 * 24,
      openPrCount: 50,
      staleOpenPrCount: 40,
      stars: 150,
    })
    const r = score(weak, policy({ contributingFile: null, prTemplatePath: null }))
    expect(r.score).toBeLessThan(0.55)
    expect(r.hardSkip).toBe(`score ${r.score.toFixed(2)} below minimum 0.55`)
    expect(r.reasons).toContain("- median first maintainer response 30 days (n=8), above 14 days")
    expect(r.reasons).toContain("- 80% of open PRs stale for 90+ days (40/50)")
  })

  test("informational reasons for CLA / sign-off / issue-first / reserved good first issues", () => {
    const r = score(metrics(), policy({ requiresCla: true, requiresSignoff: true, requiresIssueFirst: true, reservesGoodFirstIssues: true }))
    expect(r.hardSkip).toBeNull()
    expect(r.reasons).toContain("~ CLA required (you must sign it yourself)")
    expect(r.reasons).toContain("~ good first issues reserved for newcomers (they are skipped)")
  })

  test("deterministic", () => {
    expect(score(metrics())).toEqual(score(metrics()))
  })

  test("score stays within [0,1] at the extremes", () => {
    const worst = metrics({
      lastMaintainerActivityAt: null,
      outsidePrSample: 50,
      outsidePrMerged: 0,
      outsideMergeRate: 0,
      medianFirstResponseHours: 10_000,
      openPrCount: 10,
      staleOpenPrCount: 10,
      hasCi: false,
      ciProviders: [],
      stars: 0,
    })
    const w = score(worst, policy({ contributingFile: null, prTemplatePath: null }))
    expect(w.score).toBeGreaterThanOrEqual(0)
    expect(w.score).toBeLessThan(0.1)
    const best = score(metrics({ outsidePrMerged: 20, outsideMergeRate: 1, staleOpenPrCount: 0, stars: 500_000, medianFirstResponseHours: 1 }))
    expect(best.score).toBeLessThanOrEqual(1)
    expect(best.score).toBeGreaterThan(0.95)
  })

  describe("monotonicity: better metrics never lower the score", () => {
    const mid = metrics({
      lastMaintainerActivityAt: daysAgo(20),
      outsidePrSample: 10,
      outsidePrMerged: 4,
      outsideMergeRate: 0.4,
      medianFirstResponseHours: 5 * 24,
      openPrCount: 20,
      staleOpenPrCount: 8,
      stars: 800,
    })
    const s0 = () => score(mid).score
    const steps: Array<[string, Partial<RepoMetrics>[]]> = [
      ["more recent maintainer activity", [{ lastMaintainerActivityAt: daysAgo(30) }, { lastMaintainerActivityAt: daysAgo(20) }, { lastMaintainerActivityAt: daysAgo(5) }, { lastMaintainerActivityAt: daysAgo(0) }]],
      ["higher merge rate", [0, 2, 4, 7, 10].map((k) => ({ outsidePrMerged: k, outsideMergeRate: k / 10 }))],
      ["faster first response", [40 * 24, 14 * 24, 5 * 24, 30, 6].map((h) => ({ medianFirstResponseHours: h }))],
      ["fewer stale PRs", [16, 12, 8, 4, 0].map((n) => ({ staleOpenPrCount: n }))],
      ["more stars", [100, 800, 5000, 80_000].map((n) => ({ stars: n }))],
      ["CI present", [{ hasCi: false, ciProviders: [] }, { hasCi: true, ciProviders: ["github-actions"] }]],
    ]
    for (const [name, seq] of steps) {
      test(name, () => {
        const scores = seq.map((over) => score({ ...mid, ...over }).score)
        for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeGreaterThanOrEqual(scores[i - 1]!)
        expect(scores[scores.length - 1]!).toBeGreaterThan(scores[0]!)
      })
    }
    test("a guide and a PR template add to the score", () => {
      const without = score(mid, policy({ contributingFile: null, prTemplatePath: null })).score
      expect(s0()).toBeGreaterThan(without)
    })
  })
})

describe("repoHardSkips", () => {
  test("only repo-object checks", () => {
    const s = config().screening
    expect(repoHardSkips(metrics(), s)).toEqual([])
    expect(repoHardSkips(metrics({ archived: true, hasCi: false, lastMaintainerActivityAt: null }), s)).toEqual(["repository is archived"])
  })
})
