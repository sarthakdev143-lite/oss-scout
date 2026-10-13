/**
 * Repo screening: read-only GitHub fetches → metrics + policy + score → persisted RepoRecord + audit.
 * Calls are bounded and stop as soon as a hard skip is certain (repo settings, AI policy, missing CI),
 * so skipped repos cost a handful of requests. Never writes to GitHub.
 */
import { isRepoAllowed } from "../core/allowlist.ts"
import { audit, recordError, type AppContext } from "../core/context.ts"
import type { CommitConvention, Millis, RepoMetrics, RepoPolicy, RepoRecord } from "../core/types.ts"
import { KilledError, RateLimitError, type GitHubApi } from "../github/api.ts"
import type { GhContentEntry, GhPull, GhRepo } from "../github/types.ts"
import { DAY, isoToMs } from "../util/clock.ts"
import { errorMessage } from "../util/log.ts"
import { splitFullName } from "../util/text.ts"
import { computeMetrics, isBotUser, isMaintainerAssociation, isOutsideContributor, repoHardSkips, scoreRepo } from "./health.ts"
import {
  classifyAiPolicy,
  extractRepoPolicy,
  POLICY_DOC_PATHS,
  policyBlocks,
  policyDocKind,
  PR_TEMPLATE_DIRS,
  PR_TEMPLATE_PATHS,
  type PolicyDoc,
  type PolicyDocKind,
} from "./policy.ts"

/** Request bounds per screened repo. */
export const SCREEN_LIMITS = {
  closedPulls: 100,
  openPulls: 100,
  commits: 30,
  commitWindowDays: 90,
  /** Recent outside PRs whose first maintainer response is measured. */
  responseSample: 8,
  commentsPerPr: 20,
  reviewsPerPr: 20,
  /** Policy documents fetched from the repo itself. */
  maxPolicyDocs: 10,
  /** Outside PRs younger than this are not sampled (a missing response would mean nothing yet). */
  minPrAgeMs: DAY,
} as const

/** When a screened repo is looked at again. */
export const RESCREEN = {
  skippedDays: 30,
  /** AI policy prohibits contributions, or the repo is gone. */
  prohibitedDays: 90,
  errorRetryMs: DAY,
} as const

export interface ScreenOutcome {
  record: RepoRecord
  /** Non-null when screening failed (recorded; the repo is retried after RESCREEN.errorRetryMs). */
  error: string | null
}

const VALID_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** Rate limits and the kill switch stop the whole tick; everything else is per-repo. */
export function isFatalScreeningError(err: unknown): boolean {
  return (
    err instanceof RateLimitError ||
    err instanceof KilledError ||
    (err instanceof Error && (err.name === "RateLimitError" || err.name === "KilledError"))
  )
}

function isGoneError(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== "GitHubError") return false
  const status = (err as Error & { status?: unknown }).status
  return status === 404 || status === 451
}

// ---------------------------------------------------------------------------
// Commit convention
// ---------------------------------------------------------------------------

const CONVENTIONAL_SUBJECT = /^[a-z]+(?:\([^)]*\))?!?: \S/

/** Conventional Commits when ≥ 60% of ≥ 5 recent non-merge subjects match `type(scope)!: subject`. */
export function detectCommitConventionFromSubjects(subjects: string[]): CommitConvention {
  const relevant = subjects.map((s) => s.trim()).filter((s) => s.length > 0 && !/^(?:merge|revert)\b/i.test(s))
  if (relevant.length < 5) return "unknown"
  const matching = relevant.filter((s) => CONVENTIONAL_SUBJECT.test(s)).length
  return matching / relevant.length >= 0.6 ? "conventional" : "none"
}

// ---------------------------------------------------------------------------
// Repository layout (root, .github, docs listings)
// ---------------------------------------------------------------------------

/** One entry of the root / .github / docs listings, with its repo-relative path. */
export interface FileRef {
  path: string
  name: string
  type: GhContentEntry["type"]
}

interface Layout {
  /** null when the repository has no content (empty) or the root cannot be listed. */
  root: GhContentEntry[] | null
  files: FileRef[]
}

const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

