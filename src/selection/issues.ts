/**
 * Issue selection. Per eligible repo: search open, unassigned issues (preferred labels first, then
 * any label), drop the ones that are claimed, linked to a pull request, waiting on a maintainer
 * decision, already worked on (rejected by you, aborted/failed task) or otherwise unsuitable, score
 * the rest (labels, clarity, reproducibility, scope, maintainer engagement, recency) and persist every
 * decision. `selectNextIssue` then picks the best (repo, issue) across repos within caps, moving past
 * repos that recently yielded nothing. Read-only on GitHub; every skip/candidate/select decision is audited.
 */
import { isRepoAllowed } from "../core/allowlist.ts"
import { audit, type AppContext } from "../core/context.ts"
import type { OssScoutConfig } from "../config/schema.ts"
import type { IssueKind, IssueRecord, Millis, RepoRecord, ScoreResult, TaskRecord } from "../core/types.ts"
import { KilledError, RateLimitError } from "../github/api.ts"
import type { GhComment, GhIssue, GhTimelineEvent, GhUser } from "../github/types.ts"
import { canStartAnyTask, canStartTaskForRepo, capsSnapshot, type CapsSnapshot } from "../scheduler/caps.ts"
import { hasAiPolicyFlag } from "../screening/policy.ts"
import { DAY, HOUR, isoToMs, utcDay } from "../util/clock.ts"
import { errorMessage } from "../util/log.ts"
import { clamp01, issueId, oneLine, truncate } from "../util/text.ts"

/** Claims ("I'll take this") older than this are ignored. */
export const CLAIM_WINDOW_DAYS = 45
/** Stored candidates younger than this are reused instead of re-searching the repo. */
export const CANDIDATE_CACHE_MS = 24 * HOUR
/**
 * Repos examined per selectNextIssue call: repos that cost GitHub calls (open-PR check, candidate
 * refresh, re-fetch). Repos ruled out locally (caps, allow list, a fresh cache with nothing workable,
 * a recent fruitless examination) are free and not counted.
 */
export const MAX_REPOS_PER_SELECTION = 5
/** A repo examined without result (your open PR there, or an error) is passed over for this long. */
export const EXAMINE_BACKOFF_MS = 6 * HOUR
/**
 * skip_reason prefixes of terminal outcomes: a human rejected the work, or its task was aborted or
 * failed. Such issues never become candidates again.
 */
export const TERMINAL_SKIP_PREFIXES = ["rejected by human", "task aborted", "task failed"] as const
/** Candidates re-fetched per repo before moving on to the next repo. */
const MAX_CANDIDATES_TRIED_PER_REPO = 3
const MIN_BODY_CHARS = 20
const MAX_STORED_BODY_CHARS = 20_000
const COMMENTS_FETCHED = 50
const TIMELINE_FETCHED = 100
/** Issues younger than this may not have been triaged yet. */
const UNTRIAGED_MS = 2 * DAY
const BASE_SCORE = 0.32
const MERGED_PR_PENALTY = 0.2

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])

/** Labels meaning "maintainers want an outside contribution here" (strongest score boost). */
const STRONG_LABELS = ["good first issue", "good first bug", "help wanted", "confirmed"]
/** Acceptance labels that boost even when not in config.issues.labels. */
const ACCEPTANCE_LABELS = [
  "accepted",
  "pr welcome",
  "prs welcome",
  "pull request welcome",
  "pull requests welcome",
  "accepting prs",
  "contributions welcome",
  "contribution welcome",
  "ideal for contribution",
  "up for grabs",
]
/** Labels that satisfy a repo's "open/discuss an issue first" rule. */
const ISSUE_FIRST_OK_LABELS = ["help wanted", "good first issue", ...ACCEPTANCE_LABELS]
const GOOD_FIRST_ISSUE_LABELS = ["good first issue", "good first bug", "good first contribution", "first timers only"]

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

/** Lowercase, every run of non-alphanumerics → one space. "Type: Bug" → "type bug". */
function normLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/**
 * Label words for fuzzy matching: camelCase split, lowercased, punctuation and emoji dropped
 * ("Type: Bug" → ["type", "bug"], "GoodFirstIssue" → ["good", "first", "issue"]).
 */
function labelWords(label: string): string[] {
  return label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0)
}

/** A trailing plural "s" folded away ("docs" → "doc", "goodfirstissues" → "goodfirstissue"; not "class"). */
function foldPlural(s: string): string {
  return s.length > 3 && s.endsWith("s") && !s.endsWith("ss") ? s.slice(0, -1) : s
}

/**
 * Fuzzy whole-word phrase match, so prefixed and decorated label schemes count: "status: confirmed"
 * and "kind/bug" have "confirmed" / "bug"; "Good First Issue :wave:", "good-first-issue",
 * "GoodFirstIssue" and "goodfirstissue" all have "good first issue". "debugging" has no "bug".
 */
export function labelHas(label: string, phrase: string): boolean {
  const target = foldPlural(labelWords(phrase).join(""))
  if (!target) return false
  // A run of consecutive whole label words must spell the phrase (word breaks and a plural may differ).
  const w = labelWords(label)
  for (let i = 0; i < w.length; i++) {
    let run = ""
    for (let j = i; j < w.length && run.length <= target.length; j++) {
      run += w[j]
      if (foldPlural(run) === target) return true
    }
  }
  return false
}

function anyLabelHas(labels: string[], phrases: string[]): string | null {
  for (const l of labels) if (phrases.some((p) => labelHas(l, p))) return l
  return null
}

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, "")
}

/** Prose only: no HTML comments, fenced code, or quoted lines; straight apostrophes. */
function prose(text: string | null | undefined): string {
  return stripHtmlComments(text ?? "")
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, " ")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
}

function isBot(user: GhUser | null | undefined): boolean {
  if (!user) return false
  return user.type === "Bot" || /\[bot\]$/i.test(user.login)
}

function isMaintainer(association: string | undefined): boolean {
  return MAINTAINER_ASSOCIATIONS.has((association ?? "").toUpperCase())
}

