import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createApp, loadAppConfig, loadPluginConfig, splitPluginOptions, USER_AGENT, type App, type CreateAppOptions } from "../src/app.ts"
import { PACKAGE_ROOT } from "../src/util/paths.ts"
import { ConfigError } from "../src/config/schema.ts"
import { mintWriteAuthorization, WriteForbiddenError, type CreatePullInput, type WriteAuthorization } from "../src/github/api.ts"
import type { LlmHost } from "../src/llm/host.ts"
import { runningScheduler } from "../src/scheduler/daemon.ts"
import { FakeClock } from "../src/util/clock.ts"
import { createLogger } from "../src/util/log.ts"
import { redact } from "../src/util/redact.ts"
import { FakeGitHub, FakeLlm, FakeSandbox, fakeExec, ghPull, ghUser, removeTempDir } from "./helpers/fakes.ts"

const CLASSIC = "ghp_" + "c".repeat(36)
const CLASSIC_WRITE = "ghp_" + "w".repeat(36)
const FINE = "github_pat_" + "f".repeat(40)

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oss-scout-app-"))
  cleanups.push(() => removeTempDir(dir))
  return dir
}

/** Temp project dir with an oss-scout.config.json whose state dir is inside it. */
function project(config: Record<string, unknown> = {}, file = "oss-scout.config.json"): { dir: string; stateDir: string } {
  const dir = tempDir()
  const stateDir = join(dir, "state")
  writeFileSync(join(dir, file), JSON.stringify({ stateDir, ...config }))
  return { dir, stateDir }
}

interface Recorder {
  fetch: typeof fetch
  calls: Array<{ url: string; init: RequestInit | undefined }>
}

function recordingFetch(respond?: (url: string, init: RequestInit | undefined) => Response): Recorder {
  const calls: Recorder["calls"] = []
  const fn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (!respond) throw new Error(`unexpected fetch ${url}`)
    return respond(url, init)
  }) as unknown as typeof fetch
  return { fetch: fn, calls }
}

function make(opts: Partial<CreateAppOptions> & { directory: string }): App {
  const app = createApp({ llm: null, env: {}, exec: fakeExec(), ...opts })
  cleanups.push(() => app.close())
  return app
}

const pullInput: CreatePullInput = { title: "fix: x", body: "body\n\nAI disclosure", head: "me:oss-scout/1-x", base: "main" }

// ---------------------------------------------------------------------------
// creation
// ---------------------------------------------------------------------------

