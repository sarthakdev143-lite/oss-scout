import { afterEach, describe, expect, test } from "bun:test"
import type { ConfigInput } from "../src/config/schema.ts"
import {
  buildRepoSearchQueries,
  dependencySourceDetail,
  DISCOVERY_LAST_RUN_KEY,
  runDiscovery,
  searchSkipReason,
  searchSortFor,
  selectManifestPaths,
  type DiscoveryLastRun,
} from "../src/discovery/discover.ts"
import type { DependencyRef } from "../src/discovery/manifests.ts"
import type { RegistryResolver } from "../src/discovery/registries.ts"
import { GitHubError, KilledError, RateLimitError } from "../src/github/api.ts"
import type { GhRepo, GhTreeEntry } from "../src/github/types.ts"
import { DAY, HOUR } from "../src/util/clock.ts"
import { FakeGitHub, ghRepo, ghUser, makeTestContext, testConfig, type TestContext } from "./helpers/fakes.ts"

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function own(name: string, over: Partial<GhRepo> = {}): GhRepo {
  return ghRepo({ full_name: `me/${name}`, owner: ghUser("me"), stargazers_count: 3, ...over })
}

function blob(path: string, size = 100): GhTreeEntry {
  return { path, type: "blob", size, sha: "abc" }
}

const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}, name?: string) =>
  JSON.stringify({ ...(name ? { name } : {}), dependencies: deps, devDependencies: dev })

/** Own repos with manifests; me/lib publishes "@me/lib" which me/app depends on. */
const OWN_FILES: Record<string, Record<string, string>> = {
  "me/app": {
    "package.json": pkg({ zod: "^3", react: "^19", "@me/lib": "^1.0.0", "my-published": "^1" }, { vitest: "^2", typescript: "5.9.3" }),
    "packages/ui/package.json": pkg({ react: "^19", clsx: "^2" }),
    "node_modules/leftpad/package.json": pkg({ vendored: "1" }),
    "a/b/c/d/package.json": pkg({ "too-deep": "1" }),
    "test/fixtures/package.json": pkg({ fixture: "1" }),
    "README.md": "# app",
  },
  "me/api": {
    "requirements.txt": "fastapi>=0.110\npydantic>=2\n",
    "requirements-dev.txt": "pytest\n",
    "web/package.json": pkg({ zod: "^3" }),
  },
  "me/lib": { "package.json": pkg({}, {}, "@me/lib") },
  "me/forked": { "package.json": pkg({ forkdep: "1" }) },
  "me/old": { "package.json": pkg({ olddep: "1" }) },
}

const REGISTRY: Record<string, string> = {
  "npm:zod": "colinhacks/zod",
  "npm:react": "facebook/react",
  "npm:clsx": "lukeed/clsx",
  "npm:my-published": "me/published",
  "npm:vitest": "vitest-dev/vitest",
  "npm:typescript": "microsoft/TypeScript",
  "npm:@me/lib": "me/lib",
  "pypi:fastapi": "fastapi/fastapi",
  "pypi:pydantic": "pydantic/pydantic",
  "pypi:pytest": "pytest-dev/pytest",
}

function mapResolver(map: Record<string, string | null> = REGISTRY): RegistryResolver & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async resolve(dep: DependencyRef) {
      const key = `${dep.ecosystem}:${dep.name}`
      calls.push(key)
      return map[key] ?? null
    },
  }
}

function ownReposGitHub(files: Record<string, Record<string, string>> = OWN_FILES): FakeGitHub {
  return new FakeGitHub({
    listOwnRepos: async () => [
      own("app"),
      own("api"),
      own("lib"),
      own("forked", { fork: true }),
      own("old", { archived: true }),
      own("empty"),
      own("broken"),
    ],
    getTree: async (fullName: string) => {
      if (fullName === "me/empty") throw new GitHubError("Git Repository is empty.", 409)
      if (fullName === "me/broken") throw new Error("boom: tree exploded")
      return Object.keys(files[fullName] ?? {}).map((p) => blob(p))
    },
    getFileContent: async (fullName: string, path: string) => files[fullName]?.[path] ?? null,
  })
}