function findEntry(files: FileRef[], path: string, type?: GhContentEntry["type"]): FileRef | null {
  const lower = path.toLowerCase()
  return files.find((f) => f.path.toLowerCase() === lower && (!type || f.type === type)) ?? null
}

async function readLayout(gh: GitHubApi, repo: string, subdirs: readonly string[]): Promise<Layout> {
  const root = await gh.listDirectory(repo, "")
  if (!root) return { root: null, files: [] }
  const files: FileRef[] = root.map((e) => ({ path: e.name, name: e.name, type: e.type }))
  for (const sub of subdirs) {
    const dir = findEntry(files, sub, "dir")
    if (!dir) continue
    const entries = (await gh.listDirectory(repo, dir.path)) ?? []
    files.push(...entries.map((e) => ({ path: joinPath(dir.path, e.name), name: e.name, type: e.type })))
  }
  return { root, files }
}

const isFileLike = (f: FileRef) => f.type === "file" || f.type === "symlink"

// ---------------------------------------------------------------------------
// CI detection
// ---------------------------------------------------------------------------

const ROOT_CI_MARKERS: Array<{ re: RegExp; type: "file" | "dir"; provider: string }> = [
  { re: /^\.circleci$/i, type: "dir", provider: "circleci" },
  { re: /^\.travis\.ya?ml$/i, type: "file", provider: "travis-ci" },
  { re: /^azure-pipelines\.ya?ml$/i, type: "file", provider: "azure-pipelines" },
  { re: /^\.azure-pipelines$/i, type: "dir", provider: "azure-pipelines" },
  { re: /^jenkinsfile$/i, type: "file", provider: "jenkins" },
  { re: /^\.gitlab-ci\.ya?ml$/i, type: "file", provider: "gitlab-ci" },
  { re: /^\.buildkite$/i, type: "dir", provider: "buildkite" },
  { re: /^\.?appveyor\.ya?ml$/i, type: "file", provider: "appveyor" },
  { re: /^\.drone\.ya?ml$/i, type: "file", provider: "drone" },
  { re: /^\.cirrus\.ya?ml$/i, type: "file", provider: "cirrus-ci" },
]

/** GitHub Actions (workflow YAML present) plus CI config files/dirs found in the root listing. */
async function detectCiProviders(gh: GitHubApi, repo: string, layout: Layout): Promise<string[]> {
  const providers: string[] = []
  const workflows = findEntry(layout.files, ".github/workflows", "dir")
  if (workflows) {
    const entries = (await gh.listDirectory(repo, workflows.path)) ?? []
    if (entries.some((e) => e.type === "file" && /\.ya?ml$/i.test(e.name))) providers.push("github-actions")
  }
  for (const entry of layout.root ?? []) {
    for (const m of ROOT_CI_MARKERS) {
      const typeOk = m.type === "dir" ? entry.type === "dir" : entry.type === "file" || entry.type === "symlink"
      if (typeOk && m.re.test(entry.name) && !providers.includes(m.provider)) providers.push(m.provider)
    }
  }
  return providers
}

// ---------------------------------------------------------------------------
// Policy documents
// ---------------------------------------------------------------------------

const KIND_RANK: Record<PolicyDocKind, number> = {
  ai_policy: 0,
  contributing: 1,
  code_of_conduct: 2,
  agents: 3,
  readme: 4,
  pr_template: 5,
}

/** Paths to fetch: POLICY_DOC_PATHS present in the listings, other AI-policy files, guide variants. */
export function policyDocCandidates(files: FileRef[], max: number = SCREEN_LIMITS.maxPolicyDocs): string[] {
  const out: string[] = []
  const push = (p: string) => {
    if (!out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p)
  }
  const fileList = files.filter(isFileLike)
  for (const p of POLICY_DOC_PATHS) {
    const hit = findEntry(fileList, p)
    if (hit) push(hit.path)
  }
  for (const f of fileList) if (policyDocKind(f.path) === "ai_policy") push(f.path)
  for (const kind of ["contributing", "code_of_conduct"] as const) {
    if (out.some((p) => policyDocKind(p) === kind)) continue
    const variant = fileList.find((f) => policyDocKind(f.path) === kind)
    if (variant) push(variant.path)
  }
  if (!out.some((p) => policyDocKind(p) === "readme")) {
    const readme = fileList.find((f) => !f.path.includes("/") && policyDocKind(f.path) === "readme")
    if (readme) push(readme.path)
  }
  const rank = (p: string) => KIND_RANK[policyDocKind(p) ?? "readme"]
  return out
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map(({ p }) => p)
    .slice(0, max)
}

