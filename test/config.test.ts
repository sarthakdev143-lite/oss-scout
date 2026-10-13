import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { CONFIG_FILENAME, deepMerge, loadConfig } from "../src/config/load.ts"
import {
  ALLOW_CUSTOM_GITHUB_API_ENV,
  ConfigError,
  DEFAULT_DISCLOSURE_LINE,
  DEFAULT_GITHUB_API_URL,
  configJsonSchema,
  isDefaultGithubApiUrl,
  parseConfig,
  parseModelRef,
} from "../src/config/schema.ts"

function configError(raw: unknown): ConfigError {
  try {
    parseConfig(raw)
  } catch (err) {
    if (err instanceof ConfigError) return err
    throw err
  }
  throw new Error("expected ConfigError")
}

// ---------------------------------------------------------------------------
// schema defaults
// ---------------------------------------------------------------------------

describe("parseConfig defaults", () => {
  test("{} yields a complete dry-run config", () => {
    const c = parseConfig({})
    expect(c.mode).toBe("dry-run")
    expect(c.stateDir).toBeNull()
    expect(c.homeDirectory).toBeNull()
    expect(c.interests.languages).toEqual(["TypeScript", "JavaScript", "Python", "Java"])
    expect(c.interests.topics).toContain("fastapi")
    expect(c.interests.keywords).toEqual([])
    expect(c.github).toEqual({
      tokenEnv: "GITHUB_TOKEN",
      writeTokenEnv: "OSS_SCOUT_WRITE_TOKEN",
      apiBaseUrl: "https://api.github.com",
      apiVersion: "2022-11-28",
      concurrency: 1,
      minWriteIntervalMs: 1500,
    })
    expect(c.repos).toEqual({ allow: [], deny: [] })
    expect(c.caps).toMatchObject({ maxOpenPrsPerRepo: 1, repoCooldownDays: 30, maxSubmittedPrsPerWeek: 3 })
    expect(c.sandbox.images.node).toBe("node:22-bookworm")
    expect(c.sandbox.timeouts).toEqual({ installMinutes: 20, testMinutes: 20, lintMinutes: 10 })
    expect(c.budget.perTask.maxTokens).toBe(600_000)
    expect(c.budget.perDay.maxCostUsd).toBe(20)
    expect(c.disclosure.line).toBe(DEFAULT_DISCLOSURE_LINE)
    expect(c.disclosure.line).toMatch(/\bAI\b/)
    expect(c.disclosure.replyLine).toMatch(/\bAI\b/)
    expect(c.implementation.model).toBeNull()
    expect(c.critic).toEqual({ model: null, minConfidence: 0.7 })
    expect(c.logging).toEqual({ level: "info", console: false })
  })

  test("null and undefined are treated as {}", () => {
    expect(parseConfig(null)).toEqual(parseConfig({}))
    expect(parseConfig(undefined)).toEqual(parseConfig({}))
  })

  test("partial sections keep sibling defaults", () => {
    const c = parseConfig({ interests: { languages: ["Go"] } })
    expect(c.interests.languages).toEqual(["Go"])
    expect(c.interests.topics).toEqual(parseConfig({}).interests.topics)
    expect(c.github.apiVersion).toBe("2022-11-28")
    const s = parseConfig({ sandbox: { images: { node: "node:20" } } })
    expect(s.sandbox.images).toMatchObject({ node: "node:20", python: "python:3.12-bookworm" })
  })

  test("unknown keys are ignored, $schema is allowed", () => {
    const c = parseConfig({ $schema: "./schema.json", somethingElse: 1 })
    expect(c.$schema).toBe("./schema.json")
    expect((c as Record<string, unknown>).somethingElse).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

describe("parseConfig validation", () => {
  test("invalid values produce ConfigError with dotted paths", () => {
    const e = configError({
      mode: "yolo",
      github: { minWriteIntervalMs: 10, apiBaseUrl: "not a url" },
      repos: { allow: ["acme/widget", "bad pattern"] },
      screening: { minScore: 2 },
      implementation: { maxAttempts: 0 },
    })
    expect(e.name).toBe("ConfigError")
    const paths = e.issues.map((i) => i.split(":")[0])
    expect(paths).toEqual(
      expect.arrayContaining([
        "mode",
        "github.minWriteIntervalMs",
        "github.apiBaseUrl",
        "repos.allow.1",
        "screening.minScore",
        "implementation.maxAttempts",
      ]),
    )
    expect(e.message).toContain("Invalid oss-scout config")
    expect(e.message).toContain("repos.allow.1")
  })

  test("repo patterns accept owner/repo and owner/*", () => {
    const c = parseConfig({ repos: { allow: ["acme/*", "a.b-c/d_e.f"], deny: ["evil/*"] } })
    expect(c.repos.allow).toEqual(["acme/*", "a.b-c/d_e.f"])
    expect(configError({ repos: { deny: ["*/*"] } }).issues[0]).toMatch(/^repos\.deny\.0:/)
  })

  test("model refs must be provider/model", () => {
    expect(parseConfig({ critic: { model: "anthropic/claude-x#high" } }).critic.model).toBe("anthropic/claude-x#high")
    expect(configError({ critic: { model: "nomodel" } }).issues[0]).toMatch(/^critic\.model:/)
    expect(configError({ implementation: { model: "a b/c" } }).issues[0]).toMatch(/^implementation\.model:/)
  })

  test("disclosure lines must mention AI", () => {
    expect(configError({ disclosure: { line: "Thanks for reviewing this change!" } }).issues[0]).toMatch(
      /^disclosure\.line: disclosure line must explicitly mention AI/,
    )
    expect(configError({ disclosure: { replyLine: "Cheers, me" } }).issues[0]).toMatch(/^disclosure\.replyLine:/)
    expect(parseConfig({ disclosure: { line: "Written with help from a large language model." } }).disclosure.line).toContain(
      "language model",
    )
    expect(parseConfig({ disclosure: { line: "This PR was prepared with an LLM." } }).disclosure.line).toContain("LLM")
    // "AI" must be a word, not a substring
    expect(() => parseConfig({ disclosure: { line: "Maintained with care by Kai Smith" } })).toThrow(ConfigError)
  })

  test("non-object input is rejected at the root", () => {
    expect(configError(42).issues[0]).toMatch(/^\(root\):/)
  })

  test("configJsonSchema exposes top-level properties", () => {
    const schema = configJsonSchema() as { properties?: Record<string, unknown> }
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(["mode", "interests", "github", "disclosure"]))
  })
})

// ---------------------------------------------------------------------------
// parseModelRef
// ---------------------------------------------------------------------------

describe("parseModelRef", () => {
  test("parses provider, model and variant", () => {
    expect(parseModelRef("anthropic/claude-sonnet")).toEqual({ providerID: "anthropic", modelID: "claude-sonnet" })
    expect(parseModelRef("openai/gpt-5#high")).toEqual({ providerID: "openai", modelID: "gpt-5", variant: "high" })
    expect(parseModelRef("openrouter/meta/llama-3")).toEqual({ providerID: "openrouter", modelID: "meta/llama-3" })
  })

  test("returns null for empty or malformed refs", () => {
    expect(parseModelRef(null)).toBeNull()
    expect(parseModelRef("")).toBeNull()
    expect(parseModelRef("noslash")).toBeNull()
    expect(parseModelRef("/model")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

describe("deepMerge", () => {
  test("objects merge recursively; arrays and scalars replace", () => {
    const a = { mode: "dry-run", interests: { languages: ["Go"], topics: ["x"] }, caps: { maxOpenPrsPerRepo: 1 } }
    const b = { interests: { languages: ["Rust"] }, caps: { repoCooldownDays: 7 }, mode: "queue" }
    expect(deepMerge(a, b)).toEqual({
      mode: "queue",
      interests: { languages: ["Rust"], topics: ["x"] },
      caps: { maxOpenPrsPerRepo: 1, repoCooldownDays: 7 },
    })
    expect(a.interests.languages).toEqual(["Go"])
  })

  test("undefined keeps the base; configPath is never merged", () => {
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 })
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 })
    expect(deepMerge({ a: 1 }, { configPath: "/x.json", b: 2 })).toEqual({ a: 1, b: 2 })
    expect(deepMerge([1], [2, 3])).toEqual([2, 3])
    expect(deepMerge({ a: { b: 1 } }, { a: null })).toEqual({ a: null })
  })
})

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  let dir: string
  const homeConfig = join(homedir(), ".oss-scout", CONFIG_FILENAME)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oss-scout-config-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function write(path: string, data: unknown): string {
    mkdirSync(resolve(path, ".."), { recursive: true })
    writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data))
    return path
  }

  test("reads <directory>/oss-scout.config.json and defaults homeDirectory to its folder", () => {
    const file = write(join(dir, CONFIG_FILENAME), { mode: "queue", interests: { languages: ["Go"] } })
    const loaded = loadConfig({ directory: dir, env: {} })
    expect(loaded.file).toBe(file)
    expect(loaded.baseDir).toBe(dir)
    expect(loaded.config.mode).toBe("queue")
    expect(loaded.config.interests.languages).toEqual(["Go"])
    expect(loaded.config.homeDirectory).toBe(dir)
  })

  test("relative homeDirectory resolves against the config file's folder", () => {
    write(join(dir, CONFIG_FILENAME), { homeDirectory: "work/home" })
    expect(loadConfig({ directory: dir, env: {} }).config.homeDirectory).toBe(resolve(dir, "work/home"))
  })

  test("explicit path wins and resolves relative to directory", () => {
    write(join(dir, CONFIG_FILENAME), { mode: "queue" })
    const explicit = write(join(dir, "cfg", "custom.json"), { mode: "off" })
    const loaded = loadConfig({ directory: dir, explicitPath: "cfg/custom.json", env: {} })
    expect(loaded.file).toBe(explicit)
    expect(loaded.baseDir).toBe(join(dir, "cfg"))
    expect(loaded.config.mode).toBe("off")
    expect(loaded.config.homeDirectory).toBe(join(dir, "cfg"))
  })

  test("OSS_SCOUT_CONFIG is used when no explicit path is given", () => {
    write(join(dir, CONFIG_FILENAME), { mode: "queue" })
    const viaEnv = write(join(dir, "env.json"), { mode: "off" })
    const loaded = loadConfig({ directory: dir, env: { OSS_SCOUT_CONFIG: viaEnv } })
    expect(loaded.file).toBe(viaEnv)
    expect(loaded.config.mode).toBe("off")
  })

  test("a missing explicit path is an error, not a silent fallback", () => {
    write(join(dir, CONFIG_FILENAME), { mode: "queue" })
    expect(() => loadConfig({ directory: dir, explicitPath: "nope.json", env: {} })).toThrow(ConfigError)
    expect(() => loadConfig({ directory: dir, explicitPath: "nope.json", env: {} })).toThrow(/not found/)
    expect(() => loadConfig({ directory: dir, env: { OSS_SCOUT_CONFIG: join(dir, "missing.json") } })).toThrow(ConfigError)
  })

  test("overrides are deep-merged over the file and validated", () => {
    write(join(dir, CONFIG_FILENAME), { interests: { languages: ["Go"], topics: ["cli"] }, caps: { repoCooldownDays: 10 } })
    const loaded = loadConfig({
      directory: dir,
      env: {},
      overrides: { interests: { languages: ["Rust"] }, configPath: "ignored.json" },
    })
    expect(loaded.config.interests).toMatchObject({ languages: ["Rust"], topics: ["cli"] })
    expect(loaded.config.caps.repoCooldownDays).toBe(10)
    expect(() => loadConfig({ directory: dir, env: {}, overrides: { mode: "bad" } })).toThrow(ConfigError)
  })

  test("invalid JSON and invalid values are ConfigErrors naming the file", () => {
    write(join(dir, CONFIG_FILENAME), "{ not json")
    expect(() => loadConfig({ directory: dir, env: {} })).toThrow(/not valid JSON/)
    write(join(dir, CONFIG_FILENAME), { disclosure: { line: "No mention of the tooling here." } })
    try {
      loadConfig({ directory: dir, env: {} })
      throw new Error("expected ConfigError")
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      expect((err as ConfigError).issues.join("\n")).toContain("disclosure.line")
    }
  })

  test.skipIf(existsSync(homeConfig))("no file anywhere → defaults (+ overrides), homeDirectory = directory", () => {
    const loaded = loadConfig({ directory: dir, env: {}, overrides: { interests: { languages: ["Go"] } } })
    expect(loaded.file).toBeNull()
    expect(loaded.baseDir).toBe(dir)
    expect(loaded.config.mode).toBe("dry-run")
    expect(loaded.config.interests.languages).toEqual(["Go"])
    expect(loaded.config.homeDirectory).toBe(dir)
  })

  test("the directory config is preferred over the home config", () => {
    const file = write(join(dir, CONFIG_FILENAME), { mode: "off" })
    expect(loadConfig({ directory: dir, env: {} }).file).toBe(file)
  })
})