function sameLogin(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

/** Comments oldest first (stable for equal/missing timestamps). */
function chronological(comments: GhComment[]): GhComment[] {
  return comments
    .map((c, i) => ({ c, i, t: isoToMs(c.created_at) ?? 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.c)
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000
const fmtDelta = (d: number): string => `${d >= 0 ? "+" : "-"}${Math.abs(d).toFixed(2)}`
const daysBetween = (from: Millis, to: Millis): number => Math.floor((to - from) / DAY)

// ---------------------------------------------------------------------------
// labels + kind
// ---------------------------------------------------------------------------

export function labelNames(issue: Pick<GhIssue, "labels">): string[] {
  const out: string[] = []
  for (const l of issue.labels ?? []) {
    const name = (typeof l === "string" ? l : l?.name ?? "").trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

const KIND_LABEL_WORDS: Array<[IssueKind, string[]]> = [
  ["docs", ["documentation", "docs", "doc"]],
  ["tests", ["test", "tests", "testing", "coverage"]],
  ["bug", ["bug", "bugs", "defect", "regression", "crash", "bugfix"]],
  ["enhancement", ["enhancement", "feature", "feat", "improvement"]],
]

/**
 * Kind from labels. Area labels (docs/tests) win over type labels (bug/enhancement); status labels
 * like "needs tests" / "needs docs" describe missing work on another kind and are ignored.
 */
function kindFromLabels(labels: string[]): IssueKind | null {
  const words = new Set(
    labels
      .map(normLabel)
      .filter((l) => !/^needs? /.test(l))
      .flatMap((l) => l.split(" ")),
  )
  for (const [kind, ws] of KIND_LABEL_WORDS) if (ws.some((w) => words.has(w))) return kind
  return null
}

const TITLE_KIND_PATTERNS: Array<[IssueKind, RegExp]> = [
  ["docs", /\b(?:docs?|documentation|readme|docstrings?|jsdoc|javadoc|tsdoc|changelog)\b/i],
  [
    "tests",
    /\b(?:add|adding|missing|more|write|improve|increase|needs?)\s+(?:unit\s+|integration\s+|e2e\s+|regression\s+)?tests?\b|\btest coverage\b|\bcoverage\b|\bflaky\b|\btests? for\b/i,
  ],
  [
    "bug",
    /\b(?:bug|crash(?:es|ed|ing)?|errors?|exceptions?|fail(?:s|ed|ing|ure)?|broken|regression|incorrect(?:ly)?|wrong|panic|segfault|hangs?|leaks?|doesn't work|does not work|not working|typeerror|nullpointerexception|undefined is not)\b/i,
  ],
  ["docs", /\btypos?\b|\bspelling\b|\bmisspel/i],
  [
    "enhancement",
    /\b(?:feature|feature request|add support|support for|allow(?:s|ing)?|option to|ability to|enhancement|would be nice|request)\b/i,
  ],
]

const BODY_KIND_PATTERNS: Array<[IssueKind, RegExp]> = [
  [
    "enhancement",
    /is your feature request related|describe the solution you'?d like|\bfeature request\b|\bit would be (?:nice|great|useful)\b/i,
  ],
  [
    "bug",
    /\bsteps to reproduce\b|\bexpected behaviou?r\b|\bactual behaviou?r\b|\btraceback\b|\bstack ?trace\b|\b\w+(?:Error|Exception):|\bcrash(?:es|ed)?\b/i,
  ],
  ["docs", /\b(?:the )?(?:documentation|docs|readme)\b/i],
  ["tests", /\btest coverage\b|\bmissing tests?\b|\bunit tests? for\b/i],
]

export function classifyIssueKind(title: string, body: string, labels: string[]): IssueKind {
  const fromLabels = kindFromLabels(labels)
  if (fromLabels) return fromLabels
  for (const [kind, re] of TITLE_KIND_PATTERNS) if (re.test(title)) return kind
  const text = prose(body)
  for (const [kind, re] of BODY_KIND_PATTERNS) if (re.test(text)) return kind
  return "other"
}

// ---------------------------------------------------------------------------
// prefilter
// ---------------------------------------------------------------------------

/** Cheap checks on the issue object alone. Returns a skip reason or null. */
export function prefilterIssue(issue: GhIssue, config: OssScoutConfig, now: Millis): string | null {
  if (issue.pull_request) return "is a pull request, not an issue"
  if (issue.state !== "open") return `issue is ${issue.state}`
  if (issue.locked) return "issue is locked"
  const assignees = (issue.assignees ?? []).map((a) => a?.login).filter((l): l is string => !!l)
  if (assignees.length > 0) return `already assigned to ${assignees.map((l) => `@${l}`).join(", ")}`
  if (isBot(issue.user)) return `opened by a bot (@${issue.user?.login})`
  const excluded = excludedLabel(labelNames(issue), config.issues.excludeLabels)
  if (excluded) return `has excluded label "${excluded}"`
  const updated = isoToMs(issue.updated_at)
  if (updated !== null && now - updated > config.issues.staleAfterDays * DAY) {
    return `stale: no activity for ${daysBetween(updated, now)} days (limit ${config.issues.staleAfterDays})`
  }
  if (issue.comments > config.issues.maxComments) {
    return `too many comments (${issue.comments} > ${config.issues.maxComments})`
  }
  const bodyLen = stripHtmlComments(issue.body ?? "").trim().length
  if (bodyLen < MIN_BODY_CHARS) return `description too short to act on (${bodyLen} chars)`
  return null
}

function excludedLabel(labels: string[], exclude: string[]): string | null {
  for (const label of labels) {
    const l = label.toLowerCase()
    if (exclude.some((x) => x.trim() !== "" && l.includes(x.trim().toLowerCase()))) return label
  }
  return null
}

// ---------------------------------------------------------------------------
// linked pull requests
// ---------------------------------------------------------------------------

type TimelineSubject = NonNullable<GhTimelineEvent["subject"]> & { repository?: { full_name?: string } }

/** "owner/repo" from an html or API url, else null. */
function repoFromUrl(url: string | undefined): string | null {
  if (!url) return null
  const m =
    /api\.github\.com\/repos\/([^/\s]+\/[^/\s]+)\/(?:issues|pulls)\/\d+/i.exec(url) ??
    /github\.com\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/\d+/i.exec(url)
  return m?.[1] ?? null
}

function prRef(repo: string | null | undefined, number: number): string {
  return repo ? `${repo}#${number}` : `#${number}`
}

/** Open PRs (and merged ones) linked to the issue via cross-reference / connected events. */
export function detectLinkedPullRequests(timeline: GhTimelineEvent[]): { open: string[]; merged: string[] } {
  const open = new Set<string>()
  const merged = new Set<string>()
  const manual = new Map<string, { connected: boolean; at: number | null; subject: TimelineSubject }>()

  for (const ev of timeline) {
    if (ev.event === "cross-referenced") {
      const src = ev.source?.issue
      if (!src || !src.pull_request) continue
      const ref = prRef(src.repository?.full_name ?? repoFromUrl(src.html_url ?? src.pull_request.html_url), src.number)
      if (src.pull_request.merged_at) merged.add(ref)
      else if (src.state === "open") open.add(ref)
      continue
    }
    if (ev.event !== "connected" && ev.event !== "disconnected") continue
    const subject = ev.subject as TimelineSubject | undefined
    if (!subject || typeof subject.number !== "number") continue
    if (subject.type && !/pull/i.test(subject.type)) continue
    const ref = prRef(subject.repository?.full_name ?? repoFromUrl(subject.url), subject.number)
    const at = isoToMs(ev.created_at)
    const prev = manual.get(ref)
    // Timeline order wins unless timestamps prove this event is older.
    if (prev && prev.at !== null && at !== null && at < prev.at) continue
    manual.set(ref, { connected: ev.event === "connected", at, subject })
  }

  for (const [ref, m] of manual) {
    if (!m.connected) continue
    if (m.subject.merged_at) merged.add(ref)
    else if ((m.subject.state ?? "open").toLowerCase() !== "closed") open.add(ref)
  }
  for (const ref of merged) open.delete(ref)
  return { open: [...open], merged: [...merged] }
}

/** A linked PR matters when it lives in the repo, a sibling repo, or a same-named fork. */
function linkedRefConcernsRepo(ref: string, repo: string): boolean {
  const refRepo = ref.slice(0, ref.lastIndexOf("#"))
  if (!refRepo.includes("/")) return true
  const [ro, rn] = refRepo.toLowerCase().split("/")
  const [o, n] = repo.toLowerCase().split("/")
  return ro === o || rn === n
}

// ---------------------------------------------------------------------------
// claims
// ---------------------------------------------------------------------------

const LOGIN = "([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))"
/** "take" as in claiming, not "take a look". */
const TAKE = "take(?! a (?:look|peek|glance|quick look))"

/**
 * Offers rather than commitments ("I'd like to work on this", "I'm willing to submit a PR", "can I take
 * this?"). In comments they count as claims; in the issue description they are only a score penalty
 * (issue templates ask reporters exactly this, and many never follow up).
 */
const VOLUNTEER: RegExp[] = [
  new RegExp(
    `\\bi(?:'d| would)(?: really)? (?:like|love) to (?:work on|${TAKE}|tackle|pick (?:it |this )?up|fix|handle|contribute|give (?:it|this) a (?:try|shot|go)|try)\\b`,
    "i",
  ),
  /\b(?:i|we)(?:'d| would) be (?:happy|glad|willing) to (?:work on|take (?:this|it)|fix|submit|send|open|make|tackle)\b/i,
  new RegExp(
    `\\b(?:can|could|may) i (?:please )?(?:work on|${TAKE}|tackle|pick (?:it |this )?up|handle|try|fix|have|grab|be assigned|get assigned)\\b`,
    "i",
  ),
  /\bi(?:'m| am) (?:happy|glad|willing) to (?:work on|take|fix|submit|send|open|make|tackle)\b/i,
  new RegExp(`\\bi(?:'m| am)? (?:want|wanna) (?:to )?(?:work on|${TAKE}|tackle|pick up|fix|submit|open|send)\\b`, "i"),
  /\bi (?:can|could)(?: try to| gladly| happily| also| definitely)? (?:take (?:this|it|that|care of)|work on|pick (?:it |this |that )?up|tackle|handle (?:this|it))\b/i,
  /\bi (?:can|could)(?: try to| gladly| happily| also| definitely)? (?:submit|open|send|create|make|prepare|raise|put up) (?:a |the )?(?:pr|pull request|fix|patch)\b/i,
]

/**
 * "We can/could take care of this", "we could open a PR": a claim in a comment, but in a description it
 * usually proposes an approach ("we could handle this by …"), so it counts for nothing there.
 */
const WE_CAN: RegExp[] = [
  /\bwe (?:can|could)(?: try to| gladly| happily| also| definitely)? (?:take (?:this|it|that|care of)|work on|pick (?:it |this |that )?up|tackle|handle (?:this|it))\b/i,
  /\bwe (?:can|could)(?: try to| gladly| happily| also| definitely)? (?:submit|open|send|create|make|prepare|raise|put up) (?:a |the )?(?:pr|pull request|fix|patch)\b/i,
]

/** Commitments: someone is (about to be) working on it ("I'm working on a fix", "PR coming soon", "/assign"). */
const COMMITMENT: RegExp[] = [
  new RegExp(`\\bi(?:'m| am)? (?:plan|planning|intend|going|gonna) (?:to )?(?:work on|${TAKE}|tackle|pick up|fix|submit|open|send)\\b`, "i"),
  /\b(?:i|we)(?:'ll| will)(?: try to| gladly| happily| also| definitely)? (?:take (?:this|it|that|care of)|work on|pick (?:it |this |that )?up|tackle|handle (?:this|it))\b/i,
  /\b(?:i|we)(?:'ll| will)(?: try to| gladly| happily| also| definitely)? fix (?:this|it)\b/i,
  /\b(?:i|we)(?:'ll| will)(?: try to| gladly| happily| also| definitely)? (?:submit|open|send|create|make|prepare|raise|put up) (?:a |the )?(?:pr|pull request|fix|patch)\b/i,
  /\b(?:i'm|i am|i've been|i have been|we're|we are)(?: (?:currently|already|actively|still|now|also))? working on (?:a |the |an )?(?:fix|pr|pull request|patch|this|it|that)\b/i,
  /(?:^|[.!?]\s+)(?:(?:currently|already|still|now) )?working on (?:a |the |an )?(?:fix|pr|pull request|patch|this|it)\b/im,
  /\bassign (?:(?:it|this|this issue|the issue) )?(?:to )?me\b/i,
  /\bi(?:'m| am) on (?:it|this)\b/i,
  /^\s*on it\b/im,
  /^\s*\/(?:assign|take|claim)\b/im,
  /\bi(?:'ve| have)? (?:started|begun|began) (?:working|work) on\b/i,
  /\bi(?:'ve| have) (?:got )?(?:a|an) (?:fix|pr|patch|pull request)\b/i,
  /\b(?:pr|pull request|fix|patch) (?:is )?(?:incoming|on (?:the|its) way|coming (?:soon|up|later|shortly))\b/i,
  /\blet me (?:work on|take|fix|handle|tackle|try) (?:this|it)\b/i,
]

/** Claims in comments: commitments and offers alike. */
const SELF_CLAIM: RegExp[] = [...COMMITMENT, ...VOLUNTEER, ...WE_CAN]

const WITHDRAW: RegExp[] = [
  /\bno longer (?:working|work|able|interested|have (?:the )?time|pursuing)\b/i,
  /\bnot (?:working on (?:this|it) )?any ?more\b/i,
  /\bi(?:'m| am) not (?:working on|going to (?:work on|finish|continue)|able to (?:work on|finish|continue))\b/i,
  /\b(?:won't|will not|can't|cannot|couldn't|could not) (?:be able to )?(?:work on|finish|continue|complete|get to|pursue)\b/i,
  /\bun-?assign/i,
  /\bfeel free to (?:take|pick|work|grab)\b/i,
  /\b(?:someone|anyone|somebody|anybody) else (?:can|could|may|is welcome to|should) (?:take|pick|work|grab)\b/i,
  /\b(?:gave|give|giving) up on (?:this|it)\b/i,
  /\bstepp(?:ing|ed) (?:down|back|away) from\b/i,
  /\b(?:don't|do not) have (?:the |enough )?(?:time|bandwidth|capacity)\b/i,
  /\b(?:releasing|freeing up|free up) (?:this|it|the issue)\b/i,
]

/** Maintainer assigns the work to someone in prose ("assigned to @x", "@x is working on this"). */
const ASSIGN_OTHER: RegExp[] = [
  new RegExp(`\\b(?:re)?assign(?:ed|ing)?\\s+(?:(?:this|it|the issue)\\s+)?(?:to\\s+)?@${LOGIN}`, "gi"),
  new RegExp(
    `@${LOGIN}\\s+(?:is|was|has been)\\s+(?:already\\s+|currently\\s+|now\\s+)?(?:working on|on it|assigned|looking into|taking (?:it|this|care)|fixing)`,
    "gi",
  ),
  new RegExp(`@${LOGIN}\\s+(?:will|is going to|plans to)\\s+(?:work on|${TAKE}|fix|handle|tackle|pick (?:it |this )?up|submit|open|send)`, "gi"),
]

/** Maintainer releases a specific claimant. */
const RELEASE_OTHER: RegExp[] = [
  new RegExp(`\\bun-?assign(?:ed|ing)?\\s+(?:from\\s+)?@${LOGIN}`, "gi"),
  new RegExp(`@${LOGIN}\\s+(?:is|was|has been)\\s+(?:now\\s+)?un-?assigned`, "gi"),
  new RegExp(`@${LOGIN}\\s+(?:is|has)\\s+no longer\\s+(?:working|assigned)`, "gi"),
]

/** Maintainer opens the issue to everyone again. */
const RELEASE_ALL: RegExp[] = [
  /\bup for grabs\b/i,
  /\b(?:anyone|someone|somebody|anybody)(?: else)? (?:can|could|is welcome to|should feel free to) (?:take|pick|work|grab)\b/i,
  /\bun-?assign(?:ed|ing)? (?:due to|because of|as|since|for)\b/i,
]

function captures(text: string, patterns: RegExp[]): string[] {
  const out: string[] = []
  for (const re of patterns) for (const m of text.matchAll(re)) if (m[1]) out.push(m[1])
  return out
}

interface Claim {
  login: string
  at: Millis
  /** Made in the issue description rather than a comment. */
  inDescription: boolean
}

/** Task-list lines ("- [ ] I'm willing to submit a PR") are template checkboxes, not statements. */
function withoutTaskList(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*[-*+]\s+\[[ xX]\]/.test(line))
    .join("\n")
}

/** Issue description as prose for claim detection (no comments, code, quotes or checkboxes). */
function descriptionProse(issue: Pick<GhIssue, "body">): string {
  return withoutTaskList(prose(issue.body))
}

/**
 * Someone else said they're working on it ("I'll take this", "working on a PR", …) recently. Returns
 * reason or null. With `issue`, the description counts too, as written by the reporter at creation:
 * "I'm already working on a fix, PR coming" there is a claim (offers like "I'd be happy to submit a PR"
 * are only a score penalty, see reporterVolunteerPart). Later withdrawals and maintainer releases clear it.
 */
export function detectClaim(
  comments: GhComment[],
  now: Millis,
  selfLogin: string | null,
  issue?: Pick<GhIssue, "body" | "user" | "created_at" | "author_association"> | null,
): string | null {
  const active = new Map<string, Claim>()
  const claim = (login: string, at: Millis, inDescription = false) => {
    if (!sameLogin(login, selfLogin)) active.set(login.toLowerCase(), { login, at, inDescription })
  }

  const reporter = issue?.user?.login
  if (issue && reporter && !isBot(issue.user) && !sameLogin(reporter, selfLogin)) {
    const at = isoToMs(issue.created_at) ?? 0
    const text = descriptionProse(issue)
    if (COMMITMENT.some((re) => re.test(text)) && !WITHDRAW.some((re) => re.test(text))) claim(reporter, at, true)
    if (isMaintainer(issue.author_association)) for (const login of captures(text, ASSIGN_OTHER)) claim(login, at, true)
  }

  for (const c of chronological(comments)) {
    const author = c.user?.login
    if (!author || isBot(c.user) || sameLogin(author, selfLogin)) continue
    const at = isoToMs(c.created_at) ?? 0
    const text = prose(c.body)
    const maintainer = isMaintainer(c.author_association)

    if (SELF_CLAIM.some((re) => re.test(text))) claim(author, at)
    if (maintainer) for (const login of captures(text, ASSIGN_OTHER)) claim(login, at)

    // Withdrawals win over claims made in the same comment.
    if (WITHDRAW.some((re) => re.test(text))) active.delete(author.toLowerCase())
    if (maintainer) {
      for (const login of captures(text, RELEASE_OTHER)) active.delete(login.toLowerCase())
      if (RELEASE_ALL.some((re) => re.test(text))) {
        for (const key of [...active.keys()]) if (key !== author.toLowerCase()) active.delete(key)
      }
    }
  }

  const since = now - CLAIM_WINDOW_DAYS * DAY
  let latest: Claim | null = null
  for (const c of active.values()) if (c.at >= since && (!latest || c.at > latest.at)) latest = c
  if (!latest) return null
  return `claimed by @${latest.login}${latest.inDescription ? " in the issue description" : ""} on ${utcDay(latest.at)}`
}

// ---------------------------------------------------------------------------
// design decisions
// ---------------------------------------------------------------------------

const DECISION_LABEL =
  /\b(?:rfc|proposal|design|architecture|breaking|discussion|undecided|tbd|needs (?:discussion|decision|consensus|design|rfc|approval|spec)|api design|under consideration|to be decided)\b/

/** "[RFC] …", "Proposal: …", or "RFC" anywhere except IETF references ("RFC 7231"). */
const DECISION_TITLE =
  /^\s*(?:\[\s*(?:rfc|proposal|discussion|design|idea)\s*\]|(?:rfc|proposal|discussion|design|idea)\s*[:\-–])|\brfc\b(?!\s*-?\s*\d)/i

const DECISION_PHRASES: RegExp[] = [
  /\bneeds? (?:more |further |some )?discussion\b/i,
  /\b(?:needs?|requires?) (?:a )?(?:maintainer |team |core team )?decision\b/i,
  /\bnot sure (?:if |whether )?we (?:want|should)\b/i,
  /\bopen questions?\b/i,
  /\bapi design\b/i,
  /\bdesign (?:discussion|decision|doc|proposal|review)\b/i,
  /\barchitectur(?:e|al) (?:change|decision|discussion|question|proposal)s?\b/i,
  /\b(?:would|will|might|may|could) (?:be|require|need|introduce|cause) a breaking change\b/i,
  /\brequires? a breaking change\b/i,
  /\b(?:we )?(?:haven't|have not) (?:yet )?(?:decided|agreed)\b/i,
  /\bundecided\b/i,
  /\brequest for comments?\b/i,
  /\b(?:let's|we should|we need to) discuss\b/i,
  /\bneeds? (?:an? )?rfc\b/i,
]

const MAINTAINER_DECISION_PHRASES: RegExp[] = [
  ...DECISION_PHRASES,
  /\bnot (?:yet )?convinced\b/i,
  /\bon the fence\b/i,
  /\bout of scope\b/i,
  /\b(?:won't|will not|wouldn't|would not) (?:accept|merge)\b/i,
  /\bnot something we (?:want|plan)\b/i,
]

/** Maintainer go-ahead that resolves an earlier "needs discussion". */
const GO_AHEAD: RegExp[] = [
  /\b(?:prs?|pull requests?|contributions?|patch(?:es)?) (?:are |is )?(?:very |more than )?welcome\b/i,
  /\bhappy to (?:accept|review|merge|take) (?:a |the )?(?:pr|pull request|patch|contribution|fix)/i,
  /\b(?:we'd|we would) (?:accept|welcome|love|be happy to (?:accept|review)) (?:a |the )?(?:pr|pull request|patch|contribution|fix)/i,
  /\blet's (?:do|go with|proceed with) (?:it|this|that|option)/i,
  /\bgo ahead\b/i,
  /\b(?:we've|we have) decided\b/i,
]

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(text)
    if (m) return m[0].trim()
  }
  return null
}

/** Issue/thread needs maintainers to make design/architecture decisions first. Returns reason or null. */
export function needsDecision(issue: GhIssue, comments: GhComment[]): string | null {
  const label = labelNames(issue).find((l) => DECISION_LABEL.test(normLabel(l)))
  if (label) return `needs a maintainer decision: label "${label}"`
  if (DECISION_TITLE.test(issue.title)) return "needs a maintainer decision: title marks an RFC/proposal/discussion"

  const inBody = firstMatch(prose(issue.body), DECISION_PHRASES)
  let pending: string | null = inBody ? `needs a maintainer decision: issue says "${inBody}"` : null
  for (const c of chronological(comments)) {
    if (isBot(c.user) || !isMaintainer(c.author_association)) continue
    const text = prose(c.body)
    const hit = firstMatch(text, MAINTAINER_DECISION_PHRASES)
    if (hit) pending = `needs a maintainer decision: maintainer @${c.user?.login ?? "?"} said "${hit}"`
    else if (GO_AHEAD.some((re) => re.test(text))) pending = null
  }
  return pending
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

/**
 * Score weights. score = clamp01(BASE_SCORE + Σ component deltas); every component is capped so
 * an ideal issue lands near 1.0 without saturating, and each delta is listed in the reasons.
 */
const W = {
  label: { strong: 0.1, acceptance: 0.07, preferred: 0.04, cap: 0.18 },
  clarity: { short: -0.1, sized: 0.05, long: 0.02, huge: -0.05, structured: 0.03, code: 0.03, shortTitle: -0.03, min: -0.15, cap: 0.12 },
  repro: { steps: 0.05, version: 0.02, error: 0.03, link: 0.03, expectedActual: 0.04, missingForBug: -0.08, cap: 0.16 },
  scope: { file: 0.03, symbol: 0.02, line: 0.02, typo: 0.04, test: 0.03, docs: 0.02, cap: 0.12, maxPenalty: 0.3 },
  kind: { bug: 0.02, docs: 0.04, tests: 0.04, enhancement: -0.05, other: -0.05 } as Record<IssueKind, number>,
  engagement: { commented: 0.04, confirmed: 0.06, doubt: -0.1, filedByMaintainer: 0.03, min: -0.1, cap: 0.12 },
  recency: { active: 0.02, quiet: -0.04, old: -0.05, ancient: -0.1, untriaged: -0.05, busy: -0.04 },
  volunteer: -0.1,
} as const

interface Part {
  delta: number
  reason: string
}

const capped = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

function partOf(delta: number, label: string, details: string[]): Part | null {
  const d = round3(delta)
  return d === 0 ? null : { delta: d, reason: `${label}: ${details.join(", ")}` }
}

/** Accumulates weighted signals for one component. */
class Tally {
  delta = 0
  readonly details: string[] = []
  add(weight: number, detail: string): void {
    this.delta += weight
    this.details.push(detail)
  }
}

function labelPart(labels: string[], preferred: string[]): Part | null {
  const t = new Tally()
  for (const label of labels) {
    const inConfig = preferred.some((p) => labelHas(label, p))
    if (inConfig && STRONG_LABELS.some((s) => labelHas(label, s))) t.add(W.label.strong, `"${label}"`)
    else if (ACCEPTANCE_LABELS.some((s) => labelHas(label, s))) t.add(W.label.acceptance, `"${label}"`)
    else if (inConfig) t.add(W.label.preferred, `"${label}"`)
  }
  return partOf(capped(t.delta, 0, W.label.cap), "preferred labels", t.details)
}

const STRUCTURE = [/^#{1,6}\s+\S/m, /^\s*\*\*[^*\n]+\*\*:?\s*$/m, /^\s*(?:[-*+]|\d+[.)])\s+\S/m]

function clarityPart(title: string, body: string): Part | null {
  const t = new Tally()
  const len = body.trim().length
  if (len < 80) t.add(W.clarity.short, `very short description (${len} chars)`)
  else if (len >= 150 && len <= 4000) t.add(W.clarity.sized, `well-sized description (${len} chars)`)
  else if (len > 4000 && len <= 8000) t.add(W.clarity.long, `long description (${len} chars)`)
  else if (len > 8000) t.add(W.clarity.huge, `very long description (${len} chars)`)
  if (STRUCTURE.some((re) => re.test(body))) t.add(W.clarity.structured, "structured (headings/lists)")
  if (/```|~~~|`[^`\n]+`/.test(body)) t.add(W.clarity.code, "includes code")
  if (title.trim().length < 10) t.add(W.clarity.shortTitle, "very short title")
  return partOf(capped(t.delta, W.clarity.min, W.clarity.cap), "clarity", t.details)
}

const REPRO_SIGNALS: Array<[number, string, RegExp]> = [
  [
    W.repro.steps,
    "steps to reproduce",
    /steps? to reproduce|\bto reproduce\b|reproduction steps|repro(?:duction)? steps|how to reproduce|minimal reproduc|reproducible example|\brepro\b/i,
  ],
  [W.repro.version, "version info", /\bversions?\b|\bv\d+\.\d+|\b\d+\.\d+\.\d+\b/i],
  [
    W.repro.error,
    "error message / stack trace",
    /\b\w*(?:Error|Exception)\b:|traceback \(most recent call last\)|^\s+at \S.*:\d+(?::\d+)?\)?\s*$|panicked at|stack ?trace|segmentation fault/im,
  ],
  [
    W.repro.link,
    "reproduction link",
    /stackblitz\.com|codesandbox\.io|replit\.com|jsfiddle\.net|codepen\.io|gist\.github\.com|\bplayground\b|github\.com\/\S*repro|reproduction (?:repo|repository|link)/i,
  ],
]

function reproPart(body: string, kind: IssueKind): Part | null {
  const t = new Tally()
  for (const [w, name, re] of REPRO_SIGNALS) if (re.test(body)) t.add(w, name)
  if (/\bexpected\b/i.test(body) && /\b(?:actual|actually|instead|but got|got:|current behaviou?r|observed)\b/i.test(body)) {
    t.add(W.repro.expectedActual, "expected vs actual")
  }
  if (t.details.length === 0) {
    return kind === "bug" ? { delta: W.repro.missingForBug, reason: "reproducibility: bug report without reproduction details" } : null
  }
  return partOf(capped(t.delta, 0, W.repro.cap), "reproducibility", t.details)
}

const FILE_EXT =
  "(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|java|kt|kts|go|rs|rb|md|mdx|rst|txt|json|ya?ml|toml|c|cc|cpp|h|hpp|cs|php|swift|scala|sh|css|scss|html|vue|svelte|xml|gradle)"
/** [weight, name, pattern, matches prose only (true) or raw text incl. code (false)] */
const SMALL_SCOPE: Array<[number, string, RegExp, boolean]> = [
  [
    W.scope.file,
    "names a file",
    new RegExp(`(?:[\\w.-]+/)+[\\w.-]+\\.${FILE_EXT}\\b|\`[\\w./-]+\\.${FILE_EXT}\`|\\b[A-Z][A-Z_]+\\.(?:md|txt|rst)\\b`),
    false,
  ],
  [
    W.scope.symbol,
    "names a function/symbol",
    /`[A-Za-z_$][\w$.]*\([^`\n]*\)`|`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+`|\b(?:function|method|class)\s+`?[A-Za-z_$][\w$.]*/,
    false,
  ],
  [W.scope.line, "points at a line", /\bline \d+|#L\d+|\S:\d+:\d+\b/i, false],
  [W.scope.typo, "typo-sized fix", /\btypos?\b|\bspelling\b|\bmisspel/i, true],
  [W.scope.test, "adds a missing test", /\bmissing tests?\b|\badd(?:ing)? (?:a |unit |more )?tests?\b|\btest coverage\b/i, true],
]
/** [penalty, name, pattern], matched against prose (title + body). */
const LARGE_SCOPE: Array<[number, string, RegExp]> = [
  [0.15, "tracking/meta issue", /\b(?:tracking issue|meta issue|umbrella issue|epic|roadmap)\b/i],
  [0.1, "rewrite", /\brewrit(?:e|ing)\b/i],
  [0.1, "redesign/overhaul", /\b(?:redesign|overhaul|re-?architect)/i],
  [0.08, "refactor", /\brefactor/i],
  [0.08, "migration", /\bmigrat(?:e|ion|ing)\b/i],
  [
    0.08,
    "cross-cutting",
    /\b(?:across|throughout) (?:the )?(?:entire |whole )?(?:codebase|code base|project|repo|repository|library|packages)\b|\bcross[- ]cutting\b|\ball (?:files|modules|packages|components)\b|\bevery (?:file|module|package|component)\b/i,
  ],
  [0.05, "new feature support", /\bsupport for\b/i],
]

function scopeParts(title: string, body: string, kind: IssueKind): Part[] {
  const text = `${title}\n${body}`
  const words = prose(text)
  const small = new Tally()
  for (const [w, name, re, onProse] of SMALL_SCOPE) if (re.test(onProse ? words : text)) small.add(w, name)
  if (kind === "docs") small.add(W.scope.docs, "documentation change")
  const large = new Tally()
  for (const [w, name, re] of LARGE_SCOPE) if (re.test(words)) large.add(w, name)
  const tasks = (body.match(/^\s*[-*+]\s+\[[ xX]\]/gm) ?? []).length
  if (tasks >= 6) large.add(tasks >= 12 ? 0.12 : 0.08, `long task list (${tasks} items)`)
  return [
    partOf(capped(small.delta, 0, W.scope.cap), "small scope", small.details),
    partOf(-capped(large.delta, 0, W.scope.maxPenalty), "large scope", large.details),
  ].filter((p): p is Part => p !== null)
}

function kindPart(kind: IssueKind): Part {
  const note = kind === "enhancement" ? " (feature work often needs design agreement)" : kind === "other" ? " (unclear issue type)" : ""
  return { delta: W.kind[kind], reason: `kind: ${kind}${note}` }
}

const MAINTAINER_CONFIRMS: RegExp[] = [
  /\b(?:i|we) (?:can|could) (?:confirm|reproduce)\b/i,
  /\breproduced\b/i,
  /\bconfirmed\b/i,
  /\bgood catch\b/i,
  /\b(?:this is|looks like) a (?:valid )?bug\b/i,
  /\bvalid (?:bug|issue)\b/i,
  ...GO_AHEAD,
]
const MAINTAINER_DOUBTS: RegExp[] = [
  /\b(?:can't|cannot|couldn't|could not|unable to|not able to) (?:reproduce|repro)\b/i,
  /\bworks for me\b/i,
  /\bneeds? more (?:info|information|details)\b/i,
  /\bplease provide (?:a )?(?:minimal )?(?:repro|reproduction|example)\b/i,
]

function engagementPart(issue: GhIssue, comments: GhComment[]): Part | null {
  const t = new Tally()
  const maintainers: string[] = []
  let stance: "confirmed" | "doubt" | null = null
  for (const c of chronological(comments)) {
    if (isBot(c.user) || !isMaintainer(c.author_association)) continue
    const login = c.user?.login ?? "?"
    if (!maintainers.includes(login)) maintainers.push(login)
    const text = prose(c.body)
    if (MAINTAINER_DOUBTS.some((re) => re.test(text))) stance = "doubt"
    else if (MAINTAINER_CONFIRMS.some((re) => re.test(text))) stance = "confirmed"
  }
  if (maintainers.length > 0) t.add(W.engagement.commented, `maintainer commented (${maintainers.map((l) => `@${l}`).join(", ")})`)
  if (stance === "confirmed") t.add(W.engagement.confirmed, "maintainer confirmed or welcomed a PR")
  else if (stance === "doubt") t.add(W.engagement.doubt, "maintainer could not reproduce or asked for more info")
  if (isMaintainer(issue.author_association)) t.add(W.engagement.filedByMaintainer, "filed by a maintainer")
  return partOf(capped(t.delta, W.engagement.min, W.engagement.cap), "maintainer engagement", t.details)
}

function recencyPart(issue: GhIssue, comments: GhComment[], now: Millis): Part | null {
  const t = new Tally()
  const updated = isoToMs(issue.updated_at)
  const created = isoToMs(issue.created_at)
  if (updated !== null) {
    const quiet = daysBetween(updated, now)
    if (quiet <= 30) t.add(W.recency.active, "recently active")
    else if (quiet > 90) t.add(W.recency.quiet, `quiet for ${quiet} days`)
  }
  if (created !== null) {
    const age = daysBetween(created, now)
    if (age > 730) t.add(W.recency.ancient, `old issue (${age} days)`)
    else if (age > 365) t.add(W.recency.old, `old issue (${age} days)`)
    const triaged = comments.some((c) => isMaintainer(c.author_association) && !isBot(c.user))
    if (now - created < UNTRIAGED_MS && !triaged) t.add(W.recency.untriaged, "very new, possibly untriaged")
  }
  if (issue.comments > 8) t.add(W.recency.busy, `busy thread (${issue.comments} comments)`)
  return partOf(t.delta, "recency", t.details)
}

/**
 * Reporter ticked "I'm willing to submit a PR", or offered it in prose ("I'd be happy to submit a
 * PR"), recently: give them the chance first. Firm commitments in the description are claims (detectClaim).
 */
function reporterVolunteerPart(issue: GhIssue, now: Millis, selfLogin: string | null): Part | null {
  if (sameLogin(issue.user?.login, selfLogin)) return null
  const created = isoToMs(issue.created_at)
  if (created === null || now - created > CLAIM_WINDOW_DAYS * DAY) return null
  const ticked = /^\s*[-*+]\s+\[[xX]\]\s+[^\n]*\b(?:willing|like|want|plan)\b[^\n]*\b(?:submit|open|send|create|implement|work on|fix)\b/im
  const offered = ticked.test(stripHtmlComments(issue.body ?? "")) || VOLUNTEER.some((re) => re.test(descriptionProse(issue)))
  return offered ? { delta: W.volunteer, reason: "reporter: offered to submit a PR themselves" } : null
}

/** Clarity, reproducibility and scope scoring. Pure. */
export function scoreIssue(input: {
  issue: GhIssue
  comments: GhComment[]
  config: OssScoutConfig
  now: Millis
  /** Your login: your own comments never count as someone else's claim. */
  selfLogin?: string | null
}): ScoreResult & { kind: IssueKind } {
  const { issue, comments, config, now } = input
  const selfLogin = input.selfLogin ?? null
  const labels = labelNames(issue)
  const body = stripHtmlComments(issue.body ?? "")
  const kind = classifyIssueKind(issue.title, issue.body ?? "", labels)

  const parts = [
    labelPart(labels, config.issues.labels),
    clarityPart(issue.title, body),
    reproPart(body, kind),
    ...scopeParts(issue.title, body, kind),
    kindPart(kind),
    engagementPart(issue, comments),
    recencyPart(issue, comments, now),
    reporterVolunteerPart(issue, now, selfLogin),
  ].filter((p): p is Part => p !== null)

  const score = round3(clamp01(BASE_SCORE + parts.reduce((s, p) => s + p.delta, 0)))
  const reasons = parts.map((p) => `${fmtDelta(p.delta)} ${p.reason}`)
  const hardSkip =
    prefilterIssue(issue, config, now) ?? detectClaim(comments, now, selfLogin, issue) ?? needsDecision(issue, comments)
  return { score, reasons, hardSkip, kind }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/** label value for search: bare when simple, quoted when it has spaces/specials, null if unrepresentable. */
function searchLabelValue(label: string): string | null {
  const l = label.trim()
  if (!l || l.includes('"') || /[\r\n]/.test(l)) return null
  return /^[A-Za-z0-9_.-]+$/.test(l) ? l : `"${l}"`
}

/**
 * Issue-search query for one repo (is:issue is:open no:assignee -linked:pr …). With `labels` (default)
 * it also requires one of the preferred labels by exact name; `{ labels: false }` gives the broad query.
 */
export function buildIssueSearchQuery(repo: string, config: OssScoutConfig, now: Millis, opts: { labels?: boolean } = {}): string {
  const since = utcDay(now - config.issues.staleAfterDays * DAY)
  const parts = [`repo:${repo}`, "is:issue", "is:open", "no:assignee", "-linked:pr", "archived:false", `updated:>=${since}`]
  const seen = new Set<string>()
  const values: string[] = []
  for (const label of opts.labels === false ? [] : config.issues.labels) {
    const key = label.trim().toLowerCase()
    const v = searchLabelValue(label)
    if (!v || seen.has(key)) continue
    seen.add(key)
    values.push(v)
  }
  // Comma-separated values are an OR without spending a boolean operator.
  if (values.length > 0) parts.push(`label:${values.join(",")}`)
  return parts.join(" ")
}

/**
 * The searches a refresh runs, in order. GitHub's label qualifier only matches exact label names, so
 * repos with prefixed or decorated schemes ("type: bug", "kind/bug", "Good First Issue :wave:") would
 * never match the preferred-label search. Preferred labels are a preference, not a filter: the labeled
 * search goes first, then a broad search (newest activity first) fills the remaining slots, and label
 * preference is applied in scoring with fuzzy matching (labelHas).
 */
export function buildIssueSearchQueries(repo: string, config: OssScoutConfig, now: Millis): string[] {
  const labeled = buildIssueSearchQuery(repo, config, now)
  const broad = buildIssueSearchQuery(repo, config, now, { labels: false })
  return labeled === broad ? [broad] : [labeled, broad]
}

// ---------------------------------------------------------------------------
// refresh (fetch + filter + score + persist)
// ---------------------------------------------------------------------------

/** kv key holding the last successful candidate refresh for a repo. */
export function issueRefreshKey(repo: string): string {
  return `selection.refreshedAt:${repo.toLowerCase()}`
}

function isFatal(err: unknown): boolean {
  return err instanceof RateLimitError || err instanceof KilledError
}

// ---------------------------------------------------------------------------
// earlier outcomes (rejections, aborted/failed tasks)
// ---------------------------------------------------------------------------

/** Tasks of one repo per issue id (lowercased), oldest first. */
function tasksByIssue(ctx: AppContext, repo: string): Map<string, TaskRecord[]> {
  const out = new Map<string, TaskRecord[]>()
  for (const t of ctx.store.listTasks({ repo })) {
    if (!t.issueId) continue
    const key = t.issueId.toLowerCase()
    out.set(key, [...(out.get(key) ?? []), t])
  }
  for (const list of out.values()) list.sort((a, b) => a.createdAt - b.createdAt)
  return out
}

/**
 * Why an issue must not become a candidate (or be selected) again, else null: a task is already
 * working on it, it is done, its skip is sticky, a human rejected the work, or an earlier task on it
 * ended (done, aborted or failed). A rejected or abandoned issue is never retried automatically.
 */
export function priorOutcomeReason(rec: IssueRecord | null, tasks: TaskRecord[], sticky: boolean): string | null {
  return priorOutcome(rec, tasks, sticky)?.reason ?? null
}

/** priorOutcomeReason plus whether the outcome is final (everything except a task still in progress). */
function priorOutcome(rec: IssueRecord | null, tasks: TaskRecord[], sticky: boolean): { reason: string; final: boolean } | null {
  const running = tasks.find((t) => t.status === "active" || t.status === "waiting")
  if (running) return { reason: `task ${running.id} is already working on it`, final: false }
  if (rec?.status === "done") return { reason: "already done", final: true }
  if (rec && sticky && rec.status === "skipped") return { reason: rec.skipReason ?? "skipped for good", final: true }
  const reason = rec?.skipReason ?? null
  if (reason && TERMINAL_SKIP_PREFIXES.some((p) => reason.toLowerCase().startsWith(p))) return { reason, final: true }
  const last = tasks[tasks.length - 1]
  if (last) {
    const why = last.abortReason ?? last.lastError
    return { reason: oneLine(`already attempted by task ${last.id} (${last.status}${why ? `: ${why}` : ""})`, 240), final: true }
  }
  return null
}

/** priorOutcome for a stored issue id, given the repo's task index. */
function priorOutcomeOf(
  ctx: AppContext,
  id: string,
  rec: IssueRecord | null,
  tasks: Map<string, TaskRecord[]>,
): { reason: string; final: boolean } | null {
  return priorOutcome(rec, tasks.get(id.toLowerCase()) ?? [], rec ? ctx.store.isIssueSticky(id) : false)
}

/** A stored candidate that must not be worked on again becomes skipped (sticky when final; audited). */
function retireCandidate(ctx: AppContext, rec: IssueRecord, prior: { reason: string; final: boolean }): void {
  ctx.store.setIssueStatus(rec.id, "skipped", prior.reason, prior.final ? { sticky: true } : {})
  audit(ctx, "scout", "issue.skip", rec.id, "skip", [prior.reason], { repo: rec.repo, stage: "history" })
}

// ---------------------------------------------------------------------------
// transferred issues
// ---------------------------------------------------------------------------

/** "owner/repo" an issue object belongs to (html_url, else repository_url), or null. */
function issueRepoOf(issue: Pick<GhIssue, "html_url" | "repository_url">): string | null {
  const fromHtml = repoFromUrl(issue.html_url)
  if (fromHtml) return fromHtml
  const m = /\/repos\/([^/\s]+\/[^/\s]+?)\/?$/i.exec(issue.repository_url ?? "")
  return m?.[1] ?? null
}

/**
 * Where an issue fetched as (repo, number) really lives when that is elsewhere, else null. GitHub
 * answers a transferred issue with a 301 that the client follows, returning the issue from its new
 * repo (usually with a new number).
 */
export function transferredTo(repo: string, number: number, issue: Pick<GhIssue, "number" | "html_url" | "repository_url">): string | null {
  const actual = issueRepoOf(issue)
  const moved = actual !== null && actual.toLowerCase() !== repo.toLowerCase()
  if (!moved && issue.number === number) return null
  return `${actual ?? repo}#${issue.number}`
}

async function selfLoginOf(ctx: AppContext): Promise<string | null> {
  try {
    return await ctx.login()
  } catch (err) {
    if (isFatal(err)) throw err
    ctx.log.warn("could not resolve own GitHub login", { error: errorMessage(err) })
    return null
  }
}

function toRecord(
  repo: string,
  issue: GhIssue,
  now: Millis,
  fields: Pick<IssueRecord, "kind" | "status" | "score" | "reasons" | "skipReason">,
): IssueRecord {
  return {
    id: issueId(repo, issue.number),
    repo,
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    body: truncate(issue.body ?? "", MAX_STORED_BODY_CHARS),
    labels: labelNames(issue),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    comments: issue.comments,
    fetchedAt: now,
    ...fields,
  }
}

function skipIssue(ctx: AppContext, rec: IssueRecord, reason: string): void {
  ctx.store.upsertIssue({ ...rec, status: "skipped", skipReason: reason })
  audit(ctx, "scout", "issue.skip", rec.id, "skip", [reason, ...rec.reasons], {
    repo: rec.repo,
    kind: rec.kind,
    score: rec.score,
    url: rec.url,
  })
}

/** Evaluate one search hit. Returns the persisted candidate or null (skipped / not evaluated). */
async function evaluateIssue(
  ctx: AppContext,
  repo: RepoRecord,
  issue: GhIssue,
  selfLogin: string | null,
  now: Millis,
): Promise<IssueRecord | null> {
  const cfg = ctx.config
  const labels = labelNames(issue)
  const kind = classifyIssueKind(issue.title, issue.body ?? "", labels)
  const base = toRecord(repo.fullName, issue, now, { kind, status: "skipped", score: null, reasons: [], skipReason: null })

  const skip = (rec: IssueRecord, reason: string): null => {
    skipIssue(ctx, rec, reason)
    return null
  }

  const pre = prefilterIssue(issue, cfg, now)
  if (pre) return skip(base, pre)
  if (repo.policy?.reservesGoodFirstIssues && anyLabelHas(labels, GOOD_FIRST_ISSUE_LABELS)) {
    return skip(base, "repo reserves good first issues for new human contributors")
  }

  const comments = await ctx.github.listIssueComments(repo.fullName, issue.number, { max: COMMENTS_FETCHED })
  const timeline = await ctx.github.listIssueTimeline(repo.fullName, issue.number, { max: TIMELINE_FETCHED })
  const linked = detectLinkedPullRequests(timeline)
  const openPr = linked.open.find((ref) => linkedRefConcernsRepo(ref, repo.fullName))
  if (openPr) return skip(base, `linked open pull request ${openPr}`)

  const result = scoreIssue({ issue, comments, config: cfg, now, selfLogin })
  let score = result.score
  const reasons = [...result.reasons]
  const mergedPr = linked.merged.find((ref) => linkedRefConcernsRepo(ref, repo.fullName))
  if (mergedPr) {
    score = round3(clamp01(score - MERGED_PR_PENALTY))
    reasons.push(`${fmtDelta(-MERGED_PR_PENALTY)} linked PR ${mergedPr} already merged (may be fixed)`)
  }
  const rec = { ...base, kind: result.kind, score, reasons }
  if (result.hardSkip) return skip(rec, result.hardSkip)
  if (score < cfg.issues.minScore) {
    return skip(rec, `score ${score.toFixed(2)} below minimum ${cfg.issues.minScore.toFixed(2)}`)
  }

  const candidate: IssueRecord = { ...rec, status: "candidate", skipReason: null }
  ctx.store.upsertIssue(candidate)
  audit(ctx, "scout", "issue.candidate", candidate.id, "candidate", reasons, {
    repo: repo.fullName,
    kind: candidate.kind,
    score,
    url: candidate.url,
  })
  return candidate
}

/**
 * Search hits for a refresh: the preferred-label search, then the broad one while slots remain
 * (at most config.issues.maxCandidatesPerRepo issues, deduplicated). `matched` holds every hit's id,
 * including ones beyond the limit, so still-matching candidates are not retired.
 */
async function searchRepoIssues(ctx: AppContext, repo: string, now: Millis): Promise<{ found: GhIssue[]; matched: Set<string> }> {
  const max = ctx.config.issues.maxCandidatesPerRepo
  const found: GhIssue[] = []
  const matched = new Set<string>()
  for (const query of buildIssueSearchQueries(repo, ctx.config, now)) {
    if (found.length >= max) break
    for (const hit of await ctx.github.searchIssues(query, { max, sort: "updated", order: "desc" })) {
      if (transferredTo(repo, hit.number, hit)) continue
      const id = issueId(repo, hit.number)
      if (matched.has(id)) continue
      matched.add(id)
      if (found.length < max) found.push(hit)
    }
  }
  return { found, matched }
}

/** Fetch, filter, score and persist issue candidates for one eligible repo. */
export async function refreshRepoIssues(ctx: AppContext, repo: RepoRecord): Promise<IssueRecord[]> {
  const now = ctx.clock.now()
  const { found, matched } = await searchRepoIssues(ctx, repo.fullName, now)
  const selfLogin = await selfLoginOf(ctx)
  const tasks = tasksByIssue(ctx, repo.fullName)

  const candidates: IssueRecord[] = []
  let skipped = 0
  for (const issue of found) {
    const id = issueId(repo.fullName, issue.number)
    const existing = ctx.store.getIssue(id)
    if (existing && (existing.status === "selected" || existing.status === "done")) continue
    // Rejected by you, aborted/failed task, sticky skip or work in progress: never re-evaluated.
    const prior = priorOutcomeOf(ctx, id, existing, tasks)
    if (prior) {
      if (existing?.status === "candidate") retireCandidate(ctx, existing, prior)
      continue
    }
    try {
      const rec = await evaluateIssue(ctx, repo, issue, selfLogin, now)
      if (rec) candidates.push(rec)
      else skipped++
    } catch (err) {
      if (isFatal(err)) throw err
      ctx.log.warn("issue evaluation failed; skipping it", { repo: repo.fullName, issue: issue.number, error: errorMessage(err) })
    }
  }

  // Earlier candidates that no longer match the search (closed, assigned, linked, stale) are retired.
  for (const old of ctx.store.listIssues({ repo: repo.fullName, status: "candidate" })) {
    if (!matched.has(old.id)) ctx.store.setIssueStatus(old.id, "skipped", "no longer matches the issue search")
  }
  ctx.store.setKv(issueRefreshKey(repo.fullName), now, now)
  ctx.log.info("issue candidates refreshed", { repo: repo.fullName, found: found.length, candidates: candidates.length, skipped })
  return candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.number - b.number)
}

// ---------------------------------------------------------------------------
// selection across repos
// ---------------------------------------------------------------------------

export interface SelectionDeps {
  capsSnapshot: typeof capsSnapshot
  canStartAnyTask: typeof canStartAnyTask
  canStartTaskForRepo: typeof canStartTaskForRepo
  /** Candidate refresh for one repo (default: refreshRepoIssues). */
  refreshRepoIssues: typeof refreshRepoIssues
}

export const defaultSelectionDeps: SelectionDeps = { capsSnapshot, canStartAnyTask, canStartTaskForRepo, refreshRepoIssues }

/** When candidates for the repo were last refreshed (kv marker, else newest stored fetch). */
function lastRefreshAt(ctx: AppContext, repo: string): Millis | null {
  const marker = ctx.store.getKv<number>(issueRefreshKey(repo))
  if (typeof marker === "number") return marker
  const fetched = ctx.store.listIssues({ repo }).map((i) => i.fetchedAt)
  return fetched.length > 0 ? Math.max(...fetched) : null
}

/**
 * Candidates of a repo that may be selected, best first: still "candidate" in the store, above the
 * minimum score, allowed by the repo's issue-first rule, and never worked on before (rejected,
 * aborted/failed task, sticky skip, task in progress; such leftovers are retired here).
 */
function workableCandidates(ctx: AppContext, repo: RepoRecord, list: IssueRecord[]): IssueRecord[] {
  const tasks = tasksByIssue(ctx, repo.fullName)
  const minScore = ctx.config.issues.minScore
  const out: IssueRecord[] = []
  for (const listed of list) {
    const rec = ctx.store.getIssue(listed.id) ?? listed
    if (rec.status !== "candidate" || (rec.score ?? 0) < minScore) continue
    const prior = priorOutcomeOf(ctx, rec.id, rec, tasks)
    if (prior) {
      retireCandidate(ctx, rec, prior)
      continue
    }
    if (issueFirstBlocks(repo, rec.labels)) continue
    out.push(rec)
  }
  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.number - b.number)
}

/** Workable stored candidates when the repo's cache is fresh (no GitHub calls); null when a refresh is due. */
function cachedCandidates(ctx: AppContext, repo: RepoRecord, now: Millis): IssueRecord[] | null {
  const last = lastRefreshAt(ctx, repo.fullName)
  if (last === null || now - last >= CANDIDATE_CACHE_MS) return null
  return workableCandidates(ctx, repo, ctx.store.listIssues({ repo: repo.fullName, status: "candidate" }))
}

/** kv key: the last examination of a repo that cost GitHub calls and yielded nothing ({ at, reason }). */
export function examinedKey(repo: string): string {
  return `selection.lastExamined:${repo.toLowerCase()}`
}

interface ExaminedMarker {
  at: Millis
  reason: string
}

/** Reason the repo is passed over for now (examined recently without result), else null. */
function examineBackoff(ctx: AppContext, repo: string, now: Millis): string | null {
  const m = ctx.store.getKv<ExaminedMarker>(examinedKey(repo))
  if (!m || typeof m.at !== "number" || now - m.at >= EXAMINE_BACKOFF_MS) return null
  return `examined ${Math.max(0, Math.round((now - m.at) / 60_000))} min ago: ${m.reason}`
}

function noteExamined(ctx: AppContext, repo: string, now: Millis, reason: string): void {
  ctx.store.setKv(examinedKey(repo), { at: now, reason: oneLine(reason, 200) } satisfies ExaminedMarker, now)
}

export const ONE_AI_PR_REASON = "repository allows one AI-assisted PR at a time"

/**
 * Repos whose AI policy allows one AI-assisted PR at a time (flag one_ai_pr_at_a_time) are skipped while
 * you have an open PR, a queued PR item or an active contribution task there. Returns the reason or null.
 */
export function oneAiPrAtATimeBlocks(repo: RepoRecord, snap: CapsSnapshot): string | null {
  const ai = repo.policy?.ai
  if (!ai || !hasAiPolicyFlag(ai, "one_ai_pr_at_a_time")) return null
  const k = repo.fullName.toLowerCase()
  const busy = (snap.openPrsByRepo[k] ?? 0) + (snap.queuedByRepo[k] ?? 0) + (snap.activeTasksByRepo[k] ?? 0)
  return busy > 0 ? ONE_AI_PR_REASON : null
}

/** Repos asking for issue-first contributions only accept issues explicitly open to outside PRs. */
function issueFirstBlocks(repo: RepoRecord, labels: string[]): boolean {
  return !!repo.policy?.requiresIssueFirst && anyLabelHas(labels, ISSUE_FIRST_OK_LABELS) === null
}

async function hasOpenPr(ctx: AppContext, login: string, repo: string): Promise<boolean> {
  const prs = await ctx.github.searchIssues(`is:pr is:open author:${login} repo:${repo}`, { max: 1 })
  return prs.length > 0
}

/** Re-fetch a stored candidate and confirm it is still workable. Returns a skip reason or null. */
async function recheckCandidate(ctx: AppContext, repo: RepoRecord, rec: IssueRecord, now: Millis): Promise<{ gh: GhIssue | null; reason: string | null }> {
  let gh: GhIssue
  try {
    gh = await ctx.github.getIssue(repo.fullName, rec.number)
  } catch (err) {
    if (isFatal(err)) throw err
    return { gh: null, reason: `could not re-fetch issue: ${errorMessage(err)}` }
  }
  // A transferred issue comes back (via the followed 301) from another repo, usually with another number.
  const moved = transferredTo(repo.fullName, rec.number, gh)
  if (moved) return { gh: null, reason: `issue transferred to ${moved}` }
  const pre = prefilterIssue(gh, ctx.config, now)
  if (pre) return { gh, reason: pre }
  const labels = labelNames(gh)
  if (repo.policy?.reservesGoodFirstIssues && anyLabelHas(labels, GOOD_FIRST_ISSUE_LABELS)) {
    return { gh, reason: "repo reserves good first issues for new human contributors" }
  }
  if (issueFirstBlocks(repo, labels)) return { gh, reason: "repo requires issue-first and the issue is not marked as open for PRs" }
  return { gh, reason: null }
}

/** Try the best few candidates of one repo; the first that survives a re-fetch is selected. */
async function selectFromRepo(ctx: AppContext, repo: RepoRecord, candidates: IssueRecord[], now: Millis): Promise<IssueRecord | null> {
  for (const cand of candidates.slice(0, MAX_CANDIDATES_TRIED_PER_REPO)) {
    const { gh, reason } = await recheckCandidate(ctx, repo, cand, now)
    if (reason) {
      ctx.store.setIssueStatus(cand.id, "skipped", reason)
      audit(ctx, "scout", "issue.skip", cand.id, "skip", [reason], { repo: repo.fullName, stage: "select" })
      continue
    }
    const selected = { kind: cand.kind, status: "selected" as const, score: cand.score, reasons: cand.reasons, skipReason: null }
    const refreshed: IssueRecord = gh ? toRecord(repo.fullName, gh, now, selected) : { ...cand, ...selected }
    ctx.store.upsertIssue(refreshed, { force: true })
    audit(ctx, "scout", "issue.select", cand.id, "selected", [`score ${(cand.score ?? 0).toFixed(2)}`, ...cand.reasons], {
      repo: repo.fullName,
      kind: refreshed.kind,
      score: cand.score,
      url: refreshed.url,
    })
    return ctx.store.getIssue(cand.id) ?? refreshed
  }
  return null
}

/**
 * selectNextIssue with injectable caps/refresh functions (tests). Repos are visited best score first;
 * the ones ruled out locally cost nothing and are not counted: caps, allow/deny list, a fresh candidate
 * cache with nothing workable, or a fruitless examination (your open PR there, an error) within
 * EXAMINE_BACKOFF_MS. At most MAX_REPOS_PER_SELECTION repos that need GitHub calls are examined, so
 * successive calls move on to lower-ranked repos instead of re-checking the same top ones.
 */
export async function selectNextIssueWith(
  ctx: AppContext,
  overrides: Partial<SelectionDeps> = {},
): Promise<{ repo: RepoRecord; issue: IssueRecord } | null> {
  const deps: SelectionDeps = { ...defaultSelectionDeps, ...overrides }
  const now = ctx.clock.now()
  const snap = deps.capsSnapshot(ctx.store, ctx.config, now)
  const any = deps.canStartAnyTask(snap, ctx.config)
  if (!any.ok) {
    ctx.log.debug("issue selection skipped: caps", { reason: any.reason })
    return null
  }

  const login = await selfLoginOf(ctx)
  if (!login) {
    ctx.log.warn("issue selection skipped: own login unknown, cannot check open PRs")
    return null
  }

  let examined = 0
  for (const repo of ctx.store.listRepos({ status: "eligible", orderBy: "score" })) {
    if (examined >= MAX_REPOS_PER_SELECTION) break
    const cap = deps.canStartTaskForRepo(snap, repo.fullName, ctx.config)
    if (!cap.ok) {
      ctx.log.debug("repo skipped for selection: caps", { repo: repo.fullName, reason: cap.reason })
      continue
    }
    const oneAtATime = oneAiPrAtATimeBlocks(repo, snap)
    if (oneAtATime) {
      ctx.log.debug("repo skipped for selection: AI policy", { repo: repo.fullName, reason: oneAtATime })
      continue
    }
    const allowed = isRepoAllowed(repo.fullName, ctx.config)
    if (!allowed.ok) {
      ctx.log.debug("repo skipped for selection: not allowed", { repo: repo.fullName, reason: allowed.reason })
      continue
    }
    const backoff = examineBackoff(ctx, repo.fullName, now)
    if (backoff) {
      ctx.log.debug("repo skipped for selection: examined recently", { repo: repo.fullName, reason: backoff })
      continue
    }
    // A fresh cache answers locally; only an empty one is skipped for free (a stale one needs a refresh).
    const cached = cachedCandidates(ctx, repo, now)
    if (cached !== null && cached.length === 0) {
      ctx.log.debug("repo skipped for selection: no workable cached candidates", { repo: repo.fullName })
      continue
    }
    examined++
    try {
      if (await hasOpenPr(ctx, login, repo.fullName)) {
        ctx.log.debug("repo skipped for selection: you already have an open PR", { repo: repo.fullName })
        noteExamined(ctx, repo.fullName, now, "you already have an open PR there")
        continue
      }
      const candidates = cached ?? workableCandidates(ctx, repo, await deps.refreshRepoIssues(ctx, repo))
      const issue = await selectFromRepo(ctx, repo, candidates, now)
      if (issue) {
        ctx.store.deleteKv(examinedKey(repo.fullName))
        return { repo, issue }
      }
    } catch (err) {
      if (isFatal(err)) throw err
      ctx.log.warn("issue selection failed for repo", { repo: repo.fullName, error: errorMessage(err) })
      noteExamined(ctx, repo.fullName, now, `error: ${errorMessage(err)}`)
    }
  }
  ctx.log.debug("no suitable issue found", { examined })
  return null
}

/**
 * Pick the best (repo, issue) to work on next across eligible repos, honoring caps
 * (scheduler/caps.ts), cooldowns and your existing open PRs. Marks the issue "selected". null = nothing suitable.
 */
export async function selectNextIssue(ctx: AppContext): Promise<{ repo: RepoRecord; issue: IssueRecord } | null> {
  return selectNextIssueWith(ctx)
}
