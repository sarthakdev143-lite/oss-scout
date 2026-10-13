/**
 * GitHub REST client (fetch-based). Every request is serialized, checks the kill switch, honors
 * primary/secondary rate limits without busy-retrying, uses conditional requests (ETag cache in
 * SQLite) for GETs, and never puts the token anywhere except the Authorization header of requests
 * to the configured API origin. Mutating methods require a human-minted WriteAuthorization.
 */
import { Buffer } from "node:buffer"
import type { Store } from "../state/store.ts"
import type { Clock } from "../util/clock.ts"
import { errorMessage, type Logger } from "../util/log.ts"
import { redact, registerSecret } from "../util/redact.ts"
import { splitFullName } from "../util/text.ts"
import type { KillSwitch } from "../scheduler/killswitch.ts"
import {
  GitHubError,
  KilledError,
  RateLimitError,
  WriteForbiddenError,
  isWriteAuthorization,
  type CreatePullInput,
  type GitHubApi,
  type ListOptions,
  type SearchOptions,
  type WriteAuthorization,
} from "./api.ts"
import type {
  GhComment,
  GhCommit,
  GhCommunityProfile,
  GhContentEntry,
  GhIssue,
  GhPull,
  GhRepo,
  GhReview,
  GhReviewComment,
  GhTimelineEvent,
  GhTreeEntry,
  GhUser,
  RateLimitInfo,
  TokenInfo,
} from "./types.ts"

export interface GitHubClientOptions {
  /** null = unauthenticated (60 req/h). Never logged. */
  token: string | null
  baseUrl: string
  apiVersion: string
  userAgent: string
  /** ETag cache store; null disables conditional requests. */
  store: Store | null
  clock: Clock
  log: Logger
  kill: KillSwitch
  fetch?: typeof fetch
  /** false = every mutating method throws WriteForbiddenError regardless of authorization. */
  allowWrites: boolean
  /** Minimum ms between mutating requests. */
  minWriteIntervalMs: number
  /** Max time to wait for an async fork to become reachable. */
  forkPollTimeoutMs?: number
  /** Per-request network timeout in real ms (default 60s). Keeps a hung socket from blocking the queue. */
  requestTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GITHUB_JSON_ACCEPT = "application/vnd.github+json"
export const GITHUB_RAW_ACCEPT = "application/vnd.github.raw+json"

const DEFAULT_MAX = 100
const MAX_PER_PAGE = 100
const SEARCH_RESULT_CAP = 1000
const GET_RETRIES = 2
const RETRY_BASE_MS = 1000
const SECONDARY_WAIT_MS = 60_000
const FORK_POLL_TIMEOUT_MS = 300_000
const FORK_POLL_START_MS = 2000
const FORK_POLL_MAX_MS = 30_000
const MAX_REDIRECTS = 3
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests and reuse)
// ---------------------------------------------------------------------------

/** Token kind from its prefix. Never returns or logs the token itself. */
export function tokenKind(token: string | null): TokenInfo["kind"] {
  if (!token) return "other"
  if (token.startsWith("ghp_")) return "classic"
  if (token.startsWith("github_pat_")) return "fine-grained"
  return "other"
}

/** X-OAuth-Scopes → list; null when the header is absent (fine-grained / app tokens). */
export function parseScopes(header: string | null): string[] | null {
  if (header === null) return null
  return header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** URL of rel="next" in a Link header, or null. Robust to commas inside URLs. */
export function parseLinkNext(header: string | null): string | null {
  if (!header) return null
  for (const m of header.matchAll(/<([^>]*)>([^<]*)/g)) {
    const rel = /rel\s*=\s*"?([^";,]+)"?/i.exec(m[2] ?? "")?.[1]
    if (rel && rel.trim().split(/\s+/).includes("next")) return m[1] ?? null
  }
  return null
}

/** True when an issue-search query names its type (GitHub requires it for some tokens; we always do). */
export function searchQueryHasType(query: string): boolean {
  return /(^|[\s(])(is|type):(issue|pr|pull-request)(?=$|[\s)])/i.test(query)
}

/** One URL path segment; rejects empty/dot segments so a value can never change the endpoint. */
export function encodeSegment(value: string): string {
  if (value === "" || value === "." || value === "..") throw new Error(`invalid GitHub path segment: "${value}"`)
  return encodeURIComponent(value)
}

