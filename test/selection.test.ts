import { afterEach, describe, expect, test } from "bun:test"
import type { ConfigInput } from "../src/config/schema.ts"
import type { IssueRecord, RepoPolicy, RepoRecord, TaskRecord } from "../src/core/types.ts"
import { GitHubError, KilledError, RateLimitError } from "../src/github/api.ts"
import type { GhComment, GhIssue, GhTimelineEvent } from "../src/github/types.ts"
import type { CapsSnapshot } from "../src/scheduler/caps.ts"
import { AI_POLICY_FLAG_NOTES } from "../src/screening/policy.ts"
import {
  buildIssueSearchQueries,
  buildIssueSearchQuery,
  CANDIDATE_CACHE_MS,
  classifyIssueKind,
  detectClaim,
  detectLinkedPullRequests,
  EXAMINE_BACKOFF_MS,
  examinedKey,
  issueRefreshKey,
  labelHas,
  labelNames,
  MAX_REPOS_PER_SELECTION,
  needsDecision,
  ONE_AI_PR_REASON,
  oneAiPrAtATimeBlocks,
  prefilterIssue,
  priorOutcomeReason,
  refreshRepoIssues,
  scoreIssue,
  selectNextIssueWith,
  TERMINAL_SKIP_PREFIXES,
  transferredTo,
  type SelectionDeps,
} from "../src/selection/issues.ts"
import { DAY, HOUR } from "../src/util/clock.ts"
import {
  crossRefPr,
  FakeGitHub,
  ghComment,
  ghIssue,
  ghUser,
  makeTestContext,
  testConfig,
  type TestContext,
} from "./helpers/fakes.ts"

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** FakeClock default: 2026-01-15T12:00:00Z */
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)
const CONFIG = testConfig()

let nextCommentId = 1
function say(login: string, body: string, at = "2026-01-08T10:00:00Z", association = "NONE", type = "User"): GhComment {
  return ghComment({ id: nextCommentId++, body, user: ghUser(login, type), author_association: association, created_at: at, updated_at: at })
}
const maint = (login: string, body: string, at = "2026-01-09T10:00:00Z") => say(login, body, at, "MEMBER")

function policy(over: Partial<RepoPolicy> = {}): RepoPolicy {
  return {
    ai: { classification: "none_found", evidence: [], requiresDisclosure: false, notes: [] },
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
    ...over,
  }
}

function repoRec(fullName: string, over: Partial<RepoRecord> = {}): RepoRecord {
  return {
    fullName,
    source: "dependency",
    sourceDetail: null,
    status: "eligible",
    score: 0.8,
    reasons: [],
    skipReason: null,
    policy: policy(),
    metrics: null,
    discoveredAt: NOW - 30 * DAY,
    screenedAt: NOW - 2 * DAY,
    nextScreenAt: NOW + 10 * DAY,
    ...over,
  }
}

function issueRec(repo: string, number: number, over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: `${repo}#${number}`,
    repo,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${repo}/issues/${number}`,
    body: "body",
    labels: ["bug"],
    createdAt: "2026-01-05T09:00:00Z",
    updatedAt: "2026-01-10T09:00:00Z",
    comments: 1,
    kind: "bug",
    status: "candidate",
    score: 0.7,
    reasons: ["+0.10 preferred labels: \"bug\""],
    skipReason: null,
    fetchedAt: NOW - HOUR,
    ...over,
  }
}

/** A gh issue in `repo` for search / getIssue results. */
function ghIn(repo: string, over: Partial<GhIssue> = {}): GhIssue {
  const n = over.number ?? 42
  return ghIssue({ html_url: `https://github.com/${repo}/issues/${n}`, ...over })
}

const SNAP: CapsSnapshot = {
  now: NOW,
  submittedLast7Days: 0,
  openPrsByRepo: {},
  queuedByRepo: {},
  activeTasksByRepo: {},
  cooldownUntilByRepo: {},
  pendingQueue: 0,
  activeTasks: 0,
}

const OPEN_CAPS: Partial<SelectionDeps> = {
  capsSnapshot: () => SNAP,
  canStartAnyTask: () => ({ ok: true, reason: null }),
  canStartTaskForRepo: () => ({ ok: true, reason: null }),
}

let ctx: TestContext | null = null
function context(opts: { config?: ConfigInput; github?: FakeGitHub; login?: string } = {}): TestContext {
  ctx = makeTestContext(opts)
  return ctx
}
afterEach(() => {
  ctx?.cleanup()
  ctx = null
})

function methodCalls(gh: FakeGitHub, method: string): unknown[][] {
  return gh.calls.filter((c) => c.method === method).map((c) => c.args)
}

// ---------------------------------------------------------------------------
// labelNames / classifyIssueKind
// ---------------------------------------------------------------------------

describe("labelNames", () => {
  test("accepts strings and {name} objects, trims and dedupes", () => {
    expect(labelNames({ labels: ["bug", { name: " help wanted " }, { name: "" }, "bug", "  "] })).toEqual(["bug", "help wanted"])
  })
  test("empty labels", () => {
    expect(labelNames({ labels: [] })).toEqual([])
  })
})

describe("classifyIssueKind", () => {
  test("labels decide first, including prefixed/namespaced forms", () => {
    expect(classifyIssueKind("Something", "", ["bug"])).toBe("bug")
    expect(classifyIssueKind("Something", "", ["Type: Bug"])).toBe("bug")
    expect(classifyIssueKind("Something", "", ["C-bug"])).toBe("bug")
    expect(classifyIssueKind("Something", "", ["regression"])).toBe("bug")
    expect(classifyIssueKind("Something", "", ["kind/documentation"])).toBe("docs")
    expect(classifyIssueKind("Something", "", ["area: testing"])).toBe("tests")
    expect(classifyIssueKind("Something", "", ["coverage"])).toBe("tests")
    expect(classifyIssueKind("Something", "", ["Feature Request"])).toBe("enhancement")
    expect(classifyIssueKind("Crash on start", "", ["enhancement"])).toBe("enhancement")
  })

  test("area labels (docs/tests) win over type labels; 'needs …' status labels are ignored", () => {
    expect(classifyIssueKind("Wrong example in guide", "", ["bug", "documentation"])).toBe("docs")
    expect(classifyIssueKind("Flaky", "", ["bug", "tests"])).toBe("tests")
    expect(classifyIssueKind("Crash on start", "", ["bug", "needs tests"])).toBe("bug")
  })

  test("title heuristics when labels say nothing", () => {
    expect(classifyIssueKind("Crash when options.timeout is 0", "", ["good first issue"])).toBe("bug")
    expect(classifyIssueKind("Docs: wrong flag name in CLI guide", "", [])).toBe("docs")
    expect(classifyIssueKind("Fix typo in installation section", "", [])).toBe("docs")
    expect(classifyIssueKind("Add unit tests for the parser", "", [])).toBe("tests")
    expect(classifyIssueKind("Add support for YAML config files", "", [])).toBe("enhancement")
  })

  test("body heuristics, then other", () => {
    expect(classifyIssueKind("Parser problem", "### Steps to reproduce\n1. run it", [])).toBe("bug")
    expect(classifyIssueKind("Idea", "**Is your feature request related to a problem?**\nYes", [])).toBe("enhancement")
    expect(classifyIssueKind("Question about setup", "The README does not mention Windows.", [])).toBe("docs")
    expect(classifyIssueKind("Hmm", "Something to think about", [])).toBe("other")
  })
})

// ---------------------------------------------------------------------------
// prefilterIssue
// ---------------------------------------------------------------------------

describe("prefilterIssue", () => {
  test("a normal open issue passes", () => {
    expect(prefilterIssue(ghIssue(), CONFIG, NOW)).toBeNull()
  })

  test("each cheap skip reason", () => {
    expect(prefilterIssue(ghIssue({ pull_request: { url: "x" } }), CONFIG, NOW)).toMatch(/pull request/)
    expect(prefilterIssue(ghIssue({ state: "closed" }), CONFIG, NOW)).toBe("issue is closed")
    expect(prefilterIssue(ghIssue({ locked: true }), CONFIG, NOW)).toBe("issue is locked")
    expect(prefilterIssue(ghIssue({ assignees: [ghUser("alice"), ghUser("bob")] }), CONFIG, NOW)).toBe(
      "already assigned to @alice, @bob",
    )
    expect(prefilterIssue(ghIssue({ user: ghUser("renovate[bot]", "Bot") }), CONFIG, NOW)).toMatch(/opened by a bot/)
    expect(prefilterIssue(ghIssue({ comments: 16 }), CONFIG, NOW)).toBe("too many comments (16 > 15)")
    expect(prefilterIssue(ghIssue({ body: "pls fix" }), CONFIG, NOW)).toMatch(/too short/)
    expect(prefilterIssue(ghIssue({ body: null }), CONFIG, NOW)).toMatch(/too short/)
    expect(prefilterIssue(ghIssue({ body: "<!-- template comment that is long enough -->\nok" }), CONFIG, NOW)).toMatch(/too short/)
  })

  test("excluded labels match case-insensitively by substring", () => {
    expect(prefilterIssue(ghIssue({ labels: [{ name: "Status: Needs Triage" }] }), CONFIG, NOW)).toBe(
      'has excluded label "Status: Needs Triage"',
    )
    expect(prefilterIssue(ghIssue({ labels: ["breaking change"] }), CONFIG, NOW)).toMatch(/excluded label/)
    expect(prefilterIssue(ghIssue({ labels: ["WONTFIX"] }), CONFIG, NOW)).toMatch(/excluded label/)
    expect(prefilterIssue(ghIssue({ labels: ["bug", "help wanted"] }), CONFIG, NOW)).toBeNull()
  })

  test("staleness uses updated_at and config.issues.staleAfterDays", () => {
    const cfg = testConfig({ issues: { staleAfterDays: 30 } })
    const at = (days: number) => new Date(NOW - days * DAY).toISOString()
    expect(prefilterIssue(ghIssue({ updated_at: at(29) }), cfg, NOW)).toBeNull()
    expect(prefilterIssue(ghIssue({ updated_at: at(31) }), cfg, NOW)).toBe("stale: no activity for 31 days (limit 30)")
  })
})