let ctx: TestContext | null = null
afterEach(() => {
  ctx?.cleanup()
  ctx = null
})

function context(config: ConfigInput, github: FakeGitHub, extra: Parameters<typeof makeTestContext>[0] = {}): TestContext {
  ctx = makeTestContext({ ...extra, config, github })
  return ctx
}

const DEPS_ONLY: ConfigInput = { discovery: { fromSearch: false } }

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("selectManifestPaths", () => {
  test("depth ≤ 3, skipped directories, blobs only, shallow first", () => {
    const tree: GhTreeEntry[] = [
      blob("packages/ui/package.json"),
      blob("package.json"),
      blob("node_modules/x/package.json"),
      blob("vendor/pkg/pom.xml"),
      blob("dist/package.json"),
      blob("build/pom.xml"),
      blob(".venv/lib/pyproject.toml"),
      blob("tests/fixtures/requirements.txt"),
      blob("examples/demo/package.json"),
      blob("a/b/c/package.json"),
      blob("a/b/c/d/package.json"),
      blob("gradle/libs.versions.toml"),
      blob("huge/package.json", 5_000_000),
      { path: "sub/package.json", type: "tree", sha: "t" },
      blob("src/index.ts"),
    ]
    expect(selectManifestPaths(tree)).toEqual(["package.json", "gradle/libs.versions.toml", "packages/ui/package.json", "a/b/c/package.json"])
  })

  test("caps the number of manifests per repo", () => {
    const tree = Array.from({ length: 40 }, (_, i) => blob(`pkg${String(i).padStart(2, "0")}/package.json`))
    expect(selectManifestPaths(tree, 5)).toHaveLength(5)
    expect(selectManifestPaths(tree)).toHaveLength(25)
  })
})

describe("searchSkipReason", () => {
  const config = testConfig({ screening: { minStars: 100, maxStars: 50_000 } })
  test.each([
    [{}, null],
    [{ archived: true }, "archived"],
    [{ disabled: true }, "disabled"],
    [{ fork: true }, "fork"],
    [{ private: true }, "private repository"],
    [{ stargazers_count: 99 }, "stars 99 < minStars 100"],
    [{ stargazers_count: 60_000 }, "stars 60000 > maxStars 50000"],
    [{ has_issues: false }, "issues disabled"],
    [{ has_pull_requests: false }, "pull requests disabled"],
    [{ pull_request_creation_policy: "collaborators_only" as const }, "pull requests limited to collaborators"],
  ])("%p → %p", (over, expected) => {
    expect(searchSkipReason(ghRepo(over as Partial<GhRepo>), config)).toBe(expected)
  })
})

test("dependencySourceDetail caps long lists", () => {
  expect(dependencySourceDetail(["npm:zod"], ["you/app", "you/api"])).toBe("npm:zod (used by you/app, you/api)")
  expect(dependencySourceDetail(["a", "b", "c", "d", "e"], ["x"])).toBe("a, b, c +2 more (used by x)")
})

