import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { DependencyRef, PackageEcosystem } from "../src/discovery/manifests.ts"
import {
  createRegistryResolver,
  depsDevDefaultVersion,
  mavenMetadataVersion,
  normalizeGithubRepoUrl,
  registryCacheKey,
  REGISTRY_USER_AGENT,
  type RegistryCacheEntry,
  repoFromDepsDevVersion,
  repoFromNpmManifest,
  repoFromPom,
  repoFromPypiInfo,
} from "../src/discovery/registries.ts"
import { openDatabase } from "../src/state/db.ts"
import { Store } from "../src/state/store.ts"
import { DAY, FakeClock } from "../src/util/clock.ts"
import { nullLogger } from "../src/util/log.ts"

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const DD = "https://api.deps.dev/v3/systems"
const NPM = "https://registry.npmjs.org"
const PYPI = "https://pypi.org/pypi"
const MVN = "https://repo1.maven.org/maven2"

type RouteValue = unknown | number | ((init: RequestInit | undefined) => Response | Promise<Response>)

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

/** Fake fetch over exact URLs: object → JSON 200, string → text 200, number → that status. Unknown URLs → plain-text 404. */
function routedFetch(routes: Record<string, RouteValue>): typeof fetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (!(url in routes)) return new Response("package not found", { status: 404, headers: { "content-type": "text/plain" } })
    const v = routes[url]
    if (typeof v === "function") return (v as (i: RequestInit | undefined) => Response | Promise<Response>)(init)
    if (typeof v === "number") return new Response(`HTTP ${v}`, { status: v })
    if (typeof v === "string") return new Response(v, { status: 200 })
    return Response.json(v)
  }) as unknown as typeof fetch & { calls: FetchCall[] }
  fn.calls = calls
  return fn
}

function dep(ecosystem: PackageEcosystem, name: string): DependencyRef {
  return { ecosystem, name, manifestPath: "x", dev: false }
}

function depsDevPackage(system: string, name: string, versions: Array<[string, boolean]>) {
  return {
    packageKey: { system, name },
    versions: versions.map(([version, isDefault]) => ({
      versionKey: { system, name, version },
      isDefault,
      isDeprecated: false,
      deprecatedReason: "",
    })),
  }
}

function depsDevVersion(opts: {
  related?: Array<[string, "SOURCE_REPO" | "ISSUE_TRACKER"]>
  links?: Array<[string, string]>
}) {
  return {
    versionKey: { system: "NPM", name: "x", version: "1" },
    isDefault: true,
    licenses: [],
    advisoryKeys: [],
    links: (opts.links ?? []).map(([label, url]) => ({ label, url })),
    relatedProjects: (opts.related ?? []).map(([id, relationType]) => ({
      projectKey: { id },
      relationProvenance: "UNVERIFIED_METADATA",
      relationType,
    })),
  }
}

let store: Store
let clock: FakeClock

beforeEach(() => {
  store = new Store(openDatabase(":memory:"))
  clock = new FakeClock(Date.UTC(2026, 9, 11, 12, 0, 0))
})

afterEach(() => {
  store.db.close()
})

function resolverWith(fetchFn: typeof fetch, extra: { timeoutMs?: number; perHostConcurrency?: number } = {}) {
  return createRegistryResolver({ fetch: fetchFn, store, clock, log: nullLogger, ...extra })
}

// ---------------------------------------------------------------------------
// normalizeGithubRepoUrl
// ---------------------------------------------------------------------------