/** First PR template: the single-file locations, then the first file of a PULL_REQUEST_TEMPLATE/ dir. */
async function findPrTemplate(gh: GitHubApi, repo: string, files: FileRef[], label: (p: string) => string): Promise<PolicyDoc | null> {
  const tried = new Set<string>()
  for (const p of PR_TEMPLATE_PATHS) {
    const hit = findEntry(files.filter(isFileLike), p)
    if (!hit || tried.has(hit.path.toLowerCase())) continue
    tried.add(hit.path.toLowerCase())
    const text = await gh.getFileContent(repo, hit.path)
    if (text !== null && text.trim()) return { path: label(hit.path), text }
  }
  for (const d of PR_TEMPLATE_DIRS) {
    const dir = findEntry(files, d, "dir")
    if (!dir) continue
    const entries = ((await gh.listDirectory(repo, dir.path)) ?? [])
      .filter((e) => e.type === "file" && /\.(?:md|markdown|txt)$/i.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => Number(!/default|pull_request_template/i.test(a)) - Number(!/default|pull_request_template/i.test(b)) || a.localeCompare(b))
    const first = entries[0]
    if (!first) continue
    const path = joinPath(dir.path, first)
    const text = await gh.getFileContent(repo, path)
    if (text !== null && text.trim()) return { path: label(path), text }
  }
  return null
}

/** Fetch `paths` in order; stop early once the documents so far prohibit AI contributions. */
async function fetchPolicyDocs(
  gh: GitHubApi,
  repo: string,
  paths: string[],
  label: (p: string) => string,
  already: PolicyDoc[],
): Promise<PolicyDoc[]> {
  const out: PolicyDoc[] = []
  for (const p of paths) {
    const text = await gh.getFileContent(repo, p)
    if (text === null || !text.trim()) continue
    out.push({ path: label(p), text })
    if (classifyAiPolicy([...already, ...out]).classification === "prohibited") break
  }
  return out
}

interface PolicySources {
  docs: PolicyDoc[]
  prTemplate: PolicyDoc | null
  layout: Layout
}

/**
 * Repo documents plus the owner's `.github` repository defaults: GitHub applies its CONTRIBUTING,
 * CODE_OF_CONDUCT and PR template when the repo has none, and orgs keep AI policies there (always read).
 */
async function gatherPolicySources(gh: GitHubApi, fullName: string): Promise<PolicySources> {
  const layout = await readLayout(gh, fullName, [".github", "docs"])
  const prTemplate = await findPrTemplate(gh, fullName, layout.files, (p) => p)
  const docs = await fetchPolicyDocs(gh, fullName, policyDocCandidates(layout.files), (p) => p, prTemplate ? [prTemplate] : [])
  const found = [...docs, ...(prTemplate ? [prTemplate] : [])]
  if (classifyAiPolicy(found).classification === "prohibited") return { docs, prTemplate, layout }

  const { owner, name } = splitFullName(fullName)
  if (name.toLowerCase() === ".github") return { docs, prTemplate, layout }
  const orgRepo = `${owner}/.github`
  const org = await readLayout(gh, orgRepo, [".github"])
  if (!org.root) return { docs, prTemplate, layout }

  const label = (p: string) => `${orgRepo}/${p}`
  const has = (kind: PolicyDocKind) => docs.some((d) => policyDocKind(d.path) === kind)
  const orgPaths = policyDocCandidates(org.files).filter((p) => {
    const kind = policyDocKind(p)
    return kind === "ai_policy" || (kind === "contributing" && !has("contributing")) || (kind === "code_of_conduct" && !has("code_of_conduct"))
  })
  const orgDocs = await fetchPolicyDocs(gh, orgRepo, orgPaths, label, found)
  const orgTemplate = prTemplate ?? (await findPrTemplate(gh, orgRepo, org.files, label))
  return { docs: [...docs, ...orgDocs], prTemplate: orgTemplate, layout }
}

// ---------------------------------------------------------------------------
// First maintainer responses
// ---------------------------------------------------------------------------