// ---------------------------------------------------------------------------
// lookup order (injected home directory: the real ~/.oss-scout is never read)
// ---------------------------------------------------------------------------

describe("loadConfig lookup order", () => {
  let root: string
  let home: string
  let cwd: string
  let pkg: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oss-scout-lookup-"))
    home = join(root, "home")
    cwd = join(root, "project")
    pkg = join(root, "oss-scout")
    for (const d of [home, cwd, pkg]) mkdirSync(d, { recursive: true })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function write(path: string, data: unknown): string {
    mkdirSync(resolve(path, ".."), { recursive: true })
    writeFileSync(path, JSON.stringify(data))
    return path
  }
  const homeFile = () => join(home, ".oss-scout", CONFIG_FILENAME)

  test("CLI order: directory → ~/.oss-scout → package directory → defaults; other files are reported as shadowed", () => {
    const inCwd = write(join(cwd, CONFIG_FILENAME), { mode: "off" })
    const inHome = write(homeFile(), { mode: "queue" })
    const inPkg = write(join(pkg, CONFIG_FILENAME), { mode: "dry-run" })
    const opts = { directory: cwd, packageDirectory: pkg, homeDir: home, env: {} }
    const first = loadConfig(opts)
    expect(first.file).toBe(inCwd)
    expect(first.searched).toEqual([inCwd, inHome, inPkg])
    expect(first.shadowed).toEqual([inHome, inPkg])
    rmSync(inCwd)
    expect(loadConfig(opts).file).toBe(inHome)
    rmSync(inHome)
    const pkgOnly = loadConfig(opts)
    expect(pkgOnly.file).toBe(inPkg)
    expect(pkgOnly.config.homeDirectory).toBe(pkg)
    expect(pkgOnly.shadowed).toEqual([])
    rmSync(inPkg)
    const defaults = loadConfig(opts)
    expect(defaults.file).toBeNull()
    expect(defaults.config.homeDirectory).toBe(cwd)
  })

  test("searchDirectory: false never reads the directory (the opencode location is not a config source)", () => {
    const attacker = write(join(cwd, CONFIG_FILENAME), {
      github: { tokenEnv: "GITHUB_TOKEN" },
      stateDir: "./.s",
      mode: "queue",
    })
    const loaded = loadConfig({ directory: cwd, searchDirectory: false, homeDir: home, env: {} })
    expect(loaded.file).toBeNull()
    expect(loaded.searched).toEqual([homeFile()])
    expect(loaded.searched).not.toContain(attacker)
    expect(loaded.config.mode).toBe("dry-run")
    // the attacker's stateDir is ignored; the default is resolved under the (injected) home dir
    expect(loaded.config.stateDir).toBe(join(home, ".oss-scout"))
  })

  test("plugin order: ~/.oss-scout before the package directory; a directory equal to the package directory is searched there", () => {
    const inPkg = write(join(pkg, CONFIG_FILENAME), { mode: "off" })
    const inHome = write(homeFile(), { mode: "queue" })
    const plugin = loadConfig({ directory: pkg, searchDirectory: false, packageDirectory: pkg, homeDir: home, env: {} })
    expect(plugin.file).toBe(inHome)
    expect(plugin.shadowed).toEqual([inPkg])
    // the CLI run from the checkout resolves exactly like the plugin
    const cli = loadConfig({ directory: pkg, packageDirectory: pkg, homeDir: home, env: {} })
    expect(cli.file).toBe(inHome)
    expect(cli.searched).toEqual([inHome, inPkg])
  })

  test("explicit path and OSS_SCOUT_CONFIG win; ~ expands to the given home directory", () => {
    write(homeFile(), { mode: "queue" })
    const custom = write(join(home, "cfg", "custom.json"), { mode: "off" })
    const viaPath = loadConfig({ directory: cwd, explicitPath: "~/cfg/custom.json", homeDir: home, env: {} })
    expect(viaPath.file).toBe(custom)
    expect(viaPath.shadowed).toEqual([])
    expect(viaPath.searched).toBeUndefined()
    expect(loadConfig({ directory: cwd, homeDir: home, env: { OSS_SCOUT_CONFIG: "~/cfg/custom.json" } }).file).toBe(custom)
  })

  test("relative and ~ stateDir / homeDirectory resolve against the config's folder and the given home", () => {
    write(join(pkg, CONFIG_FILENAME), { stateDir: "state", homeDirectory: "~/work" })
    const loaded = loadConfig({ directory: pkg, searchDirectory: false, packageDirectory: pkg, homeDir: home, env: {} })
    expect(loaded.config.stateDir).toBe(join(pkg, "state"))
    expect(loaded.config.homeDirectory).toBe(join(home, "work"))
    // options-only (no file): relative paths resolve against the base directory, not a location
    const optionsOnly = loadConfig({ directory: pkg, searchDirectory: false, homeDir: home, env: {}, overrides: { stateDir: "s" } })
    expect(optionsOnly.file).toBeNull()
    expect(optionsOnly.config.stateDir).toBe(join(pkg, "s"))
  })

  test("reload re-runs the same lookup (notices a changed file)", () => {
    const file = write(join(pkg, CONFIG_FILENAME), { mode: "dry-run" })
    const loaded = loadConfig({ directory: pkg, searchDirectory: false, packageDirectory: pkg, homeDir: home, env: {} })
    expect(loaded.config.mode).toBe("dry-run")
    write(file, { mode: "queue" })
    expect(loaded.config.mode).toBe("dry-run")
    expect(loaded.reload!().config.mode).toBe("queue")
  })
})

