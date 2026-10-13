/**
 * Repository health: metrics from GitHub data (maintainer activity, outside-contributor merge rate,
 * first-response time, CI, stale PR backlog) and a deterministic weighted score with hard skips.
 */
import type { OssScoutConfig } from "../config/schema.ts"
import type { Millis, RepoMetrics, RepoPolicy, ScoreResult } from "../core/types.ts"
import type { GhCommit, GhPull, GhRepo, GhUser } from "../github/types.ts"
import { DAY, HOUR, isoToMs } from "../util/clock.ts"
import { clamp01, median } from "../util/text.ts"
import { policyBlocks } from "./policy.ts"

export interface HealthInputs {
  repo: GhRepo
  /** Recently closed PRs (merged or not), newest first. */
  closedPulls: GhPull[]
  openPulls: GhPull[]
  /** For a sample of recent outside PRs: when opened, and when a maintainer first responded (null = never). */
  firstResponses: Array<{ openedAt: string; firstResponseAt: string | null }>
  recentCommits: GhCommit[]
  /** CI providers detected from repo files (e.g. "github-actions", "circleci"). */
  ciProviders: string[]
  now: Millis
}

/** Open PRs without an update for this long count as stale. */
export const STALE_PR_DAYS = 90

/** Score weights (sum to 1). */
export const SCORE_WEIGHTS = {
  activity: 0.25,
  mergeRate: 0.25,
  responseTime: 0.2,
  ci: 0.1,
  staleBacklog: 0.1,
  contributingGuide: 0.05,
  prTemplate: 0.03,
  popularity: 0.02,
} as const

const OUTSIDE_ASSOCIATIONS = new Set(["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN"])
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])

/** Machine-account logins that are plain "User" accounts: "renovate-bot", "k8s-ci-robot", "my_bot". */
const BOT_LOGIN = /(?:^|[-_])(?:ro)?bot$/i
/** Well-known automation identities (git author/committer names). */
const BOT_NAME = /^(?:dependabot|renovate|greenkeeper|github-actions|pre-commit-ci|semantic-release-bot|snyk-bot|allcontributors|imgbot|depfu|pyup-bot|mergify)\b/i

/** GitHub App / bot account ("Bot" type, a login ending in "[bot]", or a "-bot"/"-robot" machine account). */
export function isBotUser(user: GhUser | null | undefined): boolean {
  return !!user && (user.type === "Bot" || /\[bot\]$/i.test(user.login) || BOT_LOGIN.test(user.login))
}

/** A git author/committer identity that belongs to automation (Dependabot, Renovate, GitHub Actions, …). */
export function isBotGitIdentity(id: { name?: string; email?: string } | null | undefined): boolean {
  if (!id) return false
  const name = (id.name ?? "").trim()
  const email = (id.email ?? "").trim()
  return (
    /\[bot\]$/i.test(name) ||
    BOT_LOGIN.test(name) ||
    BOT_NAME.test(name) ||
    /\[bot\]@users\.noreply\.github\.com$/i.test(email) ||
    /^actions?@github\.com$/i.test(email)
  )
}

/**
 * When a human last acted through this commit: null for bot-authored commits (Dependabot, Renovate,
 * workflow commits). A human commit landed by automation (merge queue, backport bot) counts at its
 * author date, otherwise at its commit date (when it reached the default branch).
 */
export function humanCommitAt(c: GhCommit): string | null {
  if (isBotUser(c.author) || isBotGitIdentity(c.commit.author)) return null
  const botCommitter = isBotUser(c.committer) || isBotGitIdentity(c.commit.committer)
  if (botCommitter) return c.commit.author?.date ?? null
  return c.commit.committer?.date ?? c.commit.author?.date ?? null
}

/** author_association + user type → is this an outside (non-maintainer, non-bot) contributor? */
export function isOutsideContributor(association: string | undefined, user: GhUser | null): boolean {
  if (!user || isBotUser(user)) return false
  return OUTSIDE_ASSOCIATIONS.has((association ?? "").toUpperCase())
}

/** OWNER / MEMBER / COLLABORATOR. */
export function isMaintainerAssociation(association: string | undefined): boolean {
  return MAINTAINER_ASSOCIATIONS.has((association ?? "").toUpperCase())
}

function normalizeLicense(spdx: string | null | undefined): string | null {
  if (!spdx) return null
  const v = spdx.trim()
  return v === "" || v.toUpperCase() === "NOASSERTION" ? null : v
}

function latestIso(values: Array<string | null | undefined>): string | null {
  let best: number | null = null
  for (const v of values) {
    const ms = isoToMs(v)
    if (ms !== null && (best === null || ms > best)) best = ms
  }
  return best === null ? null : new Date(best).toISOString()
}

