/**
 * Discovery: finds candidate repos from (1) the dependencies declared in your own repos'
 * manifests, mapped to GitHub through package registries, and (2) repository searches built
 * from `config.interests`. Read-only on GitHub; candidates are persisted and every decision is
 * audited. Screening happens later (src/screening).
 */
import { isRepoAllowed } from "../core/allowlist.ts"
import type { AppContext } from "../core/context.ts"
import { audit, recordError } from "../core/context.ts"
import type { OssScoutConfig } from "../config/schema.ts"
import type { Millis, RepoSource } from "../core/types.ts"
import { GitHubError, KilledError, RateLimitError } from "../github/api.ts"
import type { GhRepo, GhTreeEntry } from "../github/types.ts"
import { DAY, HOUR, utcDay } from "../util/clock.ts"
import { errorMessage } from "../util/log.ts"
import { declaredPackageName, isManifestPath, parseManifest, type DependencyRef } from "./manifests.ts"
import { createRegistryResolver, type RegistryResolver } from "./registries.ts"

export interface DiscoveryReport {
  added: string[]
  existing: number
  skipped: Array<{ repo: string; reason: string }>
  errors: string[]
}

export interface DiscoveryOptions {
  /** Registry resolver override (tests). Default: createRegistryResolver over ctx.fetch. */
  resolver?: RegistryResolver
}

/** kv key holding the summary of the last completed discovery pass. */
export const DISCOVERY_LAST_RUN_KEY = "discovery.lastRun"

export interface DiscoveryLastRun {
  at: Millis
  added: number
  existing: number
  skipped: number
  errors: number
}

/** Manifests deeper than this many directories are ignored. */
export const MAX_MANIFEST_DEPTH = 3
export const MAX_MANIFESTS_PER_REPO = 25
export const MAX_MANIFEST_BYTES = 1_000_000
export const MAX_SEARCH_QUERIES = 12
const GOOD_FIRST_ISSUES_MIN = 2
const HELP_WANTED_ISSUES_MIN = 2
const RESOLVE_CONCURRENCY = 4
const RESOLVE_BATCH = 16

/** Directories whose manifests are vendored, generated, environments, fixtures or examples. */
const SKIPPED_DIRS = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
  "vendor",
  "third_party",
  "third-party",
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "venv",
  ".tox",
  ".nox",
  "__pycache__",
  "site-packages",
  ".git",
  ".yarn",
  ".pnpm-store",
  ".next",
  ".nuxt",
  ".gradle",
  ".mvn",
  "fixtures",
  "__fixtures__",
  "test-fixtures",
  "test_fixtures",
  "testdata",
  "__mocks__",
  "example",
  "examples",
])

const VALID_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Manifest paths worth reading from a repo tree: depth ≤ 3, outside vendored/generated/fixture dirs, shallow first. */
export function selectManifestPaths(tree: readonly GhTreeEntry[], max = MAX_MANIFESTS_PER_REPO): string[] {
  return tree
    .filter((e) => e.type === "blob" && (e.size === undefined || e.size <= MAX_MANIFEST_BYTES))
    .map((e) => e.path.replace(/\\/g, "/"))
    .filter((path) => {
      const parts = path.split("/")
      if (parts.length - 1 > MAX_MANIFEST_DEPTH) return false
      if (parts.slice(0, -1).some((dir) => SKIPPED_DIRS.has(dir.toLowerCase()))) return false
      return isManifestPath(path)
    })
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, max)
}

/** Why a repository-search result is not a candidate, or null when it is. */
export function searchSkipReason(repo: GhRepo, config: Pick<OssScoutConfig, "screening">): string | null {
  const { minStars, maxStars } = config.screening
  if (repo.archived) return "archived"
  if (repo.disabled) return "disabled"
  if (repo.fork) return "fork"
  if (repo.private) return "private repository"
  if (repo.stargazers_count < minStars) return `stars ${repo.stargazers_count} < minStars ${minStars}`
  if (maxStars !== null && repo.stargazers_count > maxStars) return `stars ${repo.stargazers_count} > maxStars ${maxStars}`
  if (!repo.has_issues) return "issues disabled"
  if (repo.has_pull_requests === false) return "pull requests disabled"
  if (repo.pull_request_creation_policy === "collaborators_only") return "pull requests limited to collaborators"
  return null
}

