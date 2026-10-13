import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  ALLOW_CUSTOM_GITHUB_API_ENV,
  ConfigError,
  DEFAULT_GITHUB_API_URL,
  isDefaultGithubApiUrl,
  parseConfig,
  type OssScoutConfig,
} from "./schema.ts"
import { expandHome } from "../util/paths.ts"

export const CONFIG_FILENAME = "oss-scout.config.json"

export interface LoadedConfig {
  config: OssScoutConfig
  /** File the config was read from; null when running on defaults. */
  file: string | null
  /** Directory relative paths in the config resolve against. */
  baseDir: string
  /** Config files that were looked for (in order) when no explicit path was given. */
  searched?: string[]
  /** Other existing config files in the lookup order that were NOT used (doctor warns about them). */
  shadowed?: string[]
  /** Re-run the same lookup, e.g. to notice that the file changed on disk after it was loaded. */
  reload?: () => LoadedConfig
}

export interface LoadConfigOptions {
  /**
   * Base directory: relative explicit paths and the relative paths of a defaults-only config resolve
   * against it. The CLI passes its working directory; the opencode plugin passes the oss-scout checkout.
   */
  directory: string
  /** Explicit config path (plugin option `configPath` or CLI --config). */
  explicitPath?: string | null
  /** Inline overrides (plugin options), deep-merged over the file. */
  overrides?: Record<string, unknown> | null
  env?: Record<string, string | undefined>
  /**
   * Look for `<directory>/oss-scout.config.json` before ~/.oss-scout (default true: the CLI). The
   * opencode plugin passes false: the project opencode was opened in is never a config source.
   */
  searchDirectory?: boolean
  /** Searched after ~/.oss-scout: the oss-scout checkout (where server.ts lives). */
  packageDirectory?: string | null
  /** Home directory for ~/.oss-scout and "~" expansion (tests); default os.homedir(). */
  homeDir?: string
}

function normalize(p: string): string {
  const r = resolve(p)
  return process.platform === "win32" ? r.toLowerCase() : r
}

/** Remove duplicates, keeping the LAST occurrence (a directory that is also a later fallback is searched there). */
function dedupeKeepLast(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = paths.length - 1; i >= 0; i--) {
    const key = normalize(paths[i]!)
    if (seen.has(key)) continue
    seen.add(key)
    out.unshift(paths[i]!)
  }
  return out
}

/**
 * Resolve and validate the config. Lookup order:
 *  1. explicitPath, else $OSS_SCOUT_CONFIG
 *  2. <directory>/oss-scout.config.json (only when searchDirectory is not false)
 *  3. ~/.oss-scout/oss-scout.config.json
 *  4. <packageDirectory>/oss-scout.config.json (when given)
 *  5. built-in defaults
 * A directory that is also the package directory is searched at step 4, so the CLI run from the
 * checkout resolves exactly like the plugin.
 */
export function loadConfig(opts: LoadConfigOptions): LoadedConfig {
  const env = opts.env ?? process.env
  const home = opts.homeDir ?? homedir()
  const reload = (): LoadedConfig => loadConfig(opts)
  const explicit = opts.explicitPath ?? env.OSS_SCOUT_CONFIG ?? null

  let candidates: string[]
  if (explicit) {
    const p = resolve(opts.directory, expandHome(explicit, home))
    if (!existsSync(p)) throw new ConfigError(`oss-scout config not found: ${p}`, [`file not found: ${p}`])
    candidates = [p]
  } else {
    const list: string[] = []
    if (opts.searchDirectory !== false) list.push(join(opts.directory, CONFIG_FILENAME))
    list.push(join(home, ".oss-scout", CONFIG_FILENAME))
    if (opts.packageDirectory) list.push(join(opts.packageDirectory, CONFIG_FILENAME))
    candidates = dedupeKeepLast(list)
  }
  const searched = explicit ? undefined : candidates

  for (const file of candidates) {
    if (!existsSync(file)) continue
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, "utf8"))
    } catch (err) {
      throw new ConfigError(`oss-scout config ${file} is not valid JSON: ${(err as Error).message}`, ["invalid JSON"])
    }
    const merged = opts.overrides ? deepMerge(raw, opts.overrides) : raw
    const config = parseConfig(merged)
    checkGithubApi(config, env, file)
    const baseDir = dirname(file)
    const shadowed = explicit ? [] : candidates.filter((c) => c !== file && existsSync(c))
    return { config: withDefaults(config, baseDir, home), file, baseDir, searched, shadowed, reload }
  }

  const config = parseConfig(opts.overrides ?? {})
  checkGithubApi(config, env, null)
  return { config: withDefaults(config, opts.directory, home), file: null, baseDir: opts.directory, searched, shadowed: [], reload }
}

/**
 * The GitHub token is sent to `github.apiBaseUrl`: only api.github.com is accepted unless the
 * environment (never a config file) opts in with OSS_SCOUT_ALLOW_CUSTOM_GITHUB_API=1.
 */
function checkGithubApi(config: OssScoutConfig, env: Record<string, string | undefined>, file: string | null): void {
  const url = config.github.apiBaseUrl
  if (isDefaultGithubApiUrl(url) || env[ALLOW_CUSTOM_GITHUB_API_ENV] === "1") return
  const issue = `github.apiBaseUrl: must be ${DEFAULT_GITHUB_API_URL} unless ${ALLOW_CUSTOM_GITHUB_API_ENV}=1 is set in the environment (got ${url})`
  throw new ConfigError(`Invalid oss-scout config${file ? ` ${file}` : ""}:\n  - ${issue}`, [issue])
}

function withDefaults(config: OssScoutConfig, baseDir: string, home: string): OssScoutConfig {
  return {
    ...config,
    // Default state dir is resolved here (not later via os.homedir()) so an injected home dir is honored.
    stateDir: config.stateDir ? resolve(baseDir, expandHome(config.stateDir, home)) : join(home, ".oss-scout"),
    homeDirectory: config.homeDirectory ? resolve(baseDir, expandHome(config.homeDirectory, home)) : baseDir,
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Deep merge: objects merge recursively, arrays and scalars from `b` replace `a`. */
export function deepMerge(a: unknown, b: unknown): unknown {
  if (!isPlainObject(a) || !isPlainObject(b)) return b === undefined ? a : b
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (k === "configPath") continue
    out[k] = k in a ? deepMerge(a[k], v) : v
  }
  return out
}