// ---------------------------------------------------------------------------
// detectLinkedPullRequests
// ---------------------------------------------------------------------------

describe("detectLinkedPullRequests", () => {
  test("cross-referenced open and merged PRs; closed-unmerged and plain issues ignored", () => {
    const timeline: GhTimelineEvent[] = [
      crossRefPr({ number: 77, state: "open" }),
      crossRefPr({ number: 78, state: "closed", merged: true }),
      crossRefPr({ number: 79, state: "closed" }),
      { event: "cross-referenced", source: { type: "issue", issue: { number: 80, state: "open", repository: { full_name: "acme/widget" } } } },
      { event: "labeled" },
    ]
    expect(detectLinkedPullRequests(timeline)).toEqual({ open: ["acme/widget#77"], merged: ["acme/widget#78"] })
  })

  test("falls back to html_url for the repo, then to a bare #n", () => {
    const timeline: GhTimelineEvent[] = [
      {
        event: "cross-referenced",
        source: { issue: { number: 5, state: "open", html_url: "https://github.com/other/thing/pull/5", pull_request: {} } },
      },
      { event: "cross-referenced", source: { issue: { number: 6, state: "open", pull_request: { merged_at: null } } } },
    ]
    expect(detectLinkedPullRequests(timeline).open).toEqual(["other/thing#5", "#6"])
  })

  test("connected/disconnected pairs: latest wins; unknown state counts as open", () => {
    const connected = (n: number, at: string, subject: Record<string, unknown> = {}): GhTimelineEvent => ({
      event: "connected",
      created_at: at,
      subject: { type: "pull_request", number: n, url: `https://api.github.com/repos/acme/widget/issues/${n}`, ...subject },
    })
    const disconnected = (n: number, at: string): GhTimelineEvent => ({
      event: "disconnected",
      created_at: at,
      subject: { number: n, url: `https://api.github.com/repos/acme/widget/issues/${n}` },
    })
    expect(detectLinkedPullRequests([connected(1, "2026-01-01T00:00:00Z"), disconnected(1, "2026-01-02T00:00:00Z")]).open).toEqual([])
    expect(detectLinkedPullRequests([disconnected(2, "2026-01-01T00:00:00Z"), connected(2, "2026-01-02T00:00:00Z")]).open).toEqual([
      "acme/widget#2",
    ])
    // out-of-order timeline: the older disconnect must not override the newer connect
    expect(detectLinkedPullRequests([connected(3, "2026-01-05T00:00:00Z"), disconnected(3, "2026-01-01T00:00:00Z")]).open).toEqual([
      "acme/widget#3",
    ])
    expect(detectLinkedPullRequests([connected(4, "2026-01-01T00:00:00Z", { merged_at: "2026-01-03T00:00:00Z" })])).toEqual({
      open: [],
      merged: ["acme/widget#4"],
    })
    expect(detectLinkedPullRequests([connected(5, "2026-01-01T00:00:00Z", { state: "closed" })])).toEqual({ open: [], merged: [] })
    expect(detectLinkedPullRequests([{ event: "connected", subject: { number: 6 } }]).open).toEqual(["#6"])
  })
})

// ---------------------------------------------------------------------------
// detectClaim
// ---------------------------------------------------------------------------