describe("buildRepoSearchQueries", () => {
  const NOW = Date.UTC(2026, 9, 11, 12, 0, 0)
  const stripPushed = (q: string) => q.replace(/ pushed:>\d{4}-\d{2}-\d{2}/, "")

  test("default interests: ≤ 12 unique queries with filters and both issue variants", () => {
    const queries = buildRepoSearchQueries(testConfig(), NOW)
    expect(queries.length).toBe(12)
    expect(new Set(queries).size).toBe(12)
    for (const q of queries) {
      expect(q).toContain("stars:>=100 pushed:>2026-08-12 archived:false")
      expect(q).toMatch(/ (good-first-issues|help-wanted-issues):>2$/)
      expect(q.length).toBeLessThan(256)
    }
  })

  test("never pairs a topic with a language it does not use; rotation covers everything", () => {
    const config = testConfig()
    const union = new Set<string>()
    for (let slot = 0; slot < 3; slot++) {
      for (const q of buildRepoSearchQueries(config, NOW + slot * config.discovery.intervalHours * HOUR)) union.add(stripPushed(q))
    }
    const all = [...union]
    expect(all.length).toBe(36)
    expect(all).toContain("language:TypeScript topic:react stars:>=100 archived:false good-first-issues:>2")
    expect(all).toContain("language:TypeScript topic:react stars:>=100 archived:false help-wanted-issues:>2")
    expect(all).toContain("language:Python topic:fastapi stars:>=100 archived:false good-first-issues:>2")
    expect(all).toContain("language:Java topic:spring-boot stars:>=100 archived:false good-first-issues:>2")
    expect(all).toContain("language:Python topic:llm stars:>=100 archived:false good-first-issues:>2")
    expect(all.some((q) => q.includes("language:Python topic:react"))).toBe(false)
    expect(all.some((q) => q.includes("language:Java topic:fastapi"))).toBe(false)
    for (const topic of ["react", "nextjs", "fastapi", "spring-boot", "mongodb", "llm", "ai-tools"]) {
      expect(all.some((q) => q.includes(`topic:${topic} `))).toBe(true)
    }
  })

  test("the same slot yields the same queries (deterministic)", () => {
    const config = testConfig()
    expect(buildRepoSearchQueries(config, NOW)).toEqual(buildRepoSearchQueries(config, NOW + 1000))
  })

  test("small interest sets: exact queries, keywords quoted, unmatched topics searched without a language", () => {
    const config = testConfig({
      interests: { languages: ["Python"], topics: ["fastapi", "react", "FastAPI"], keywords: ['machine "learning"'] },
      screening: { minStars: 50, maxStars: 5000 },
      discovery: { searchPushedWithinDays: 30 },
    })
    const f = "stars:50..5000 pushed:>2026-09-11 archived:false"
    expect(buildRepoSearchQueries(config, NOW)).toEqual([
      `language:Python topic:fastapi ${f} good-first-issues:>2`,
      `language:Python topic:fastapi ${f} help-wanted-issues:>2`,
      `topic:react ${f} good-first-issues:>2`,
      `topic:react ${f} help-wanted-issues:>2`,
      `language:Python "machine learning" ${f} good-first-issues:>2`,
      `language:Python "machine learning" ${f} help-wanted-issues:>2`,
    ])
  })

  test("languages only, quoted language names, and empty interests", () => {
    const langsOnly = testConfig({ interests: { languages: ["Go", "Jupyter Notebook"], topics: [], keywords: [] } })
    const queries = buildRepoSearchQueries(langsOnly, NOW)
    expect(queries.map((q) => q.split(" stars:")[0])).toEqual(["language:Go", "language:Go", 'language:"Jupyter Notebook"', 'language:"Jupyter Notebook"'])
    expect(buildRepoSearchQueries(testConfig({ interests: { languages: [], topics: [], keywords: [] } }), NOW)).toEqual([])
  })

  test("topics without configured languages", () => {
    const config = testConfig({ interests: { languages: [], topics: ["llm"], keywords: [] } })
    expect(buildRepoSearchQueries(config, NOW).map((q) => q.split(" stars:")[0])).toEqual(["topic:llm", "topic:llm"])
  })

  test("sort follows the variant", () => {
    expect(searchSortFor("topic:x help-wanted-issues:>2")).toBe("help-wanted-issues")
    expect(searchSortFor("topic:x good-first-issues:>2")).toBe("updated")
  })
})

// ---------------------------------------------------------------------------
// runDiscovery: dependencies
// ---------------------------------------------------------------------------