/** Sort order used for a query built by buildRepoSearchQueries. */
export function searchSortFor(query: string): "help-wanted-issues" | "updated" {
  return query.includes("help-wanted-issues:") ? "help-wanted-issues" : "updated"
}

const JS = ["typescript", "javascript"]
const PY = ["python"]
const JVM = ["java", "kotlin"]
/** Languages a well-known topic implies, so we never search e.g. `language:Python topic:react`. */
const TOPIC_LANGUAGES: Record<string, readonly string[]> = {
  react: JS,
  "react-native": JS,
  nextjs: JS,
  next: JS,
  vue: JS,
  vuejs: JS,
  nuxt: JS,
  angular: JS,
  svelte: JS,
  sveltekit: JS,
  nodejs: JS,
  node: JS,
  express: JS,
  nestjs: JS,
  deno: JS,
  bun: JS,
  typescript: JS,
  javascript: JS,
  frontend: JS,
  webpack: JS,
  vite: JS,
  eslint: JS,
  electron: JS,
  tailwindcss: JS,
  fastapi: PY,
  django: PY,
  flask: PY,
  pandas: PY,
  numpy: PY,
  pytorch: PY,
  python: PY,
  pydantic: PY,
  "scikit-learn": PY,
  jupyter: PY,
  sqlalchemy: PY,
  pytest: PY,
  celery: PY,
  "spring-boot": JVM,
  spring: JVM,
  "spring-framework": JVM,
  java: JVM,
  maven: JVM,
  gradle: JVM,
  quarkus: JVM,
  micronaut: JVM,
  hibernate: JVM,
  junit: JVM,
  kotlin: ["kotlin", "java"],
  android: ["kotlin", "java"],
  ktor: ["kotlin"],
  rust: ["rust"],
  go: ["go"],
  golang: ["go"],
  rails: ["ruby"],
  ruby: ["ruby"],
  laravel: ["php"],
  php: ["php"],
  dotnet: ["c#"],
  csharp: ["c#"],
}

function uniqueCi(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const v = raw.trim()
    if (!v || seen.has(v.toLowerCase())) continue
    seen.add(v.toLowerCase())
    out.push(v)
  }
  return out
}

/** Qualifier value, quoted when it contains whitespace. */
function qualifierValue(v: string): string {
  const clean = v.replace(/"/g, "").trim()
  return /\s/.test(clean) ? `"${clean}"` : clean
}

/** Free-text keyword (bounded so queries stay far below GitHub's 256-char text limit). */
function freeText(v: string): string {
  const clean = v.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64).trim()
  return /\s/.test(clean) ? `"${clean}"` : clean
}

function roundRobin<T>(groups: readonly T[][]): T[] {
  const out: T[] = []
  const longest = Math.max(0, ...groups.map((g) => g.length))
  for (let i = 0; i < longest; i++) for (const g of groups) if (i < g.length) out.push(g[i]!)
  return out
}

/**
 * GitHub repository-search queries derived from config.interests.
 *
 * Each topic/keyword is paired with the configured languages it plausibly uses (a topic known
 * to imply other languages is searched without a language qualifier), round-robin so every
 * interest is represented early. Each base query gets a good-first-issues and a help-wanted
 * variant with stars/pushed/archived filters. At most MAX_SEARCH_QUERIES are returned; when
 * there are more, a deterministic window rotates with each discovery interval so all of them
 * are covered over successive runs.
 */