describe("createApp", () => {
  test("loads the config, prepares the state dir and makes no network or process calls", () => {
    const { dir, stateDir } = project({ mode: "dry-run" })
    const rec = recordingFetch()
    const exec = fakeExec()
    const app = make({ directory: dir, env: { GITHUB_TOKEN: CLASSIC }, fetch: rec.fetch, exec })
    expect(app.loaded.file).toBe(join(dir, "oss-scout.config.json"))
    expect(app.ctx.config.mode).toBe("dry-run")
    expect(app.ctx.paths.stateDir).toBe(stateDir)
    expect(existsSync(app.ctx.paths.dbFile)).toBe(true)
    expect(existsSync(app.ctx.paths.emptyHooksDir)).toBe(true)
    expect(readFileSync(app.ctx.paths.emptyGitConfig, "utf8")).toBe("")
    expect(rec.calls).toHaveLength(0)
    expect(exec.calls).toHaveLength(0)
    expect(app.ctx.fetch).toBe(rec.fetch)
    expect(app.scheduler.running).toBe(false)
    expect(app.commands.names).toContain("approve")
    expect(USER_AGENT).toStartWith("oss-scout/")
  })

  test("a relative stateDir resolves against the config file's directory", () => {
    const dir = tempDir()
    writeFileSync(join(dir, "oss-scout.config.json"), JSON.stringify({ stateDir: "rel-state" }))
    const app = make({ directory: dir })
    expect(app.ctx.paths.stateDir).toBe(join(dir, "rel-state"))
  })

  test("token kinds and secrets: the write token is preferred for writes", () => {
    const { dir } = project()
    const app = make({ directory: dir, env: { GITHUB_TOKEN: FINE, OSS_SCOUT_WRITE_TOKEN: CLASSIC_WRITE } })
    expect(app.tokens).toEqual({ read: "fine-grained", write: "classic" })
    expect(app.ctx.secrets.hasReadToken()).toBe(true)
    expect(app.ctx.secrets.writeToken()).toBe(CLASSIC_WRITE)
  })

  test("without a write token, writes fall back to the read token", () => {
    const { dir } = project()
    const app = make({ directory: dir, env: { GITHUB_TOKEN: CLASSIC, OSS_SCOUT_WRITE_TOKEN: "   " } })
    expect(app.tokens).toEqual({ read: "classic", write: null })
    expect(app.ctx.secrets.writeToken()).toBe(CLASSIC)
  })

  test("without any token nothing is available", () => {
    const { dir } = project()
    const app = make({ directory: dir, env: { GITHUB_TOKEN: "" } })
    expect(app.tokens).toEqual({ read: null, write: null })
    expect(app.ctx.secrets.hasReadToken()).toBe(false)
    expect(app.ctx.secrets.writeToken()).toBeNull()
  })

  test("token env names come from the config", () => {
    const { dir } = project({ github: { tokenEnv: "MY_GH_TOKEN", writeTokenEnv: "MY_GH_WRITE" } })
    const app = make({ directory: dir, env: { GITHUB_TOKEN: CLASSIC, MY_GH_TOKEN: FINE, MY_GH_WRITE: "other-token-value" } })
    expect(app.tokens).toEqual({ read: "fine-grained", write: "other" })
    expect(app.ctx.secrets.writeToken()).toBe("other-token-value")
  })

  test("a config cannot point the token at another secret or another host", () => {
    for (const github of [{ tokenEnv: "ANTHROPIC_API_KEY" }, { writeTokenEnv: "AWS_SECRET_ACCESS_KEY" }, { apiBaseUrl: "https://attacker.example" }]) {
      const { dir } = project({ github })
      const rec = recordingFetch()
      expect(() => make({ directory: dir, env: { GITHUB_TOKEN: CLASSIC, ANTHROPIC_API_KEY: "sk-ant-" + "s".repeat(30) }, fetch: rec.fetch })).toThrow(
        ConfigError,
      )
      expect(rec.calls).toHaveLength(0)
    }
  })

  test("llm: null, a host, a factory (gets a logger) and an override", () => {
    const { dir } = project()
    expect(make({ directory: dir, llm: null }).ctx.llm).toBeNull()
    const host = new FakeLlm()
    expect(make({ directory: dir, llm: host }).ctx.llm).toBe(host)
    let gotLogger = false
    const built = make({
      directory: dir,
      llm: (log) => {
        gotLogger = typeof log.info === "function" && typeof log.child === "function"
        return host
      },
    })
    expect(built.ctx.llm).toBe(host)
    expect(gotLogger).toBe(true)
    const other = new FakeLlm() as LlmHost
    expect(make({ directory: dir, llm: host, overrides: { llm: other } }).ctx.llm).toBe(other)
    expect(make({ directory: dir, llm: host, overrides: { llm: null } }).ctx.llm).toBeNull()
  })

  test("overrides replace context parts", () => {
    const { dir } = project()
    const github = new FakeGitHub()
    const writer = new FakeGitHub()
    const sandbox = new FakeSandbox()
    const clock = new FakeClock()
    const app = make({ directory: dir, overrides: { github, githubWriter: writer, sandbox, clock } })
    expect(app.ctx.github).toBe(github)
    expect(app.ctx.githubWriter).toBe(writer)
    expect(app.ctx.sandbox).toBe(sandbox)
    expect(app.ctx.clock).toBe(clock)
  })

  test("an invalid config throws ConfigError", () => {
    const dir = tempDir()
    writeFileSync(join(dir, "oss-scout.config.json"), JSON.stringify({ mode: "yolo" }))
    expect(() => createApp({ directory: dir, llm: null, env: {} })).toThrow(ConfigError)
  })

  test("a failure after the database was opened closes it again", () => {
    const { dir, stateDir } = project()
    expect(() =>
      createApp({
        directory: dir,
        env: {},
        exec: fakeExec(),
        llm: () => {
          throw new Error("host exploded")
        },
      }),
    ).toThrow("host exploded")
    // On Windows an open SQLite handle makes this fail with EBUSY.
    rmSync(join(stateDir, "oss-scout.db"), { force: true })
    expect(existsSync(join(stateDir, "oss-scout.db"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

describe("login", () => {
  test("rejects clearly without a token (and does not call GitHub)", async () => {
    const { dir } = project()
    const github = new FakeGitHub({ getAuthenticatedUser: async () => ghUser("me") })
    const app = make({ directory: dir, env: {}, overrides: { github } })
    await expect(app.ctx.login()).rejects.toThrow("GITHUB_TOKEN is not set")
    expect(github.calls).toHaveLength(0)
  })

  test("caches the login after the first success", async () => {
    const { dir } = project()
    const github = new FakeGitHub({ getAuthenticatedUser: async () => ghUser("octo") })
    const app = make({ directory: dir, env: { GITHUB_TOKEN: CLASSIC }, overrides: { github } })
    const [a, b] = await Promise.all([app.ctx.login(), app.ctx.login()])
    expect(a).toBe("octo")
    expect(b).toBe("octo")
    expect(await app.ctx.login()).toBe("octo")
    expect(github.calls.filter((c) => c.method === "getAuthenticatedUser")).toHaveLength(1)
  })

  test("a failed lookup is not cached", async () => {
    const { dir } = project()
    let n = 0
    const github = new FakeGitHub({
      getAuthenticatedUser: async () => {
        n++
        if (n === 1) throw new Error("502 Bad Gateway")
        return ghUser("octo")
      },
    })
    const app = make({ directory: dir, env: { GITHUB_TOKEN: CLASSIC }, overrides: { github } })
    await expect(app.ctx.login()).rejects.toThrow("502")
    expect(await app.ctx.login()).toBe("octo")
    expect(n).toBe(2)
  })

  test("an overridden login is used as is", async () => {
    const { dir } = project()
    const app = make({ directory: dir, overrides: { login: async () => "injected" } })
    expect(await app.ctx.login()).toBe("injected")
  })
})

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

describe("secret registration", () => {
  test("the env tokens are redacted everywhere, even when they match no known token shape", () => {
    const { dir } = project({ logging: { level: "debug" } })
    const unique = `plain-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const writeUnique = `${unique}-write`
    expect(redact(`token=${unique}`)).toContain(unique)
    const app = make({ directory: dir, env: { GITHUB_TOKEN: unique, OSS_SCOUT_WRITE_TOKEN: writeUnique } })
    expect(redact(`token=${unique}`)).toBe("token=[REDACTED]")
    expect(redact(`w=${writeUnique}`)).not.toContain(writeUnique)

    const lines: string[] = []
    const log = createLogger({ sink: (l) => lines.push(l) })
    log.warn(`using ${unique}`, { header: `Bearer ${unique}`, nested: { t: writeUnique } })
    expect(lines.join("\n")).not.toContain(unique)

    app.ctx.log.warn(`app log with ${unique}`)
    const file = readFileSync(app.ctx.paths.logFile, "utf8")
    expect(file).toContain("[REDACTED]")
    expect(file).not.toContain(unique)
  })

  test("the creation log line records token presence, never the tokens", () => {
    const { dir } = project({ logging: { level: "debug" } })
    const app = make({ directory: dir, env: { GITHUB_TOKEN: CLASSIC } })
    const file = readFileSync(app.ctx.paths.logFile, "utf8")
    expect(file).toContain("oss-scout app created")
    expect(file).toContain('"readToken":true')
    expect(file).not.toContain(CLASSIC)
  })
})

// ---------------------------------------------------------------------------
// GitHub write gating (real client, mocked fetch)
// ---------------------------------------------------------------------------

function minted(): WriteAuthorization {
  return mintWriteAuthorization({
    queueItemId: 1,
    itemStatus: "approved",
    itemDigest: "abcdef0123456789",
    providedDigest: "abcdef01",
    actor: "human",
    via: "cli",
    mode: "queue",
    now: 0,
  })
}

const forged = { queueItemId: 1, digest: "abcdef0123456789", approvedAt: 0, via: "cli" } as unknown as WriteAuthorization

describe("githubWriter", () => {
  test("dry-run: the writer refuses every write, forged or genuine, without any request", async () => {
    const { dir } = project({ mode: "dry-run" })
    const rec = recordingFetch()
    const app = make({ directory: dir, env: { GITHUB_TOKEN: CLASSIC, OSS_SCOUT_WRITE_TOKEN: CLASSIC_WRITE }, fetch: rec.fetch, overrides: { clock: new FakeClock() } })
    await expect(app.ctx.githubWriter.createPull(forged, "acme/widget", pullInput)).rejects.toBeInstanceOf(WriteForbiddenError)
    await expect(app.ctx.githubWriter.createPull(minted(), "acme/widget", pullInput)).rejects.toThrow("read-only")
    await expect(app.ctx.githubWriter.createFork(minted(), "acme/widget")).rejects.toBeInstanceOf(WriteForbiddenError)
    await expect(app.ctx.githubWriter.createIssueComment(minted(), "acme/widget", 1, "hi")).rejects.toBeInstanceOf(WriteForbiddenError)
    expect(rec.calls).toHaveLength(0)
  })

  test("off mode: writes are refused too", async () => {
    const { dir } = project({ mode: "off" })
    const rec = recordingFetch()
    const app = make({ directory: dir, env: { GITHUB_TOKEN: CLASSIC }, fetch: rec.fetch })
    await expect(app.ctx.githubWriter.createPull(minted(), "acme/widget", pullInput)).rejects.toThrow("read-only")
    expect(rec.calls).toHaveLength(0)
  })

  test("queue mode: a forged authorization is refused; a minted one writes with the write token", async () => {
    const { dir } = project({ mode: "queue" })
    const rec = recordingFetch(
      () =>
        new Response(JSON.stringify(ghPull({ number: 101, state: "open", merged_at: null, closed_at: null })), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    )
    const app = make({
      directory: dir,
      env: { GITHUB_TOKEN: CLASSIC, OSS_SCOUT_WRITE_TOKEN: CLASSIC_WRITE },
      fetch: rec.fetch,
      overrides: { clock: new FakeClock() },
    })
    await expect(app.ctx.githubWriter.createPull(forged, "acme/widget", pullInput)).rejects.toThrow("no human approval")
    expect(rec.calls).toHaveLength(0)

    const pr = await app.ctx.githubWriter.createPull(minted(), "acme/widget", pullInput)
    expect(pr.number).toBe(101)
    expect(rec.calls).toHaveLength(1)
    const call = rec.calls[0]!
    expect(call.url).toBe("https://api.github.com/repos/acme/widget/pulls")
    expect(call.init?.method).toBe("POST")
    const headers = call.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${CLASSIC_WRITE}`)
    expect(headers["User-Agent"]).toBe(USER_AGENT)
  })

  test("queue mode: the read client still refuses writes", async () => {
    const { dir } = project({ mode: "queue" })
    const rec = recordingFetch()
    const app = make({ directory: dir, env: { GITHUB_TOKEN: CLASSIC }, fetch: rec.fetch })
    await expect(app.ctx.github.createPull(minted(), "acme/widget", pullInput)).rejects.toThrow("read-only")
    expect(rec.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

describe("close", () => {
  test("stops the scheduler, closes the database and is idempotent", async () => {
    const { dir, stateDir } = project()
    const app = createApp({ directory: dir, llm: null, env: {}, exec: fakeExec() })
    app.scheduler.start()
    expect(app.scheduler.running).toBe(true)
    expect(runningScheduler(stateDir)).toBe(app.scheduler)

    await app.close()
    expect(app.scheduler.running).toBe(false)
    expect(runningScheduler(stateDir)).toBeNull()
    expect(() => app.ctx.store.db.query("SELECT 1").get()).toThrow()
    await app.close()
    await Promise.all([app.close(), app.close()])
    rmSync(stateDir, { recursive: true, force: true })
    expect(existsSync(stateDir)).toBe(false)
  })

  test("commands after close return errors instead of throwing", async () => {
    const { dir } = project()
    const app = createApp({ directory: dir, llm: null, env: {}, exec: fakeExec() })
    await app.close()
    expect(await app.commands.run("queue", "", "cli")).toStartWith("error:")
  })
})

// ---------------------------------------------------------------------------
// plugin options / config loading
// ---------------------------------------------------------------------------

describe("splitPluginOptions", () => {
  test("separates configPath from inline overrides", () => {
    expect(splitPluginOptions(null)).toEqual({ configPath: null, overrides: null })
    expect(splitPluginOptions(undefined)).toEqual({ configPath: null, overrides: null })
    expect(splitPluginOptions({})).toEqual({ configPath: null, overrides: null })
    expect(splitPluginOptions({ configPath: "x.json" })).toEqual({ configPath: "x.json", overrides: null })
    expect(splitPluginOptions({ configPath: "  ", mode: "queue" })).toEqual({ configPath: null, overrides: { mode: "queue" } })
    expect(splitPluginOptions({ configPath: 5, caps: { maxOpenPrsPerRepo: 1 } })).toEqual({
      configPath: null,
      overrides: { caps: { maxOpenPrsPerRepo: 1 } },
    })
  })
})

describe("loadAppConfig", () => {
  test("finds oss-scout.config.json in the directory", () => {
    const { dir, stateDir } = project({ mode: "off" })
    const loaded = loadAppConfig({ directory: dir, env: {} })
    expect(loaded.file).toBe(join(dir, "oss-scout.config.json"))
    expect(loaded.baseDir).toBe(dir)
    expect(loaded.config.mode).toBe("off")
    expect(loaded.config.stateDir).toBe(stateDir)
    expect(loaded.config.homeDirectory).toBe(dir)
  })

  test("plugin options select the file and override keys", () => {
    const { dir } = project({ mode: "dry-run", scheduler: { tickSeconds: 120 } }, "custom.json")
    const loaded = loadAppConfig({ directory: dir, pluginOptions: { configPath: "custom.json", mode: "queue" }, env: {} })
    expect(loaded.file).toBe(join(dir, "custom.json"))
    expect(loaded.config.mode).toBe("queue")
    expect(loaded.config.scheduler.tickSeconds).toBe(120)
  })

  test("OSS_SCOUT_CONFIG from the given env selects the file", () => {
    const { dir } = project({ mode: "off" }, "elsewhere.json")
    const loaded = loadAppConfig({ directory: dir, env: { OSS_SCOUT_CONFIG: join(dir, "elsewhere.json") } })
    expect(loaded.file).toBe(join(dir, "elsewhere.json"))
    expect(loaded.config.mode).toBe("off")
  })

  test("a missing explicit config and an invalid override throw ConfigError", () => {
    const { dir } = project()
    expect(() => loadAppConfig({ directory: dir, pluginOptions: { configPath: "missing.json" }, env: {} })).toThrow(ConfigError)
    expect(() => loadAppConfig({ directory: dir, pluginOptions: { mode: "yolo" }, env: {} })).toThrow(ConfigError)
  })
})

describe("loadPluginConfig (the opencode location is never a config source)", () => {
  test("order: configPath option → OSS_SCOUT_CONFIG → ~/.oss-scout → the checkout → defaults", () => {
    const home = tempDir()
    const pkg = project({ mode: "off" })
    const homeFile = join(home, ".oss-scout", "oss-scout.config.json")
    const base = { packageDirectory: pkg.dir, homeDir: home, env: {} }

    expect(loadPluginConfig({ ...base, pluginOptions: null }).file).toBe(join(pkg.dir, "oss-scout.config.json"))
    mkdirSync(dirname(homeFile), { recursive: true })
    writeFileSync(homeFile, JSON.stringify({ mode: "queue", stateDir: join(home, "state") }))
    const fromHome = loadPluginConfig({ ...base, pluginOptions: {} })
    expect(fromHome.file).toBe(homeFile)
    expect(fromHome.config.homeDirectory).toBe(dirname(homeFile))
    const viaEnv = project({ mode: "off" }, "env.json")
    expect(loadPluginConfig({ ...base, pluginOptions: null, env: { OSS_SCOUT_CONFIG: join(viaEnv.dir, "env.json") } }).file).toBe(
      join(viaEnv.dir, "env.json"),
    )
    // a relative configPath resolves against the checkout, never against an opencode location
    writeFileSync(join(pkg.dir, "custom.json"), JSON.stringify({ mode: "dry-run" }))
    expect(loadPluginConfig({ ...base, pluginOptions: { configPath: "custom.json" } }).file).toBe(join(pkg.dir, "custom.json"))

    rmSync(homeFile)
    rmSync(join(pkg.dir, "oss-scout.config.json"))
    const defaults = loadPluginConfig({ ...base, pluginOptions: { stateDir: "state" } })
    expect(defaults.file).toBeNull()
    expect(defaults.baseDir).toBe(pkg.dir)
    expect(defaults.config.homeDirectory).toBe(pkg.dir)
    expect(defaults.config.stateDir).toBe(join(pkg.dir, "state"))
  })

  test("defaults to the oss-scout checkout (where server.ts lives)", () => {
    expect(existsSync(join(PACKAGE_ROOT, "server.ts"))).toBe(true)
    expect(existsSync(join(PACKAGE_ROOT, "package.json"))).toBe(true)
  })
})