describe("normalizeGithubRepoUrl", () => {
  test.each([
    ["git+https://github.com/facebook/react.git", "facebook/react"],
    ["git+ssh://git@github.com/DABH/colors.js.git", "DABH/colors.js"],
    ["git://github.com/debug-js/debug.git", "debug-js/debug"],
    ["https://github.com/babel/babel.git", "babel/babel"],
    ["github:npm/example", "npm/example"],
    ["github:user/repo#branch", "user/repo"],
    ["npm/example", "npm/example"],
    ["chalk/chalk#v5", "chalk/chalk"],
    ["git@github.com:npm/cli.git", "npm/cli"],
    ["git+ssh://git@github.com:npm/cli.git#v1.0.27", "npm/cli"],
    ["ssh://git@github.com:22/owner/repo.git", "owner/repo"],
    ["https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node", "DefinitelyTyped/DefinitelyTyped"],
    ["https://github.com/numpy/numpy/issues", "numpy/numpy"],
    ["http://www.github.com/x/y/", "x/y"],
    ["github.com/foo/bar", "foo/bar"],
    ["www.github.com/foo/bar.git", "foo/bar"],
    ["https://github.com/psf/requests#readme", "psf/requests"],
    ["https://github.com/psf/requests?tab=readme", "psf/requests"],
    ["scm:git:https://github.com/google/guava.git", "google/guava"],
    ["scm:git:git@github.com:google/guava.git", "google/guava"],
    ["scm:git:git://github.com/spring-projects/spring-boot.git", "spring-projects/spring-boot"],
    ["git+https://github.com/me/MyProject.git@v1.0#subdirectory=pkg", "me/MyProject"],
    ["https://github.com/urllib3/urllib3/archive/refs/tags/1.26.8.zip", "urllib3/urllib3"],
    ["  https://GitHub.com/Owner/Repo  ", "Owner/Repo"],
    ["https://gitbox.apache.org/repos/asf?p=commons-lang.git", null],
    ["https://gitlab.com/group/project", null],
    ["gitlab:user/repo", null],
    ["bitbucket:user/repo", null],
    ["gist:11081aaa281", null],
    ["git@gitlab.com:group/project.git", null],
    ["https://github.com/sponsors/samuelcolvin", null],
    ["https://github.com/orgs/acme/people", null],
    ["https://github.com/onlyowner", null],
    ["https://github.com/", null],
    ["https://raw.githubusercontent.com/o/r/main/x", null],
    ["https://o.github.io/r", null],
    ["https://github.com/bad_owner/repo", null],
    ["https://github.com/owner/repo%20with%20space", null],
    ["https://github.com/owner/..", null],
    ["mailto:someone@example.com", null],
    ["scm:svn:http://svn.example.com/repo", null],
    ["not a url at all", null],
    ["", null],
  ])("%p → %p", (input, expected) => {
    expect(normalizeGithubRepoUrl(input)).toBe(expected)
  })

  test("null/undefined and non-strings", () => {
    expect(normalizeGithubRepoUrl(null)).toBeNull()
    expect(normalizeGithubRepoUrl(undefined)).toBeNull()
    expect(normalizeGithubRepoUrl(42 as unknown as string)).toBeNull()
  })

  test("bare owner/repo shorthand can be disabled", () => {
    expect(normalizeGithubRepoUrl("owner/repo", { allowShorthand: false })).toBeNull()
    expect(normalizeGithubRepoUrl("https://github.com/owner/repo", { allowShorthand: false })).toBe("owner/repo")
  })
})

// ---------------------------------------------------------------------------
// pure response interpretation
// ---------------------------------------------------------------------------