export function buildRepoSearchQueries(config: OssScoutConfig, now: Millis): string[] {
  const { languages, topics, keywords } = config.interests
  const { minStars, maxStars } = config.screening
  const pushedSince = utcDay(now - config.discovery.searchPushedWithinDays * DAY)
  const stars = maxStars !== null && maxStars >= minStars ? `stars:${minStars}..${maxStars}` : `stars:>=${minStars}`
  const filters = `${stars} pushed:>${pushedSince} archived:false`

  const langs = uniqueCi(languages)
  const terms = [
    ...uniqueCi(topics).map((t) => {
      const topic = t.toLowerCase().replace(/\s+/g, "-")
      return { text: `topic:${qualifierValue(topic)}`, affinity: TOPIC_LANGUAGES[topic] ?? null }
    }),
    ...uniqueCi(keywords).map((k) => ({ text: freeText(k), affinity: null as readonly string[] | null })),
  ].filter((t) => t.text && t.text !== "topic:")

  const groups: string[][] =
    terms.length === 0
      ? langs.map((l) => [`language:${qualifierValue(l)}`])
      : terms.map((term) => {
          const matching = term.affinity ? langs.filter((l) => term.affinity!.includes(l.toLowerCase())) : langs
          return matching.length > 0 ? matching.map((l) => `language:${qualifierValue(l)} ${term.text}`) : [term.text]
        })

  const all: string[] = []
  for (const base of roundRobin(groups)) {
    all.push(`${base} ${filters} good-first-issues:>${GOOD_FIRST_ISSUES_MIN}`)
    all.push(`${base} ${filters} help-wanted-issues:>${HELP_WANTED_ISSUES_MIN}`)
  }
  const unique = [...new Set(all)]
  if (unique.length <= MAX_SEARCH_QUERIES) return unique
  const slot = Math.floor(now / (Math.max(1, config.discovery.intervalHours) * HOUR))
  const start = (slot * MAX_SEARCH_QUERIES) % unique.length
  return Array.from({ length: MAX_SEARCH_QUERIES }, (_, i) => unique[(start + i) % unique.length]!)
}

/** "npm:zod, npm:@zod/mini (used by you/app, you/api)" (lists capped at 3 + "+N more"). */
export function dependencySourceDetail(packages: readonly string[], usedBy: readonly string[]): string {
  return `${summarize(packages)} (used by ${summarize(usedBy)})`
}

function summarize(items: readonly string[], max = 3): string {
  const head = items.slice(0, max).join(", ")
  return items.length > max ? `${head} +${items.length - max} more` : head
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

interface Run {
  ctx: AppContext
  report: DiscoveryReport
  now: Millis
  cap: number
  login: string | null
  /** Lowercased full names of your own repos. */
  own: Set<string>
  /** Lowercased full names already decided in this run. */
  seen: Set<string>
}

function isFatal(err: unknown): boolean {
  return (
    err instanceof RateLimitError ||
    err instanceof KilledError ||
    (err instanceof Error && (err.name === "RateLimitError" || err.name === "KilledError"))
  )
}

function ensureLive(ctx: AppContext): void {
  if (ctx.kill.isEngaged()) throw new KilledError()
}

/** Record a non-fatal failure; rethrow rate limits and the kill switch. */
function noteError(run: Run, scope: string, err: unknown, details: Record<string, unknown> = {}): void {
  if (isFatal(err)) throw err
  const message = `${scope}: ${errorMessage(err)}`
  run.report.errors.push(message)
  recordError(run.ctx, "discovery", message, details)
}

function isFull(run: Run): boolean {
  return run.report.added.length >= run.cap
}

function ownReason(run: Run, fullName: string): string | null {
  const owner = fullName.slice(0, fullName.indexOf("/")).toLowerCase()
  const mine = run.own.has(fullName.toLowerCase()) || (run.login !== null && owner === run.login.toLowerCase())
  return mine ? "your own repository" : null
}

function rejectReason(run: Run, fullName: string): string | null {
  const own = ownReason(run, fullName)
  if (own) return own
  const allowed = isRepoAllowed(fullName, run.ctx.config)
  return allowed.ok ? null : (allowed.reason ?? "not allowed by config")
}

function skip(run: Run, fullName: string, reason: string, source: RepoSource, sourceDetail: string): void {
  run.report.skipped.push({ repo: fullName, reason })
  audit(run.ctx, "scout", "repo.discover.skip", fullName, "skipped", [reason], { source, sourceDetail })
}

/** Decide one candidate (once per run): skip with reason, count as existing, or persist + audit as new. */
function offer(
  run: Run,
  input: { fullName: string; source: RepoSource; sourceDetail: string; details: Record<string, unknown> },
): void {
  const key = input.fullName.toLowerCase()
  if (run.seen.has(key)) return
  run.seen.add(key)
  const reason = rejectReason(run, input.fullName)
  if (reason) return skip(run, input.fullName, reason, input.source, input.sourceDetail)
  const { store } = run.ctx
  if (store.getRepo(input.fullName)) {
    run.report.existing++
    return
  }
  const { repo, created } = store.upsertRepoCandidate(
    { fullName: input.fullName, source: input.source, sourceDetail: input.sourceDetail },
    run.now,
  )
  if (!created) {
    run.report.existing++
    return
  }
  run.report.added.push(repo.fullName)
  audit(run.ctx, "scout", "repo.discover", repo.fullName, "added", [input.sourceDetail], {
    source: input.source,
    sourceDetail: input.sourceDetail,
    ...input.details,
  })
}

/** Would `offer` add this repo right now? (no side effects) */
function isFreshCandidate(run: Run, fullName: string): boolean {
  return !run.seen.has(fullName.toLowerCase()) && rejectReason(run, fullName) === null && !run.ctx.store.getRepo(fullName)
}

async function mapPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

// ---------------------------------------------------------------------------
// Dependencies of your repos
// ---------------------------------------------------------------------------

interface DepUsage {
  key: string
  dep: DependencyRef
  usedBy: Set<string>
}

interface RepoUsage {
  fullName: string
  packages: string[]
  usedBy: Set<string>
}

function depKey(dep: Pick<DependencyRef, "ecosystem" | "name">): string {
  return `${dep.ecosystem}:${dep.name}`
}

/** Read and parse the manifests of one of your repos. Non-fatal failures are recorded. */
async function scanRepo(run: Run, repo: GhRepo): Promise<{ deps: DependencyRef[]; declared: string[] }> {
  const { ctx } = run
  const ref = repo.default_branch || "HEAD"
  const result = { deps: [] as DependencyRef[], declared: [] as string[] }
  let tree: GhTreeEntry[]
  try {
    tree = await ctx.github.getTree(repo.full_name, ref, true)
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 404 || err.status === 409)) {
      ctx.log.debug("discovery: repo has no readable tree", { repo: repo.full_name, status: err.status })
    } else noteError(run, repo.full_name, err, { repo: repo.full_name })
    return result
  }
  for (const path of selectManifestPaths(tree)) {
    ensureLive(ctx)
    let text: string | null
    try {
      text = await ctx.github.getFileContent(repo.full_name, path, ref)
    } catch (err) {
      noteError(run, `${repo.full_name}:${path}`, err, { repo: repo.full_name, path })
      continue
    }
    if (text === null) continue
    result.deps.push(...parseManifest(path, text))
    const declared = declaredPackageName(path, text)
    if (declared) result.declared.push(depKey(declared))
  }
  return result
}

