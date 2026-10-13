/**
 * Maps a package dependency to its GitHub source repository.
 *
 * Order: deps.dev v3 (GetPackage → default version → GetVersion → SOURCE_REPO), then the
 * ecosystem registry (npm `/latest`, PyPI JSON, Maven metadata + POM <scm> with parent chain).
 * Results, including "no repo", are cached in the kv store. Requests are unauthenticated
 * (no token is ever sent), time out after 15 s, and are limited per host.
 */
import type { Store } from "../state/store.ts"
import type { Clock } from "../util/clock.ts"
import { DAY } from "../util/clock.ts"
import type { Logger } from "../util/log.ts"
import { errorMessage } from "../util/log.ts"
import type { DependencyRef, PackageEcosystem } from "./manifests.ts"
import { normalizePypiName, removeXmlBlocks, xmlBlocks, xmlTag } from "./manifests.ts"

export interface RegistryResolver {
  /** "owner/name" of the package's GitHub source repo, or null if unknown / not on github.com. Cached. */
  resolve(dep: DependencyRef): Promise<string | null>
}

export const DEPS_DEV_BASE = "https://api.deps.dev/v3"
export const NPM_REGISTRY_BASE = "https://registry.npmjs.org"
export const PYPI_BASE = "https://pypi.org/pypi"
export const MAVEN_CENTRAL_BASE = "https://repo1.maven.org/maven2"
export const REGISTRY_USER_AGENT = "oss-scout/0.1 (dependency-to-repository mapping)"

export const REGISTRY_POSITIVE_TTL_MS = 30 * DAY
export const REGISTRY_NEGATIVE_TTL_MS = 7 * DAY
export const REGISTRY_FETCH_TIMEOUT_MS = 15_000
/** Concurrent requests per registry host. */
export const REGISTRY_HOST_CONCURRENCY = 2
/** Parent POMs followed when an artifact POM has no <scm>. */
export const MAVEN_PARENT_DEPTH = 3

/** Value stored under "registry:<ecosystem>:<name>". */
export interface RegistryCacheEntry {
  repo: string | null
  /** When the lookup completed (epoch ms). */
  at: number
}