describe("registry response helpers", () => {
  test("deps.dev default version", () => {
    expect(depsDevDefaultVersion(depsDevPackage("NPM", "x", [["1.0.0", false], ["2.0.0", true], ["3.0.0-rc", false]]))).toBe("2.0.0")
    expect(depsDevDefaultVersion(depsDevPackage("NPM", "x", [["1.0.0", false], ["1.1.0", false]]))).toBe("1.1.0")
    expect(depsDevDefaultVersion({ versions: [] })).toBeNull()
    expect(depsDevDefaultVersion("nope")).toBeNull()
  })

  test("deps.dev: multiple SOURCE_REPO entries prefer the one matching the link (numpy)", () => {
    const v = depsDevVersion({
      related: [
        ["github.com/numpy/numpy-release", "SOURCE_REPO"],
        ["github.com/numpy/numpy", "SOURCE_REPO"],
      ],
      links: [["SOURCE_REPO", "https://github.com/numpy/numpy"]],
    })
    expect(repoFromDepsDevVersion(v)).toBe("numpy/numpy")
  })

  test("deps.dev: ISSUE_TRACKER on another repo is not the source (tslib)", () => {
    const v = depsDevVersion({
      related: [
        ["github.com/microsoft/typescript", "ISSUE_TRACKER"],
        ["github.com/microsoft/tslib", "SOURCE_REPO"],
      ],
    })
    expect(repoFromDepsDevVersion(v)).toBe("microsoft/tslib")
  })

  test("deps.dev: prefer the source that is also the issue tracker when links do not decide", () => {
    const v = depsDevVersion({
      related: [
        ["github.com/a/release-wrapper", "SOURCE_REPO"],
        ["github.com/a/real", "SOURCE_REPO"],
        ["github.com/a/real", "ISSUE_TRACKER"],
      ],
    })
    expect(repoFromDepsDevVersion(v)).toBe("a/real")
  })

  test("deps.dev: empty ids and non-GitHub projects fall back to SOURCE_REPO links (casing kept)", () => {
    expect(
      repoFromDepsDevVersion(
        depsDevVersion({ related: [["", "ISSUE_TRACKER"]], links: [["SOURCE_REPO", "git+ssh://git@github.com/DABH/colors.js.git"]] }),
      ),
    ).toBe("DABH/colors.js")
    expect(
      repoFromDepsDevVersion(
        depsDevVersion({
          related: [["gitlab.com/x/y", "SOURCE_REPO"]],
          links: [["SOURCE_REPO", "https://gitbox.apache.org/repos/asf/commons-lang.git"]],
        }),
      ),
    ).toBeNull()
    expect(repoFromDepsDevVersion({})).toBeNull()
  })

  test("npm: repository object, string shorthand, homepage, bugs", () => {
    expect(repoFromNpmManifest({ repository: { type: "git", url: "git+https://github.com/react/react.git", directory: "packages/react" } })).toBe(
      "react/react",
    )
    expect(repoFromNpmManifest({ repository: "chalk/chalk" })).toBe("chalk/chalk")
    expect(repoFromNpmManifest({ repository: "gitlab:a/b", homepage: "https://github.com/c/d#readme" })).toBe("c/d")
    expect(repoFromNpmManifest({ bugs: { url: "https://github.com/e/f/issues" } })).toBe("e/f")
    expect(repoFromNpmManifest({ homepage: "owner/repo" })).toBeNull()
    expect(repoFromNpmManifest("Not Found")).toBeNull()
  })

  test("PyPI: label priority, null project_urls, home_page, sponsors and JIRA trackers", () => {
    expect(
      repoFromPypiInfo({
        project_urls: {
          Funding: "https://github.com/sponsors/samuelcolvin",
          Homepage: "https://example.org",
          "Source Code": "https://github.com/pydantic/pydantic",
        },
      }),
    ).toBe("pydantic/pydantic")
    expect(repoFromPypiInfo({ project_urls: null, home_page: "https://github.com/scikit-learn/scikit-learn" })).toBe(
      "scikit-learn/scikit-learn",
    )
    expect(repoFromPypiInfo({ project_urls: null, home_page: "" })).toBeNull()
    expect(repoFromPypiInfo({ project_urls: { "Bug Tracker": "https://jira.mongodb.org/browse/PYTHON" }, home_page: null })).toBeNull()
    expect(repoFromPypiInfo({ project_urls: { tracker: "https://github.com/o/tracked/issues" } })).toBe("o/tracked")
    expect(repoFromPypiInfo({ project_urls: { Changelog: "https://github.com/o/changes/blob/main/CHANGES.md" } })).toBe("o/changes")
    expect(repoFromPypiInfo({ project_urls: { homepage: "https://github.com/o/home" }, home_page: "https://github.com/o/legacy" })).toBe(
      "o/home",
    )
  })

  test("Maven metadata version selection", () => {
    expect(mavenMetadataVersion("<metadata><versioning><latest>2.0</latest><release>1.9</release></versioning></metadata>")).toBe("1.9")
    expect(mavenMetadataVersion("<metadata><versioning><latest>2.0-SNAPSHOT</latest></versioning></metadata>")).toBe("2.0-SNAPSHOT")
    expect(mavenMetadataVersion("<metadata><versioning><versions><version>1.0</version><version>1.1</version></versions></versioning></metadata>")).toBe(
      "1.1",
    )
    expect(mavenMetadataVersion("<metadata/>")).toBeNull()
  })

  test("POM scm url, connection, project url and placeholders", () => {
    expect(repoFromPom("<project><scm><url>https://github.com/google/guava</url></scm></project>").repo).toBe("google/guava")
    expect(repoFromPom("<project><scm><connection>scm:git:git@github.com:google/guava.git</connection></scm></project>").repo).toBe(
      "google/guava",
    )
    expect(
      repoFromPom("<project><artifactId>lib</artifactId><scm><url>https://github.com/acme/${project.artifactId}</url></scm></project>").repo,
    ).toBe("acme/lib")
    expect(repoFromPom("<project><url>https://github.com/o/site</url><scm><url>${unknown}</url></scm></project>").repo).toBe("o/site")
    const noScm = repoFromPom(
      "<project><parent><groupId>g</groupId><artifactId>p</artifactId><version>1</version></parent><url>https://example.com</url></project>",
    )
    expect(noScm).toEqual({ repo: null, parent: { groupId: "g", artifactId: "p", version: "1" } })
  })
})