// ---------------------------------------------------------------------------
// token and API host restrictions (a config must not redirect a secret)
// ---------------------------------------------------------------------------

describe("github token / API host restrictions", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oss-scout-ghcfg-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const load = (github: Record<string, unknown>, env: Record<string, string | undefined> = {}) => {
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ github }))
    return loadConfig({ directory: dir, searchDirectory: true, homeDir: dir, env })
  }

  test("tokenEnv / writeTokenEnv must be GitHub/oss-scout variables", () => {
    for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "MY_GH_TOKEN", "OSS_SCOUT_WRITE_TOKEN", "GITHUB_PAT_2"]) {
      expect(parseConfig({ github: { tokenEnv: name, writeTokenEnv: name } }).github.tokenEnv).toBe(name)
    }
    for (const name of ["OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY", "PATH", "github_token", "GH-TOKEN", "", "1GITHUB"]) {
      expect(`${name}:${configError({ github: { tokenEnv: name } }).issues[0]}`).toMatch(new RegExp(`^${name}:github\\.tokenEnv:`))
      expect(configError({ github: { writeTokenEnv: name } }).issues[0]).toMatch(/^github\.writeTokenEnv:/)
    }
  })

  test("apiBaseUrl must be https", () => {
    expect(configError({ github: { apiBaseUrl: "http://api.github.com" } }).issues[0]).toMatch(/^github\.apiBaseUrl: must be an https/)
  })

  test("only https://api.github.com is accepted unless OSS_SCOUT_ALLOW_CUSTOM_GITHUB_API=1", () => {
    expect(load({ apiBaseUrl: "https://api.github.com/" }).config.github.apiBaseUrl).toBe("https://api.github.com/")
    for (const url of ["https://attacker.example", "https://api.github.com.attacker.example", "https://api.github.com:8443", "https://user:pw@api.github.com", "https://api.github.com/v3"]) {
      let err: unknown = null
      try {
        load({ apiBaseUrl: url })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ConfigError)
      expect((err as ConfigError).issues[0]).toContain(`github.apiBaseUrl: must be ${DEFAULT_GITHUB_API_URL}`)
      expect((err as ConfigError).message).toContain(ALLOW_CUSTOM_GITHUB_API_ENV)
    }
    // the opt-in lives in the environment only (a config file cannot grant it to itself)
    expect(() => load({ apiBaseUrl: "https://ghe.example.com/api/v3" }, { [ALLOW_CUSTOM_GITHUB_API_ENV]: "true" })).toThrow(ConfigError)
    expect(load({ apiBaseUrl: "https://ghe.example.com/api/v3" }, { [ALLOW_CUSTOM_GITHUB_API_ENV]: "1" }).config.github.apiBaseUrl).toBe(
      "https://ghe.example.com/api/v3",
    )
    // plugin options (overrides) are checked as well
    expect(() => loadConfig({ directory: dir, homeDir: dir, env: {}, overrides: { github: { apiBaseUrl: "https://x.example" } } })).toThrow(ConfigError)
  })

  test("isDefaultGithubApiUrl", () => {
    expect(isDefaultGithubApiUrl("https://api.github.com")).toBe(true)
    expect(isDefaultGithubApiUrl("https://API.GITHUB.COM/")).toBe(true)
    for (const u of ["http://api.github.com", "https://api.github.com/x", "https://api.github.com?x=1", "not a url", "https://github.com"]) {
      expect(`${u}:${isDefaultGithubApiUrl(u)}`).toBe(`${u}:false`)
    }
  })
})