/**
 * For up to SCREEN_LIMITS.responseSample recent outside PRs (open or closed, not drafts, at least a day
 * old): the first comment/review by a non-author maintainer, or the merge. Closed-unmerged PRs without
 * a visible maintainer response are left out (they may have been withdrawn by their author).
 */
async function sampleFirstResponses(
  gh: GitHubApi,
  fullName: string,
  pulls: GhPull[],
  now: Millis,
): Promise<Array<{ openedAt: string; firstResponseAt: string | null }>> {
  const seen = new Set<number>()
  const sample = pulls
    .filter((p) => {
      if (seen.has(p.number)) return false
      seen.add(p.number)
      const created = isoToMs(p.created_at)
      return !p.draft && isOutsideContributor(p.author_association, p.user) && created !== null && created <= now - SCREEN_LIMITS.minPrAgeMs
    })
    .sort((a, b) => (isoToMs(b.created_at) ?? 0) - (isoToMs(a.created_at) ?? 0))
    .slice(0, SCREEN_LIMITS.responseSample)

  const out: Array<{ openedAt: string; firstResponseAt: string | null }> = []
  for (const pr of sample) {
    const author = pr.user?.login.toLowerCase() ?? null
    const byMaintainer = (assoc: string | undefined, user: GhPull["user"]) =>
      isMaintainerAssociation(assoc) && !!user && !isBotUser(user) && user.login.toLowerCase() !== author
    const comments = await gh.listIssueComments(fullName, pr.number, { max: SCREEN_LIMITS.commentsPerPr, perPage: SCREEN_LIMITS.commentsPerPr })
    const reviews = await gh.listPullReviews(fullName, pr.number, { max: SCREEN_LIMITS.reviewsPerPr, perPage: SCREEN_LIMITS.reviewsPerPr })
    const times = [
      ...comments.filter((c) => byMaintainer(c.author_association, c.user)).map((c) => c.created_at),
      ...reviews.filter((r) => r.state !== "PENDING" && byMaintainer(r.author_association, r.user)).map((r) => r.submitted_at ?? null),
      pr.merged_at,
    ]
      .map((t) => ({ t, ms: isoToMs(t) }))
      .filter((x): x is { t: string; ms: number } => x.ms !== null)
      .sort((a, b) => a.ms - b.ms)
    const first = times[0]?.t ?? null
    if (first === null && pr.state === "closed") continue
    out.push({ openedAt: pr.created_at, firstResponseAt: first })
  }
  return out
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

interface Verdict {
  status: "eligible" | "skipped"
  score: number | null
  reasons: string[]
  skipReason: string | null
  policy: RepoPolicy | null
  metrics: RepoMetrics | null
}

function newRecord(fullName: string, now: Millis): RepoRecord {
  return {
    fullName,
    source: "manual",
    sourceDetail: null,
    status: "candidate",
    score: null,
    reasons: [],
    skipReason: null,
    policy: null,
    metrics: null,
    discoveredAt: now,
    screenedAt: null,
    nextScreenAt: now,
  }
}

function skip(reason: string, extra: Partial<Verdict> = {}): Verdict {
  return { status: "skipped", score: null, reasons: [`skip: ${reason}`], skipReason: reason, policy: null, metrics: null, ...extra }
}

/** Persist the verdict and audit it as "repo.screen" (decision eligible/skip). */
function conclude(ctx: AppContext, base: RepoRecord, v: Verdict, now: Millis, rescreenMs: number): RepoRecord {
  const record: RepoRecord = { ...base, ...v, screenedAt: now, nextScreenAt: now + rescreenMs }
  ctx.store.saveRepo(record)
  const eligible = v.status === "eligible"
  const reasons = eligible ? v.reasons : [v.skipReason ?? "skipped", ...v.reasons.filter((r) => r !== `skip: ${v.skipReason}`)]
  audit(ctx, "scout", "repo.screen", record.fullName, eligible ? "eligible" : "skip", reasons, {
    source: record.source,
    score: record.score,
    skipReason: record.skipReason,
    aiPolicy: record.policy?.ai.classification ?? null,
    aiEvidence: record.policy?.ai.evidence.slice(0, 3) ?? [],
    metrics: record.metrics
      ? {
          stars: record.metrics.stars,
          outsideMergeRate: record.metrics.outsideMergeRate,
          outsidePrSample: record.metrics.outsidePrSample,
          medianFirstResponseHours: record.metrics.medianFirstResponseHours,
          lastMaintainerActivityAt: record.metrics.lastMaintainerActivityAt,
          ciProviders: record.metrics.ciProviders,
        }
      : null,
    nextScreenAt: record.nextScreenAt,
  })
  ctx.log.info(`screened ${record.fullName}: ${eligible ? "eligible" : "skipped"}`, {
    repo: record.fullName,
    score: record.score,
    skipReason: record.skipReason,
  })
  return record
}

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

async function screenFromGitHub(ctx: AppContext, base: RepoRecord, now: Millis): Promise<RepoRecord> {
  const gh = ctx.github
  const s = ctx.config.screening
  const skipDays = RESCREEN.skippedDays * DAY

  let repo: GhRepo
  try {
    repo = await gh.getRepo(base.fullName)
  } catch (err) {
    if (!isGoneError(err)) throw err
    return conclude(ctx, base, skip("repository not found or not accessible"), now, RESCREEN.prohibitedDays * DAY)
  }

  // Renamed/transferred: track the new name as its own candidate.
  if (repo.full_name.toLowerCase() !== base.fullName.toLowerCase()) {
    ctx.store.upsertRepoCandidate({ fullName: repo.full_name, source: base.source, sourceDetail: `moved from ${base.fullName}` }, now)
    return conclude(ctx, base, skip(`repository moved to ${repo.full_name}`), now, RESCREEN.prohibitedDays * DAY)
  }
  const fullName = repo.full_name

  // 1. Repo settings / stars / license: decidable from the repo object alone.
  const repoOnly = (ciProviders: string[] = []) =>
    computeMetrics({ repo, closedPulls: [], openPulls: [], firstResponses: [], recentCommits: [], ciProviders, now })
  const settingsSkips = repoHardSkips(repoOnly(), s)
  if (settingsSkips.length > 0) {
    const v = skip(settingsSkips[0]!, { metrics: repoOnly(), reasons: settingsSkips.map((r) => `skip: ${r}`) })
    return conclude(ctx, base, v, now, skipDays)
  }

  // 2. Contribution / AI policy.
  const sources = await gatherPolicySources(gh, fullName)
  const preliminary = extractRepoPolicy({ docs: sources.docs, prTemplate: sources.prTemplate, repo, commitConvention: "unknown" })
  const aiBlock = policyBlocks(preliminary.ai, s.skipUnclearRestrictivePolicy)
  if (aiBlock) {
    const days = preliminary.ai.classification === "prohibited" ? RESCREEN.prohibitedDays : RESCREEN.skippedDays
    return conclude(ctx, base, skip(aiBlock, { policy: preliminary, metrics: repoOnly() }), now, days * DAY)
  }

  // 3. CI.
  const ciProviders = await detectCiProviders(gh, fullName, sources.layout)
  if (s.requireCi && ciProviders.length === 0) {
    return conclude(ctx, base, skip("no CI configuration detected", { policy: preliminary, metrics: repoOnly() }), now, skipDays)
  }

  // 4. Activity, merge rate, responsiveness.
  const closedPulls = await gh.listPulls(fullName, {
    state: "closed",
    sort: "updated",
    direction: "desc",
    max: SCREEN_LIMITS.closedPulls,
    perPage: SCREEN_LIMITS.closedPulls,
  })
  const openPulls = await gh.listPulls(fullName, {
    state: "open",
    sort: "created",
    direction: "desc",
    max: SCREEN_LIMITS.openPulls,
    perPage: SCREEN_LIMITS.openPulls,
  })
  const recentCommits = await gh.listCommits(fullName, {
    since: new Date(now - SCREEN_LIMITS.commitWindowDays * DAY).toISOString(),
    max: SCREEN_LIMITS.commits,
    perPage: SCREEN_LIMITS.commits,
  })
  const firstResponses = await sampleFirstResponses(gh, fullName, [...openPulls, ...closedPulls], now)

  const commitConvention = detectCommitConventionFromSubjects(recentCommits.map((c) => c.commit.message.split("\n")[0] ?? ""))
  const policy = extractRepoPolicy({ docs: sources.docs, prTemplate: sources.prTemplate, repo, commitConvention })
  const metrics = computeMetrics({ repo, closedPulls, openPulls, firstResponses, recentCommits, ciProviders, now })
  const scored = scoreRepo(metrics, policy, ctx.config, now)

  if (scored.hardSkip) {
    const verdict: Verdict = { status: "skipped", score: scored.score, reasons: scored.reasons, skipReason: scored.hardSkip, policy, metrics }
    const days = policy.ai.classification === "prohibited" ? RESCREEN.prohibitedDays : RESCREEN.skippedDays
    return conclude(ctx, base, verdict, now, days * DAY)
  }
  const verdict: Verdict = { status: "eligible", score: scored.score, reasons: scored.reasons, skipReason: null, policy, metrics }
  return conclude(ctx, base, verdict, now, s.rescreenAfterDays * DAY)
}

/**
 * Screen one repo and report failures instead of throwing them. Rate limits and the kill switch
 * propagate; any other error is recorded and the repo keeps its status, retried after a day.
 */
export async function screenRepoOutcome(ctx: AppContext, fullName: string): Promise<ScreenOutcome> {
  const now = ctx.clock.now()
  const base = ctx.store.getRepo(fullName) ?? newRecord(fullName, now)

  if (!VALID_FULL_NAME.test(fullName)) {
    return { record: conclude(ctx, base, skip(`invalid repository name "${fullName}"`), now, RESCREEN.prohibitedDays * DAY), error: null }
  }
  const allowed = isRepoAllowed(fullName, ctx.config)
  if (!allowed.ok) {
    const v = skip(allowed.reason ?? "not allowed by config", { policy: base.policy, metrics: base.metrics })
    return { record: conclude(ctx, base, v, now, RESCREEN.skippedDays * DAY), error: null }
  }

  try {
    return { record: await screenFromGitHub(ctx, base, now), error: null }
  } catch (err) {
    if (isFatalScreeningError(err)) throw err
    const message = errorMessage(err)
    recordError(ctx, "screening", `screening ${fullName} failed: ${message}`, { repo: fullName })
    const record: RepoRecord = { ...base, nextScreenAt: now + RESCREEN.errorRetryMs }
    ctx.store.saveRepo(record)
    audit(ctx, "scout", "repo.screen", fullName, "error", [message], { status: record.status })
    return { record, error: message }
  }
}

/** Fetch everything needed, compute metrics + policy + score, persist the RepoRecord and audit the decision. */
export async function screenRepo(ctx: AppContext, fullName: string): Promise<RepoRecord> {
  return (await screenRepoOutcome(ctx, fullName)).record
}

/** Repos due for screening: new candidates first (oldest discovered first), then stale eligible, then stale skipped. */
export function dueRepos(ctx: Pick<AppContext, "store">, now: Millis, limit: number): RepoRecord[] {
  const out = ctx.store.listRepos({ status: "candidate", dueForScreenAt: now, limit })
  const byNext = (a: RepoRecord, b: RepoRecord) => (a.nextScreenAt ?? 0) - (b.nextScreenAt ?? 0) || a.fullName.localeCompare(b.fullName)
  for (const status of ["eligible", "skipped"] as const) {
    if (out.length >= limit) break
    const due = ctx.store.listRepos({ status, dueForScreenAt: now }).sort(byNext)
    out.push(...due.slice(0, limit - out.length))
  }
  return out.slice(0, limit)
}

/** Screen up to config.screening.maxPerTick repos that are due (new candidates first, then stale re-screens). */
export async function runScreening(ctx: AppContext): Promise<{ screened: RepoRecord[]; errors: string[] }> {
  const screened: RepoRecord[] = []
  const errors: string[] = []
  for (const repo of dueRepos(ctx, ctx.clock.now(), ctx.config.screening.maxPerTick)) {
    if (ctx.kill.isEngaged()) throw new KilledError()
    const outcome = await screenRepoOutcome(ctx, repo.fullName)
    if (outcome.error) errors.push(`${repo.fullName}: ${outcome.error}`)
    else screened.push(outcome.record)
  }
  return { screened, errors }
}
