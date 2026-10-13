/**
 * Composition root: config → paths → store → clients → AppContext → queue / scheduler / commands.
 * Used by the opencode plugin entry points (V2 `setup`, V1 `server`) and by the CLI.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { loadConfig, type LoadedConfig } from "./config/load.ts"
import type { AppContext } from "./core/context.ts"
import type { GitHubApi } from "./github/api.ts"
import { createGitHubClient, tokenKind } from "./github/client.ts"
import type { TokenInfo } from "./github/types.ts"
import type { LlmHost } from "./llm/host.ts"
import { createCommandRouter, type CommandRouter } from "./plugin/commands.ts"
import { ApprovalQueue } from "./queue/queue.ts"
import { Scheduler } from "./scheduler/daemon.ts"
import { KillSwitch } from "./scheduler/killswitch.ts"
import { openDatabase } from "./state/db.ts"
import { Store } from "./state/store.ts"
import { systemClock } from "./util/clock.ts"
import { execCommand, type Exec } from "./util/exec.ts"
import { createLogger, type Logger } from "./util/log.ts"
import { PACKAGE_ROOT, resolvePaths } from "./util/paths.ts"
import { registerSecret } from "./util/redact.ts"
import { createSandbox } from "./workspace/container.ts"

export const USER_AGENT = "oss-scout/0.1.0"

export interface App {
  ctx: AppContext
  loaded: LoadedConfig
  queue: ApprovalQueue
  scheduler: Scheduler
  commands: CommandRouter
  /** Kinds of the configured tokens (never the tokens themselves); null = not set. */
  tokens: { read: TokenInfo["kind"] | null; write: TokenInfo["kind"] | null }
  /** Environment the app was created with (doctor's environment checks). */
  env: Readonly<Record<string, string | undefined>>
  /** Stop the scheduler and close the database. Idempotent. */
  close(): Promise<void>
}

export interface CreateAppOptions {
  /**
   * CLI: its working directory (config lookup + relative paths). Plugin: the opencode location (only
   * logged; the plugin loads its config itself, see loadAppConfig / `loaded`).
   */
  directory: string
  /** Look for <directory>/oss-scout.config.json first (default true; see loadConfig). */
  searchDirectory?: boolean
  /** Searched after ~/.oss-scout (the oss-scout checkout); none by default. */
  packageDirectory?: string | null
  /** Home directory for ~/.oss-scout (tests); default os.homedir(). */
  homeDir?: string
  /** Plugin options: `configPath` selects the config file; other keys are deep-merged over it. */
  pluginOptions?: Readonly<Record<string, unknown>> | null
  /** LLM host (or a factory receiving the app logger); null outside opencode (CLI). */
  llm: LlmHost | null | ((log: Logger) => LlmHost)
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  exec?: Exec
  /** Replace parts of the context (tests: fake GitHub, sandbox, clock, …). */
  overrides?: Partial<AppContext>
  /** Already-loaded config (avoids loading it twice when the caller needed it first). */
  loaded?: LoadedConfig
}

function nonEmpty(v: string | undefined): string | null {
  const t = v?.trim()
  return t ? t : null
}

/** Plugin options → (explicit config path, inline config overrides). */
export function splitPluginOptions(options: Readonly<Record<string, unknown>> | null | undefined): {
  configPath: string | null
  overrides: Record<string, unknown> | null
} {
  if (!options) return { configPath: null, overrides: null }
  const { configPath, ...rest } = options
  return {
    configPath: typeof configPath === "string" && configPath.trim() ? configPath : null,
    overrides: Object.keys(rest).length > 0 ? rest : null,
  }
}

/** Load the config the same way createApp does (exposed so entry points can inspect it first). */
export function loadAppConfig(
  opts: Pick<CreateAppOptions, "directory" | "pluginOptions" | "env" | "searchDirectory" | "packageDirectory" | "homeDir">,
): LoadedConfig {
  const { configPath, overrides } = splitPluginOptions(opts.pluginOptions)
  return loadConfig({
    directory: opts.directory,
    explicitPath: configPath,
    overrides,
    env: opts.env ?? process.env,
    ...(opts.searchDirectory !== undefined ? { searchDirectory: opts.searchDirectory } : {}),
    ...(opts.packageDirectory ? { packageDirectory: opts.packageDirectory } : {}),
    ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
  })
}

/**
 * Config for the opencode plugin (V2 and V1). The project opencode was opened in is NOT a config
 * source (a cloned repository could otherwise redirect the token or start a scheduler). Lookup:
 * plugin option `configPath` → $OSS_SCOUT_CONFIG → ~/.oss-scout/oss-scout.config.json →
 * <oss-scout checkout>/oss-scout.config.json → built-in defaults. Relative paths (configPath, a
 * defaults-only stateDir) resolve against the checkout, so every location shares one state dir.
 */
export function loadPluginConfig(opts: {
  pluginOptions: Readonly<Record<string, unknown>> | null | undefined
  env?: Record<string, string | undefined> | undefined
  /** The oss-scout checkout (default PACKAGE_ROOT; tests pass a temp dir). */
  packageDirectory?: string | undefined
  homeDir?: string | undefined
}): LoadedConfig {
  const pkg = opts.packageDirectory ?? PACKAGE_ROOT
  return loadAppConfig({
    directory: pkg,
    searchDirectory: false,
    packageDirectory: pkg,
    pluginOptions: opts.pluginOptions ?? null,
    env: opts.env ?? process.env,
    ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
  })
}

/**
 * bun:sqlite caches only 20 prepared queries; statements beyond that are finalized by the garbage
 * collector, and until then `db.close()` leaves a zombie connection (sqlite3_close_v2) that keeps the
 * database file open. On Windows that locks the state dir (it cannot be deleted or moved) long after
 * close(). A forced collection finalizes those statements and releases the file.
 */