describe("runDiscovery from dependencies", () => {
  test("aggregates usage across repos, skips dev/internal/own, ignores vendored paths, audits decisions", async () => {
    const github = ownReposGitHub()
    const c = context(DEPS_ONLY, github)
    const resolver = mapResolver()
    const report = await runDiscovery(c, { resolver })

    expect(report.added.sort()).toEqual(["colinhacks/zod", "facebook/react", "fastapi/fastapi", "lukeed/clsx", "pydantic/pydantic"])
    expect(report.existing).toBe(0)
    expect(report.skipped).toEqual([{ repo: "me/published", reason: "your own repository" }])
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toContain("me/broken: boom: tree exploded")

    // dev deps, the internal @me/lib package and vendored/deep/fixture manifests never reach the resolver
    expect(resolver.calls.sort()).toEqual(["npm:clsx", "npm:my-published", "npm:react", "npm:zod", "pypi:fastapi", "pypi:pydantic"])
    // forks and archived repos are not scanned; empty repos are not errors
    const treeRepos = github.calls.filter((x) => x.method === "getTree").map((x) => x.args[0])
    expect(treeRepos).toEqual(["me/app", "me/api", "me/lib", "me/empty", "me/broken"])
    const fetched = github.calls.filter((x) => x.method === "getFileContent").map((x) => `${x.args[0]}:${x.args[1]}`)
    expect(fetched.sort()).toEqual([
      "me/api:requirements-dev.txt",
      "me/api:requirements.txt",
      "me/api:web/package.json",
      "me/app:package.json",
      "me/app:packages/ui/package.json",
      "me/lib:package.json",
    ])
    expect(github.calls.find((x) => x.method === "getTree")?.args).toEqual(["me/app", "main", true])
    expect(github.calls.find((x) => x.method === "listOwnRepos")?.args).toEqual([{ max: 30 }])

    const zod = c.store.getRepo("colinhacks/zod")!
    expect(zod.source).toBe("dependency")
    expect(zod.status).toBe("candidate")
    expect(zod.sourceDetail).toBe("npm:zod (used by me/app, me/api)")
    expect(c.store.getRepo("facebook/react")!.sourceDetail).toBe("npm:react (used by me/app)")
    expect(c.store.getRepo("me/published")).toBeNull()

    const added = c.store.listAudit({ action: "repo.discover" })
    expect(added.map((a) => a.subject).sort()).toEqual(report.added.slice().sort())
    const zodAudit = added.find((a) => a.subject === "colinhacks/zod")!
    expect(zodAudit.actor).toBe("scout")
    expect(zodAudit.decision).toBe("added")
    expect(zodAudit.details).toMatchObject({ source: "dependency", packages: ["npm:zod"], usedBy: ["me/app", "me/api"] })
    const skipped = c.store.listAudit({ action: "repo.discover.skip" })
    expect(skipped.map((a) => [a.subject, a.reasons[0]])).toEqual([["me/published", "your own repository"]])

    expect(c.store.listErrors().map((e) => e.scope)).toEqual(["discovery"])
    const last = c.store.getKv<DiscoveryLastRun>(DISCOVERY_LAST_RUN_KEY)
    expect(last).toEqual({ at: c.clock.now(), added: 5, existing: 0, skipped: 1, errors: 1 })
  })

  test("includeDevDependencies adds dev-only packages", async () => {
    const c = context({ discovery: { fromSearch: false, includeDevDependencies: true } }, ownReposGitHub())
    const report = await runDiscovery(c, { resolver: mapResolver() })
    expect(report.added).toContain("vitest-dev/vitest")
    expect(report.added).toContain("microsoft/TypeScript")
    expect(report.added).toContain("pytest-dev/pytest")
    expect(report.added).not.toContain("me/lib")
  })

  test("deny list wins and allow list is exclusive", async () => {
    const c = context(
      { discovery: { fromSearch: false }, repos: { allow: ["colinhacks/*", "facebook/react"], deny: ["facebook/*"] } },
      ownReposGitHub(),
    )
    const report = await runDiscovery(c, { resolver: mapResolver() })
    expect(report.added).toEqual(["colinhacks/zod"])
    const reasons = Object.fromEntries(report.skipped.map((s) => [s.repo, s.reason]))
    expect(reasons["facebook/react"]).toBe("denied by config (repos.deny: facebook/*)")
    expect(reasons["fastapi/fastapi"]).toBe("not in repos.allow")
    expect(reasons["me/published"]).toBe("your own repository")
    expect(c.store.getRepo("facebook/react")).toBeNull()
    expect(c.store.listAudit({ action: "repo.discover.skip", subject: "facebook/react" })).toHaveLength(1)
  })

  test("repos already known are counted as existing and not re-audited", async () => {
    const c = context(DEPS_ONLY, ownReposGitHub())
    c.store.upsertRepoCandidate({ fullName: "colinhacks/zod", source: "manual", sourceDetail: null }, 1)
    const report = await runDiscovery(c, { resolver: mapResolver() })
    expect(report.existing).toBe(1)
    expect(report.added).not.toContain("colinhacks/zod")
    expect(c.store.getRepo("colinhacks/zod")!.source).toBe("manual")
    expect(c.store.listAudit({ subject: "colinhacks/zod" })).toEqual([])
  })

  test("caps new repos per run and stops resolving early", async () => {
    const deps = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`dep${String(i).padStart(2, "0")}`, "^1"]))
    const files = { "me/app": { "package.json": pkg(deps) } }
    const github = new FakeGitHub({
      listOwnRepos: async () => [own("app")],
      getTree: async (n: string) => Object.keys(files[n as "me/app"] ?? {}).map((p) => blob(p)),
      getFileContent: async (n: string, p: string) => files[n as "me/app"]?.[p as "package.json"] ?? null,
    })
    const map = Object.fromEntries(Object.keys(deps).map((d) => [`npm:${d}`, `org${d}/${d}`]))
    const resolver = mapResolver(map)
    const c = context({ discovery: { fromSearch: true, maxNewReposPerRun: 3 } }, github)
    const report = await runDiscovery(c, { resolver })
    expect(report.added).toEqual(["orgdep00/dep00", "orgdep01/dep01", "orgdep02/dep02"])
    expect(resolver.calls.length).toBe(16) // one batch was enough to fill the cap
    expect(github.calls.some((x) => x.method === "searchRepositories")).toBe(false) // cap reached: no searches
  })

  test("deps used by more of your repos are added first", async () => {
    const files: Record<string, Record<string, string>> = {
      "me/a": { "package.json": pkg({ rare: "1", popular: "1" }) },
      "me/b": { "package.json": pkg({ popular: "1" }) },
    }
    const github = new FakeGitHub({
      listOwnRepos: async () => [own("a"), own("b")],
      getTree: async (n: string) => Object.keys(files[n] ?? {}).map((p) => blob(p)),
      getFileContent: async (n: string, p: string) => files[n]?.[p] ?? null,
    })
    const c = context({ discovery: { fromSearch: false, maxNewReposPerRun: 1 } }, github)
    const report = await runDiscovery(c, { resolver: mapResolver({ "npm:rare": "x/rare", "npm:popular": "x/popular" }) })
    expect(report.added).toEqual(["x/popular"])
  })

  test("a rate limit while reading manifests propagates and does not record a completed run", async () => {
    const github = ownReposGitHub().set({
      getFileContent: async () => {
        throw new RateLimitError("API rate limit exceeded", Date.now() + 60_000, "core", false)
      },
    })
    const c = context(DEPS_ONLY, github)
    await expect(runDiscovery(c, { resolver: mapResolver() })).rejects.toBeInstanceOf(RateLimitError)
    expect(c.store.getKv(DISCOVERY_LAST_RUN_KEY)).toBeNull()
  })

  test("a rate limit while listing your repos propagates", async () => {
    const github = new FakeGitHub({
      listOwnRepos: async () => {
        throw new RateLimitError("secondary rate limit", Date.now() + 60_000, "core", true)
      },
    })
    const c = context(DEPS_ONLY, github)
    await expect(runDiscovery(c, { resolver: mapResolver() })).rejects.toBeInstanceOf(RateLimitError)
  })

  test("the kill switch stops discovery before any request", async () => {
    const github = ownReposGitHub()
    const c = context({}, github)
    c.kill.engage("test", c.clock.now())
    await expect(runDiscovery(c, { resolver: mapResolver() })).rejects.toBeInstanceOf(KilledError)
    expect(github.calls).toEqual([])
  })

  test("KilledError thrown by the GitHub client propagates", async () => {
    const github = ownReposGitHub().set({
      getTree: async () => {
        throw new KilledError()
      },
    })
    const c = context(DEPS_ONLY, github)
    await expect(runDiscovery(c, { resolver: mapResolver() })).rejects.toBeInstanceOf(KilledError)
  })

  test("resolver failures are tolerated", async () => {
    const c = context(DEPS_ONLY, ownReposGitHub())
    const resolver: RegistryResolver = {
      resolve: async (d) => {
        if (d.name === "react") throw new Error("registry exploded")
        return REGISTRY[`${d.ecosystem}:${d.name}`] ?? null
      },
    }
    const report = await runDiscovery(c, { resolver })
    expect(report.added).toContain("colinhacks/zod")
    expect(report.added).not.toContain("facebook/react")
  })

  test("uses the registry resolver over ctx.fetch by default (no tokens sent)", async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    const fakeFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") })
      if (url === "https://registry.npmjs.org/zod/latest") {
        return Response.json({ repository: { type: "git", url: "git+https://github.com/colinhacks/zod.git" } })
      }
      return new Response("package not found", { status: 404 })
    }) as unknown as typeof fetch
    const files = { "me/app": { "package.json": pkg({ zod: "^3" }) } }
    const github = new FakeGitHub({
      listOwnRepos: async () => [own("app")],
      getTree: async () => [blob("package.json")],
      getFileContent: async (n: string, p: string) => files[n as "me/app"]?.[p as "package.json"] ?? null,
    })
    const c = context(DEPS_ONLY, github, { fetch: fakeFetch })
    const report = await runDiscovery(c)
    expect(report.added).toEqual(["colinhacks/zod"])
    expect(seen.map((s) => s.url)).toEqual(["https://api.deps.dev/v3/systems/npm/packages/zod", "https://registry.npmjs.org/zod/latest"])
    expect(seen.every((s) => s.auth === null)).toBe(true)
    expect(c.store.getKv("registry:npm:zod")).toMatchObject({ repo: "colinhacks/zod" })
  })

  test("maxOwnRepos 0 skips dependency discovery entirely", async () => {
    const github = new FakeGitHub({})
    const c = context({ discovery: { fromSearch: false, maxOwnRepos: 0 } }, github)
    const report = await runDiscovery(c, { resolver: mapResolver() })
    expect(report).toEqual({ added: [], existing: 0, skipped: [], errors: [] })
    expect(github.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// runDiscovery: searches
// ---------------------------------------------------------------------------

describe("runDiscovery from searches", () => {
  const SEARCH_ONLY: ConfigInput = {
    discovery: { fromDependencies: false, searchResultsPerQuery: 7 },
    interests: { languages: ["TypeScript"], topics: ["react"], keywords: [] },
  }

  function searchGitHub(results: (query: string) => GhRepo[] | Promise<GhRepo[]>): FakeGitHub {
    return new FakeGitHub({ searchRepositories: async (q: string) => results(q) })
  }

  test("filters results, dedupes across queries, records the query as provenance", async () => {
    const good = ghRepo({ full_name: "acme/widget" })
    const github = searchGitHub((q) =>
      q.includes("good-first-issues")
        ? [
            good,
            ghRepo({ full_name: "acme/archived", archived: true }),
            ghRepo({ full_name: "acme/forked", fork: true }),
            ghRepo({ full_name: "acme/tiny", stargazers_count: 12 }),
            ghRepo({ full_name: "acme/noissues", has_issues: false }),
            ghRepo({ full_name: "acme/noprs", has_pull_requests: false }),
            ghRepo({ full_name: "me/mine", owner: ghUser("me") }),
          ]
        : [good, ghRepo({ full_name: "acme/other" }), ghRepo({ full_name: "acme/archived", archived: true })],
    )
    const c = context(SEARCH_ONLY, github)
    const report = await runDiscovery(c)
    expect(report.added).toEqual(["acme/widget", "acme/other"])
    expect(report.skipped).toEqual([
      { repo: "acme/archived", reason: "archived" },
      { repo: "acme/forked", reason: "fork" },
      { repo: "acme/tiny", reason: "stars 12 < minStars 100" },
      { repo: "acme/noissues", reason: "issues disabled" },
      { repo: "acme/noprs", reason: "pull requests disabled" },
      { repo: "me/mine", reason: "your own repository" },
    ])
    const searches = github.calls.filter((x) => x.method === "searchRepositories")
    expect(searches).toHaveLength(2)
    const [gfiQuery, gfiOpts] = searches[0]!.args as [string, Record<string, unknown>]
    expect(gfiQuery).toMatch(/^language:TypeScript topic:react stars:>=100 pushed:>\d{4}-\d{2}-\d{2} archived:false good-first-issues:>2$/)
    expect(gfiOpts).toEqual({ sort: "updated", order: "desc", max: 7, perPage: 7 })
    expect((searches[1]!.args[1] as Record<string, unknown>).sort).toBe("help-wanted-issues")

    const widget = c.store.getRepo("acme/widget")!
    expect(widget.source).toBe("search")
    expect(widget.sourceDetail).toBe(gfiQuery)
    expect(c.store.listAudit({ action: "repo.discover.skip" })).toHaveLength(6)
    expect(c.store.listAudit({ action: "repo.discover", subject: "acme/widget" })[0]!.details).toMatchObject({
      source: "search",
      query: gfiQuery,
      stars: 1200,
    })
  })

  test("stops searching once the cap is reached", async () => {
    const github = searchGitHub((q) =>
      Array.from({ length: 5 }, (_, i) => ghRepo({ full_name: `org/${q.includes("help") ? "h" : "g"}${i}` })),
    )
    const c = context({ ...SEARCH_ONLY, discovery: { fromDependencies: false, maxNewReposPerRun: 3 } }, github)
    const report = await runDiscovery(c)
    expect(report.added).toEqual(["org/g0", "org/g1", "org/g2"])
    expect(github.calls.filter((x) => x.method === "searchRepositories")).toHaveLength(1)
    expect(c.store.countRepos().candidate).toBe(3)
  })

  test("a failing query is recorded and the pass continues", async () => {
    const github = searchGitHub((q) => {
      if (q.includes("good-first-issues")) throw new GitHubError("Validation Failed", 422)
      return [ghRepo({ full_name: "acme/widget" })]
    })
    const c = context(SEARCH_ONLY, github)
    const report = await runDiscovery(c)
    expect(report.added).toEqual(["acme/widget"])
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toMatch(/^search "language:TypeScript topic:react .*good-first-issues:>2": Validation Failed$/)
  })

  test("a search rate limit propagates", async () => {
    const github = searchGitHub(() => {
      throw new RateLimitError("search rate limit", Date.now() + 60_000, "search", false)
    })
    const c = context(SEARCH_ONLY, github)
    await expect(runDiscovery(c)).rejects.toBeInstanceOf(RateLimitError)
  })

  test("a login failure is recorded but discovery continues", async () => {
    const github = searchGitHub(() => [ghRepo({ full_name: "acme/widget" })])
    ctx = makeTestContext({ config: SEARCH_ONLY, github })
    const c = Object.assign(Object.create(ctx) as TestContext, {
      login: async () => {
        throw new Error("Bad credentials")
      },
    })
    const report = await runDiscovery(c)
    expect(report.added).toEqual(["acme/widget"])
    expect(report.errors).toEqual(["login: Bad credentials"])
  })

  test("dependency and search sources share the per-run dedupe and cap", async () => {
    const files = { "me/app": { "package.json": pkg({ zod: "^3" }) } }
    const github = new FakeGitHub({
      listOwnRepos: async () => [own("app")],
      getTree: async () => [blob("package.json")],
      getFileContent: async (n: string, p: string) => files[n as "me/app"]?.[p as "package.json"] ?? null,
      searchRepositories: async () => [ghRepo({ full_name: "colinhacks/zod" }), ghRepo({ full_name: "acme/widget" })],
    })
    const c = context({ ...SEARCH_ONLY, discovery: { fromDependencies: true } }, github)
    const report = await runDiscovery(c, { resolver: mapResolver() })
    expect(report.added).toEqual(["colinhacks/zod", "acme/widget"])
    expect(c.store.getRepo("colinhacks/zod")!.source).toBe("dependency")
    expect(report.existing).toBe(0)
  })

  test("a second run counts previous candidates as existing", async () => {
    const github = searchGitHub(() => [ghRepo({ full_name: "acme/widget" })])
    const c = context(SEARCH_ONLY, github)
    await runDiscovery(c)
    c.clock.advance(DAY)
    const second = await runDiscovery(c)
    expect(second.added).toEqual([])
    expect(second.existing).toBe(1)
    expect(c.store.getKv<DiscoveryLastRun>(DISCOVERY_LAST_RUN_KEY)!.at).toBe(c.clock.now())
  })
})
