import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  GitHubError,
  KilledError,
  RateLimitError,
  WriteForbiddenError,
  mintWriteAuthorization,
  type GitHubApi,
  type WriteAuthorization,
} from "../src/github/api.ts"
import {
  GITHUB_RAW_ACCEPT,
  createGitHubClient,
  encodeContentPath,
  parseLinkNext,
  parseScopes,
  searchQueryHasType,
  tokenKind,
  type GitHubClientOptions,
} from "../src/github/client.ts"
import { KillSwitch } from "../src/scheduler/killswitch.ts"
import { openDatabase } from "../src/state/db.ts"
import { Store } from "../src/state/store.ts"
import { FakeClock, type Clock } from "../src/util/clock.ts"
import { createLogger } from "../src/util/log.ts"
import { clearRegisteredSecrets } from "../src/util/redact.ts"
import { ghComment, ghIssue, ghPull, ghRepo, ghUser } from "./helpers/fakes.ts"

const TOKEN = "ghp_SuperSecretTokenValue0123456789abcdef"
const API = "https://api.github.com"

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface Call {
  method: string
  url: URL
  headers: Headers
  body: unknown
  at: number
}

type Handler = (call: Call, index: number) => Response | Promise<Response>

function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  })
}

function limitHeaders(remaining: number, resetSec: number, resource = "core"): Record<string, string> {
  return {
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(resetSec),
    "x-ratelimit-resource": resource,
  }
}

const dirs: string[] = []