/**
 * Resolve dependencies (most used first) to repos, aggregating packages and users per repo.
 * Stops early once enough fresh candidates were found to fill this run's cap.
 */
async function resolveUsages(run: Run, resolver: RegistryResolver, usages: readonly DepUsage[]): Promise<RepoUsage[]> {
  const byRepo = new Map<string, RepoUsage>()
  let fresh = 0
  for (let index = 0; index < usages.length && fresh < run.cap - run.report.added.length; ) {
    ensureLive(run.ctx)
    const batch = usages.slice(index, index + RESOLVE_BATCH)
    index += batch.length
    const repos = await mapPool(batch, RESOLVE_CONCURRENCY, async (u) => {
      try {
        return await resolver.resolve(u.dep)
      } catch (err) {
        run.ctx.log.debug("discovery: registry resolution failed", { dep: u.key, error: errorMessage(err) })
        return null
      }
    })
    batch.forEach((u, i) => {
      const repo = repos[i]
      if (!repo || !VALID_REPO.test(repo)) return
      const key = repo.toLowerCase()
      let entry = byRepo.get(key)
      if (!entry) {
        entry = { fullName: repo, packages: [], usedBy: new Set() }
        byRepo.set(key, entry)
        if (isFreshCandidate(run, repo)) fresh++
      }
      entry.packages.push(u.key)
      for (const user of u.usedBy) entry.usedBy.add(user)
    })
  }
  return [...byRepo.values()].sort(
    (a, b) =>
      b.usedBy.size - a.usedBy.size || b.packages.length - a.packages.length || a.fullName.localeCompare(b.fullName),
  )
}