/** Repository content path: segments encoded, "/" kept, leading/trailing slashes dropped. */
export function encodeContentPath(path: string): string {
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map(encodeSegment)
    .join("/")
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/

/** "/repos/{owner}/{repo}" with validated, encoded parts. */
export function repoApiPath(fullName: string): string {
  const { owner, name } = splitFullName(fullName)
  for (const part of [owner, name]) {
    if (!NAME_RE.test(part) || /^\.+$/.test(part)) throw new Error(`invalid repository name: ${fullName}`)
  }
  return `/repos/${encodeSegment(owner)}/${encodeSegment(name)}`
}

function positiveInt(n: number, what: string): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid ${what}: ${n}`)
  return n
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function tryJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function intHeader(headers: Headers, name: string): number | null {
  const v = headers.get(name)
  if (v === null || v.trim() === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** retry-after: seconds (GitHub) or an HTTP date. Returns epoch ms, or null when absent/invalid. */
function retryAfterAt(header: string | null, now: number): number | null {
  if (header === null || header.trim() === "") return null
  const secs = Number(header)
  if (Number.isFinite(secs)) return now + Math.max(0, secs) * 1000
  const at = Date.parse(header)
  return Number.isFinite(at) ? at : null
}

function bodyMessage(body: unknown): string {
  return isRecord(body) && typeof body.message === "string" ? body.message : ""
}

/** 422 detail: errors[].message / code, joined. */
function validationDetail(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.errors)) return ""
  return body.errors
    .map((e) => {
      if (typeof e === "string") return e
      if (!isRecord(e)) return ""
      if (typeof e.message === "string") return e.message
      return [e.resource, e.field, e.code].filter((x) => typeof x === "string").join(" ")
    })
    .filter((s) => s.length > 0)
    .join("; ")
}

function asArray<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : []
}

function searchItems<T>(data: unknown): T[] {
  return isRecord(data) && Array.isArray(data.items) ? (data.items as T[]) : []
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type Query = Record<string, string | number | boolean | null | undefined>

interface Req {
  method: "GET" | "POST"
  url: string
  body?: unknown
  accept?: string
  /** Use the ETag cache (GETs only; default true). */
  cache?: boolean
  /** 404 → null instead of GitHubError. */
  allow404?: boolean
  /** Return the raw body text instead of parsed JSON. */
  text?: boolean
  write?: boolean
}

interface Res {
  status: number
  data: unknown
  headers: Headers
  /** rel="next" URL (same origin only). */
  next: string | null
}

interface RawResponse {
  status: number
  headers: Headers
  text: string
}

interface CacheEntry {
  etag: string | null
  lastModified: string | null
  next: string | null
  text: string
}

export function createGitHubClient(opts: GitHubClientOptions): GitHubApi {
  registerSecret(opts.token)
  const doFetch: typeof fetch = opts.fetch ?? globalThis.fetch
  const base = opts.baseUrl.replace(/\/+$/, "")
  const baseUrl = new URL(base)
  const baseOrigin = baseUrl.origin
  const basePath = baseUrl.pathname.replace(/\/+$/, "")
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  const limits = new Map<string, RateLimitInfo>()
  let pause: { until: number; resource: string } | null = null
  let lastWriteAt: number | null = null
  let warnedDeprecation = false
  let tail: Promise<unknown> = Promise.resolve()

  // --- small utilities -------------------------------------------------------

  function url(path: string, query: Query = {}): string {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") params.set(k, String(v))
    }
    const qs = params.toString()
    return `${base}${path}${qs ? `?${qs}` : ""}`
  }

  function sameOrigin(u: string): boolean {
    try {
      return new URL(u).origin === baseOrigin
    } catch {
      return false
    }
  }

  /** API path without query (and without a GHES "/api/v3" prefix). */
  function apiPath(u: string): string {
    try {
      const p = new URL(u).pathname
      return basePath && p.startsWith(basePath) ? p.slice(basePath.length) || "/" : p
    } catch {
      return "(invalid url)"
    }
  }

  function resourceOf(path: string): string {
    return path.startsWith("/search/") ? "search" : "core"
  }

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function assertNotKilled(): void {
    if (opts.kill.isEngaged()) throw new KilledError()
  }

  function assertNotRateLimited(resource: string): void {
    const now = opts.clock.now()
    if (pause && pause.until > now) {
      throw new RateLimitError(
        `GitHub secondary rate limit: paused until ${new Date(pause.until).toISOString()}`,
        pause.until,
        pause.resource,
        true,
      )
    }
    const snap = limits.get(resource)
    if (snap && snap.remaining <= 0 && snap.resetAt > now) {
      throw new RateLimitError(
        `GitHub ${resource} rate limit exhausted until ${new Date(snap.resetAt).toISOString()}`,
        snap.resetAt,
        resource,
        false,
      )
    }
  }

  function recordLimits(headers: Headers, fallbackResource: string): number | null {
    const remaining = intHeader(headers, "x-ratelimit-remaining")
    const reset = intHeader(headers, "x-ratelimit-reset")
    if (remaining !== null && reset !== null) {
      const resource = headers.get("x-ratelimit-resource") || fallbackResource
      limits.set(resource, { resource, limit: intHeader(headers, "x-ratelimit-limit") ?? 0, remaining, resetAt: reset * 1000 })
    }
    return remaining
  }

  function noteDeprecation(headers: Headers, path: string): void {
    if (warnedDeprecation) return
    const deprecation = headers.get("deprecation")
    const sunset = headers.get("sunset")
    if (deprecation === null && sunset === null) return
    warnedDeprecation = true
    opts.log.warn("GitHub API deprecation notice", { path, deprecation, sunset })
  }

  function rateLimitFrom(raw: RawResponse, body: unknown, fallbackResource: string): RateLimitError | null {
    const now = opts.clock.now()
    const resource = raw.headers.get("x-ratelimit-resource") || fallbackResource
    const retryAt = retryAfterAt(raw.headers.get("retry-after"), now)
    if (retryAt !== null) {
      pause = { until: Math.max(pause?.until ?? 0, retryAt), resource }
      return new RateLimitError(`GitHub secondary rate limit (retry-after ${Math.ceil((retryAt - now) / 1000)}s)`, retryAt, resource, true)
    }
    if (raw.headers.get("x-ratelimit-remaining") === "0") {
      const reset = intHeader(raw.headers, "x-ratelimit-reset")
      const resetAt = reset !== null && reset > 0 ? reset * 1000 : now + SECONDARY_WAIT_MS
      limits.set(resource, { resource, limit: intHeader(raw.headers, "x-ratelimit-limit") ?? 0, remaining: 0, resetAt })
      return new RateLimitError(`GitHub ${resource} rate limit exhausted`, resetAt, resource, false)
    }
    if (/secondary rate limit|abuse/i.test(bodyMessage(body)) || raw.status === 429) {
      const until = now + SECONDARY_WAIT_MS
      pause = { until: Math.max(pause?.until ?? 0, until), resource }
      return new RateLimitError("GitHub secondary rate limit", until, resource, true)
    }
    return null
  }

  function httpError(raw: RawResponse, body: unknown, path: string): GitHubError {
    const message = bodyMessage(body) || `GitHub request failed with HTTP ${raw.status}`
    const detail = validationDetail(body)
    return new GitHubError(
      redact(detail ? `${message}: ${detail}` : message),
      raw.status,
      raw.headers.get("x-accepted-github-permissions"),
      path,
    )
  }

  function readCache(key: string): CacheEntry | null {
    try {
      const row = opts.store?.getHttpCache(key)
      if (!row) return null
      const env = tryJson(row.body)
      if (!isRecord(env) || typeof env.text !== "string") return null
      return {
        etag: row.etag,
        lastModified: row.lastModified,
        next: typeof env.next === "string" ? env.next : null,
        text: env.text,
      }
    } catch {
      return null
    }
  }

  function writeCache(key: string, entry: CacheEntry): void {
    try {
      opts.store?.setHttpCache(
        key,
        { etag: entry.etag, lastModified: entry.lastModified, body: JSON.stringify({ next: entry.next, text: entry.text }) },
        opts.clock.now(),
      )
    } catch (err) {
      opts.log.debug("github cache write failed", { error: errorMessage(err) })
    }
  }

  function headersFor(req: Req, cached: CacheEntry | null, trusted: boolean): Record<string, string> {
    const h: Record<string, string> = {
      Accept: req.accept ?? GITHUB_JSON_ACCEPT,
      "X-GitHub-Api-Version": opts.apiVersion,
      "User-Agent": opts.userAgent,
    }
    if (trusted && opts.token) h.Authorization = `Bearer ${opts.token}`
    if (req.body !== undefined) h["Content-Type"] = "application/json"
    if (trusted && cached?.etag) h["If-None-Match"] = cached.etag
    if (trusted && cached?.lastModified) h["If-Modified-Since"] = cached.lastModified
    return h
  }

  /** One fetch with a real-time timeout; the body is read inside the timeout window. */
  async function fetchRaw(target: string, init: RequestInit): Promise<RawResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await doFetch(target, { ...init, signal: controller.signal, redirect: "manual" })
      const text = await res.text()
      return { status: res.status, headers: res.headers, text }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Fetch, following GET redirects manually: the token (and conditional headers) only go to the
   * API origin; a cross-origin hop is made without credentials.
   */
  async function fetchFollowing(req: Req, cached: CacheEntry | null): Promise<RawResponse> {
    let target = req.url
    for (let hop = 0; ; hop++) {
      const trusted = sameOrigin(target)
      const raw = await fetchRaw(target, {
        method: req.method,
        headers: headersFor(req, cached, trusted),
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      })
      const location = raw.headers.get("location")
      if (req.method !== "GET" || !REDIRECTS.has(raw.status) || !location || hop >= MAX_REDIRECTS) return raw
      target = new URL(location, target).toString()
      assertNotKilled()
    }
  }

  async function paceWrite(): Promise<void> {
    if (lastWriteAt !== null) {
      const wait = lastWriteAt + opts.minWriteIntervalMs - opts.clock.now()
      if (wait > 0) {
        await opts.clock.sleep(wait)
        assertNotKilled()
      }
    }
    lastWriteAt = opts.clock.now()
  }

  async function execute(req: Req): Promise<Res | null> {
    const path = apiPath(req.url)
    const resource = resourceOf(path)
    const cacheKey = req.method === "GET" && req.cache !== false && !req.text && opts.store ? `GET ${req.url}` : null
    for (let attempt = 0; ; attempt++) {
      assertNotKilled()
      assertNotRateLimited(resource)
      if (req.write) await paceWrite()
      const cached = cacheKey ? readCache(cacheKey) : null
      let raw: RawResponse
      try {
        raw = await fetchFollowing(req, cached)
      } catch (err) {
        if (err instanceof KilledError) throw err
        if (req.method === "GET" && attempt < GET_RETRIES) {
          opts.log.debug("github request", { method: req.method, path, status: 0, remaining: null })
          await opts.clock.sleep(RETRY_BASE_MS * 2 ** attempt)
          continue
        }
        throw new GitHubError(redact(`GitHub ${req.method} ${path} failed: ${errorMessage(err)}`), 0, null, path)
      }
      const remaining = recordLimits(raw.headers, resource)
      noteDeprecation(raw.headers, path)
      opts.log.debug("github request", { method: req.method, path, status: raw.status, remaining })

      if (raw.status === 304 && cached) {
        return {
          status: 304,
          data: req.text ? cached.text : tryJson(cached.text),
          headers: raw.headers,
          next: safeNext(parseLinkNext(raw.headers.get("link")) ?? cached.next),
        }
      }
      if (raw.status >= 200 && raw.status < 300) {
        const next = safeNext(parseLinkNext(raw.headers.get("link")))
        if (cacheKey) {
          const etag = raw.headers.get("etag")
          const lastModified = raw.headers.get("last-modified")
          if (etag || lastModified) writeCache(cacheKey, { etag, lastModified, next, text: raw.text })
        }
        return { status: raw.status, data: req.text ? raw.text : tryJson(raw.text), headers: raw.headers, next }
      }
      const body = tryJson(raw.text)
      if (raw.status === 404 && req.allow404) return null
      if (raw.status === 403 || raw.status === 429) {
        const limited = rateLimitFrom(raw, body, resource)
        if (limited) throw limited
      }
      if (raw.status >= 500 && req.method === "GET" && attempt < GET_RETRIES) {
        await opts.clock.sleep(RETRY_BASE_MS * 2 ** attempt)
        continue
      }
      throw httpError(raw, body, path)
    }
  }

  function safeNext(next: string | null): string | null {
    return next && sameOrigin(next) ? next : null
  }

  function request(req: Req): Promise<Res | null> {
    return serialize(() => execute(req))
  }

  async function getData<T>(target: string, extra: Partial<Req> = {}): Promise<T> {
    const res = await request({ method: "GET", url: target, ...extra })
    if (!res) throw new GitHubError("Not Found", 404, null, apiPath(target))
    return res.data as T
  }

  async function getOrNull<T>(target: string, extra: Partial<Req> = {}): Promise<T | null> {
    const res = await request({ method: "GET", url: target, allow404: true, ...extra })
    return res ? (res.data as T) : null
  }

  async function paginate<T>(
    path: string,
    query: Query,
    list: ListOptions | undefined,
    pick: (data: unknown) => T[],
    cap = Number.POSITIVE_INFINITY,
  ): Promise<T[]> {
    const max = Math.min(cap, Math.max(0, Math.floor(list?.max ?? DEFAULT_MAX)))
    if (max <= 0) return []
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(list?.perPage ?? max)))
    const out: T[] = []
    const seen = new Set<string>()
    let next: string | null = url(path, { ...query, per_page: perPage })
    while (next && out.length < max && !seen.has(next)) {
      seen.add(next)
      const res = await request({ method: "GET", url: next })
      if (!res) break
      out.push(...pick(res.data))
      next = res.next
    }
    return out.slice(0, max)
  }

  // --- writes -----------------------------------------------------------------

  function assertWriteAllowed(auth: WriteAuthorization, action: string): void {
    if (!opts.allowWrites) throw new WriteForbiddenError(`GitHub write "${action}" refused: this client is read-only`)
    if (!isWriteAuthorization(auth)) {
      throw new WriteForbiddenError(`GitHub write "${action}" refused: no human approval (WriteAuthorization)`)
    }
    assertNotKilled()
  }

  async function post<T>(auth: WriteAuthorization, action: string, path: string, body: unknown): Promise<T> {
    assertWriteAllowed(auth, action)
    const res = await request({ method: "POST", url: url(path), body, write: true, cache: false })
    if (!res || !isRecord(res.data)) throw new GitHubError(`GitHub ${action} returned no object`, res?.status ?? 0, null, path)
    return res.data as T
  }

  async function waitForFork(fork: GhRepo): Promise<GhRepo> {
    const timeout = opts.forkPollTimeoutMs ?? FORK_POLL_TIMEOUT_MS
    const deadline = opts.clock.now() + timeout
    const forkPath = repoApiPath(fork.full_name)
    let delay = FORK_POLL_START_MS
    for (;;) {
      const repo = await getOrNull<GhRepo>(url(forkPath), { cache: false })
      const branchName = repo?.default_branch || fork.default_branch
      if (repo && !branchName) return repo
      if (repo && branchName) {
        const branch = await getOrNull<unknown>(url(`${forkPath}/branches/${encodeSegment(branchName)}`), { cache: false })
        if (branch) return repo
      }
      const now = opts.clock.now()
      if (now >= deadline) {
        throw new GitHubError(
          `fork ${fork.full_name} was not reachable within ${Math.round(timeout / 1000)}s`,
          0,
          null,
          forkPath,
        )
      }
      await opts.clock.sleep(Math.min(delay, deadline - now))
      delay = Math.min(delay * 2, FORK_POLL_MAX_MS)
    }
  }

  // --- API ----------------------------------------------------------------------

  return {
    getAuthenticatedUser: async () => getData<GhUser>(url("/user")),

    async tokenInfo(): Promise<TokenInfo> {
      const res = await request({ method: "GET", url: url("/user"), cache: false })
      const user = res?.data as GhUser | undefined
      if (!user || typeof user.login !== "string") throw new GitHubError("GitHub /user returned no login", res?.status ?? 0, null, "/user")
      return { login: user.login, kind: tokenKind(opts.token), scopes: parseScopes(res!.headers.get("x-oauth-scopes")) }
    },

    listOwnRepos: async (o) =>
      paginate<GhRepo>("/user/repos", { affiliation: "owner", sort: "pushed", direction: "desc" }, o, asArray),

    getRepo: async (fullName) => getData<GhRepo>(url(repoApiPath(fullName))),

    async getFileContent(fullName, path, ref) {
      const target = url(`${repoApiPath(fullName)}/contents/${encodeContentPath(path)}`, { ref })
      const entry = await getOrNull<unknown>(target)
      if (!isRecord(entry) || entry.type !== "file") return null
      const content = typeof entry.content === "string" ? entry.content : ""
      if (entry.encoding === "base64" && content.length > 0) {
        return Buffer.from(content.replace(/\s+/g, ""), "base64").toString("utf8")
      }
      if (entry.size === 0) return ""
      // Large file (1–100 MB): content is omitted ("none"); fetch the raw media type instead.
      const raw = await request({ method: "GET", url: target, accept: GITHUB_RAW_ACCEPT, text: true, cache: false, allow404: true })
      return raw ? String(raw.data) : null
    },

    async listDirectory(fullName, path, ref) {
      const target = url(`${repoApiPath(fullName)}/contents/${encodeContentPath(path)}`, { ref })
      const data = await getOrNull<unknown>(target)
      return Array.isArray(data) ? (data as GhContentEntry[]) : null
    },

    async getTree(fullName, ref, recursive) {
      const data = await getData<unknown>(
        url(`${repoApiPath(fullName)}/git/trees/${encodeSegment(ref)}`, recursive ? { recursive: 1 } : {}),
      )
      return isRecord(data) && Array.isArray(data.tree) ? (data.tree as GhTreeEntry[]) : []
    },

    getCommunityProfile: async (fullName) => getOrNull<GhCommunityProfile>(url(`${repoApiPath(fullName)}/community/profile`)),

    searchRepositories: async (query, o) =>
      paginate<GhRepo>("/search/repositories", { q: query, sort: o?.sort, order: o?.order }, o, searchItems, SEARCH_RESULT_CAP),

    async searchIssues(query: string, o?: SearchOptions) {
      if (!searchQueryHasType(query)) {
        throw new Error(`issue search query must include is:issue or is:pr (got: ${query})`)
      }
      return paginate<GhIssue>(
        "/search/issues",
        { q: query, sort: o?.sort, order: o?.order, advanced_search: "true" },
        o,
        searchItems,
        SEARCH_RESULT_CAP,
      )
    },

    getIssue: async (fullName, number) => getData<GhIssue>(url(`${repoApiPath(fullName)}/issues/${positiveInt(number, "issue number")}`)),

    listIssueComments: async (fullName, number, o) =>
      paginate<GhComment>(
        `${repoApiPath(fullName)}/issues/${positiveInt(number, "issue number")}/comments`,
        { since: o?.since },
        o,
        asArray,
      ),

    listIssueTimeline: async (fullName, number, o) =>
      paginate<GhTimelineEvent>(`${repoApiPath(fullName)}/issues/${positiveInt(number, "issue number")}/timeline`, {}, o, asArray),

    listPulls: async (fullName, o) =>
      paginate<GhPull>(
        `${repoApiPath(fullName)}/pulls`,
        { state: o?.state, sort: o?.sort, direction: o?.direction, head: o?.head },
        o,
        asArray,
      ),

    getPull: async (fullName, number) => getData<GhPull>(url(`${repoApiPath(fullName)}/pulls/${positiveInt(number, "pull number")}`)),

    listPullReviews: async (fullName, number, o) =>
      paginate<GhReview>(`${repoApiPath(fullName)}/pulls/${positiveInt(number, "pull number")}/reviews`, {}, o, asArray),

    listPullReviewComments: async (fullName, number, o) =>
      paginate<GhReviewComment>(
        `${repoApiPath(fullName)}/pulls/${positiveInt(number, "pull number")}/comments`,
        { since: o?.since },
        o,
        asArray,
      ),

    listCommits: async (fullName, o) =>
      paginate<GhCommit>(`${repoApiPath(fullName)}/commits`, { since: o?.since, sha: o?.sha }, o, asArray),

    rateLimitSnapshot: () => [...limits.values()].map((l) => ({ ...l })),

    async createFork(auth, fullName) {
      assertWriteAllowed(auth, "createFork")
      const fork = await post<GhRepo>(auth, "createFork", `${repoApiPath(fullName)}/forks`, { default_branch_only: true })
      if (typeof fork.full_name !== "string") throw new GitHubError("GitHub fork response has no full_name", 0, null, "/forks")
      return waitForFork(fork)
    },

    async createPull(auth, fullName, input: CreatePullInput) {
      assertWriteAllowed(auth, "createPull")
      return post<GhPull>(auth, "createPull", `${repoApiPath(fullName)}/pulls`, {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft ?? false,
        maintainer_can_modify: input.maintainerCanModify ?? true,
      })
    },

    async createIssueComment(auth, fullName, number, body) {
      assertWriteAllowed(auth, "createIssueComment")
      return post<GhComment>(auth, "createIssueComment", `${repoApiPath(fullName)}/issues/${positiveInt(number, "issue number")}/comments`, {
        body,
      })
    },
  }
}