/**
 * Pure metrics. First responses that never happened count with the PR's age so far (a lower bound),
 * so silent repos are not rewarded for having no data.
 */
export function computeMetrics(input: HealthInputs): RepoMetrics {
  const { repo, closedPulls, openPulls, firstResponses, recentCommits, now } = input

  const outsideClosed = closedPulls.filter((p) => isOutsideContributor(p.author_association, p.user))
  const outsidePrSample = outsideClosed.length
  const outsidePrMerged = outsideClosed.filter((p) => !!p.merged_at).length

  const responseHours: number[] = []
  for (const r of firstResponses) {
    const opened = isoToMs(r.openedAt)
    if (opened === null) continue
    const responded = isoToMs(r.firstResponseAt)
    const end = responded ?? now
    responseHours.push(Math.max(0, end - opened) / HOUR)
  }
  const med = median(responseHours)

  const staleBefore = now - STALE_PR_DAYS * DAY
  const staleOpenPrCount = openPulls.filter((p) => {
    const updated = isoToMs(p.updated_at) ?? isoToMs(p.created_at)
    return updated !== null && updated <= staleBefore
  }).length

  // Human maintainer activity only. repo.pushed_at is deliberately left out: it moves on pushes to any
  // branch, including Dependabot/Renovate branches and scheduled workflow commits, so a dead repo with
  // bots enabled would look active. Bot-authored PR merges (often auto-merged) and bot commits are
  // ignored too.
  const lastMaintainerActivityAt = latestIso([
    ...closedPulls.filter((p) => !isBotUser(p.user)).map((p) => p.merged_at),
    ...recentCommits.map(humanCommitAt),
    ...firstResponses.map((r) => r.firstResponseAt),
  ])

  const ciProviders = [...new Set(input.ciProviders.filter((p) => p.trim().length > 0))].sort()

  return {
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    archived: repo.archived === true,
    disabled: repo.disabled === true,
    isFork: repo.fork === true,
    license: normalizeLicense(repo.license?.spdx_id),
    defaultBranch: repo.default_branch,
    language: repo.language,
    topics: repo.topics ?? [],
    pushedAt: repo.pushed_at,
    hasIssues: repo.has_issues !== false,
    pullRequestsEnabled: repo.has_pull_requests !== false,
    prCreationPolicy: repo.pull_request_creation_policy ?? null,
    allowForking: repo.allow_forking !== false,
    webCommitSignoffRequired: repo.web_commit_signoff_required === true,
    lastMaintainerActivityAt,
    outsidePrSample,
    outsidePrMerged,
    outsideMergeRate: outsidePrSample > 0 ? outsidePrMerged / outsidePrSample : null,
    medianFirstResponseHours: med === null ? null : Math.round(med * 10) / 10,
    firstResponseSample: responseHours.length,
    openPrCount: openPulls.length,
    staleOpenPrCount,
    hasCi: ciProviders.length > 0,
    ciProviders,
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

type Screening = OssScoutConfig["screening"]

const pct = (v: number) => `${Math.round(v * 100)}%`

function fmtDays(days: number): string {
  if (days < 1) return "less than a day ago"
  const d = Math.floor(days)
  return `${d} day${d === 1 ? "" : "s"} ago`
}

function fmtHours(h: number): string {
  if (h < 48) return `${Math.round(h)}h`
  return `${Math.round(h / 24)} days`
}

function fmtStars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function dateOnly(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "never"
}

/** Repository settings that make a contribution impossible (archived, PRs off, no forking…). */
function structuralSkips(m: RepoMetrics): string[] {
  const out: string[] = []
  if (m.archived) out.push("repository is archived")
  if (m.disabled) out.push("repository is disabled")
  if (m.isFork) out.push("repository is a fork")
  if (!m.pullRequestsEnabled) out.push("pull requests are disabled")
  if (m.prCreationPolicy === "collaborators_only") out.push("pull requests are restricted to collaborators")
  if (!m.allowForking) out.push("forking is disabled")
  return out
}

/** Configured popularity / license filters. */
function filterSkips(m: RepoMetrics, screening: Screening): string[] {
  const out: string[] = []
  if (m.stars < screening.minStars) out.push(`stars ${m.stars} below minimum ${screening.minStars}`)
  if (screening.maxStars !== null && m.stars > screening.maxStars) out.push(`stars ${m.stars} above maximum ${screening.maxStars}`)
  if (m.license === null) {
    if (screening.requireLicense) out.push("no recognized license")
  } else if (
    screening.allowedLicenses.length > 0 &&
    !screening.allowedLicenses.some((l) => l.toLowerCase() === m.license!.toLowerCase())
  ) {
    out.push(`license ${m.license} not in allowedLicenses`)
  }
  return out
}

/**
 * Hard skips decidable from the repository object alone (archived, PR settings, forking, stars,
 * license), in priority order. Lets the screener stop before fetching anything else.
 */
export function repoHardSkips(m: RepoMetrics, screening: Screening): string[] {
  return [...structuralSkips(m), ...filterSkips(m, screening)]
}

function daysSinceActivity(m: RepoMetrics, now: Millis): number | null {
  const last = isoToMs(m.lastMaintainerActivityAt)
  return last === null ? null : Math.max(0, (now - last) / DAY)
}

/** All hard-skip reasons in priority order (empty = none). Score-based skip not included. */
export function hardSkipReasons(m: RepoMetrics, policy: RepoPolicy, config: OssScoutConfig, now: Millis): string[] {
  const s = config.screening
  // structural reasons first, then the AI policy, then the configured filters
  const out = structuralSkips(m)
  const ai = policyBlocks(policy.ai, s.skipUnclearRestrictivePolicy)
  if (ai) out.push(ai)
  out.push(...filterSkips(m, s))
  if (s.requireCi && !m.hasCi) out.push("no CI configuration detected")
  const days = daysSinceActivity(m, now)
  if (days === null) out.push("no maintainer activity found")
  else if (days > s.maxDaysSinceMaintainerActivity) {
    out.push(`no maintainer activity in ${s.maxDaysSinceMaintainerActivity} days (last ${dateOnly(m.lastMaintainerActivityAt)})`)
  }
  if (m.outsideMergeRate !== null && m.outsidePrSample >= s.minMergeRateSample && m.outsideMergeRate < s.minOutsideMergeRate) {
    out.push(`outside PR merge rate ${pct(m.outsideMergeRate)} (n=${m.outsidePrSample}) below minimum ${pct(s.minOutsideMergeRate)}`)
  }
  return out
}

interface Component {
  weight: number
  value: number
  reason: string
}

/** Score credit for a recent push when no human activity was found (pushes may be bots). */
const PUSH_ONLY_ACTIVITY_VALUE = 0.1

function activityComponent(m: RepoMetrics, s: Screening, now: Millis): Component {
  const days = daysSinceActivity(m, now)
  if (days === null) {
    // Weak fallback for the score only; the hard skip ignores pushes (see hardSkipReasons).
    const pushed = isoToMs(m.pushedAt)
    if (pushed !== null && now - pushed <= s.maxDaysSinceMaintainerActivity * DAY) {
      const ago = fmtDays(Math.max(0, (now - pushed) / DAY))
      return {
        weight: SCORE_WEIGHTS.activity,
        value: PUSH_ONLY_ACTIVITY_VALUE,
        reason: `- no human maintainer activity found (last push ${ago}, possibly automated)`,
      }
    }
    return { weight: SCORE_WEIGHTS.activity, value: 0, reason: "- no maintainer activity found" }
  }
  // full marks within ~2 days, linear decay to 0 at maxDaysSinceMaintainerActivity (+2)
  const value = clamp01(1 - Math.max(0, days - 2) / s.maxDaysSinceMaintainerActivity)
  return { weight: SCORE_WEIGHTS.activity, value, reason: `${value >= 0.5 ? "+" : "-"} last maintainer activity ${fmtDays(days)}` }
}

function mergeRateComponent(m: RepoMetrics): Component {
  const n = m.outsidePrSample
  if (n === 0 || m.outsideMergeRate === null) {
    return { weight: SCORE_WEIGHTS.mergeRate, value: 0.5, reason: "~ no closed outside-contributor PRs sampled" }
  }
  // shrink small samples toward 50% (prior of 4 PRs), full marks at >= 70%
  const k = 4
  const shrunk = (m.outsidePrMerged + 0.5 * k) / (n + k)
  const value = clamp01(shrunk / 0.7)
  const rate = m.outsideMergeRate
  return { weight: SCORE_WEIGHTS.mergeRate, value, reason: `${rate >= 0.5 ? "+" : "-"} outside PR merge rate ${pct(rate)} (n=${n})` }
}

function responseComponent(m: RepoMetrics, s: Screening): Component {
  const h = m.medianFirstResponseHours
  if (h === null) return { weight: SCORE_WEIGHTS.responseTime, value: 0.5, reason: "~ no first-response data" }
  const maxH = Math.max(24, s.maxMedianFirstResponseDays * 24)
  let value: number
  if (h <= 24) value = 1
  else if (h <= maxH) value = 1 - (0.5 * (h - 24)) / Math.max(1, maxH - 24)
  else value = clamp01(0.5 - (0.5 * (h - maxH)) / maxH)
  const over = h > maxH
  const reason = `${over ? "-" : "+"} median first maintainer response ${fmtHours(h)} (n=${m.firstResponseSample})${
    over ? `, above ${s.maxMedianFirstResponseDays} days` : ""
  }`
  return { weight: SCORE_WEIGHTS.responseTime, value, reason }
}

function ciComponent(m: RepoMetrics): Component {
  return m.hasCi
    ? { weight: SCORE_WEIGHTS.ci, value: 1, reason: `+ CI: ${m.ciProviders.join(", ")}` }
    : { weight: SCORE_WEIGHTS.ci, value: 0, reason: "- no CI detected" }
}

function staleComponent(m: RepoMetrics): Component {
  if (m.openPrCount === 0) return { weight: SCORE_WEIGHTS.staleBacklog, value: 1, reason: "+ no open PR backlog" }
  const ratio = m.staleOpenPrCount / m.openPrCount
  const value = clamp01(1 - ratio * 1.5)
  return {
    weight: SCORE_WEIGHTS.staleBacklog,
    value,
    reason: `${ratio <= 0.25 ? "+" : "-"} ${pct(ratio)} of open PRs stale for ${STALE_PR_DAYS}+ days (${m.staleOpenPrCount}/${m.openPrCount})`,
  }
}

function policyComponents(policy: RepoPolicy): Component[] {
  return [
    policy.contributingFile
      ? { weight: SCORE_WEIGHTS.contributingGuide, value: 1, reason: `+ contributing guide: ${policy.contributingFile}` }
      : { weight: SCORE_WEIGHTS.contributingGuide, value: 0, reason: "- no contributing guide" },
    policy.prTemplatePath
      ? { weight: SCORE_WEIGHTS.prTemplate, value: 1, reason: `+ PR template: ${policy.prTemplatePath}` }
      : { weight: SCORE_WEIGHTS.prTemplate, value: 0, reason: "~ no PR template" },
  ]
}

function popularityComponent(m: RepoMetrics): Component {
  const value = clamp01(Math.log10(Math.max(1, m.stars)) / 5)
  return { weight: SCORE_WEIGHTS.popularity, value, reason: `~ ${fmtStars(m.stars)} stars` }
}

const AI_LABEL: Record<RepoPolicy["ai"]["classification"], string> = {
  prohibited: "- AI policy: AI contributions prohibited",
  restricted: "- AI policy: AI contributions restricted",
  unclear_restrictive: "~ AI policy: unclear, restrictive tone",
  disclosure_required: "+ AI policy: allowed with disclosure",
  allowed: "+ AI policy: AI assistance allowed",
  none_found: "~ AI policy: none found (disclosure is always included)",
}

/** Informational reasons that do not change the score. */
function infoReasons(policy: RepoPolicy): string[] {
  const out = [AI_LABEL[policy.ai.classification]]
  if (policy.requiresCla) out.push("~ CLA required (you must sign it yourself)")
  if (policy.requiresSignoff) out.push("~ DCO sign-off required")
  if (policy.requiresIssueFirst) out.push("~ guide asks to discuss an issue / get assigned before a PR")
  if (policy.reservesGoodFirstIssues) out.push("~ good first issues reserved for newcomers (they are skipped)")
  return out
}

/** Weighted 0..1 score with human-readable reasons, plus hard-skip reasons. Pure and deterministic. */
export function scoreRepo(metrics: RepoMetrics, policy: RepoPolicy, config: OssScoutConfig, now: Millis): ScoreResult {
  const s = config.screening
  const components: Component[] = [
    activityComponent(metrics, s, now),
    mergeRateComponent(metrics),
    responseComponent(metrics, s),
    ciComponent(metrics),
    staleComponent(metrics),
    ...policyComponents(policy),
    popularityComponent(metrics),
  ]
  const raw = components.reduce((sum, c) => sum + c.weight * clamp01(c.value), 0)
  const score = Math.round(clamp01(raw) * 1000) / 1000

  const hard = hardSkipReasons(metrics, policy, config, now)
  if (hard.length === 0 && score < s.minScore) hard.push(`score ${score.toFixed(2)} below minimum ${s.minScore.toFixed(2)}`)

  const reasons = [...hard.map((h) => `skip: ${h}`), ...components.map((c) => c.reason), ...infoReasons(policy)]
  return { score, reasons, hardSkip: hard[0] ?? null }
}