afterEach(() => {
  clearRegisteredSecrets()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(handler: Handler, over: Partial<GitHubClientOptions> & { clock?: Clock } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oss-scout-gh-"))
  dirs.push(dir)
  const clock = (over.clock as FakeClock | undefined) ?? new FakeClock()
  const kill = new KillSwitch(join(dir, "KILL"))
  const lines: string[] = []
  const log = createLogger({ level: "debug", sink: (l) => lines.push(l) })
  const calls: Call[] = []
  const fetchMock = async (input: unknown, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      at: clock.now(),
    }
    calls.push(call)
    return handler(call, calls.length - 1)
  }
  const client = createGitHubClient({
    token: TOKEN,
    baseUrl: API,
    apiVersion: "2022-11-28",
    userAgent: "oss-scout-test/0.1",
    store: null,
    clock,
    log,
    kill,
    fetch: fetchMock as unknown as typeof fetch,
    allowWrites: true,
    minWriteIntervalMs: 1500,
    ...over,
  })
  return { client, calls, clock: clock as FakeClock, kill, lines }
}

function approval(): WriteAuthorization {
  return mintWriteAuthorization({
    queueItemId: 7,
    itemStatus: "approved",
    itemDigest: "abcdef0123456789abcdef",
    providedDigest: "abcdef01",
    actor: "human",
    via: "cli",
    mode: "queue",
    now: Date.UTC(2026, 0, 15),
  })
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  throw new Error("expected promise to reject")
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("helpers", () => {
  test("tokenKind by prefix", () => {
    expect(tokenKind("ghp_abc")).toBe("classic")
    expect(tokenKind("github_pat_abc")).toBe("fine-grained")
    expect(tokenKind("gho_abc")).toBe("other")
    expect(tokenKind(null)).toBe("other")
  })

  test("parseScopes", () => {
    expect(parseScopes(null)).toBeNull()
    expect(parseScopes("")).toEqual([])
    expect(parseScopes("repo, public_repo ,workflow")).toEqual(["repo", "public_repo", "workflow"])
  })

  test("parseLinkNext handles multiple rels and commas in URLs", () => {
    const h = `<${API}/x?page=2&q=a%2Cb,c>; rel="next", <${API}/x?page=9>; rel="last"`
    expect(parseLinkNext(h)).toBe(`${API}/x?page=2&q=a%2Cb,c`)
    expect(parseLinkNext(`<${API}/x?page=1>; rel="prev"`)).toBeNull()
    expect(parseLinkNext(null)).toBeNull()
  })

  test("searchQueryHasType", () => {
    expect(searchQueryHasType("is:issue is:open")).toBe(true)
    expect(searchQueryHasType("repo:a/b is:pr")).toBe(true)
    expect(searchQueryHasType("type:issue label:bug")).toBe(true)
    expect(searchQueryHasType("(is:issue OR is:pr) repo:a/b")).toBe(true)
    expect(searchQueryHasType("label:bug -is:pr")).toBe(false)
    expect(searchQueryHasType("is:open label:bug")).toBe(false)
  })

  test("encodeContentPath keeps slashes, encodes segments, rejects dot segments", () => {
    expect(encodeContentPath("/docs/My File#1.md")).toBe("docs/My%20File%231.md")
    expect(encodeContentPath("")).toBe("")
    expect(() => encodeContentPath("a/../b")).toThrow()
  })
})

// ---------------------------------------------------------------------------
// headers + secrets
// ---------------------------------------------------------------------------

describe("request headers and token hygiene", () => {
  test("sends version, user agent, accept and bearer auth", async () => {
    const { client, calls } = setup(() => json(ghUser("me")))
    const user = await client.getAuthenticatedUser()
    expect(user.login).toBe("me")
    expect(calls).toHaveLength(1)
    const h = calls[0]!.headers
    expect(calls[0]!.url.toString()).toBe(`${API}/user`)
    expect(h.get("accept")).toBe("application/vnd.github+json")
    expect(h.get("x-github-api-version")).toBe("2022-11-28")
    expect(h.get("user-agent")).toBe("oss-scout-test/0.1")
    expect(h.get("authorization")).toBe(`Bearer ${TOKEN}`)
  })

  test("omits Authorization when unauthenticated", async () => {
    const { client, calls } = setup(() => json(ghUser("anon")), { token: null })
    await client.getAuthenticatedUser()
    expect(calls[0]!.headers.has("authorization")).toBe(false)
  })

  test("token never appears in errors or logs, even when the server echoes it", async () => {
    const { client, lines } = setup(() => json({ message: `Bad credentials for ${TOKEN}` }, { status: 401 }))
    const err = await caught(client.getRepo("acme/widget"))
    expect(err).toBeInstanceOf(GitHubError)
    const e = err as GitHubError
    expect(e.status).toBe(401)
    expect(e.path).toBe("/repos/acme/widget")
    for (const text of [e.message, String(e), e.stack ?? "", JSON.stringify(e)]) expect(text).not.toContain(TOKEN)
    expect(e.message).toContain("Bad credentials")
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toContain(TOKEN)
  })

  test("network failure messages are redacted and carry status 0", async () => {
    const { client } = setup(() => {
      throw new TypeError(`connect failed Authorization: Bearer ${TOKEN}`)
    })
    const err = (await caught(client.getRepo("acme/widget"))) as GitHubError
    expect(err).toBeInstanceOf(GitHubError)
    expect(err.status).toBe(0)
    expect(err.message).not.toContain(TOKEN)
  })

  test("debug log carries only method, path, status, remaining", async () => {
    const { client, lines } = setup(() => json(ghRepo(), { headers: limitHeaders(4999, 2_000_000_000) }))
    await client.getRepo("acme/widget")
    const rec = JSON.parse(lines.find((l) => l.includes("github request"))!)
    const { ts, level, svc, msg, ...fields } = rec
    expect([ts !== undefined, level, svc, msg]).toEqual([true, "debug", "oss-scout", "github request"])
    expect(fields).toEqual({ method: "GET", path: "/repos/acme/widget", status: 200, remaining: 4999 })
  })

  test("warns once on Deprecation/Sunset headers", async () => {
    const { client, lines } = setup(() => json(ghRepo(), { headers: { deprecation: "true", sunset: "Wed, 10 Mar 2028 00:00:00 GMT" } }))
    await client.getRepo("acme/widget")
    await client.getRepo("acme/widget")
    expect(lines.filter((l) => l.includes("deprecation notice"))).toHaveLength(1)
  })

  test("cross-origin redirects drop credentials; same-origin redirects keep them", async () => {
    const { client, calls } = setup((call) => {
      if (call.url.pathname === "/repos/old/name") return new Response(null, { status: 301, headers: { location: `${API}/repositories/1` } })
      if (call.url.pathname === "/repositories/1") return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/r" } })
      return json(ghRepo({ full_name: "new/name" }))
    })
    const repo = await client.getRepo("old/name")
    expect(repo.full_name).toBe("new/name")
    expect(calls.map((c) => c.url.host)).toEqual(["api.github.com", "api.github.com", "elsewhere.example"])
    expect(calls[1]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(calls[2]!.headers.has("authorization")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// kill switch
// ---------------------------------------------------------------------------

describe("kill switch", () => {
  test("blocks reads and writes before any network traffic", async () => {
    const { client, calls, kill, clock } = setup(() => json(ghRepo()))
    kill.engage("test", clock.now())
    expect(await caught(client.getRepo("acme/widget"))).toBeInstanceOf(KilledError)
    expect(await caught(client.searchIssues("is:issue is:open"))).toBeInstanceOf(KilledError)
    expect(await caught(client.createIssueComment(approval(), "acme/widget", 1, "hi"))).toBeInstanceOf(KilledError)
    expect(await caught(client.createFork(approval(), "acme/widget"))).toBeInstanceOf(KilledError)
    expect(calls).toHaveLength(0)
    kill.release()
    await client.getRepo("acme/widget")
    expect(calls).toHaveLength(1)
  })

  test("a write waiting on the write interval is refused if the kill switch engages meanwhile", async () => {
    const fake = new FakeClock()
    let killRef: KillSwitch | null = null
    const clock: Clock = {
      now: () => fake.now(),
      sleep: async (ms) => {
        await fake.sleep(ms)
        killRef?.engage("engaged while waiting", fake.now())
      },
    }
    const { client, calls, kill } = setup(() => json(ghComment(), { status: 201 }), { clock })
    killRef = kill
    await client.createIssueComment(approval(), "acme/widget", 1, "first")
    expect(await caught(client.createIssueComment(approval(), "acme/widget", 1, "second"))).toBeInstanceOf(KilledError)
    expect(calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// rate limits
// ---------------------------------------------------------------------------

describe("rate limits", () => {
  test("primary limit: 403 with remaining=0 → RateLimitError at reset, then proactive block until reset", async () => {
    let n = 0
    const { client, calls, clock } = setup(() => {
      n++
      if (n === 1) {
        const reset = Math.floor(clock.now() / 1000) + 600
        return json({ message: "API rate limit exceeded" }, { status: 403, headers: limitHeaders(0, reset) })
      }
      return json(ghRepo(), { headers: limitHeaders(4999, Math.floor(clock.now() / 1000) + 3600) })
    })
    const resetAt = (Math.floor(clock.now() / 1000) + 600) * 1000
    const err = (await caught(client.getRepo("acme/widget"))) as RateLimitError
    expect(err).toBeInstanceOf(RateLimitError)
    expect(err.secondary).toBe(false)
    expect(err.resource).toBe("core")
    expect(err.resetAt).toBe(resetAt)

    const again = (await caught(client.getIssue("acme/widget", 1))) as RateLimitError
    expect(again).toBeInstanceOf(RateLimitError)
    expect(again.resetAt).toBe(resetAt)
    expect(calls).toHaveLength(1)

    clock.set(resetAt + 1)
    await client.getRepo("acme/widget")
    expect(calls).toHaveLength(2)
  })

  test("primary limit without a reset header still blocks proactively for 60s", async () => {
    const { client, calls, clock } = setup(() => json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } }))
    const start = clock.now()
    const err = (await caught(client.getRepo("acme/widget"))) as RateLimitError
    expect(err.secondary).toBe(false)
    expect(err.resetAt).toBe(start + 60_000)
    expect(await caught(client.getRepo("acme/widget"))).toBeInstanceOf(RateLimitError)
    expect(calls).toHaveLength(1)
  })

  test("retry-after → secondary RateLimitError and a pause (no busy retry)", async () => {
    const { client, calls, clock } = setup(() => json({ message: "slow down" }, { status: 403, headers: { "retry-after": "30" } }))
    const start = clock.now()
    const err = (await caught(client.getRepo("acme/widget"))) as RateLimitError
    expect(err).toBeInstanceOf(RateLimitError)
    expect(err.secondary).toBe(true)
    expect(err.resetAt).toBe(start + 30_000)
    expect(calls).toHaveLength(1)
    // paused: nothing is sent until the retry-after passes
    expect(await caught(client.listOwnRepos())).toBeInstanceOf(RateLimitError)
    expect(calls).toHaveLength(1)
    expect(clock.now()).toBe(start)
  })

  test("429 with retry-after is a secondary limit", async () => {
    const { client, clock } = setup(() => json({}, { status: 429, headers: { "retry-after": "5" } }))
    const err = (await caught(client.getRepo("acme/widget"))) as RateLimitError
    expect(err.secondary).toBe(true)
    expect(err.resetAt).toBe(clock.now() + 5000)
  })

  test("secondary-limit message without headers → wait 60s", async () => {
    const { client, clock } = setup(() =>
      json({ message: "You have exceeded a secondary rate limit. Please wait a few minutes." }, { status: 403 }),
    )
    const err = (await caught(client.createIssueComment(approval(), "acme/widget", 3, "x"))) as RateLimitError
    expect(err).toBeInstanceOf(RateLimitError)
    expect(err.secondary).toBe(true)
    expect(err.resetAt).toBe(clock.now() + 60_000)
  })

  test("abuse message is a secondary limit", async () => {
    const { client } = setup(() => json({ message: "You have triggered an abuse detection mechanism." }, { status: 403 }))
    const err = (await caught(client.getRepo("acme/widget"))) as RateLimitError
    expect(err).toBeInstanceOf(RateLimitError)
    expect(err.secondary).toBe(true)
  })

  test("plain 403 is a GitHubError with accepted permissions", async () => {
    const { client } = setup(() =>
      json(
        { message: "Resource not accessible by personal access token" },
        { status: 403, headers: { "x-accepted-github-permissions": "pull_requests=write", ...limitHeaders(4000, 2_000_000_000) } },
      ),
    )
    const err = (await caught(client.createPull(approval(), "acme/widget", { title: "t", body: "b", head: "me:x", base: "main" }))) as GitHubError
    expect(err).toBeInstanceOf(GitHubError)
    expect(err.status).toBe(403)
    expect(err.acceptedPermissions).toBe("pull_requests=write")
    expect(err.isTokenPermissionError).toBe(true)
    expect(err.path).toBe("/repos/acme/widget/pulls")
  })

  test("proactive block after remaining=0 on a 200; resources are tracked separately", async () => {
    const { client, calls, clock } = setup((call) => {
      const reset = Math.floor(clock.now() / 1000) + 120
      if (call.url.pathname.startsWith("/search/")) return json({ items: [ghIssue()] }, { headers: limitHeaders(0, reset, "search") })
      return json(ghRepo(), { headers: limitHeaders(10, reset, "core") })
    })
    await client.searchIssues("is:issue is:open", { max: 1 })
    const err = (await caught(client.searchIssues("is:issue label:bug", { max: 1 }))) as RateLimitError
    expect(err).toBeInstanceOf(RateLimitError)
    expect(err.resource).toBe("search")
    expect(err.secondary).toBe(false)
    expect(calls).toHaveLength(1)
    await client.getRepo("acme/widget")
    expect(calls).toHaveLength(2)
    const snap = client.rateLimitSnapshot().sort((a, b) => a.resource.localeCompare(b.resource))
    expect(snap.map((s) => [s.resource, s.remaining, s.limit])).toEqual([
      ["core", 10, 5000],
      ["search", 0, 5000],
    ])
    expect(snap[1]!.resetAt).toBe((Math.floor(clock.now() / 1000) + 120) * 1000)
  })
})

// ---------------------------------------------------------------------------
// retries
// ---------------------------------------------------------------------------

describe("retries", () => {
  test("5xx on GET retries twice with 1s/2s backoff then succeeds", async () => {
    const { client, calls, clock } = setup((_c, i) => (i < 2 ? json({ message: "boom" }, { status: 502 + i }) : json(ghRepo())))
    const start = clock.now()
    const repo = await client.getRepo("acme/widget")
    expect(repo.full_name).toBe("acme/widget")
    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c.at - start)).toEqual([0, 1000, 3000])
  })

  test("5xx exhausted → GitHubError after 3 attempts", async () => {
    const { client, calls } = setup(() => json({ message: "Service Unavailable" }, { status: 503 }))
    const err = (await caught(client.getRepo("acme/widget"))) as GitHubError
    expect(err).toBeInstanceOf(GitHubError)
    expect(err.status).toBe(503)
    expect(calls).toHaveLength(3)
  })

  test("network errors on GET are retried", async () => {
    const { client, calls } = setup((_c, i) => {
      if (i === 0) throw new TypeError("socket hang up")
      return json(ghRepo())
    })
    await client.getRepo("acme/widget")
    expect(calls).toHaveLength(2)
  })

  test("writes are never retried", async () => {
    const { client, calls } = setup(() => json({ message: "Server Error" }, { status: 502 }))
    const err = (await caught(client.createIssueComment(approval(), "acme/widget", 1, "hello"))) as GitHubError
    expect(err.status).toBe(502)
    expect(calls).toHaveLength(1)
  })

  test("4xx are not retried; 422 detail is included", async () => {
    const { client, calls } = setup(() =>
      json({ message: "Validation Failed", errors: [{ message: "A pull request already exists for me:fix." }] }, { status: 422 }),
    )
    const err = (await caught(client.createPull(approval(), "acme/widget", { title: "t", body: "b", head: "me:fix", base: "main" }))) as GitHubError
    expect(err.message).toBe("Validation Failed: A pull request already exists for me:fix.")
    expect(calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------

test("requests are serialized (never more than one in flight)", async () => {
  let inFlight = 0
  let maxInFlight = 0
  const { client, calls } = setup(async () => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 2))
    inFlight--
    return json(ghRepo())
  })
  await Promise.all([client.getRepo("a/b"), client.getRepo("c/d"), client.getIssue("a/b", 1), client.listOwnRepos({ max: 1 })])
  expect(calls).toHaveLength(4)
  expect(maxInFlight).toBe(1)
})

test("a failing request does not break the queue", async () => {
  const { client } = setup((c) => (c.url.pathname.endsWith("/bad") ? json({ message: "Not Found" }, { status: 404 }) : json(ghRepo())))
  const results = await Promise.allSettled([client.getRepo("acme/bad"), client.getRepo("acme/widget")])
  expect(results[0]!.status).toBe("rejected")
  expect(results[1]!.status).toBe("fulfilled")
})

// ---------------------------------------------------------------------------
// pagination + conditional requests
// ---------------------------------------------------------------------------

describe("pagination", () => {
  test("follows Link rel=next until max; per_page = min(100, max)", async () => {
    const page = (start: number, n: number) => Array.from({ length: n }, (_, i) => ghComment({ id: start + i }))
    const { client, calls } = setup((call) => {
      const p = Number(call.url.searchParams.get("page") ?? "1")
      const next = `${API}/repos/acme/widget/issues/5/comments?per_page=100&since=2026-01-01T00%3A00%3A00Z&page=${p + 1}`
      return json(page((p - 1) * 100, 100), { headers: { link: `<${next}>; rel="next"` } })
    })
    const comments = await client.listIssueComments("acme/widget", 5, { max: 150, since: "2026-01-01T00:00:00Z" })
    expect(comments).toHaveLength(150)
    expect(comments[149]!.id).toBe(149)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("100")
    expect(calls[0]!.url.searchParams.get("since")).toBe("2026-01-01T00:00:00Z")
    expect(calls[1]!.url.searchParams.get("page")).toBe("2")
  })

  test("small max uses a small page and a single request", async () => {
    const { client, calls } = setup(() =>
      json([ghPull({ number: 1 }), ghPull({ number: 2 })], { headers: { link: `<${API}/repos/acme/widget/pulls?page=2>; rel="next"` } }),
    )
    const pulls = await client.listPulls("acme/widget", { max: 2, state: "closed", sort: "updated", direction: "desc", head: "me:fix" })
    expect(pulls.map((p) => p.number)).toEqual([1, 2])
    expect(calls).toHaveLength(1)
    const q = calls[0]!.url.searchParams
    expect([q.get("per_page"), q.get("state"), q.get("sort"), q.get("direction"), q.get("head")]).toEqual(["2", "closed", "updated", "desc", "me:fix"])
  })

  test("stops at the last page and never follows a foreign-origin next link", async () => {
    const { client, calls } = setup(() => json([ghPull()], { headers: { link: `<https://evil.example/steal?page=2>; rel="next"` } }))
    const pulls = await client.listPulls("acme/widget")
    expect(pulls).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  test("max 0 makes no request", async () => {
    const { client, calls } = setup(() => json([]))
    expect(await client.listCommits("acme/widget", { max: 0 })).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test("listOwnRepos, listCommits, reviews, review comments and timeline hit the right endpoints", async () => {
    const { client, calls } = setup(() => json([]))
    await client.listOwnRepos({ max: 30 })
    await client.listCommits("acme/widget", { since: "2026-01-01T00:00:00Z", sha: "main", max: 10 })
    await client.listPullReviews("acme/widget", 9)
    await client.listPullReviewComments("acme/widget", 9, { since: "2026-01-02T00:00:00Z" })
    await client.listIssueTimeline("acme/widget", 4)
    const urls = calls.map((c) => `${c.url.pathname}?${c.url.searchParams.toString()}`)
    expect(urls).toEqual([
      "/user/repos?affiliation=owner&sort=pushed&direction=desc&per_page=30",
      "/repos/acme/widget/commits?since=2026-01-01T00%3A00%3A00Z&sha=main&per_page=10",
      "/repos/acme/widget/pulls/9/reviews?per_page=100",
      "/repos/acme/widget/pulls/9/comments?since=2026-01-02T00%3A00%3A00Z&per_page=100",
      "/repos/acme/widget/issues/4/timeline?per_page=100",
    ])
  })
})

describe("conditional requests (ETag cache)", () => {
  function storeFor() {
    return new Store(openDatabase(":memory:"))
  }

  test("304 reuses the cached body and sends If-None-Match / If-Modified-Since", async () => {
    const store = storeFor()
    const { client, calls } = setup(
      (call, i) => {
        if (i === 0) return json(ghRepo({ stargazers_count: 77 }), { headers: { etag: 'W/"abc"', "last-modified": "Mon, 12 Jan 2026 10:00:00 GMT" } })
        expect(call.headers.get("if-none-match")).toBe('W/"abc"')
        expect(call.headers.get("if-modified-since")).toBe("Mon, 12 Jan 2026 10:00:00 GMT")
        return new Response(null, { status: 304, headers: { etag: 'W/"abc"' } })
      },
      { store },
    )
    const first = await client.getRepo("acme/widget")
    const second = await client.getRepo("acme/widget")
    expect(first.stargazers_count).toBe(77)
    expect(second).toEqual(first)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.headers.has("if-none-match")).toBe(false)
    const row = store.getHttpCache(`GET ${API}/repos/acme/widget`)
    expect(row?.etag).toBe('W/"abc"')
    expect(row?.body).not.toContain(TOKEN)
    store.db.close()
  })

  test("each page is cached separately and the cached next link survives a 304", async () => {
    const store = storeFor()
    const p2 = `${API}/repos/acme/widget/pulls?per_page=1&page=2`
    let round = 0
    const { client, calls } = setup(
      (call) => {
        const isP2 = call.url.searchParams.get("page") === "2"
        if (round === 1) return new Response(null, { status: 304 })
        return isP2
          ? json([ghPull({ number: 2 })], { headers: { etag: '"p2"' } })
          : json([ghPull({ number: 1 })], { headers: { etag: '"p1"', link: `<${p2}>; rel="next"` } })
      },
      { store },
    )
    const a = await client.listPulls("acme/widget", { max: 2, perPage: 1 })
    round = 1
    const b = await client.listPulls("acme/widget", { max: 2, perPage: 1 })
    expect(a.map((p) => p.number)).toEqual([1, 2])
    expect(b.map((p) => p.number)).toEqual([1, 2])
    expect(calls).toHaveLength(4)
    expect(calls[2]!.headers.get("if-none-match")).toBe('"p1"')
    expect(calls[3]!.headers.get("if-none-match")).toBe('"p2"')
    store.db.close()
  })

  test("responses without validators are not cached; tokenInfo bypasses the cache", async () => {
    const store = storeFor()
    const { client, calls } = setup(() => json(ghUser("me"), { headers: { "x-oauth-scopes": "public_repo" } }), { store })
    await client.getAuthenticatedUser()
    await client.tokenInfo()
    expect(store.getHttpCache(`GET ${API}/user`)).toBeNull()
    expect(calls.every((c) => !c.headers.has("if-none-match"))).toBe(true)
    store.db.close()
  })
})

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

describe("endpoints", () => {
  test("404 → null for getFileContent, listDirectory, getCommunityProfile; getRepo throws", async () => {
    const { client } = setup(() => json({ message: "Not Found" }, { status: 404 }))
    expect(await client.getFileContent("acme/widget", "CONTRIBUTING.md")).toBeNull()
    expect(await client.listDirectory("acme/widget", ".github")).toBeNull()
    expect(await client.getCommunityProfile("acme/widget")).toBeNull()
    const err = (await caught(client.getRepo("acme/widget"))) as GitHubError
    expect(err).toBeInstanceOf(GitHubError)
    expect(err.status).toBe(404)
    expect(err.message).toBe("Not Found")
  })

  test("getFileContent decodes base64 with embedded newlines and encodes the path", async () => {
    const text = "# Contributing\n\nUse conventional commits. Ünïcödé ✓\n"
    const b64 = Buffer.from(text, "utf8").toString("base64").replace(/(.{20})/g, "$1\n")
    const { client, calls } = setup(() => json({ type: "file", encoding: "base64", content: b64, size: text.length, name: "x", path: "x", sha: "s" }))
    expect(await client.getFileContent("acme/widget", "docs/My Guide.md", "v1.2")).toBe(text)
    expect(calls[0]!.url.pathname).toBe("/repos/acme/widget/contents/docs/My%20Guide.md")
    expect(calls[0]!.url.searchParams.get("ref")).toBe("v1.2")
  })

  test("getFileContent returns null for directories and non-file entries", async () => {
    const { client } = setup((c) =>
      c.url.pathname.endsWith("/dir") ? json([{ type: "file", name: "a", path: "dir/a", size: 1, sha: "s" }]) : json({ type: "symlink", target: "x" }),
    )
    expect(await client.getFileContent("acme/widget", "dir")).toBeNull()
    expect(await client.getFileContent("acme/widget", "link")).toBeNull()
  })

  test("getFileContent refetches large files with the raw media type", async () => {
    const { client, calls } = setup((c) => {
      if (c.headers.get("accept") === GITHUB_RAW_ACCEPT) return new Response("big raw content", { status: 200 })
      return json({ type: "file", encoding: "none", content: "", size: 5_000_000, name: "big", path: "big", sha: "s" })
    })
    expect(await client.getFileContent("acme/widget", "big.json")).toBe("big raw content")
    expect(calls).toHaveLength(2)
    expect(calls[1]!.headers.get("accept")).toBe(GITHUB_RAW_ACCEPT)
  })

  test("empty files decode to an empty string without a second request", async () => {
    const { client, calls } = setup(() => json({ type: "file", encoding: "base64", content: "", size: 0, name: "e", path: "e", sha: "s" }))
    expect(await client.getFileContent("acme/widget", "empty.txt")).toBe("")
    expect(calls).toHaveLength(1)
  })

  test("listDirectory returns arrays only", async () => {
    const entries = [{ type: "file", name: "CONTRIBUTING.md", path: ".github/CONTRIBUTING.md", size: 10, sha: "a" }]
    const { client, calls } = setup((c) => (c.url.pathname.endsWith("/.github") ? json(entries) : json({ type: "file" })))
    expect(await client.listDirectory("acme/widget", ".github")).toEqual(entries as never)
    expect(await client.listDirectory("acme/widget", "README.md")).toBeNull()
    expect(calls[0]!.url.pathname).toBe("/repos/acme/widget/contents/.github")
  })

  test("getTree requests recursive trees and returns entries", async () => {
    const tree = [{ path: "src/a.ts", type: "blob", sha: "1", size: 3 }]
    const { client, calls } = setup(() => json({ sha: "t", tree, truncated: false }))
    expect(await client.getTree("acme/widget", "feature/x", true)).toEqual(tree as never)
    expect(calls[0]!.url.pathname).toBe("/repos/acme/widget/git/trees/feature%2Fx")
    expect(calls[0]!.url.searchParams.get("recursive")).toBe("1")
    await client.getTree("acme/widget", "main", false)
    expect(calls[1]!.url.searchParams.has("recursive")).toBe(false)
  })

  test("invalid names and paths are rejected before any request", async () => {
    const { client, calls } = setup(() => json({}))
    expect(await caught(client.getRepo("../user"))).toBeInstanceOf(Error)
    expect(await caught(client.getRepo("noslash"))).toBeInstanceOf(Error)
    expect(await caught(client.getFileContent("acme/widget", "../../../user"))).toBeInstanceOf(Error)
    expect(await caught(client.getIssue("acme/widget", -1))).toBeInstanceOf(Error)
    expect(calls).toHaveLength(0)
  })

  test("searchIssues requires is:issue / is:pr and sends advanced_search=true", async () => {
    const { client, calls } = setup(() => json({ total_count: 1, incomplete_results: false, items: [ghIssue({ number: 3 })] }))
    expect(await caught(client.searchIssues("label:bug repo:acme/widget"))).toBeInstanceOf(Error)
    expect(calls).toHaveLength(0)
    const items = await client.searchIssues('is:issue is:open label:"good first issue"', { max: 10, sort: "updated", order: "desc" })
    expect(items.map((i) => i.number)).toEqual([3])
    const q = calls[0]!.url.searchParams
    expect(calls[0]!.url.pathname).toBe("/search/issues")
    expect(q.get("q")).toBe('is:issue is:open label:"good first issue"')
    expect(q.get("advanced_search")).toBe("true")
    expect([q.get("sort"), q.get("order"), q.get("per_page")]).toEqual(["updated", "desc", "10"])
  })

  test("searchRepositories returns items and caps results at 1000", async () => {
    const { client, calls } = setup((c) => {
      const p = Number(c.url.searchParams.get("page") ?? "1")
      const items = Array.from({ length: 100 }, (_, i) => ghRepo({ id: (p - 1) * 100 + i, full_name: `o/r${(p - 1) * 100 + i}` }))
      return json({ items }, { headers: { link: `<${API}/search/repositories?q=x&per_page=100&page=${p + 1}>; rel="next"` } })
    })
    const repos = await client.searchRepositories("language:go stars:>100", { max: 5000, sort: "stars" })
    expect(repos).toHaveLength(1000)
    expect(calls).toHaveLength(10)
    expect(calls[0]!.url.searchParams.get("sort")).toBe("stars")
  })

  test("getIssue / getPull / getCommunityProfile", async () => {
    const { client, calls } = setup((c) => {
      if (c.url.pathname.endsWith("/issues/12")) return json(ghIssue({ number: 12 }))
      if (c.url.pathname.endsWith("/pulls/8")) return json(ghPull({ number: 8 }))
      return json({ health_percentage: 80, files: {} })
    })
    expect((await client.getIssue("acme/widget", 12)).number).toBe(12)
    expect((await client.getPull("acme/widget", 8)).number).toBe(8)
    expect((await client.getCommunityProfile("acme/widget"))?.health_percentage).toBe(80)
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/repos/acme/widget/issues/12",
      "/repos/acme/widget/pulls/8",
      "/repos/acme/widget/community/profile",
    ])
  })
})

// ---------------------------------------------------------------------------
// tokenInfo
// ---------------------------------------------------------------------------

describe("tokenInfo", () => {
  test("classic token: scopes from X-OAuth-Scopes", async () => {
    const { client } = setup(() => json(ghUser("me"), { headers: { "x-oauth-scopes": "public_repo, read:org" } }))
    const info = await client.tokenInfo()
    expect(info).toEqual({ login: "me", kind: "classic", scopes: ["public_repo", "read:org"] })
    expect(JSON.stringify(info)).not.toContain(TOKEN)
  })

  test("fine-grained token: no scopes header → null", async () => {
    const { client } = setup(() => json(ghUser("me")), { token: "github_pat_11ABCDEFG0123456789_abcdefghijklmnop" })
    expect(await client.tokenInfo()).toEqual({ login: "me", kind: "fine-grained", scopes: null })
  })

  test("other token kinds", async () => {
    const { client } = setup(() => json(ghUser("me"), { headers: { "x-oauth-scopes": "" } }), { token: "gho_oauthTokenValue000000000000000" })
    expect(await client.tokenInfo()).toEqual({ login: "me", kind: "other", scopes: [] })
  })
})

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

describe("writes", () => {
  const forged = { queueItemId: 7, digest: "abcdef01", approvedAt: 0, via: "cli" } as unknown as WriteAuthorization

  async function expectForbidden(client: GitHubApi, auth: WriteAuthorization) {
    expect(await caught(client.createFork(auth, "acme/widget"))).toBeInstanceOf(WriteForbiddenError)
    expect(await caught(client.createPull(auth, "acme/widget", { title: "t", body: "b", head: "me:x", base: "main" }))).toBeInstanceOf(
      WriteForbiddenError,
    )
    expect(await caught(client.createIssueComment(auth, "acme/widget", 1, "hi"))).toBeInstanceOf(WriteForbiddenError)
  }

  test("forbidden without a minted WriteAuthorization", async () => {
    const { client, calls } = setup(() => json({}, { status: 201 }))
    await expectForbidden(client, forged)
    await expectForbidden(client, undefined as unknown as WriteAuthorization)
    expect(calls).toHaveLength(0)
  })

  test("forbidden when allowWrites=false even with a valid authorization", async () => {
    const { client, calls } = setup(() => json({}, { status: 201 }), { allowWrites: false })
    await expectForbidden(client, approval())
    expect(calls).toHaveLength(0)
  })

  test("createPull posts the expected payload", async () => {
    const { client, calls } = setup(() => json(ghPull({ number: 101, state: "open" }), { status: 201 }))
    const pr = await client.createPull(approval(), "acme/widget", {
      title: "fix: zero timeout",
      body: "Body\n\nPrepared with AI assistance.",
      head: "me:oss-scout/42-fix",
      base: "main",
    })
    expect(pr.number).toBe(101)
    const c = calls[0]!
    expect(c.method).toBe("POST")
    expect(c.url.toString()).toBe(`${API}/repos/acme/widget/pulls`)
    expect(c.headers.get("content-type")).toBe("application/json")
    expect(c.headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(c.body).toEqual({
      title: "fix: zero timeout",
      body: "Body\n\nPrepared with AI assistance.",
      head: "me:oss-scout/42-fix",
      base: "main",
      draft: false,
      maintainer_can_modify: true,
    })
  })

  test("createIssueComment posts the body; min write interval is honored", async () => {
    const { client, calls, clock } = setup(() => json(ghComment({ body: "ok" }), { status: 201 }))
    const start = clock.now()
    await client.createIssueComment(approval(), "acme/widget", 5, "first")
    await client.createIssueComment(approval(), "acme/widget", 5, "second")
    clock.advance(5000)
    await client.createIssueComment(approval(), "acme/widget", 5, "third")
    expect(calls.map((c) => c.body)).toEqual([{ body: "first" }, { body: "second" }, { body: "third" }])
    expect(calls[0]!.url.pathname).toBe("/repos/acme/widget/issues/5/comments")
    expect(calls[0]!.at).toBe(start)
    expect(calls[1]!.at - calls[0]!.at).toBe(1500)
    // enough time had passed already: no extra wait
    expect(calls[2]!.at - calls[1]!.at).toBe(5000)
  })

  test("reads are not delayed by the write interval", async () => {
    const { client, calls } = setup((c) => (c.method === "POST" ? json(ghComment(), { status: 201 }) : json(ghRepo())))
    await client.createIssueComment(approval(), "acme/widget", 5, "x")
    await client.getRepo("acme/widget")
    expect(calls[1]!.at).toBe(calls[0]!.at)
  })

  test("createFork posts default_branch_only and polls until repo and branch are reachable", async () => {
    let repoPolls = 0
    let branchPolls = 0
    const { client, calls, clock } = setup((c) => {
      if (c.method === "POST") return json(ghRepo({ full_name: "me/widget", fork: true, default_branch: "main" }), { status: 202 })
      if (c.url.pathname === "/repos/me/widget") {
        repoPolls++
        return repoPolls < 3 ? json({ message: "Not Found" }, { status: 404 }) : json(ghRepo({ full_name: "me/widget", fork: true }))
      }
      if (c.url.pathname === "/repos/me/widget/branches/main") {
        branchPolls++
        return branchPolls < 2 ? json({ message: "Branch not found" }, { status: 404 }) : json({ name: "main" })
      }
      return json({ message: "unexpected" }, { status: 500 })
    })
    const start = clock.now()
    const fork = await client.createFork(approval(), "acme/widget")
    expect(fork.full_name).toBe("me/widget")
    expect(calls[0]!.url.pathname).toBe("/repos/acme/widget/forks")
    expect(calls[0]!.body).toEqual({ default_branch_only: true })
    // polls: repo 404 (t=0), repo 404 (t=2s), repo 200 + branch 404 (t=6s), repo 200 + branch 200 (t=14s)
    expect(calls.slice(1).map((c) => [c.url.pathname, c.at - start])).toEqual([
      ["/repos/me/widget", 0],
      ["/repos/me/widget", 2000],
      ["/repos/me/widget", 6000],
      ["/repos/me/widget/branches/main", 6000],
      ["/repos/me/widget", 14000],
      ["/repos/me/widget/branches/main", 14000],
    ])
  })

  test("createFork gives up after forkPollTimeoutMs", async () => {
    const { client, clock } = setup(
      (c) => (c.method === "POST" ? json(ghRepo({ full_name: "me/widget" }), { status: 202 }) : json({ message: "Not Found" }, { status: 404 })),
      { forkPollTimeoutMs: 60_000 },
    )
    const start = clock.now()
    const err = (await caught(client.createFork(approval(), "acme/widget"))) as GitHubError
    expect(err).toBeInstanceOf(GitHubError)
    expect(err.message).toContain("me/widget")
    expect(clock.now() - start).toBe(60_000)
  })
})