describe("detectClaim", () => {
  const claims = [
    "Hi! I'd like to work on this.",
    "I would love to take this one",
    "Can I take this?",
    "could I work on it?",
    "I'll take it",
    "I will work on this over the weekend",
    "I'm working on a fix",
    "Currently working on a PR for this.",
    "Working on it!",
    "Please assign me",
    "Can you assign this to me?",
    "I'm on it",
    "/assign",
    "I'd be happy to submit a PR",
    "I have a fix ready locally",
    "I'm willing to fix this",
    "I’ll open a PR tomorrow",
  ]
  for (const body of claims) {
    test(`claim: ${JSON.stringify(body)}`, () => {
      expect(detectClaim([say("bob", body)], NOW, "me")).toBe("claimed by @bob on 2026-01-08")
    })
  }

  const nonClaims = [
    "Is anyone working on this?",
    "I'll take a look when I have time",
    "Thanks for the report!",
    "I can fix it by downgrading to 2.x as a workaround",
    "> I'd like to work on this\nThat would be great, go for it.",
    "```\nI'll take it\n```",
    "Same problem here, +1",
  ]
  for (const body of nonClaims) {
    test(`no claim: ${JSON.stringify(body)}`, () => {
      expect(detectClaim([say("carol", body)], NOW, "me")).toBeNull()
    })
  }

  test("own comments and bots never count", () => {
    expect(detectClaim([say("Me", "I'll take it")], NOW, "me")).toBeNull()
    expect(detectClaim([say("helper[bot]", "/assign", undefined, "NONE", "Bot")], NOW, "me")).toBeNull()
  })

  test("claims older than 45 days are ignored", () => {
    expect(detectClaim([say("bob", "I'll take it", "2025-11-20T00:00:00Z")], NOW, "me")).toBeNull()
    expect(detectClaim([say("bob", "I'll take it", "2025-12-05T00:00:00Z")], NOW, "me")).toBe("claimed by @bob on 2025-12-05")
  })

  test("a later withdrawal by the claimant cancels the claim", () => {
    const thread = [say("bob", "I'll take it", "2026-01-02T00:00:00Z"), say("bob", "Sorry, I'm no longer working on this.", "2026-01-09T00:00:00Z")]
    expect(detectClaim(thread, NOW, "me")).toBeNull()
    const unassign = [say("bob", "Can I work on this?", "2026-01-02T00:00:00Z"), say("bob", "please unassign me", "2026-01-03T00:00:00Z")]
    expect(detectClaim(unassign, NOW, "me")).toBeNull()
  })

  test("a withdrawal by someone else does not cancel the claim; the latest active claim is reported", () => {
    const thread = [
      say("bob", "I'll take it", "2026-01-02T00:00:00Z"),
      say("carol", "I can't work on this, sorry", "2026-01-03T00:00:00Z"),
      say("dave", "Can I work on this too?", "2026-01-04T00:00:00Z"),
    ]
    expect(detectClaim(thread, NOW, "me")).toBe("claimed by @dave on 2026-01-04")
  })

  test("maintainer assigns in prose", () => {
    expect(detectClaim([maint("lead", "Assigned to @alice, thanks!")], NOW, "me")).toBe("claimed by @alice on 2026-01-09")
    expect(detectClaim([maint("lead", "@alice is working on this in a branch")], NOW, "me")).toBe("claimed by @alice on 2026-01-09")
    expect(detectClaim([maint("lead", "I'll fix this myself in the next release")], NOW, "me")).toBe("claimed by @lead on 2026-01-09")
    // a non-maintainer cannot assign
    expect(detectClaim([say("rando", "assigned to @alice")], NOW, "me")).toBeNull()
    // assignment to yourself is not someone else's claim
    expect(detectClaim([maint("lead", "Assigned to @me")], NOW, "me")).toBeNull()
  })

  test("maintainer releases a claimant or opens the issue up again", () => {
    expect(detectClaim([say("bob", "I'll take it", "2026-01-02T00:00:00Z"), maint("lead", "Unassigning @bob due to inactivity")], NOW, "me")).toBeNull()
    expect(detectClaim([say("bob", "I'll take it", "2026-01-02T00:00:00Z"), maint("lead", "This is up for grabs again.")], NOW, "me")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// needsDecision
// ---------------------------------------------------------------------------

describe("needsDecision", () => {
  test("labels", () => {
    expect(needsDecision(ghIssue({ labels: ["RFC"] }), [])).toBe('needs a maintainer decision: label "RFC"')
    expect(needsDecision(ghIssue({ labels: [{ name: "status: needs-discussion" }] }), [])).toMatch(/label "status: needs-discussion"/)
    expect(needsDecision(ghIssue({ labels: ["api design"] }), [])).toMatch(/label/)
    expect(needsDecision(ghIssue({ labels: ["bug", "good first issue"] }), [])).toBeNull()
  })

  test("titles marking RFCs/proposals, but not IETF RFC references", () => {
    expect(needsDecision(ghIssue({ title: "[RFC] New plugin API" }), [])).toMatch(/title/)
    expect(needsDecision(ghIssue({ title: "Proposal: drop Node 18" }), [])).toMatch(/title/)
    expect(needsDecision(ghIssue({ title: "Date header is not RFC 7231 compliant" }), [])).toBeNull()
  })

  test("body phrases", () => {
    const body = (b: string) => ghIssue({ body: b })
    expect(needsDecision(body("Open questions:\n- naming\n- defaults"), [])).toBe('needs a maintainer decision: issue says "Open questions"')
    expect(needsDecision(body("This would require a breaking change to the config format."), [])).toMatch(/breaking change/)
    expect(needsDecision(body("We need an API design for the hooks first, then implement."), [])).toMatch(/API design/i)
    // ordinary bug wording is not a decision signal
    expect(needsDecision(body("Breaking change in v5: CPU architecture arm64 crashes on start. Steps to reproduce: run it."), [])).toBeNull()
  })

  test("maintainer comments count; others do not", () => {
    expect(needsDecision(ghIssue(), [maint("lead", "Not sure we want this in core.")])).toBe(
      'needs a maintainer decision: maintainer @lead said "Not sure we want"',
    )
    expect(needsDecision(ghIssue(), [maint("lead", "Honestly this is out of scope for the project.")])).toMatch(/out of scope/)
    expect(needsDecision(ghIssue(), [say("rando", "Not sure we want this in core.")])).toBeNull()
  })

  test("a later maintainer go-ahead resolves an earlier discussion signal", () => {
    const thread = [maint("lead", "This needs more discussion.", "2026-01-06T00:00:00Z"), maint("lead", "OK, decided: PRs welcome!", "2026-01-08T00:00:00Z")]
    expect(needsDecision(ghIssue(), thread)).toBeNull()
    expect(needsDecision(ghIssue({ body: "Open question: which default? Steps to reproduce: n/a" }), [maint("lead", "Let's go with option A, PR welcome")])).toBeNull()
    // …but not the other way round
    expect(needsDecision(ghIssue(), [...thread].reverse().map((c, i) => ({ ...c, created_at: `2026-01-0${6 + i}T00:00:00Z` })))).toMatch(
      /needs more discussion/,
    )
  })
})

// ---------------------------------------------------------------------------
// scoreIssue
// ---------------------------------------------------------------------------

describe("scoreIssue", () => {
  const score = (issue: GhIssue, comments: GhComment[] = [], config = CONFIG) => scoreIssue({ issue, comments, config, now: NOW, selfLogin: "me" })

  test("a clear, labeled, reproducible, confirmed bug scores high with readable reasons", () => {
    const r = score(ghIssue(), [maint("lead", "Confirmed, thanks for the report!")])
    expect(r.kind).toBe("bug")
    expect(r.hardSkip).toBeNull()
    expect(r.score).toBeGreaterThan(0.8)
    expect(r.score).toBeLessThan(1)
    expect(r.reasons).toContain('+0.14 preferred labels: "bug", "good first issue"')
    expect(r.reasons.some((x) => x.startsWith("+") && x.includes("reproducibility: steps to reproduce"))).toBe(true)
    expect(r.reasons.some((x) => x.includes("expected vs actual") && x.includes("error message"))).toBe(true)
    expect(r.reasons.some((x) => x.includes("maintainer confirmed"))).toBe(true)
  })

  test("deterministic and always within 0..1", () => {
    const a = score(ghIssue(), [maint("lead", "Confirmed")])
    const b = score(ghIssue(), [maint("lead", "Confirmed")])
    expect(a).toEqual(b)
    const epic = ghIssue({
      title: "Tracking issue: rewrite and migrate everything",
      body: `Refactor across the codebase.\n${Array.from({ length: 14 }, (_, i) => `- [ ] step ${i}`).join("\n")}`,
      labels: [],
      created_at: "2023-01-01T00:00:00Z",
      updated_at: "2025-09-01T00:00:00Z",
    })
    const low = score(epic, [maint("lead", "cannot reproduce")])
    expect(low.score).toBeGreaterThanOrEqual(0)
    expect(low.score).toBeLessThan(0.1)
  })

  test("vague issues score below the default minimum", () => {
    const r = score(ghIssue({ title: "Improve performance", body: "It is slow, please make it faster ok.", labels: [] }))
    expect(r.kind).toBe("other")
    expect(r.score).toBeLessThan(CONFIG.issues.minScore)
    expect(r.reasons).toContain("-0.10 clarity: very short description (37 chars)")
  })

  test("small, concrete docs fixes pass the default minimum", () => {
    const r = score(
      ghIssue({
        title: "Typo in README",
        body: "There's a typo in README.md: 'recieve' should be 'receive' in the Installation section.",
        labels: ["documentation"],
      }),
    )
    expect(r.kind).toBe("docs")
    expect(r.score).toBeGreaterThanOrEqual(CONFIG.issues.minScore)
    expect(r.reasons.some((x) => x.includes("typo-sized fix") && x.includes("names a file"))).toBe(true)
  })

  test("large-scope signals pull the score down", () => {
    const base = ghIssue({ title: "Make the client configurable", labels: ["enhancement"] })
    const big = ghIssue({ title: "Refactor and redesign the client across the codebase", labels: ["enhancement"] })
    const a = score(base)
    const b = score(big)
    expect(b.score).toBeLessThan(a.score - 0.2)
    expect(b.reasons.some((x) => /large scope: .*redesign\/overhaul.*refactor.*cross-cutting/.test(x))).toBe(true)
  })

  test("maintainer engagement: confirmation raises, doubt lowers", () => {
    const plain = score(ghIssue()).score
    expect(score(ghIssue(), [maint("lead", "Good catch, PR welcome")]).score).toBeGreaterThan(plain)
    expect(score(ghIssue(), [maint("lead", "I can't reproduce this, please provide a repro")]).score).toBeLessThan(plain)
    // non-maintainer chatter does not count as engagement
    expect(score(ghIssue(), [say("rando", "Confirmed, same here")]).score).toBe(plain)
  })

  test("very new untriaged issues get a mild penalty; old ones a larger one", () => {
    const fresh = score(ghIssue({ created_at: "2026-01-15T00:00:00Z", updated_at: "2026-01-15T00:00:00Z" }))
    expect(fresh.reasons.some((x) => x.includes("very new, possibly untriaged"))).toBe(true)
    const old = score(ghIssue({ created_at: "2024-06-01T00:00:00Z" }))
    expect(old.reasons.some((x) => x.includes("old issue"))).toBe(true)
    expect(old.score).toBeLessThan(score(ghIssue()).score)
  })

  test("labels: strongest for good first issue / help wanted / confirmed, configurable list", () => {
    const strong = score(ghIssue({ labels: ["help wanted"] })).score
    const weak = score(ghIssue({ labels: ["bug"] })).score
    const none = score(ghIssue({ labels: ["area: core"] })).score
    expect(strong).toBeGreaterThan(weak)
    expect(weak).toBeGreaterThan(none)
    const noPrefs = testConfig({ issues: { labels: [] } })
    expect(score(ghIssue({ labels: ["help wanted"] }), [], noPrefs).score).toBe(score(ghIssue({ labels: ["area: core"] }), [], noPrefs).score)
    // acceptance labels boost even when not configured
    expect(score(ghIssue({ labels: ["PR welcome"] }), [], noPrefs).score).toBeGreaterThan(score(ghIssue({ labels: [] }), [], noPrefs).score)
  })

  test("reporter volunteering to submit a PR is a penalty", () => {
    const body = `${ghIssue().body}\n\n- [x] I'm willing to submit a PR for this`
    const r = score(ghIssue({ body }))
    expect(r.reasons).toContain("-0.10 reporter: offered to submit a PR themselves")
  })

  test("hardSkip from prefilter, claims and design decisions", () => {
    expect(score(ghIssue({ assignees: [ghUser("alice")] })).hardSkip).toBe("already assigned to @alice")
    expect(score(ghIssue(), [say("bob", "Can I take this?")]).hardSkip).toBe("claimed by @bob on 2026-01-08")
    expect(score(ghIssue(), [maint("lead", "We haven't decided on the API yet")]).hardSkip).toMatch(/needs a maintainer decision/)
    // your own claim is not someone else's
    expect(score(ghIssue(), [say("me", "I'd like to work on this")]).hardSkip).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildIssueSearchQuery
// ---------------------------------------------------------------------------

describe("buildIssueSearchQuery", () => {
  test("default config", () => {
    expect(buildIssueSearchQuery("acme/widget", CONFIG, NOW)).toBe(
      'repo:acme/widget is:issue is:open no:assignee -linked:pr archived:false updated:>=2025-07-19 label:"good first issue","help wanted",bug,confirmed,documentation,docs,tests,testing',
    )
  })

  test("custom labels: quoted when needed, deduped case-insensitively, unrepresentable ones dropped", () => {
    const cfg = testConfig({ issues: { labels: ["Bug", "bug", "type: bug", 'say "hi"', "good-first-issue"], staleAfterDays: 10 } })
    expect(buildIssueSearchQuery("o/r", cfg, NOW)).toBe(
      'repo:o/r is:issue is:open no:assignee -linked:pr archived:false updated:>=2026-01-05 label:Bug,"type: bug",good-first-issue',
    )
  })

  test("no label qualifier without preferred labels; never explicit boolean operators", () => {
    const q = buildIssueSearchQuery("o/r", testConfig({ issues: { labels: [] } }), NOW)
    expect(q).not.toContain("label:")
    expect(buildIssueSearchQuery("o/r", CONFIG, NOW)).not.toMatch(/\b(?:OR|AND|NOT)\b/)
  })
})

// ---------------------------------------------------------------------------
// refreshRepoIssues
// ---------------------------------------------------------------------------

const REPO = "acme/widget"

interface IssueFixture {
  issue: GhIssue
  comments?: GhComment[]
  timeline?: GhTimelineEvent[]
}

function githubFor(fixtures: IssueFixture[], extra: { openPrs?: Record<string, number> } = {}): FakeGitHub {
  const byNumber = new Map(fixtures.map((f) => [f.issue.number, f]))
  return new FakeGitHub({
    searchIssues: async (q: string) => {
      if (q.startsWith("is:pr")) {
        const repo = /repo:(\S+)/.exec(q)?.[1] ?? ""
        return Array.from({ length: extra.openPrs?.[repo] ?? 0 }, (_, i) => ghIssue({ number: 900 + i, pull_request: {} }))
      }
      return fixtures.map((f) => f.issue)
    },
    listIssueComments: async (_repo: string, n: number) => byNumber.get(n)?.comments ?? [],
    listIssueTimeline: async (_repo: string, n: number) => byNumber.get(n)?.timeline ?? [],
    getIssue: async (_repo: string, n: number) => {
      const f = byNumber.get(n)
      if (!f) throw new GitHubError("Not Found", 404)
      return f.issue
    },
  })
}

function standardFixtures(): IssueFixture[] {
  return [
    { issue: ghIn(REPO, { number: 1 }), comments: [maint("lead", "Confirmed, thanks!")] },
    { issue: ghIn(REPO, { number: 2, assignees: [ghUser("alice")] }) },
    { issue: ghIn(REPO, { number: 3 }), timeline: [crossRefPr({ number: 77, state: "open" })] },
    { issue: ghIn(REPO, { number: 4 }), comments: [say("bob", "Hi, can I take this one?")] },
    { issue: ghIn(REPO, { number: 5 }), comments: [maint("lead", "Not sure we want this in core; needs more discussion.")] },
    {
      issue: ghIn(REPO, {
        number: 6,
        title: "Docs",
        body: "Please improve the docs, they are confusing to read.",
        labels: ["docs"],
      }),
    },
    {
      issue: ghIn(REPO, {
        number: 7,
        title: "Wrong default for retries in `fetchWithRetry`",
        body: "The default `retries` value in src/retry.ts is 5 but the README says 3.\n\nExpected 3, actual 5. Version 2.0.1",
        labels: [{ name: "bug" }],
      }),
      comments: [maint("lead", "Good catch, PR welcome")],
    },
  ]
}

describe("refreshRepoIssues", () => {
  test("filters, scores, persists and audits every decision; returns candidates by score", async () => {
    const gh = githubFor(standardFixtures())
    const c = context({ github: gh })
    const repo = repoRec(REPO)
    c.store.saveRepo(repo)

    const result = await refreshRepoIssues(c, repo)

    expect(result.map((r) => r.number)).toEqual([1, 7])
    expect(result[0]!.score!).toBeGreaterThan(result[1]!.score!)
    expect(result.every((r) => r.status === "candidate" && r.fetchedAt === NOW && r.kind === "bug")).toBe(true)

    // preferred-label search first; fewer than 15 hits, so the broad search fills up (deduplicated)
    const search = methodCalls(gh, "searchIssues")
    expect(search).toEqual([
      [buildIssueSearchQuery(REPO, c.config, NOW), { max: 15, sort: "updated", order: "desc" }],
      [buildIssueSearchQuery(REPO, c.config, NOW, { labels: false }), { max: 15, sort: "updated", order: "desc" }],
    ])
    // prefiltered issues never cost comment/timeline calls; the rest use the documented page sizes
    expect(methodCalls(gh, "listIssueComments").map((a) => a[1])).toEqual([1, 3, 4, 5, 6, 7])
    expect(methodCalls(gh, "listIssueComments")[0]).toEqual([REPO, 1, { max: 50 }])
    expect(methodCalls(gh, "listIssueTimeline")[0]).toEqual([REPO, 1, { max: 100 }])

    const rec = (n: number) => c.store.getIssue(`${REPO}#${n}`)!
    expect(rec(1)).toMatchObject({ status: "candidate", skipReason: null, labels: ["bug", "good first issue"] })
    expect(rec(1).reasons.length).toBeGreaterThan(3)
    expect(rec(2)).toMatchObject({ status: "skipped", skipReason: "already assigned to @alice", score: null })
    expect(rec(3)).toMatchObject({ status: "skipped", skipReason: "linked open pull request acme/widget#77" })
    expect(rec(4)).toMatchObject({ status: "skipped", skipReason: "claimed by @bob on 2026-01-08" })
    expect(rec(5).skipReason).toMatch(/^needs a maintainer decision: maintainer @lead said/)
    expect(rec(6).status).toBe("skipped")
    expect(rec(6).skipReason).toMatch(/^score 0\.\d\d below minimum 0\.50$/)
    expect(rec(6).score).not.toBeNull()

    const skips = c.store.listAudit({ action: "issue.skip" })
    expect(skips.map((a) => a.subject).sort()).toEqual([2, 3, 4, 5, 6].map((n) => `${REPO}#${n}`))
    expect(skips.every((a) => a.actor === "scout" && a.decision === "skip" && a.reasons.length > 0)).toBe(true)
    const cands = c.store.listAudit({ action: "issue.candidate" })
    expect(cands.map((a) => a.subject).sort()).toEqual([`${REPO}#1`, `${REPO}#7`])
    expect(c.store.getKv<number>(issueRefreshKey(REPO))).toBe(NOW)
    // read-only: nothing was written to GitHub
    expect(gh.writes).toEqual([])
  })

  test("repos reserving good first issues: those issues are skipped before any extra API call", async () => {
    const gh = githubFor([{ issue: ghIn(REPO, { number: 1 }) }])
    const c = context({ github: gh })
    const repo = repoRec(REPO, { policy: policy({ reservesGoodFirstIssues: true }) })

    expect(await refreshRepoIssues(c, repo)).toEqual([])
    expect(c.store.getIssue(`${REPO}#1`)?.skipReason).toBe("repo reserves good first issues for new human contributors")
    expect(methodCalls(gh, "listIssueComments")).toEqual([])
  })

  test("a merged linked PR is a penalty, an unrelated repo's open PR is not a skip", async () => {
    const otherRepoPr: GhTimelineEvent = {
      event: "cross-referenced",
      source: { issue: { number: 9, state: "open", pull_request: {}, repository: { full_name: "someone/downstream-app" } } },
    }
    const forkPr: GhTimelineEvent = {
      event: "cross-referenced",
      source: { issue: { number: 3, state: "open", pull_request: {}, repository: { full_name: "contributor/widget" } } },
    }
    const gh = githubFor([
      { issue: ghIn(REPO, { number: 1 }), timeline: [crossRefPr({ number: 70, state: "closed", merged: true }), otherRepoPr] },
      { issue: ghIn(REPO, { number: 2 }), timeline: [forkPr] },
      { issue: ghIn(REPO, { number: 3 }) },
    ])
    const c = context({ github: gh })
    const result = await refreshRepoIssues(c, repoRec(REPO))
    const one = result.find((r) => r.number === 1)!
    const three = result.find((r) => r.number === 3)!
    expect(one.reasons).toContain("-0.20 linked PR acme/widget#70 already merged (may be fixed)")
    expect(one.score!).toBeCloseTo(three.score! - 0.2, 5)
    expect(c.store.getIssue(`${REPO}#2`)?.skipReason).toBe("linked open pull request contributor/widget#3")
  })

  test("rate limits and the kill switch propagate", async () => {
    const limited = githubFor([{ issue: ghIn(REPO, { number: 1 }) }]).set({
      listIssueTimeline: async () => {
        throw new RateLimitError("rate limited", NOW + HOUR, "core", false)
      },
    })
    const c1 = context({ github: limited })
    await expect(refreshRepoIssues(c1, repoRec(REPO))).rejects.toBeInstanceOf(RateLimitError)
    c1.cleanup()

    const killed = new FakeGitHub({
      searchIssues: async () => {
        throw new KilledError()
      },
    })
    const c2 = context({ github: killed })
    await expect(refreshRepoIssues(c2, repoRec(REPO))).rejects.toBeInstanceOf(KilledError)
  })

  test("other per-issue errors skip only that issue", async () => {
    const gh = githubFor([{ issue: ghIn(REPO, { number: 1 }) }, { issue: ghIn(REPO, { number: 2 }) }]).set({
      listIssueTimeline: async (_r: string, n: number) => {
        if (n === 1) throw new GitHubError("Gone", 410)
        return []
      },
    })
    const c = context({ github: gh })
    const result = await refreshRepoIssues(c, repoRec(REPO))
    expect(result.map((r) => r.number)).toEqual([2])
    expect(c.store.getIssue(`${REPO}#1`)).toBeNull()
  })

  test("selected/done issues are left alone; candidates no longer found are retired", async () => {
    const gh = githubFor([{ issue: ghIn(REPO, { number: 1 }) }, { issue: ghIn(REPO, { number: 2 }) }])
    const c = context({ github: gh })
    c.store.upsertIssue(issueRec(REPO, 1, { status: "selected" }))
    c.store.upsertIssue(issueRec(REPO, 99, { status: "candidate" }))

    const result = await refreshRepoIssues(c, repoRec(REPO))
    expect(result.map((r) => r.number)).toEqual([2])
    expect(methodCalls(gh, "listIssueComments").map((a) => a[1])).toEqual([2])
    expect(c.store.getIssue(`${REPO}#1`)?.status).toBe("selected")
    expect(c.store.getIssue(`${REPO}#99`)).toMatchObject({ status: "skipped", skipReason: "no longer matches the issue search" })
  })
})

// ---------------------------------------------------------------------------
// selectNextIssue
// ---------------------------------------------------------------------------

/** Store eligible repos with fresh cached candidates. */
function seed(c: TestContext, repos: Array<{ name: string; score: number; repo?: Partial<RepoRecord>; issues?: IssueRecord[] }>): void {
  for (const r of repos) {
    c.store.saveRepo(repoRec(r.name, { score: r.score, ...(r.repo ?? {}) }))
    for (const i of r.issues ?? []) c.store.upsertIssue(i)
    c.store.setKv(issueRefreshKey(r.name), NOW - HOUR, NOW - HOUR)
  }
}

describe("selectNextIssueWith", () => {
  test("global caps block: returns null without any GitHub traffic or audit", async () => {
    const gh = githubFor([])
    const c = context({ github: gh })
    seed(c, [{ name: "a/one", score: 0.9, issues: [issueRec("a/one", 1)] }])
    const result = await selectNextIssueWith(c, { ...OPEN_CAPS, canStartAnyTask: () => ({ ok: false, reason: "pending queue full" }) })
    expect(result).toBeNull()
    expect(gh.calls).toEqual([])
    expect(c.store.listAudit()).toEqual([])
  })

  test("selects the best candidate of the best repo, re-fetches it and marks it selected", async () => {
    const fresh = ghIn("a/one", { number: 2, title: "Fresh title", labels: ["bug", "help wanted"] })
    const gh = githubFor([{ issue: fresh }])
    const c = context({ github: gh })
    seed(c, [
      { name: "a/one", score: 0.9, issues: [issueRec("a/one", 1, { score: 0.4 }), issueRec("a/one", 2, { score: 0.8 }), issueRec("a/one", 3, { score: 0.6 })] },
      { name: "b/two", score: 0.5, issues: [issueRec("b/two", 1, { score: 0.95 })] },
    ])

    const result = await selectNextIssueWith(c, OPEN_CAPS)

    expect(result?.repo.fullName).toBe("a/one")
    expect(result?.issue).toMatchObject({ id: "a/one#2", status: "selected", title: "Fresh title", labels: ["bug", "help wanted"], score: 0.8 })
    expect(c.store.getIssue("a/one#2")?.status).toBe("selected")
    expect(methodCalls(gh, "searchIssues")).toEqual([["is:pr is:open author:me repo:a/one", { max: 1 }]])
    expect(methodCalls(gh, "getIssue")).toEqual([["a/one", 2]])
    const sel = c.store.listAudit({ action: "issue.select" })
    expect(sel).toHaveLength(1)
    expect(sel[0]).toMatchObject({ subject: "a/one#2", decision: "selected", actor: "scout" })
    expect(sel[0]!.reasons[0]).toBe("score 0.80")
    expect(gh.writes).toEqual([])
  })

  test("repos where you already have an open PR are skipped", async () => {
    const gh = githubFor([{ issue: ghIn("b/two", { number: 1 }) }], { openPrs: { "a/one": 1 } })
    const c = context({ github: gh })
    seed(c, [
      { name: "a/one", score: 0.9, issues: [issueRec("a/one", 1)] },
      { name: "b/two", score: 0.5, issues: [issueRec("b/two", 1)] },
    ])
    const result = await selectNextIssueWith(c, OPEN_CAPS)
    expect(result?.issue.id).toBe("b/two#1")
    expect(methodCalls(gh, "getIssue")).toEqual([["b/two", 1]])
  })

  test("repo caps and allow/deny lists are applied before any call; those repos are not counted", async () => {
    const gh = githubFor([{ issue: ghIn("c/three", { number: 1 }) }])
    const c = context({ github: gh, config: { repos: { deny: ["b/*"] } } })
    seed(c, [
      { name: "a/one", score: 0.9, issues: [issueRec("a/one", 1)] },
      { name: "b/two", score: 0.8, issues: [issueRec("b/two", 1)] },
      { name: "c/three", score: 0.7, issues: [issueRec("c/three", 1)] },
    ])
    const result = await selectNextIssueWith(c, {
      ...OPEN_CAPS,
      canStartTaskForRepo: (_s, repo) => (repo === "a/one" ? { ok: false, reason: "cooldown" } : { ok: true, reason: null }),
    })
    expect(result?.issue.id).toBe("c/three#1")
    expect(methodCalls(gh, "searchIssues").map((a) => a[0])).toEqual(["is:pr is:open author:me repo:c/three"])
  })

  test("one AI-assisted PR at a time: repo skipped while it has an open PR, queued item or active task", async () => {
    const flagged = policy({
      ai: {
        classification: "disclosure_required",
        evidence: [],
        requiresDisclosure: true,
        notes: [`ai:one_ai_pr_at_a_time: ${AI_POLICY_FLAG_NOTES.one_ai_pr_at_a_time}`],
      },
    })
    for (const busy of [
      { openPrsByRepo: { "a/one": 1 } },
      { queuedByRepo: { "a/one": 1 } },
      { activeTasksByRepo: { "a/one": 1 } },
    ] as Array<Partial<CapsSnapshot>>) {
      const gh = githubFor([{ issue: ghIn("b/two", { number: 1 }) }])
      const c = context({ github: gh })
      seed(c, [
        { name: "A/One", score: 0.9, repo: { policy: flagged }, issues: [issueRec("A/One", 1)] },
        { name: "b/two", score: 0.5, issues: [issueRec("b/two", 1)] },
      ])
      const snap: CapsSnapshot = { ...SNAP, ...busy }
      const result = await selectNextIssueWith(c, { ...OPEN_CAPS, capsSnapshot: () => snap })
      expect(result?.issue.id).toBe("b/two#1")
      // Skipped before any GitHub call for the flagged repo.
      expect(methodCalls(gh, "searchIssues").map((a) => a[0])).toEqual(["is:pr is:open author:me repo:b/two"])
      expect(oneAiPrAtATimeBlocks(c.store.getRepo("A/One")!, snap)).toBe(ONE_AI_PR_REASON)
      expect(ONE_AI_PR_REASON).toBe("repository allows one AI-assisted PR at a time")
      c.cleanup()
    }

    // Nothing open/queued/active in the repo: it is eligible as usual.
    const gh = githubFor([{ issue: ghIn("a/one", { number: 1 }) }])
    const c = context({ github: gh })
    seed(c, [{ name: "a/one", score: 0.9, repo: { policy: flagged }, issues: [issueRec("a/one", 1)] }])
    expect((await selectNextIssueWith(c, { ...OPEN_CAPS, capsSnapshot: () => ({ ...SNAP, openPrsByRepo: { "x/y": 2 } }) }))?.issue.id).toBe("a/one#1")
    // Without the flag, a busy repo is left to the normal caps.
    expect(oneAiPrAtATimeBlocks(repoRec("a/one"), { ...SNAP, openPrsByRepo: { "a/one": 1 } })).toBeNull()
  })

  test("requiresIssueFirst: only issues labeled as open for PRs qualify", async () => {
    const gh = githubFor([{ issue: ghIn("a/one", { number: 2, labels: ["Help Wanted"] }) }])
    const c = context({ github: gh })
    const repo = { requiresIssueFirst: true }
    seed(c, [
      {
        name: "a/one",
        score: 0.9,
        repo: { policy: policy(repo) },
        issues: [issueRec("a/one", 1, { score: 0.9, labels: ["bug"] }), issueRec("a/one", 2, { score: 0.6, labels: ["Help Wanted"] })],
      },
    ])
    expect((await selectNextIssueWith(c, OPEN_CAPS))?.issue.id).toBe("a/one#2")
    c.cleanup()

    const c2 = context({ github: githubFor([]) })
    seed(c2, [{ name: "a/one", score: 0.9, repo: { policy: policy(repo) }, issues: [issueRec("a/one", 1, { labels: ["bug"] })] }])
    expect(await selectNextIssueWith(c2, OPEN_CAPS)).toBeNull()
    expect(c2.store.listAudit()).toEqual([])
  })

  test("stale cache triggers a refresh; a fresh cache does not", async () => {
    const c = context({ github: githubFor([{ issue: ghIn("a/one", { number: 5 }) }]) })
    c.store.saveRepo(repoRec("a/one"))
    c.store.upsertIssue(issueRec("a/one", 1, { fetchedAt: NOW - 2 * DAY }))
    const refreshed: string[] = []
    const refresh: SelectionDeps["refreshRepoIssues"] = async (_ctx, repo) => {
      refreshed.push(repo.fullName)
      return []
    }
    expect(await selectNextIssueWith(c, { ...OPEN_CAPS, refreshRepoIssues: refresh })).toBeNull()
    expect(refreshed).toEqual(["a/one"])

    c.store.setKv(issueRefreshKey("a/one"), NOW - (CANDIDATE_CACHE_MS - HOUR), NOW)
    c.store.upsertIssue(issueRec("a/one", 5))
    const result = await selectNextIssueWith(c, { ...OPEN_CAPS, refreshRepoIssues: refresh })
    expect(refreshed).toEqual(["a/one"])
    expect(result?.issue.id).toBe("a/one#5")
  })

  test("end to end with the real refresh: search → score → select", async () => {
    const gh = githubFor(standardFixtures())
    const c = context({ github: gh })
    c.store.saveRepo(repoRec(REPO))
    const result = await selectNextIssueWith(c, OPEN_CAPS)
    expect(result?.issue.id).toBe(`${REPO}#1`)
    expect(c.store.listAudit({ action: "issue.candidate" })).toHaveLength(2)
    expect(c.store.listAudit({ action: "issue.select" })).toHaveLength(1)
  })

  test("a candidate that changed since caching is skipped and the next one is tried", async () => {
    const gh = githubFor([
      { issue: ghIn("a/one", { number: 1, assignees: [ghUser("alice")] }) },
      { issue: ghIn("a/one", { number: 2 }) },
    ])
    const c = context({ github: gh })
    seed(c, [{ name: "a/one", score: 0.9, issues: [issueRec("a/one", 1, { score: 0.9 }), issueRec("a/one", 2, { score: 0.7 })] }])
    const result = await selectNextIssueWith(c, OPEN_CAPS)
    expect(result?.issue.id).toBe("a/one#2")
    expect(c.store.getIssue("a/one#1")).toMatchObject({ status: "skipped", skipReason: "already assigned to @alice" })
    expect(c.store.listAudit({ action: "issue.skip" })[0]?.subject).toBe("a/one#1")
  })

  test("examines at most 5 repos per call", async () => {
    const gh = githubFor([], { openPrs: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`o/r${i}`, 1])) })
    const c = context({ github: gh })
    seed(
      c,
      Array.from({ length: 7 }, (_, i) => ({ name: `o/r${i}`, score: 0.9 - i * 0.05, issues: [issueRec(`o/r${i}`, 1)] })),
    )
    expect(await selectNextIssueWith(c, OPEN_CAPS)).toBeNull()
    expect(methodCalls(gh, "searchIssues").map((a) => a[0])).toEqual(
      Array.from({ length: MAX_REPOS_PER_SELECTION }, (_, i) => `is:pr is:open author:me repo:o/r${i}`),
    )
    expect(c.store.listAudit()).toEqual([])
  })

  test("non-fatal errors move on to the next repo; rate limits propagate", async () => {
    const gh = githubFor([{ issue: ghIn("b/two", { number: 1 }) }]).set({
      searchIssues: async (q: string) => {
        if (q.includes("repo:a/one")) throw new GitHubError("Validation Failed", 422)
        return []
      },
    })
    const c = context({ github: gh })
    seed(c, [
      { name: "a/one", score: 0.9, issues: [issueRec("a/one", 1)] },
      { name: "b/two", score: 0.5, issues: [issueRec("b/two", 1)] },
    ])
    expect((await selectNextIssueWith(c, OPEN_CAPS))?.issue.id).toBe("b/two#1")
    c.cleanup()

    const limited = githubFor([]).set({
      searchIssues: async () => {
        throw new RateLimitError("search limit", NOW + HOUR, "search", false)
      },
    })
    const c2 = context({ github: limited })
    seed(c2, [{ name: "a/one", score: 0.9, issues: [issueRec("a/one", 1)] }])
    await expect(selectNextIssueWith(c2, OPEN_CAPS)).rejects.toBeInstanceOf(RateLimitError)
  })

  test("unknown own login: nothing is selected (open-PR check impossible)", async () => {
    const gh = githubFor([])
    const c = context({ github: gh })
    ;(c as { login: () => Promise<string> }).login = async () => {
      throw new GitHubError("Bad credentials", 401)
    }
    seed(c, [{ name: "a/one", score: 0.9, issues: [issueRec("a/one", 1)] }])
    expect(await selectNextIssueWith(c, OPEN_CAPS)).toBeNull()
    expect(gh.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// fuzzy labels + search without a hard label filter (prefixed label schemes)
// ---------------------------------------------------------------------------

describe("labelHas (fuzzy label matching)", () => {
  test("prefixes, punctuation, emoji, case, camelCase, squashed and plural forms", () => {
    expect(labelHas("Type: Bug", "bug")).toBe(true)
    expect(labelHas("kind/bug", "bug")).toBe(true)
    expect(labelHas("status: confirmed", "confirmed")).toBe(true)
    expect(labelHas("🐛 bug", "bug")).toBe(true)
    expect(labelHas("Good First Issue :wave:", "good first issue")).toBe(true)
    expect(labelHas("good-first-issue", "good first issue")).toBe(true)
    expect(labelHas("GoodFirstIssue", "good first issue")).toBe(true)
    expect(labelHas("goodfirstissue", "good first issue")).toBe(true)
    expect(labelHas("type: documentation", "documentation")).toBe(true)
    expect(labelHas("area/test", "tests")).toBe(true)
    expect(labelHas("Help-Wanted", "help wanted")).toBe(true)
    expect(labelHas("macOS", "macos")).toBe(true)
    expect(labelHas("platform: macos", "macOS")).toBe(true)
    expect(labelHas("PR's welcome", "prs welcome")).toBe(true)
  })
  test("whole words only", () => {
    expect(labelHas("debugging", "bug")).toBe(false)
    expect(labelHas("first issue", "good first issue")).toBe(false)
    expect(labelHas("bugfix-needed", "bug")).toBe(false)
    expect(labelHas("anything", "")).toBe(false)
  })
  test("scoring gives prefixed/decorated labels the same boost as plain ones", () => {
    const score = (labels: string[]) => scoreIssue({ issue: ghIssue({ labels }), comments: [], config: CONFIG, now: NOW, selfLogin: "me" })
    const plain = score(["bug", "good first issue"])
    const fancy = score(["Type: Bug", "Good First Issue :wave:"])
    expect(fancy.score).toBe(plain.score)
    expect(fancy.reasons).toContain('+0.14 preferred labels: "Type: Bug", "Good First Issue :wave:"')
    // "status: ideal-for-contribution" / "up-for-grabs" are acceptance labels
    expect(score(["status: ideal-for-contribution"]).score).toBeGreaterThan(score(["area: core"]).score)
    expect(score(["up-for-grabs"]).score).toBeGreaterThan(score(["area: core"]).score)
  })
})

describe("buildIssueSearchQueries", () => {
  test("labeled search first, then a broad one without any label qualifier", () => {
    const qs = buildIssueSearchQueries("acme/widget", CONFIG, NOW)
    expect(qs).toEqual([
      buildIssueSearchQuery("acme/widget", CONFIG, NOW),
      "repo:acme/widget is:issue is:open no:assignee -linked:pr archived:false updated:>=2025-07-19",
    ])
    expect(buildIssueSearchQuery("acme/widget", CONFIG, NOW, { labels: false })).toBe(qs[1]!)
    for (const q of qs) expect(q).not.toMatch(/\b(?:OR|AND|NOT)\b/)
  })
  test("without preferred labels there is a single broad search", () => {
    const cfg = testConfig({ issues: { labels: [] } })
    expect(buildIssueSearchQueries("o/r", cfg, NOW)).toEqual([buildIssueSearchQuery("o/r", cfg, NOW)])
  })
})

describe("refreshRepoIssues: preferred labels are a preference, not a filter", () => {
  /** Exact-label search finds `labeled` (a repo using "type: bug" etc. finds nothing); the broad search returns `broad`. */
  function prefixedSchemeGitHub(broad: GhIssue[], labeled: GhIssue[] = []): FakeGitHub {
    return new FakeGitHub({
      searchIssues: async (q: string) => (q.includes("label:") ? labeled : broad),
      listIssueComments: async () => [maint("lead", "Confirmed, PR welcome")],
      listIssueTimeline: async () => [],
    })
  }

  test("a repo with a prefixed label scheme still yields candidates, with the label boost", async () => {
    const springStyle = ghIn(REPO, { number: 11, labels: ["type: bug", "status: ideal-for-contribution"] })
    const gh = prefixedSchemeGitHub([springStyle])
    const c = context({ github: gh })
    const result = await refreshRepoIssues(c, repoRec(REPO))
    expect(result.map((r) => r.number)).toEqual([11])
    expect(result[0]!.reasons.some((r) => r.includes('preferred labels: "type: bug", "status: ideal-for-contribution"'))).toBe(true)
    expect(methodCalls(gh, "searchIssues").map((a) => (a[0] as string).includes("label:"))).toEqual([true, false])
  })

  test("labeled hits come first; the broad search only fills the remaining slots", async () => {
    const labeled = [ghIn(REPO, { number: 1 }), ghIn(REPO, { number: 2 })]
    const broad = [ghIn(REPO, { number: 2 }), ghIn(REPO, { number: 3 }), ghIn(REPO, { number: 4 })]
    const gh = prefixedSchemeGitHub(broad, labeled)
    const c = context({ github: gh, config: { issues: { maxCandidatesPerRepo: 3 } } })
    // #4 was a candidate before: it still matches the search (beyond the limit), so it is not retired
    c.store.upsertIssue(issueRec(REPO, 4))
    const result = await refreshRepoIssues(c, repoRec(REPO))
    expect(result.map((r) => r.number).sort()).toEqual([1, 2, 3])
    expect(methodCalls(gh, "listIssueComments").map((a) => a[1])).toEqual([1, 2, 3])
    expect(c.store.getIssue(`${REPO}#4`)?.status).toBe("candidate")
  })

  test("no broad search when the labeled search already fills every slot", async () => {
    const labeled = [ghIn(REPO, { number: 1 }), ghIn(REPO, { number: 2 })]
    const gh = prefixedSchemeGitHub([ghIn(REPO, { number: 3 })], labeled)
    const c = context({ github: gh, config: { issues: { maxCandidatesPerRepo: 2 } } })
    await refreshRepoIssues(c, repoRec(REPO))
    expect(methodCalls(gh, "searchIssues")).toHaveLength(1)
  })

  test("search hits from another repository are ignored", async () => {
    const gh = prefixedSchemeGitHub([ghIn("other/place", { number: 5 }), ghIn(REPO, { number: 6 })])
    const c = context({ github: gh })
    expect((await refreshRepoIssues(c, repoRec(REPO))).map((r) => r.number)).toEqual([6])
    expect(c.store.getIssue(`${REPO}#5`)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// claims in the issue description
// ---------------------------------------------------------------------------

describe("detectClaim: the issue description", () => {
  const issue = (body: string, over: Partial<GhIssue> = {}) =>
    ghIssue({ body, user: ghUser("reporter"), created_at: "2026-01-13T09:00:00Z", ...over })
  const claimIn = (i: GhIssue, comments: GhComment[] = [], self: string | null = "me") => detectClaim(comments, NOW, self, i)

  test("the reporter saying they are working on a fix is a claim", () => {
    for (const body of [
      "Crash on zero timeout.\n\nI'm already working on a fix and will open a PR later today.",
      "Steps to reproduce: ...\n\nI'll submit a PR for this shortly.",
      "Broken since 2.0. PR coming soon.",
      "I've started working on this, see my branch.",
    ]) {
      expect(claimIn(issue(body))).toBe("claimed by @reporter in the issue description on 2026-01-13")
    }
  })

  test("offers, unticked/ticked checkboxes, quotes and code are not claims", () => {
    for (const body of [
      "Crash on zero timeout. I'd be happy to submit a PR if you agree with the approach.",
      "I can submit a PR if that helps.",
      "We could handle this by checking for zero in `createClient`.",
      "I want to fix this but need guidance.",
      "- [ ] I'm working on a fix and will submit a PR\n- [ ] I'm willing to submit a PR",
      "- [x] I'm willing to submit a PR",
      "> I'm working on a fix\n\nSomeone said that upstream, but nothing happened.",
      "```\n// I'll submit a PR for this\n```\nThe comment above is in the source.",
    ]) {
      expect(claimIn(issue(body))).toBeNull()
    }
  })

  test("a later withdrawal by the reporter or a maintainer release clears it", () => {
    const i = issue("I'm working on a fix, PR coming.")
    expect(claimIn(i, [say("reporter", "Sorry, I no longer have time for this.", "2026-01-14T09:00:00Z")])).toBeNull()
    expect(claimIn(i, [maint("lead", "This is up for grabs now.", "2026-01-14T10:00:00Z")])).toBeNull()
    // someone else's withdrawal does not
    expect(claimIn(i, [say("bob", "I'm not working on this", "2026-01-14T09:00:00Z")])).toMatch(/^claimed by @reporter/)
  })

  test("old descriptions, your own issues and bot-filed issues do not count", () => {
    expect(claimIn(issue("I'm working on a fix.", { created_at: "2025-10-01T00:00:00Z" }))).toBeNull()
    expect(claimIn(issue("I'm working on a fix.", { user: ghUser("me") }))).toBeNull()
    expect(claimIn(issue("I'm working on a fix.", { user: ghUser("renovate[bot]", "Bot") }))).toBeNull()
    // without the issue, only comments count (backwards compatible)
    expect(detectClaim([], NOW, "me")).toBeNull()
  })

  test("a maintainer-filed issue assigning the work in prose", () => {
    const i = issue("Tracking the fix here; @alice is working on this.", { user: ghUser("lead"), author_association: "MEMBER" })
    expect(claimIn(i)).toBe("claimed by @alice in the issue description on 2026-01-13")
  })

  test("scoreIssue: a body claim is a hard skip; a body offer is a soft penalty", () => {
    const body = `${ghIssue().body}\n\nI'm already working on a fix and will open a PR later today.`
    const claimed = scoreIssue({ issue: ghIssue({ body, created_at: "2026-01-13T09:00:00Z" }), comments: [], config: CONFIG, now: NOW, selfLogin: "me" })
    expect(claimed.hardSkip).toBe("claimed by @reporter in the issue description on 2026-01-13")

    for (const sentence of ["I'd be happy to submit a PR for this.", "I can submit a PR if that helps."]) {
      const offered = scoreIssue({ issue: ghIssue({ body: `${ghIssue().body}\n\n${sentence}` }), comments: [], config: CONFIG, now: NOW, selfLogin: "me" })
      expect(offered.hardSkip).toBeNull()
      expect(offered.reasons).toContain("-0.10 reporter: offered to submit a PR themselves")
    }
    // proposing an approach is neither
    const proposal = scoreIssue({
      issue: ghIssue({ body: `${ghIssue().body}\n\nWe could handle this by checking for zero first.` }),
      comments: [],
      config: CONFIG,
      now: NOW,
      selfLogin: "me",
    })
    expect(proposal.hardSkip).toBeNull()
    expect(proposal.reasons.some((r) => r.includes("reporter: offered"))).toBe(false)
  })

  test("comments keep counting offers as claims (unchanged)", () => {
    for (const body of ["I can submit a PR for this", "we could take care of it", "I want to work on this", "I'd like to work on this"]) {
      expect(detectClaim([say("bob", body)], NOW, "me")).toBe("claimed by @bob on 2026-01-08")
    }
  })
})

// ---------------------------------------------------------------------------
// transferred issues
// ---------------------------------------------------------------------------

describe("transferred issues", () => {
  test("transferredTo compares the fetched issue's repo and number", () => {
    expect(transferredTo("acme/widget", 7, ghIn("acme/widget", { number: 7 }))).toBeNull()
    expect(transferredTo("Acme/Widget", 7, ghIn("acme/widget", { number: 7 }))).toBeNull()
    expect(transferredTo("acme/widget", 7, ghIn("other/place", { number: 999 }))).toBe("other/place#999")
    expect(transferredTo("acme/widget", 7, ghIn("acme/widget", { number: 8 }))).toBe("acme/widget#8")
    const apiOnly = { number: 3, html_url: "", repository_url: "https://api.github.com/repos/other/place" }
    expect(transferredTo("acme/widget", 3, apiOnly)).toBe("other/place#3")
  })

  test("re-checking a transferred candidate skips it without writing a mismatched record", async () => {
    const gh = new FakeGitHub({
      searchIssues: async () => [],
      getIssue: async (_repo: string, n: number) => (n === 7 ? ghIn("other/place", { number: 999 }) : ghIn("acme/widget", { number: n })),
    })
    const c = context({ github: gh })
    seed(c, [{ name: "acme/widget", score: 0.9, issues: [issueRec("acme/widget", 7, { score: 0.9 }), issueRec("acme/widget", 8, { score: 0.6 })] }])

    const result = await selectNextIssueWith(c, OPEN_CAPS)

    expect(result?.issue.id).toBe("acme/widget#8")
    expect(c.store.getIssue("acme/widget#7")).toMatchObject({ status: "skipped", skipReason: "issue transferred to other/place#999" })
    expect(c.store.getIssue("acme/widget#999")).toBeNull()
    expect(c.store.listIssues().map((i) => i.id).sort()).toEqual(["acme/widget#7", "acme/widget#8"])
  })
})

// ---------------------------------------------------------------------------
// earlier outcomes: rejected / aborted / failed / in progress (never picked again)
// ---------------------------------------------------------------------------

function taskRec(issueId: string, status: TaskRecord["status"], over: Partial<TaskRecord> = {}): TaskRecord {
  const repo = issueId.slice(0, issueId.lastIndexOf("#"))
  const task: TaskRecord = {
    id: `task-${status}-${issueId}`,
    kind: "contribution",
    repo,
    issueId,
    prId: null,
    stage: status === "done" ? "done" : "implement",
    status,
    attempts: 1,
    failures: 0,
    nextRunAt: NOW,
    lastError: null,
    abortReason: null,
    workspace: null,
    branch: null,
    tokensUsed: 0,
    costUsd: 0,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    data: {},
  }
  return { ...task, ...over }
}

describe("priorOutcomeReason", () => {
  const rec = (over: Partial<IssueRecord> = {}) => issueRec("a/one", 1, over)
  test("terminal skip reasons, done, sticky skips and tasks block; plain skips do not", () => {
    expect(TERMINAL_SKIP_PREFIXES).toEqual(["rejected by human", "task aborted", "task failed"])
    expect(priorOutcomeReason(rec({ status: "skipped", skipReason: "rejected by human: wrong approach" }), [], false)).toBe(
      "rejected by human: wrong approach",
    )
    expect(priorOutcomeReason(rec({ status: "skipped", skipReason: "Task failed: baseline broken" }), [], false)).toBe("Task failed: baseline broken")
    expect(priorOutcomeReason(rec({ status: "skipped", skipReason: "task aborted: critic rejected" }), [], false)).toMatch(/^task aborted/)
    expect(priorOutcomeReason(rec({ status: "done" }), [], false)).toBe("already done")
    expect(priorOutcomeReason(rec({ status: "skipped", skipReason: "superseded at approval" }), [], true)).toBe("superseded at approval")
    expect(priorOutcomeReason(rec({ status: "skipped", skipReason: "no longer matches the issue search" }), [], false)).toBeNull()
    expect(priorOutcomeReason(rec(), [], false)).toBeNull()
    expect(priorOutcomeReason(null, [], false)).toBeNull()

    const aborted = taskRec("a/one#1", "aborted", { abortReason: "critic rejected: out of scope" })
    expect(priorOutcomeReason(rec(), [aborted], false)).toBe(`already attempted by task ${aborted.id} (aborted: critic rejected: out of scope)`)
    const active = taskRec("a/one#1", "waiting")
    expect(priorOutcomeReason(rec(), [aborted, active], false)).toBe(`task ${active.id} is already working on it`)
    expect(priorOutcomeReason(null, [taskRec("a/one#1", "failed")], false)).toMatch(/^already attempted by task .* \(failed\)$/)
  })
})

describe("rejected / aborted / failed issues are never picked again", () => {
  const ID = `${REPO}#7`
  function fixtureGitHub(): FakeGitHub {
    return githubFor([
      {
        issue: ghIn(REPO, {
          number: 7,
          title: "Wrong default for retries in `fetchWithRetry`",
          body: "The default `retries` value in src/retry.ts is 5 but the README says 3.\n\nExpected 3, actual 5. Version 2.0.1",
          labels: [{ name: "bug" }],
        }),
        comments: [maint("lead", "Good catch, PR welcome")],
      },
    ])
  }

  async function afterOutcome(apply: (c: TestContext) => void): Promise<{ c: TestContext; gh: FakeGitHub }> {
    const gh = fixtureGitHub()
    const c = context({ github: gh })
    c.store.saveRepo(repoRec(REPO))
    expect((await refreshRepoIssues(c, repoRec(REPO))).map((r) => r.id)).toEqual([ID])
    apply(c)
    c.clock.advance(25 * HOUR) // past CANDIDATE_CACHE_MS: the next selection refreshes the repo
    return { c, gh }
  }

  const outcomes: Array<[string, (c: TestContext) => void, RegExp]> = [
    ["rejected by a human (/oss-reject)", (c) => c.store.setIssueStatus(ID, "skipped", "rejected by human: wrong approach"), /^rejected by human/],
    [
      "task aborted (critic rejection, reason without a prefix)",
      (c) => {
        c.store.saveTask(taskRec(ID, "aborted", { abortReason: "critic rejected: not what maintainers asked for" }))
        c.store.setIssueStatus(ID, "skipped", "critic rejected: not what maintainers asked for")
      },
      /^critic rejected/,
    ],
    [
      "task failed after repeated failures",
      (c) => {
        c.store.saveTask(taskRec(ID, "failed", { lastError: "sandbox unavailable" }))
        c.store.setIssueStatus(ID, "skipped", "task failed: sandbox unavailable")
      },
      /^task failed/,
    ],
    ["task failed (no task row left)", (c) => c.store.setIssueStatus(ID, "skipped", "task failed: sandbox unavailable"), /^task failed/],
  ]
  for (const [name, apply, reason] of outcomes) {
    test(`${name}: refresh keeps it skipped and selection does not pick it`, async () => {
      const { c, gh } = await afterOutcome(apply)
      expect(await selectNextIssueWith(c, OPEN_CAPS)).toBeNull()
      const rec = c.store.getIssue(ID)!
      expect(rec.status).toBe("skipped")
      expect(rec.skipReason).toMatch(reason)
      // the refresh ran (cache expired: 2 searches each time) but did not re-evaluate the issue
      expect(methodCalls(gh, "searchIssues").filter((a) => (a[0] as string).startsWith("repo:"))).toHaveLength(4)
      expect(methodCalls(gh, "listIssueComments")).toHaveLength(1)
      expect(methodCalls(gh, "getIssue")).toEqual([])
      expect(c.store.listAudit({ action: "issue.select" })).toEqual([])
    })
  }

  test("an issue with a task in progress is never a candidate again, even if its record says candidate", async () => {
    const { c, gh } = await afterOutcome((c) => c.store.saveTask(taskRec(ID, "active")))
    expect(await selectNextIssueWith(c, OPEN_CAPS)).toBeNull()
    expect(c.store.getIssue(ID)).toMatchObject({ status: "skipped", skipReason: `task task-active-${ID} is already working on it` })
    expect(methodCalls(gh, "getIssue")).toEqual([])
  })

  test("a cached candidate with an earlier aborted task is retired, not selected", async () => {
    const gh = githubFor([{ issue: ghIn("a/one", { number: 1 }) }, { issue: ghIn("a/one", { number: 2 }) }])
    const c = context({ github: gh })
    seed(c, [{ name: "a/one", score: 0.9, issues: [issueRec("a/one", 1, { score: 0.9 }), issueRec("a/one", 2, { score: 0.6 })] }])
    c.store.saveTask(taskRec("a/one#1", "aborted", { abortReason: "verification gate failed" }))
    const result = await selectNextIssueWith(c, OPEN_CAPS)
    expect(result?.issue.id).toBe("a/one#2")
    expect(c.store.getIssue("a/one#1")?.status).toBe("skipped")
    expect(c.store.getIssue("a/one#1")!.skipReason).toMatch(/^already attempted by task .*aborted: verification gate failed/)
    expect(methodCalls(gh, "getIssue")).toEqual([["a/one", 2]])
  })

  test("sticky skips (Store.isIssueSticky) are honored whatever their reason", async () => {
    const { c, gh } = await afterOutcome((c) => c.store.setIssueStatus(ID, "skipped", "superseded: issue was closed", { sticky: true }))
    expect(await selectNextIssueWith(c, OPEN_CAPS)).toBeNull()
    expect(c.store.getIssue(ID)).toMatchObject({ status: "skipped", skipReason: "superseded: issue was closed" })
    expect(methodCalls(gh, "listIssueComments")).toHaveLength(1)
  })

  test("final retirements are marked sticky; a task still in progress is not final", async () => {
    const gh = githubFor([])
    const c = context({ github: gh })
    seed(c, [{ name: "a/one", score: 0.9, issues: [issueRec("a/one", 1), issueRec("a/one", 2)] }])
    c.store.saveTask(taskRec("a/one#1", "aborted", { abortReason: "critic rejected" }))
    c.store.saveTask(taskRec("a/one#2", "active"))
    expect(await selectNextIssueWith(c, OPEN_CAPS)).toBeNull()
    expect(c.store.isIssueSticky("a/one#1")).toBe(true)
    expect(c.store.isIssueSticky("a/one#2")).toBe(false)
    expect(c.store.getIssue("a/one#2")?.status).toBe("skipped")
    // nothing workable was cached, so the repo cost no GitHub call
    expect(gh.calls).toEqual([])
  })

  test("an ordinary skip is re-evaluated on the next refresh (only terminal outcomes stick)", async () => {
    const { c } = await afterOutcome((c) => c.store.setIssueStatus(ID, "skipped", "no longer matches the issue search"))
    expect((await selectNextIssueWith(c, OPEN_CAPS))?.issue.id).toBe(ID)
  })
})

// ---------------------------------------------------------------------------
// fair rotation across repos
// ---------------------------------------------------------------------------

describe("selectNextIssueWith: rotation past fruitless repos", () => {
  test("repos whose fresh cache has nothing workable are free and do not use up the limit", async () => {
    const gh = githubFor([{ issue: ghIn("o/r6", { number: 1 }) }])
    const c = context({ github: gh })
    seed(
      c,
      Array.from({ length: 7 }, (_, i) => ({ name: `o/r${i}`, score: 0.9 - i * 0.05, issues: i === 6 ? [issueRec("o/r6", 1, { score: 0.9 })] : [] })),
    )
    const result = await selectNextIssueWith(c, OPEN_CAPS)
    expect(result?.issue.id).toBe("o/r6#1")
    // only the repo with something to try cost GitHub calls
    expect(methodCalls(gh, "searchIssues").map((a) => a[0])).toEqual(["is:pr is:open author:me repo:o/r6"])
  })

  test("repos with your open PR are passed over for a while, so later calls reach lower-ranked repos", async () => {
    const gh = githubFor([{ issue: ghIn("o/r6", { number: 1 }) }], {
      openPrs: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`o/r${i}`, 1])),
    })
    const c = context({ github: gh })
    seed(
      c,
      Array.from({ length: 7 }, (_, i) => ({ name: `o/r${i}`, score: 0.9 - i * 0.05, issues: [issueRec(`o/r${i}`, 1)] })),
    )
    const prChecks = () => methodCalls(gh, "searchIssues").map((a) => /repo:(\S+)/.exec(a[0] as string)?.[1])

    expect(await selectNextIssueWith(c, OPEN_CAPS)).toBeNull()
    expect(prChecks()).toEqual(["o/r0", "o/r1", "o/r2", "o/r3", "o/r4"])
    expect(c.store.getKv<{ at: number; reason: string }>(examinedKey("o/r0"))).toEqual({ at: NOW, reason: "you already have an open PR there" })

    const second = await selectNextIssueWith(c, OPEN_CAPS)
    expect(second?.issue.id).toBe("o/r6#1")
    expect(prChecks().slice(5)).toEqual(["o/r5", "o/r6"])

    // after the backoff the top repos are examined again
    c.clock.advance(EXAMINE_BACKOFF_MS)
    c.store.setKv(issueRefreshKey("o/r0"), c.clock.now(), c.clock.now())
    await selectNextIssueWith(c, OPEN_CAPS)
    expect(prChecks()[7]).toBe("o/r0")
  })

  test("stale caches: each call refreshes at most 5 repos, the next call moves on", async () => {
    const c = context({ github: githubFor([{ issue: ghIn("o/r6", { number: 1 }) }]) })
    for (let i = 0; i < 7; i++) c.store.saveRepo(repoRec(`o/r${i}`, { score: 0.9 - i * 0.05 }))
    const refreshed: string[] = []
    const refresh: SelectionDeps["refreshRepoIssues"] = async (ctx, repo) => {
      refreshed.push(repo.fullName)
      ctx.store.setKv(issueRefreshKey(repo.fullName), ctx.clock.now(), ctx.clock.now())
      if (repo.fullName !== "o/r6") return []
      const rec = issueRec("o/r6", 1, { fetchedAt: ctx.clock.now() })
      ctx.store.upsertIssue(rec)
      return [rec]
    }
    expect(await selectNextIssueWith(c, { ...OPEN_CAPS, refreshRepoIssues: refresh })).toBeNull()
    expect(refreshed).toEqual(["o/r0", "o/r1", "o/r2", "o/r3", "o/r4"])
    expect((await selectNextIssueWith(c, { ...OPEN_CAPS, refreshRepoIssues: refresh }))?.issue.id).toBe("o/r6#1")
    expect(refreshed).toEqual(["o/r0", "o/r1", "o/r2", "o/r3", "o/r4", "o/r5", "o/r6"])
  })

  test("a repo that errored is passed over for a while", async () => {
    const gh = githubFor([{ issue: ghIn("b/two", { number: 1 }) }, { issue: ghIn("b/two", { number: 2 }) }]).set({
      searchIssues: async (q: string) => {
        if (q.includes("repo:a/one")) throw new GitHubError("Validation Failed", 422)
        return []
      },
    })
    const c = context({ github: gh })
    seed(c, [
      { name: "a/one", score: 0.9, issues: [issueRec("a/one", 1)] },
      { name: "b/two", score: 0.5, issues: [issueRec("b/two", 1), issueRec("b/two", 2, { score: 0.6 })] },
    ])
    expect((await selectNextIssueWith(c, OPEN_CAPS))?.issue.id).toBe("b/two#1")
    expect(c.store.getKv<{ reason: string }>(examinedKey("a/one"))?.reason).toMatch(/^error: /)
    await selectNextIssueWith(c, OPEN_CAPS)
    expect(methodCalls(gh, "searchIssues").filter((a) => (a[0] as string).includes("repo:a/one"))).toHaveLength(1)
  })
})