function releaseClosedDatabases(): void {
  try {
    Bun.gc(true)
  } catch {
    // not running on Bun / GC unavailable: the handle is released on the next collection
  }
}

/** Create the state directory skeleton (empty hooks dir, empty git config). */
function prepareStateDir(paths: AppContext["paths"]): void {
  mkdirSync(paths.stateDir, { recursive: true })
  mkdirSync(paths.emptyHooksDir, { recursive: true })
  if (!existsSync(paths.emptyGitConfig)) writeFileSync(paths.emptyGitConfig, "")
}

/**
 * Build the application. Makes no network calls: GitHub is only contacted when a command or
 * the scheduler needs it. Throws ConfigError for an invalid/missing explicit config.
 */
export function createApp(opts: CreateAppOptions): App {
  const env = opts.env ?? process.env
  const overrides = opts.overrides ?? {}
  const loaded =
    opts.loaded ??
    loadAppConfig({
      directory: opts.directory,
      pluginOptions: opts.pluginOptions,
      env,
      searchDirectory: opts.searchDirectory,
      packageDirectory: opts.packageDirectory,
      homeDir: opts.homeDir,
    })
  const config = overrides.config ?? loaded.config
  const paths = overrides.paths ?? resolvePaths(config.stateDir, loaded.baseDir)
  prepareStateDir(paths)

  const log = overrides.log ?? createLogger({ level: config.logging.level, file: paths.logFile, console: config.logging.console })

  const readToken = nonEmpty(env[config.github.tokenEnv])
  const writeToken = nonEmpty(env[config.github.writeTokenEnv])
  registerSecret(readToken)
  registerSecret(writeToken)

  const store = overrides.store ?? new Store(openDatabase(paths.dbFile))
  try {
    return buildApp(opts, { overrides, loaded, config, paths, log, readToken, writeToken, store })
  } catch (err) {
    // Do not leak an open database (on Windows it also keeps the state dir locked).
    if (!overrides.store) {
      try {
        store.db.close()
      } catch {
        // already closed
      }
      releaseClosedDatabases()
    }
    throw err
  }
}

interface AppParts {
  overrides: Partial<AppContext>
  loaded: LoadedConfig
  config: AppContext["config"]
  paths: AppContext["paths"]
  log: Logger
  readToken: string | null
  writeToken: string | null
  store: Store
}

function buildApp(opts: CreateAppOptions, parts: AppParts): App {
  const { overrides, loaded, config, paths, log, readToken, writeToken, store } = parts
  const kill = overrides.kill ?? new KillSwitch(paths.killFile)
  const clock = overrides.clock ?? systemClock
  const fetchFn = overrides.fetch ?? opts.fetch ?? globalThis.fetch
  const exec = overrides.exec ?? opts.exec ?? execCommand

  const clientBase = {
    baseUrl: config.github.apiBaseUrl,
    apiVersion: config.github.apiVersion,
    userAgent: USER_AGENT,
    clock,
    kill,
    fetch: fetchFn,
    minWriteIntervalMs: config.github.minWriteIntervalMs,
  }
  const github: GitHubApi =
    overrides.github ??
    createGitHubClient({ ...clientBase, token: readToken, allowWrites: false, store, log: log.child({ component: "github" }) })
  const githubWriter: GitHubApi =
    overrides.githubWriter ??
    createGitHubClient({
      ...clientBase,
      token: writeToken ?? readToken,
      allowWrites: config.mode === "queue",
      store: null,
      log: log.child({ component: "github-writer" }),
    })
  const sandbox = overrides.sandbox ?? createSandbox(config, exec, log.child({ component: "sandbox" }))

  let cachedLogin: Promise<string> | null = null
  const login = (): Promise<string> => {
    if (!readToken) {
      return Promise.reject(
        new Error(`${config.github.tokenEnv} is not set; oss-scout needs a GitHub token to identify your account`),
      )
    }
    if (!cachedLogin) {
      const pending = github.getAuthenticatedUser().then((u) => u.login)
      pending.catch(() => {
        if (cachedLogin === pending) cachedLogin = null
      })
      cachedLogin = pending
    }
    return cachedLogin
  }

  const ctx: AppContext = {
    config,
    paths,
    store,
    github,
    githubWriter,
    clock,
    log,
    kill,
    fetch: fetchFn,
    exec,
    sandbox,
    llm: overrides.llm !== undefined ? overrides.llm : typeof opts.llm === "function" ? opts.llm(log.child({ component: "llm" })) : opts.llm,
    secrets: overrides.secrets ?? {
      writeToken: () => writeToken ?? readToken,
      hasReadToken: () => readToken !== null,
    },
    login: overrides.login ?? login,
  }

  const queue = new ApprovalQueue(ctx)
  const scheduler = new Scheduler(ctx)
  let closed = false
  const app: App = {
    ctx,
    loaded,
    queue,
    scheduler,
    commands: undefined as unknown as CommandRouter,
    tokens: { read: readToken ? tokenKind(readToken) : null, write: writeToken ? tokenKind(writeToken) : null },
    env: opts.env ?? process.env,
    async close() {
      if (closed) return
      closed = true
      try {
        await scheduler.stop()
      } finally {
        try {
          store.db.close()
        } catch {
          // already closed
        }
        releaseClosedDatabases()
      }
    },
  }
  app.commands = createCommandRouter(app)
  log.debug("oss-scout app created", {
    directory: opts.directory,
    configFile: loaded.file,
    mode: config.mode,
    stateDir: paths.stateDir,
    llm: ctx.llm?.kind ?? null,
    readToken: readToken !== null,
    writeToken: writeToken !== null,
  })
  return app
}