async function discoverFromDependencies(run: Run, resolver: RegistryResolver): Promise<void> {
  const { ctx } = run
  const { maxOwnRepos, includeDevDependencies } = ctx.config.discovery
  if (maxOwnRepos <= 0) return
  let repos: GhRepo[]
  try {
    repos = await ctx.github.listOwnRepos({ max: maxOwnRepos })
  } catch (err) {
    noteError(run, "listOwnRepos", err)
    return
  }
  for (const r of repos) run.own.add(r.full_name.toLowerCase())

  const usage = new Map<string, DepUsage>()
  const internal = new Set<string>()
  for (const repo of repos.slice(0, maxOwnRepos)) {
    if (repo.fork || repo.archived || repo.disabled) continue
    ensureLive(ctx)
    const scanned = await scanRepo(run, repo)
    for (const name of scanned.declared) internal.add(name)
    for (const dep of scanned.deps) {
      if (dep.dev && !includeDevDependencies) continue
      const key = depKey(dep)
      let u = usage.get(key)
      if (!u) {
        u = { key, dep, usedBy: new Set() }
        usage.set(key, u)
      }
      u.usedBy.add(repo.full_name)
    }
  }

  const pending = [...usage.values()]
    .filter((u) => !internal.has(u.key))
    .sort((a, b) => b.usedBy.size - a.usedBy.size || a.key.localeCompare(b.key))
  const candidates = await resolveUsages(run, resolver, pending)
  for (const c of candidates) {
    if (isFull(run)) return
    const usedBy = [...c.usedBy]
    offer(run, {
      fullName: c.fullName,
      source: "dependency",
      sourceDetail: dependencySourceDetail(c.packages, usedBy),
      details: { packages: c.packages, usedBy },
    })
  }
}

// ---------------------------------------------------------------------------
// Interest searches
// ---------------------------------------------------------------------------

async function discoverFromSearch(run: Run): Promise<void> {
  const { ctx } = run
  const perQuery = ctx.config.discovery.searchResultsPerQuery
  for (const query of buildRepoSearchQueries(ctx.config, run.now)) {
    if (isFull(run)) return
    ensureLive(ctx)
    let results: GhRepo[]
    try {
      results = await ctx.github.searchRepositories(query, {
        sort: searchSortFor(query),
        order: "desc",
        max: perQuery,
        perPage: perQuery,
      })
    } catch (err) {
      noteError(run, `search "${query}"`, err, { query })
      continue
    }
    for (const repo of results) {
      if (isFull(run)) return
      const key = repo.full_name.toLowerCase()
      if (run.seen.has(key)) continue
      const reason = searchSkipReason(repo, ctx.config)
      if (reason) {
        run.seen.add(key)
        skip(run, repo.full_name, reason, "search", query)
        continue
      }
      offer(run, {
        fullName: repo.full_name,
        source: "search",
        sourceDetail: query,
        details: { query, stars: repo.stargazers_count },
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Run one discovery pass (dependencies of your repos + interest searches). Persists candidates, audits decisions. */
export async function runDiscovery(ctx: AppContext, opts: DiscoveryOptions = {}): Promise<DiscoveryReport> {
  ensureLive(ctx)
  const report: DiscoveryReport = { added: [], existing: 0, skipped: [], errors: [] }
  const run: Run = {
    ctx,
    report,
    now: ctx.clock.now(),
    cap: ctx.config.discovery.maxNewReposPerRun,
    login: null,
    own: new Set(),
    seen: new Set(),
  }
  try {
    run.login = await ctx.login()
  } catch (err) {
    noteError(run, "login", err)
  }

  const { fromDependencies, fromSearch } = ctx.config.discovery
  if (fromDependencies) {
    const resolver =
      opts.resolver ?? createRegistryResolver({ fetch: ctx.fetch, store: ctx.store, clock: ctx.clock, log: ctx.log })
    await discoverFromDependencies(run, resolver)
  }
  if (fromSearch && !isFull(run)) await discoverFromSearch(run)

  const summary: DiscoveryLastRun = {
    at: ctx.clock.now(),
    added: report.added.length,
    existing: report.existing,
    skipped: report.skipped.length,
    errors: report.errors.length,
  }
  ctx.store.setKv(DISCOVERY_LAST_RUN_KEY, summary, summary.at)
  ctx.log.info("discovery pass finished", { ...summary })
  return report
}