export function registryCacheKey(ecosystem: PackageEcosystem, name: string): string {
  return `registry:${ecosystem}:${name}`
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"])
/** First path segments on github.com that are not user/org names. */
const RESERVED_OWNERS = new Set([
  "about",
  "apps",
  "collections",
  "contact",
  "customer-stories",
  "enterprise",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "notifications",
  "orgs",
  "organizations",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "site",
  "sponsors",
  "topics",
  "trending",
  "users",
])
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/

function repoRef(owner: string, repo: string): string | null {
  const name = repo.replace(/\.git$/i, "")
  if (!OWNER_RE.test(owner) || RESERVED_OWNERS.has(owner.toLowerCase())) return null
  if (!REPO_RE.test(name) || name === "." || name === "..") return null
  return `${owner}/${name}`
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * Normalize any GitHub repo URL form (git+https://, git://, ssh, github:owner/repo, "owner/repo"
 * npm shorthand, trailing .git, /tree/... paths) to "owner/name". null for non-GitHub URLs.
 *
 * `allowShorthand: false` rejects the bare "owner/repo" form (it is only meaningful in npm
 * `repository` fields and dependency specs).
 */
export function normalizeGithubRepoUrl(
  url: string | null | undefined,
  opts: { allowShorthand?: boolean } = {},
): string | null {
  if (typeof url !== "string") return null
  let s = url.trim()
  if (!s || s.length > 2048) return null

  let m = /^github:([^/\s#?]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i.exec(s)
  if (m) return repoRef(m[1]!, m[2]!)
  if (/^(?:gist|gitlab|bitbucket):/i.test(s)) return null

  m = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:#.*)?$/.exec(s)
  if (m) return opts.allowShorthand === false ? null : repoRef(m[1]!, m[2]!)

  // scp-like: [user@]host:owner/repo(.git)
  m = /^(?:[^@\s/]+@)?([A-Za-z0-9.-]+):(?!\/\/)([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:[#?].*)?$/.exec(s)
  if (m) return GITHUB_HOSTS.has(m[1]!.toLowerCase()) ? repoRef(m[2]!, m[3]!) : null

  s = s
    .replace(/^scm:git:/i, "")
    .replace(/^git\+/i, "")
    .replace(/^((?:ssh|git):\/\/(?:[^@/]+@)?[A-Za-z0-9.-]+):(?!\d+(?:\/|$))/i, "$1/")
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null // other schemes (mailto:, scm:svn:, …)
    s = `https://${s}`
  }
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (!GITHUB_HOSTS.has(u.hostname.toLowerCase())) return null
  if (!["http:", "https:", "git:", "ssh:"].includes(u.protocol)) return null
  const parts = u.pathname.split("/").filter(Boolean)
  if (parts.length < 2) return null
  const repo = safeDecode(parts[1]!).replace(/@.*$/, "")
  return repoRef(safeDecode(parts[0]!), repo)
}

// ---------------------------------------------------------------------------
// Response interpretation (pure)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : []
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

/** Default version from a deps.dev GetPackage response (isDefault, else the last listed). */
export function depsDevDefaultVersion(pkg: unknown): string | null {
  if (!isRecord(pkg)) return null
  const versions = list(pkg.versions)
  const pick = versions.find((v) => v.isDefault === true) ?? versions[versions.length - 1]
  return pick && isRecord(pick.versionKey) ? str(pick.versionKey.version) : null
}

/**
 * Source repo from a deps.dev GetVersion response: SOURCE_REPO related projects on github.com
 * (preferring the one matching the SOURCE_REPO link, then one that is also the issue tracker),
 * else the SOURCE_REPO link itself. Link casing is preferred (project ids are lowercased).
 */
export function repoFromDepsDevVersion(version: unknown): string | null {
  if (!isRecord(version)) return null
  const projects = list(version.relatedProjects)
  const projectRepos = (type: string) =>
    projects
      .filter((p) => p.relationType === type && isRecord(p.projectKey))
      .map((p) => str((p.projectKey as Record<string, unknown>).id))
      .filter((id): id is string => !!id && /^github\.com\//i.test(id))
      .map((id) => normalizeGithubRepoUrl(`https://${id}`))
      .filter((r): r is string => r !== null)
  const sources = projectRepos("SOURCE_REPO")
  const trackers = projectRepos("ISSUE_TRACKER").map((r) => r.toLowerCase())
  const links = list(version.links)
    .filter((l) => l.label === "SOURCE_REPO")
    .map((l) => normalizeGithubRepoUrl(str(l.url), { allowShorthand: false }))
    .filter((r): r is string => r !== null)

  if (sources.length === 0) return links[0] ?? null
  for (const s of sources) {
    const link = links.find((l) => l.toLowerCase() === s.toLowerCase())
    if (link) return link
  }
  return sources.find((s) => trackers.includes(s.toLowerCase())) ?? sources[0]!
}

/** Source repo from an npm `/<name>/latest` document: repository, then homepage, then bugs. */
export function repoFromNpmManifest(doc: unknown): string | null {
  if (!isRecord(doc)) return null
  const repository = doc.repository
  const fromRepository =
    typeof repository === "string"
      ? normalizeGithubRepoUrl(repository)
      : isRecord(repository)
        ? normalizeGithubRepoUrl(str(repository.url))
        : null
  if (fromRepository) return fromRepository
  const homepage = normalizeGithubRepoUrl(str(doc.homepage), { allowShorthand: false })
  if (homepage) return homepage
  const bugs = doc.bugs
  return normalizeGithubRepoUrl(isRecord(bugs) ? str(bugs.url) : str(bugs), { allowShorthand: false })
}

/** Well-known project_urls label normalization (packaging.python.org). */
function normalizeUrlLabel(label: string): string {
  return label.replace(/[\s!-\/:-@\[-\`{-~]/g, "").toLowerCase()
}

const PYPI_SOURCE_LABELS = new Set(["source", "sources", "repository", "repo", "sourcecode", "code", "github", "git"])
const PYPI_HOMEPAGE_LABELS = new Set(["homepage", "home"])
const PYPI_ISSUE_LABELS = new Set(["issues", "issue", "bugs", "tracker", "issuetracker", "bugtracker"])

/**
 * Source repo from a PyPI JSON `info` object: project_urls Source/Repository/Code/GitHub,
 * then Homepage, then info.home_page, then issue tracker labels, then any other GitHub URL
 * (e.g. Changelog). Sponsor/funding links never match.
 */
export function repoFromPypiInfo(info: unknown): string | null {
  if (!isRecord(info)) return null
  const urls = isRecord(info.project_urls) ? Object.entries(info.project_urls) : []
  const pick = (labels: Set<string> | null) => {
    for (const [label, value] of urls) {
      if (labels && !labels.has(normalizeUrlLabel(label))) continue
      if (!labels && /funding|sponsor|donat/i.test(label)) continue
      const repo = normalizeGithubRepoUrl(str(value), { allowShorthand: false })
      if (repo) return repo
    }
    return null
  }
  return (
    pick(PYPI_SOURCE_LABELS) ??
    pick(PYPI_HOMEPAGE_LABELS) ??
    normalizeGithubRepoUrl(str(info.home_page), { allowShorthand: false }) ??
    pick(PYPI_ISSUE_LABELS) ??
    pick(null)
  )
}

/** Version to inspect from maven-metadata.xml: <release>, else <latest>, else the last <version>. */
export function mavenMetadataVersion(xml: string): string | null {
  const release = xmlTag(xml, "release") ?? xmlTag(xml, "latest")
  if (release) return release
  const versions = [...xml.matchAll(/<version>\s*([^<\s]+)\s*<\/version>/g)].map((m) => m[1]!)
  return versions[versions.length - 1] ?? null
}

export interface PomScmInfo {
  repo: string | null
  parent: { groupId: string; artifactId: string; version: string } | null
}

/**
 * GitHub repo from a POM's <scm> (url, connection, developerConnection), then the project <url>,
 * then <issueManagement><url>; simple ${…} placeholders are interpolated. Also returns the
 * <parent> coordinates so the caller can walk up when nothing was found.
 */
export function repoFromPom(text: string): PomScmInfo {
  const xml = text.replace(/<!--[\s\S]*?-->/g, "")
  const parentXml = xmlBlocks(xml, "parent")[0]
  const parentG = parentXml ? xmlTag(parentXml, "groupId") : undefined
  const parentA = parentXml ? xmlTag(parentXml, "artifactId") : undefined
  const parentV = parentXml ? xmlTag(parentXml, "version") : undefined
  const parent = parentG && parentA && parentV ? { groupId: parentG, artifactId: parentA, version: parentV } : null

  const top = removeXmlBlocks(xml, [
    "parent",
    "dependencies",
    "dependencyManagement",
    "build",
    "reporting",
    "profiles",
    "modules",
    "properties",
    "scm",
    "issueManagement",
    "ciManagement",
    "distributionManagement",
    "developers",
    "contributors",
    "organization",
    "licenses",
    "mailingLists",
    "repositories",
    "pluginRepositories",
  ])
  const props: Record<string, string | undefined> = {}
  for (const block of xmlBlocks(xml, "properties")) {
    for (const m of block.matchAll(/<([A-Za-z0-9_.-]+)\b[^>]*>\s*([^<]*?)\s*<\/\1>/g)) props[m[1]!] = m[2]!
  }
  const artifactId = xmlTag(top, "artifactId")
  const groupId = xmlTag(top, "groupId") ?? parentG
  Object.assign(props, {
    "project.artifactId": artifactId,
    artifactId,
    "project.groupId": groupId,
    groupId,
    "project.version": xmlTag(top, "version") ?? parentV,
  })
  const interpolate = (v: string | undefined) =>
    v?.replace(/\$\{([^}]+)\}/g, (whole, k: string) => props[k] ?? whole).replace(/^scm:(?:git|hg|svn):/i, "")

  const scm = xmlBlocks(xml, "scm")[0] ?? ""
  const issues = xmlBlocks(xml, "issueManagement")[0] ?? ""
  const candidates = [
    xmlTag(scm, "url"),
    xmlTag(scm, "connection"),
    xmlTag(scm, "developerConnection"),
    xmlTag(top, "url"),
    xmlTag(issues, "url"),
  ]
  for (const c of candidates) {
    const value = interpolate(c)
    if (!value || value.includes("${")) continue
    const repo = normalizeGithubRepoUrl(value, { allowShorthand: false })
    if (repo) return { repo, parent }
  }
  return { repo: null, parent }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

type Fetched = { kind: "ok"; body: unknown } | { kind: "missing" } | { kind: "error"; message: string }

/** Lookup outcome: `transient` = some source failed (network/5xx/429), so a miss must not be cached. */
interface Lookup {
  repo: string | null
  transient: boolean
}

const MISS: Lookup = { repo: null, transient: false }
const FAILED: Lookup = { repo: null, transient: true }

function fromFetched(f: Fetched): Lookup {
  return f.kind === "error" ? FAILED : MISS
}

/** Per-host concurrency limiter; a finished request hands its slot to the next waiter. */
function createHostLimiter(perHost: number) {
  const hosts = new Map<string, { active: number; waiting: Array<() => void> }>()
  return async function run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    let slot = hosts.get(host)
    if (!slot) {
      slot = { active: 0, waiting: [] }
      hosts.set(host, slot)
    }
    const state = slot
    if (state.active >= perHost) await new Promise<void>((resolve) => state.waiting.push(resolve))
    else state.active++
    try {
      return await fn()
    } finally {
      const next = state.waiting.shift()
      if (next) next()
      else state.active--
    }
  }
}

function isCacheEntry(v: unknown): v is RegistryCacheEntry {
  return isRecord(v) && typeof v.at === "number" && (v.repo === null || typeof v.repo === "string")
}

/** groupId / artifactId: dot-separated non-empty parts, so a path built from it cannot traverse. */
const MAVEN_SEGMENT = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/
const MAVEN_VERSION = /^[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*$/

/** Canonical lookup name, or null when the name cannot be a valid package of that ecosystem. */
function canonicalName(dep: DependencyRef): string | null {
  const name = dep.name.trim()
  if (!name || name.length > 300) return null
  switch (dep.ecosystem) {
    case "npm":
      return /^(?:@[A-Za-z0-9~][\w.~-]*\/)?[A-Za-z0-9~][\w.~-]*$/.test(name) ? name : null
    case "pypi":
      return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name) ? normalizePypiName(name) : null
    case "maven": {
      const [g, a, extra] = name.split(":")
      return g && a && extra === undefined && MAVEN_SEGMENT.test(g) && MAVEN_SEGMENT.test(a) ? name : null
    }
    default:
      return null
  }
}

function npmPath(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export function createRegistryResolver(deps: {
  fetch: typeof fetch
  store: Store
  clock: Clock
  log: Logger
  /** Per-request timeout (default 15 s). */
  timeoutMs?: number
  /** Concurrent requests per host (default 2). */
  perHostConcurrency?: number
}): RegistryResolver {
  const timeoutMs = deps.timeoutMs ?? REGISTRY_FETCH_TIMEOUT_MS
  const limit = createHostLimiter(Math.max(1, deps.perHostConcurrency ?? REGISTRY_HOST_CONCURRENCY))
  const inflight = new Map<string, Promise<string | null>>()

  async function request(url: string, as: "json" | "text"): Promise<Fetched> {
    const host = new URL(url).host
    return limit(host, async (): Promise<Fetched> => {
      // Like AbortSignal.timeout(), but with a ref'd timer: Bun's AbortSignal.timeout does not keep
      // the event loop alive, so a stalled request could otherwise hang forever. Covers the body read.
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(new DOMException(`registry request timed out after ${timeoutMs} ms`, "TimeoutError")),
        timeoutMs,
      )
      try {
        const res = await deps.fetch(url, {
          method: "GET",
          headers: {
            accept: as === "json" ? "application/json" : "application/xml, text/xml, */*",
            "user-agent": REGISTRY_USER_AGENT,
          },
          redirect: "follow",
          signal: controller.signal,
        })
        if (!res.ok) {
          await res.body?.cancel().catch(() => {})
          const missing = res.status === 404 || res.status === 410 || res.status === 400
          return missing ? { kind: "missing" } : { kind: "error", message: `HTTP ${res.status}` }
        }
        const body: unknown = as === "json" ? await res.json() : await res.text()
        return { kind: "ok", body }
      } catch (err) {
        return { kind: "error", message: errorMessage(err) }
      } finally {
        clearTimeout(timer)
      }
    }).then((result) => {
      if (result.kind === "error") deps.log.debug("registry request failed", { url, error: result.message })
      return result
    })
  }

  async function viaDepsDev(ecosystem: PackageEcosystem, name: string): Promise<Lookup> {
    const base = `${DEPS_DEV_BASE}/systems/${ecosystem}/packages/${encodeURIComponent(name)}`
    const pkg = await request(base, "json")
    if (pkg.kind !== "ok") return fromFetched(pkg)
    const version = depsDevDefaultVersion(pkg.body)
    if (!version) return MISS
    const ver = await request(`${base}/versions/${encodeURIComponent(version)}`, "json")
    if (ver.kind !== "ok") return fromFetched(ver)
    return { repo: repoFromDepsDevVersion(ver.body), transient: false }
  }

  async function viaNpm(name: string): Promise<Lookup> {
    const res = await request(`${NPM_REGISTRY_BASE}/${npmPath(name)}/latest`, "json")
    return res.kind === "ok" ? { repo: repoFromNpmManifest(res.body), transient: false } : fromFetched(res)
  }

  async function viaPypi(name: string): Promise<Lookup> {
    const res = await request(`${PYPI_BASE}/${encodeURIComponent(name)}/json`, "json")
    if (res.kind !== "ok") return fromFetched(res)
    const info = isRecord(res.body) ? res.body.info : null
    return { repo: repoFromPypiInfo(info), transient: false }
  }

  async function viaMaven(name: string): Promise<Lookup> {
    const [groupId, artifactId] = name.split(":") as [string, string]
    const meta = await request(
      `${MAVEN_CENTRAL_BASE}/${groupId.replace(/\./g, "/")}/${encodeURIComponent(artifactId)}/maven-metadata.xml`,
      "text",
    )
    if (meta.kind !== "ok") return fromFetched(meta)
    const version = mavenMetadataVersion(String(meta.body))
    if (!version) return MISS
    let coords: { groupId: string; artifactId: string; version: string } | null = { groupId, artifactId, version }
    for (let depth = 0; coords && depth <= MAVEN_PARENT_DEPTH; depth++) {
      const { groupId: g, artifactId: a, version: v } = coords
      if (!MAVEN_SEGMENT.test(g) || !MAVEN_SEGMENT.test(a) || !MAVEN_VERSION.test(v)) return MISS
      const pom = await request(
        `${MAVEN_CENTRAL_BASE}/${g.replace(/\./g, "/")}/${encodeURIComponent(a)}/${encodeURIComponent(v)}/${encodeURIComponent(`${a}-${v}.pom`)}`,
        "text",
      )
      if (pom.kind !== "ok") return fromFetched(pom)
      const info = repoFromPom(String(pom.body))
      if (info.repo) return { repo: info.repo, transient: false }
      coords = info.parent
    }
    return MISS
  }

  async function lookup(ecosystem: PackageEcosystem, name: string): Promise<Lookup> {
    const primary = await viaDepsDev(ecosystem, name)
    if (primary.repo) return primary
    const fallback =
      ecosystem === "npm" ? await viaNpm(name) : ecosystem === "pypi" ? await viaPypi(name) : await viaMaven(name)
    return { repo: fallback.repo, transient: !fallback.repo && (primary.transient || fallback.transient) }
  }

  function readCache(key: string): RegistryCacheEntry | null {
    try {
      const entry = deps.store.getKv<unknown>(key)
      if (!isCacheEntry(entry)) return null
      const ttl = entry.repo ? REGISTRY_POSITIVE_TTL_MS : REGISTRY_NEGATIVE_TTL_MS
      return deps.clock.now() - entry.at < ttl ? entry : null
    } catch {
      return null
    }
  }

  function writeCache(key: string, repo: string | null): void {
    try {
      const now = deps.clock.now()
      deps.store.setKv(key, { repo, at: now } satisfies RegistryCacheEntry, now)
    } catch (err) {
      deps.log.debug("registry cache write failed", { key, error: errorMessage(err) })
    }
  }

  return {
    async resolve(dep) {
      const name = canonicalName(dep)
      if (!name) return null
      const key = registryCacheKey(dep.ecosystem, name)
      const cached = readCache(key)
      if (cached) return cached.repo
      const pending = inflight.get(key)
      if (pending) return pending
      const task = lookup(dep.ecosystem, name)
        .then((result) => {
          if (result.repo || !result.transient) writeCache(key, result.repo)
          else deps.log.debug("registry lookup incomplete; not cached", { ecosystem: dep.ecosystem, name })
          return result.repo
        })
        .catch((err: unknown) => {
          deps.log.debug("registry lookup failed", { ecosystem: dep.ecosystem, name, error: errorMessage(err) })
          return null
        })
        .finally(() => inflight.delete(key))
      inflight.set(key, task)
      return task
    },
  }
}