// ---------------------------------------------------------------------------
// resolver
// ---------------------------------------------------------------------------

describe("createRegistryResolver", () => {
  test("deps.dev hit: encodes scoped names, uses the default version, prefers link casing", async () => {
    const f = routedFetch({
      [`${DD}/npm/packages/%40colors%2Fcolors`]: depsDevPackage("NPM", "@colors/colors", [["1.5.0", false], ["1.6.0", true]]),
      [`${DD}/npm/packages/%40colors%2Fcolors/versions/1.6.0`]: depsDevVersion({
        related: [["github.com/dabh/colors.js", "SOURCE_REPO"]],
        links: [["SOURCE_REPO", "git+ssh://git@github.com/DABH/colors.js.git"]],
      }),
    })
    const r = resolverWith(f)
    expect(await r.resolve(dep("npm", "@colors/colors"))).toBe("DABH/colors.js")
    expect(f.calls.map((c) => c.url)).toEqual([
      `${DD}/npm/packages/%40colors%2Fcolors`,
      `${DD}/npm/packages/%40colors%2Fcolors/versions/1.6.0`,
    ])
    expect(store.getKv<RegistryCacheEntry>(registryCacheKey("npm", "@colors/colors"))).toEqual({ repo: "DABH/colors.js", at: clock.now() })
  })

  test("requests are unauthenticated, identify oss-scout and carry a timeout signal", async () => {
    const f = routedFetch({})
    await resolverWith(f).resolve(dep("npm", "left-pad"))
    expect(f.calls.length).toBeGreaterThan(0)
    for (const call of f.calls) {
      const headers = new Headers(call.init?.headers)
      expect(headers.get("authorization")).toBeNull()
      expect(headers.get("user-agent")).toBe(REGISTRY_USER_AGENT)
      expect(call.init?.signal).toBeInstanceOf(AbortSignal)
      expect(call.url).not.toMatch(/token|ghp_|github_pat_/i)
    }
  })

  test("maven names are encoded with %3A for deps.dev", async () => {
    const f = routedFetch({
      [`${DD}/maven/packages/org.apache.logging.log4j%3Alog4j-core`]: depsDevPackage("MAVEN", "org.apache.logging.log4j:log4j-core", [
        ["2.24.0", true],
      ]),
      [`${DD}/maven/packages/org.apache.logging.log4j%3Alog4j-core/versions/2.24.0`]: depsDevVersion({
        related: [["github.com/apache/logging-log4j2", "SOURCE_REPO"]],
      }),
    })
    expect(await resolverWith(f).resolve(dep("maven", "org.apache.logging.log4j:log4j-core"))).toBe("apache/logging-log4j2")
  })

  test("npm fallback when deps.dev has no package (plain-text 404)", async () => {
    const f = routedFetch({
      [`${NPM}/@babel%2Fcore/latest`]: { name: "@babel/core", repository: { type: "git", url: "https://github.com/babel/babel.git", directory: "packages/babel-core" } },
    })
    expect(await resolverWith(f).resolve(dep("npm", "@babel/core"))).toBe("babel/babel")
    expect(f.calls.map((c) => c.url)).toEqual([`${DD}/npm/packages/%40babel%2Fcore`, `${NPM}/@babel%2Fcore/latest`])
  })

  test("npm fallback with a string shorthand repository when deps.dev has no SOURCE_REPO", async () => {
    const f = routedFetch({
      [`${DD}/npm/packages/tiny`]: depsDevPackage("NPM", "tiny", [["1.0.0", true]]),
      [`${DD}/npm/packages/tiny/versions/1.0.0`]: depsDevVersion({ links: [["HOMEPAGE", "https://tiny.dev"]] }),
      [`${NPM}/tiny/latest`]: { name: "tiny", repository: "someone/tiny" },
    })
    expect(await resolverWith(f).resolve(dep("npm", "tiny"))).toBe("someone/tiny")
  })

  test("PyPI fallback normalizes the name and reads project_urls", async () => {
    const f = routedFetch({
      [`${PYPI}/typing-extensions/json`]: {
        info: { name: "typing_extensions", project_urls: { Repository: "https://github.com/python/typing_extensions" }, home_page: null },
        releases: {},
      },
    })
    const r = resolverWith(f)
    expect(await r.resolve(dep("pypi", "Typing_Extensions"))).toBe("python/typing_extensions")
    expect(f.calls[0]!.url).toBe(`${DD}/pypi/packages/typing-extensions`)
    expect(store.getKv<RegistryCacheEntry>(registryCacheKey("pypi", "typing-extensions"))).not.toBeNull()
  })

  test("Maven fallback: metadata without <release>, POM without scm, parent POM with scm", async () => {
    const f = routedFetch({
      [`${MVN}/com/google/guava/guava/maven-metadata.xml`]:
        "<metadata><versioning><latest>33.7.2-jre</latest><versions><version>33.7.2-jre</version></versions></versioning></metadata>",
      [`${MVN}/com/google/guava/guava/33.7.2-jre/guava-33.7.2-jre.pom`]:
        "<project><parent><groupId>com.google.guava</groupId><artifactId>guava-parent</artifactId><version>33.7.2-jre</version></parent><artifactId>guava</artifactId></project>",
      [`${MVN}/com/google/guava/guava-parent/33.7.2-jre/guava-parent-33.7.2-jre.pom`]:
        "<project><artifactId>guava-parent</artifactId><scm><connection>scm:git:git@github.com:google/guava.git</connection></scm></project>",
    })
    expect(await resolverWith(f).resolve(dep("maven", "com.google.guava:guava"))).toBe("google/guava")
  })

  test("Maven parent chain is capped", async () => {
    const routes: Record<string, RouteValue> = {
      [`${MVN}/org/x/a0/maven-metadata.xml`]: "<metadata><versioning><release>1</release></versioning></metadata>",
    }
    for (let i = 0; i < 8; i++) {
      routes[`${MVN}/org/x/a${i}/1/a${i}-1.pom`] =
        `<project><parent><groupId>org.x</groupId><artifactId>a${i + 1}</artifactId><version>1</version></parent></project>`
    }
    const f = routedFetch(routes)
    expect(await resolverWith(f).resolve(dep("maven", "org.x:a0"))).toBeNull()
    const pomFetches = f.calls.filter((c) => c.url.endsWith(".pom"))
    expect(pomFetches.length).toBe(4) // the artifact + 3 parents
    expect(store.getKv<RegistryCacheEntry>(registryCacheKey("maven", "org.x:a0"))).toEqual({ repo: null, at: clock.now() })
  })

  test("positive results are cached for 30 days", async () => {
    const f = routedFetch({ [`${NPM}/zod/latest`]: { repository: { url: "git+https://github.com/colinhacks/zod.git" } } })
    const r = resolverWith(f)
    expect(await r.resolve(dep("npm", "zod"))).toBe("colinhacks/zod")
    const first = f.calls.length
    clock.advance(29 * DAY)
    expect(await r.resolve(dep("npm", "zod"))).toBe("colinhacks/zod")
    expect(f.calls.length).toBe(first)
    clock.advance(2 * DAY)
    expect(await resolverWith(f).resolve(dep("npm", "zod"))).toBe("colinhacks/zod")
    expect(f.calls.length).toBe(first * 2)
  })

  test("negative results are cached for 7 days", async () => {
    const f = routedFetch({})
    const r = resolverWith(f)
    expect(await r.resolve(dep("npm", "ghost-pkg"))).toBeNull()
    const first = f.calls.length
    expect(first).toBe(2) // deps.dev + npm
    expect(store.getKv<RegistryCacheEntry>(registryCacheKey("npm", "ghost-pkg"))).toEqual({ repo: null, at: clock.now() })
    clock.advance(6 * DAY)
    expect(await r.resolve(dep("npm", "ghost-pkg"))).toBeNull()
    expect(f.calls.length).toBe(first)
    clock.advance(2 * DAY)
    expect(await r.resolve(dep("npm", "ghost-pkg"))).toBeNull()
    expect(f.calls.length).toBe(first * 2)
  })

  test("transient failures (5xx, 429, network errors, bad JSON) return null and are not cached", async () => {
    let fail = true
    const f = routedFetch({
      [`${DD}/npm/packages/flaky`]: () => (fail ? new Response("busy", { status: 503 }) : new Response("package not found", { status: 404 })),
      [`${NPM}/flaky/latest`]: () => {
        if (fail) throw new TypeError("network down")
        return Response.json({ repository: "git+https://github.com/o/flaky.git" })
      },
      [`${DD}/pypi/packages/ratelimited`]: 429,
      [`${PYPI}/ratelimited/json`]: () => new Response("{not json", { status: 200 }),
    })
    const r = resolverWith(f)
    expect(await r.resolve(dep("npm", "flaky"))).toBeNull()
    expect(store.getKv<RegistryCacheEntry>(registryCacheKey("npm", "flaky"))).toBeNull()
    expect(await r.resolve(dep("pypi", "ratelimited"))).toBeNull()
    expect(store.getKv<RegistryCacheEntry>(registryCacheKey("pypi", "ratelimited"))).toBeNull()
    fail = false
    expect(await r.resolve(dep("npm", "flaky"))).toBe("o/flaky")
  })

  test("a fallback hit is cached even when deps.dev failed", async () => {
    const f = routedFetch({
      [`${DD}/npm/packages/ok`]: 500,
      [`${NPM}/ok/latest`]: { repository: { url: "https://github.com/o/ok" } },
    })
    expect(await resolverWith(f).resolve(dep("npm", "ok"))).toBe("o/ok")
    expect(store.getKv<RegistryCacheEntry>(registryCacheKey("npm", "ok"))).toEqual({ repo: "o/ok", at: clock.now() })
  })

  test("requests time out and resolve to null (not cached)", async () => {
    const hang = (init: RequestInit | undefined) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal
        if (!signal) return
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true })
      })
    const f = routedFetch({ [`${DD}/npm/packages/slow`]: hang, [`${NPM}/slow/latest`]: hang })
    const started = Date.now()
    expect(await resolverWith(f, { timeoutMs: 25 }).resolve(dep("npm", "slow"))).toBeNull()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(store.getKv<RegistryCacheEntry>(registryCacheKey("npm", "slow"))).toBeNull()
  })

  test("concurrent lookups of the same package share one request chain", async () => {
    const f = routedFetch({ [`${NPM}/same/latest`]: { repository: "git+https://github.com/o/same.git" } })
    const r = resolverWith(f)
    const results = await Promise.all([r.resolve(dep("npm", "same")), r.resolve(dep("npm", "same")), r.resolve(dep("npm", "same"))])
    expect(results).toEqual(["o/same", "o/same", "o/same"])
    expect(f.calls.length).toBe(2)
  })

  test("at most two requests per host are in flight", async () => {
    let active = 0
    let peak = 0
    const slow = async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return new Response("package not found", { status: 404 })
    }
    const routes: Record<string, RouteValue> = {}
    const names = ["a", "b", "c", "d", "e", "f"]
    for (const n of names) {
      routes[`${DD}/npm/packages/${n}`] = slow
      routes[`${NPM}/${n}/latest`] = () => Response.json({ repository: `github:o/${n}` })
    }
    const r = resolverWith(routedFetch(routes))
    const results = await Promise.all(names.map((n) => r.resolve(dep("npm", n))))
    expect(results).toEqual(names.map((n) => `o/${n}`))
    expect(peak).toBe(2)
  })

  test("invalid package names are rejected without any request", async () => {
    const f = routedFetch({})
    const r = resolverWith(f)
    expect(await r.resolve(dep("maven", "a:b:c"))).toBeNull()
    expect(await r.resolve(dep("maven", "../..:x"))).toBeNull()
    expect(await r.resolve(dep("npm", "Bad Name"))).toBeNull()
    expect(await r.resolve(dep("pypi", "-x"))).toBeNull()
    expect(await r.resolve(dep("npm", ""))).toBeNull()
    expect(f.calls).toEqual([])
  })

  test("non-GitHub source repos resolve to null and are cached negatively", async () => {
    const f = routedFetch({
      [`${DD}/npm/packages/gl`]: depsDevPackage("NPM", "gl", [["1.0.0", true]]),
      [`${DD}/npm/packages/gl/versions/1.0.0`]: depsDevVersion({ links: [["SOURCE_REPO", "https://gitlab.com/x/gl"]] }),
      [`${NPM}/gl/latest`]: { repository: { url: "git+https://gitlab.com/x/gl.git" } },
    })
    expect(await resolverWith(f).resolve(dep("npm", "gl"))).toBeNull()
    expect(store.getKv<RegistryCacheEntry>(registryCacheKey("npm", "gl"))).toEqual({ repo: null, at: clock.now() })
  })
})
