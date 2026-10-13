import { z } from "zod"

/**
 * oss-scout configuration schema.
 *
 * Every field has a default so that a config containing only `interests` (plus GITHUB_TOKEN
 * in the environment) is enough to run in dry-run mode.
 */

const repoPattern = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/(\*|[A-Za-z0-9_.-]+)$/, 'expected "owner/repo" or "owner/*"')

const modelRef = z
  .string()
  .regex(/^[^/\s]+\/[^\s]+$/, 'expected "providerID/modelID" (optionally "#variant")')

const DEFAULT_DISCLOSURE = "Prepared with AI assistance; reviewed and tested by me."

export const InterestsSchema = z
  .object({
    /** GitHub `language:` qualifiers used for search-based discovery. */
    languages: z.array(z.string().min(1)).default(["TypeScript", "JavaScript", "Python", "Java"]),
    /** GitHub `topic:` qualifiers used for search-based discovery. */
    topics: z
      .array(z.string().min(1))
      .default(["react", "nextjs", "fastapi", "spring-boot", "mongodb", "llm", "ai-tools"]),
    /** Free-text keywords added to repository searches (optional). */
    keywords: z.array(z.string().min(1)).default([]),
  })
  .prefault({})

/** The only GitHub API origin a token is sent to, unless ALLOW_CUSTOM_GITHUB_API_ENV=1 is set. */
export const DEFAULT_GITHUB_API_URL = "https://api.github.com"

/** Environment variable (never a config key) that allows a non-default `github.apiBaseUrl`. */
export const ALLOW_CUSTOM_GITHUB_API_ENV = "OSS_SCOUT_ALLOW_CUSTOM_GITHUB_API"

/** `url` is https://api.github.com (a trailing slash is tolerated; no path, query, credentials or port). */
export function isDefaultGithubApiUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (
      u.origin === DEFAULT_GITHUB_API_URL &&
      (u.pathname === "/" || u.pathname === "") &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password
    )
  } catch {
    return false
  }
}

/**
 * Env var names a config may read a token from. The value is sent as a GitHub Authorization header,
 * so a config must not be able to name an unrelated secret (OPENAI_API_KEY, AWS_SECRET_ACCESS_KEY…).
 */
const tokenEnvName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "expected an upper-case environment variable name (A-Z, 0-9, _)")
  .refine((name) => /GITHUB|GH_|OSS_SCOUT/.test(name), {
    message: 'the variable name must contain "GITHUB", "GH_" or "OSS_SCOUT" (e.g. GITHUB_TOKEN, GH_TOKEN, OSS_SCOUT_WRITE_TOKEN)',
  })

export const GithubSchema = z
  .object({
    /** Env var holding the read token (fine-grained PAT recommended). Must contain GITHUB, GH_ or OSS_SCOUT. */
    tokenEnv: tokenEnvName.default("GITHUB_TOKEN"),
    /**
     * Optional env var holding the token used ONLY by the human-approved executor (fork/push/PR/comment).
     * Fine-grained PATs cannot open PRs on repos you don't own; a classic PAT with `public_repo` may be needed.
     * When unset or empty, the read token is used. Must contain GITHUB, GH_ or OSS_SCOUT.
     */
    writeTokenEnv: tokenEnvName.default("OSS_SCOUT_WRITE_TOKEN"),
    /**
     * GitHub REST API base URL. Only https://api.github.com is accepted unless the environment variable
     * OSS_SCOUT_ALLOW_CUSTOM_GITHUB_API=1 is set (the token is sent to this host).
     */
    apiBaseUrl: z
      .string()
      .url()
      .refine((u) => u.startsWith("https://"), { message: "must be an https:// URL" })
      .default(DEFAULT_GITHUB_API_URL),
    apiVersion: z.string().default("2022-11-28"),
    /** Max requests in flight. GitHub recommends serial requests. */
    concurrency: z.number().int().min(1).max(4).default(1),
    /** Minimum delay between mutating requests (GitHub best practice: >= 1s). */
    minWriteIntervalMs: z.number().int().min(1000).default(1500),
  })
  .prefault({})

export const ReposSchema = z
  .object({
    /** If non-empty, ONLY these repos/orgs are considered ("owner/repo" or "owner/*"). */
    allow: z.array(repoPattern).default([]),
    /** Never considered ("owner/repo" or "owner/*"). Deny wins over allow. */
    deny: z.array(repoPattern).default([]),
  })
  .prefault({})

export const DiscoverySchema = z
  .object({
    fromDependencies: z.boolean().default(true),
    fromSearch: z.boolean().default(true),
    /** How often discovery runs. */
    intervalHours: z.number().min(1).default(24),
    /** Max of your own repos scanned for manifests per discovery run. */
    maxOwnRepos: z.number().int().min(0).default(30),
    /** Max new candidate repos added per discovery run. */
    maxNewReposPerRun: z.number().int().min(1).default(40),
    /** Search-based discovery: only repos pushed within this many days. */
    searchPushedWithinDays: z.number().int().min(1).default(60),
    /** Results per search query (GitHub caps at 100 per page). */
    searchResultsPerQuery: z.number().int().min(1).max(100).default(20),
    /** Include devDependencies / test dependencies from manifests. */
    includeDevDependencies: z.boolean().default(false),
  })
  .prefault({})

export const ScreeningSchema = z
  .object({
    minStars: z.number().int().min(0).default(100),
    maxStars: z.number().int().min(0).nullable().default(null),
    /** Repos scoring below this are hard-skipped. 0..1 */
    minScore: z.number().min(0).max(1).default(0.55),
    /** Skip repos with no maintainer activity (merge/review/commit) in this many days. */
    maxDaysSinceMaintainerActivity: z.number().int().min(1).default(45),
    /** Skip repos whose outside-contributor PR merge rate is below this (when the sample is large enough). */
    minOutsideMergeRate: z.number().min(0).max(1).default(0.25),
    /** Sample size needed before merge rate is used as a hard filter. */
    minMergeRateSample: z.number().int().min(1).default(8),
    /** Median time to first maintainer response on outside PRs; above this is penalized. */
    maxMedianFirstResponseDays: z.number().min(0).default(14),
    requireCi: z.boolean().default(true),
    requireLicense: z.boolean().default(true),
    /** Allowed SPDX ids. Empty = any license GitHub recognizes (not NOASSERTION). */
    allowedLicenses: z.array(z.string()).default([]),
    /** Skip when the AI policy is unclear but restrictive (recommended: true). */
    skipUnclearRestrictivePolicy: z.boolean().default(true),
    /** Re-screen eligible repos after this many days. */
    rescreenAfterDays: z.number().int().min(1).default(14),
    /** Max repos screened per scheduler tick. */
    maxPerTick: z.number().int().min(1).default(3),
  })
  .prefault({})

export const IssuesSchema = z
  .object({
    /** Preferred labels (case-insensitive). Issues with these get a score boost. */
    labels: z
      .array(z.string())
      .default(["good first issue", "help wanted", "bug", "confirmed", "documentation", "docs", "tests", "testing"]),
    /** Issues with any of these labels are skipped (case-insensitive substring match). */
    excludeLabels: z
      .array(z.string())
      .default([
        "wontfix",
        "won't fix",
        "invalid",
        "duplicate",
        "question",
        "discussion",
        "needs design",
        "needs-design",
        "rfc",
        "proposal",
        "breaking",
        "blocked",
        "on hold",
        "needs decision",
        "needs triage",
        "security",
      ]),
    /** Only issues updated within this many days (older = stale). */
    staleAfterDays: z.number().int().min(1).default(180),
    /** Skip very contentious threads. */
    maxComments: z.number().int().min(0).default(15),
    minScore: z.number().min(0).max(1).default(0.5),
    /** Max issues fetched per repo per selection pass. */
    maxCandidatesPerRepo: z.number().int().min(1).max(100).default(15),
  })
  .prefault({})

export const CapsSchema = z
  .object({
    maxOpenPrsPerRepo: z.number().int().min(1).default(1),
    /** Days after one of your PRs is merged or closed before that repo is eligible again. */
    repoCooldownDays: z.number().int().min(0).default(30),
    /** Max PRs submitted (approved + created) per rolling 7 days, globally. */
    maxSubmittedPrsPerWeek: z.number().int().min(0).default(3),
    /** Stop preparing new work while this many items await your review. */
    maxPendingQueueItems: z.number().int().min(1).default(3),
    /** Contribution tasks in flight at once. */
    maxConcurrentTasks: z.number().int().min(1).max(4).default(1),
  })
  .prefault({})

export const ImplementationSchema = z
  .object({
    /** Implementation attempts (each = LLM edit + sandboxed test run) before aborting the task. */
    maxAttempts: z.number().int().min(1).max(10).default(3),
    maxDiffLines: z.number().int().min(1).default(200),
    maxFilesChanged: z.number().int().min(1).default(8),
    /** opencode agent used for implementation sessions (default agent when unset). */
    agent: z.string().nullable().default(null),
    /** "providerID/modelID" for implementation sessions (opencode default when unset). */
    model: modelRef.nullable().default(null),
    sessionTimeoutMinutes: z.number().min(1).default(30),
    cloneDepth: z.number().int().min(1).default(50),
    /** Require a failing reproduction test before the fix for bug-type issues. */
    requireReproduction: z.boolean().default(true),
    /** Commit author; defaults to your GitHub login + noreply email. */
    authorName: z.string().nullable().default(null),
    authorEmail: z.string().nullable().default(null),
    /** Per-repo overrides for detected commands / image. */
    overrides: z
      .record(
        z.string(),
        z.object({
          install: z.string().nullable().optional(),
          test: z.string().nullable().optional(),
          lint: z.string().nullable().optional(),
          image: z.string().optional(),
        }),
      )
      .default({}),
  })
  .prefault({})

export const SandboxSchema = z
  .object({
    /** Container runtime CLI. Untrusted repo code ONLY ever runs inside a container. */
    runtime: z.enum(["docker", "podman"]).default("docker"),
    images: z
      .object({
        node: z.string().default("node:22-bookworm"),
        python: z.string().default("python:3.12-bookworm"),
        maven: z.string().default("maven:3.9-eclipse-temurin-21"),
        gradle: z.string().default("gradle:8.10-jdk21"),
        fallback: z.string().default("debian:bookworm"),
      })
      .prefault({}),
    /** Network for dependency installation. Tests and lint always run with network "none". */
    installNetwork: z.enum(["bridge", "none"]).default("bridge"),
    memory: z.string().default("4g"),
    cpus: z.string().default("2"),
    pidsLimit: z.number().int().min(64).default(1024),
    /** Read-only root filesystem (+ writable tmpfs /tmp). Installs write only inside /work. */
    readOnlyRootfs: z.boolean().default(true),
    timeouts: z
      .object({
        installMinutes: z.number().min(1).default(20),
        testMinutes: z.number().min(1).default(20),
        lintMinutes: z.number().min(1).default(10),
      })
      .prefault({}),
    /** Max bytes of command output kept per run. */
    maxOutputBytes: z.number().int().min(1024).default(200_000),
  })
  .prefault({})

export const CriticSchema = z
  .object({
    /** "providerID/modelID"; ideally different from the implementation model. */
    model: modelRef.nullable().default(null),
    /** Minimum critic confidence for an approve verdict to count. */
    minConfidence: z.number().min(0).max(1).default(0.7),
  })
  .prefault({})

export const FollowupSchema = z
  .object({
    enabled: z.boolean().default(true),
    pollIntervalMinutes: z.number().min(5).default(60),
    /** Draft replies to review comments into the approval queue. Never auto-posted. */
    draftReplies: z.boolean().default(true),
    /** Prepare follow-up fixes for "changes requested" reviews into the approval queue. */
    draftFixes: z.boolean().default(true),
    /** Model for summaries / reply drafts ("providerID/modelID"). */
    model: modelRef.nullable().default(null),
  })
  .prefault({})

export const SchedulerSchema = z
  .object({
    /** Start the background loop when the plugin loads (only in the home directory). */
    autostart: z.boolean().default(true),
    tickSeconds: z.number().int().min(10).default(60),
    backoffBaseSeconds: z.number().int().min(1).default(60),
    backoffMaxSeconds: z.number().int().min(60).default(6 * 3600),
    /** Leader lease TTL; another process may take over after this. */
    leaseSeconds: z.number().int().min(30).default(300),
  })
  .prefault({})

export const BudgetSchema = z
  .object({
    perTask: z
      .object({
        maxTokens: z.number().int().min(1000).default(600_000),
        maxCostUsd: z.number().min(0).default(5),
      })
      .prefault({}),
    perDay: z
      .object({
        maxTokens: z.number().int().min(1000).default(3_000_000),
        maxCostUsd: z.number().min(0).default(20),
      })
      .prefault({}),
  })
  .prefault({})

export const DisclosureSchema = z
  .object({
    /** Appended to every PR body. Must mention AI. Cannot be disabled. */
    line: z
      .string()
      .min(10)
      .refine((s) => /\bAI\b|artificial intelligence|LLM|language model/i.test(s), {
        message: "disclosure line must explicitly mention AI involvement",
      })
      .default(DEFAULT_DISCLOSURE),
    /** Note appended to drafted review replies. */
    replyLine: z
      .string()
      .min(5)
      .refine((s) => /\bAI\b|artificial intelligence|LLM|language model/i.test(s), {
        message: "reply disclosure must explicitly mention AI involvement",
      })
      .default("(Drafted with AI assistance and reviewed by me.)"),
  })
  .prefault({})

export const LoggingSchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    /** Also echo log lines to the console (opencode server log when running as a plugin). */
    console: z.boolean().default(false),
  })
  .prefault({})

export const ConfigSchema = z.object({
  $schema: z.string().optional(),
  mode: z.enum(["dry-run", "queue", "off"]).default("dry-run"),
  /**
   * Where state (SQLite DB, workspaces, logs, queue files, kill switch) lives.
   * Default: ~/.oss-scout. Should NOT be inside a git repository.
   */
  stateDir: z.string().nullable().default(null),
  /**
   * The directory whose opencode location runs the background loop. Default: the directory the
   * config file was found in (the oss-scout checkout when running on built-in defaults).
   */
  homeDirectory: z.string().nullable().default(null),
  interests: InterestsSchema,
  github: GithubSchema,
  repos: ReposSchema,
  discovery: DiscoverySchema,
  screening: ScreeningSchema,
  issues: IssuesSchema,
  caps: CapsSchema,
  implementation: ImplementationSchema,
  sandbox: SandboxSchema,
  critic: CriticSchema,
  followup: FollowupSchema,
  scheduler: SchedulerSchema,
  budget: BudgetSchema,
  disclosure: DisclosureSchema,
  logging: LoggingSchema,
})

export type OssScoutConfig = z.infer<typeof ConfigSchema>
export type ConfigInput = z.input<typeof ConfigSchema>
export type Mode = OssScoutConfig["mode"]

export const DEFAULT_DISCLOSURE_LINE = DEFAULT_DISCLOSURE

/** Parse + validate a raw config object. Throws ConfigError with readable issues. */
export function parseConfig(raw: unknown): OssScoutConfig {
  const result = ConfigSchema.safeParse(raw ?? {})
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    throw new ConfigError(`Invalid oss-scout config:\n  - ${issues.join("\n  - ")}`, issues)
  }
  return result.data
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message)
    this.name = "ConfigError"
  }
}

/** JSON Schema for editors (`oss-scout config-schema`). */
export function configJsonSchema(): unknown {
  return z.toJSONSchema(ConfigSchema, { io: "input" })
}

/** Parse "providerID/modelID#variant" into parts. */
export function parseModelRef(ref: string | null): { providerID: string; modelID: string; variant?: string } | null {
  if (!ref) return null
  const slash = ref.indexOf("/")
  if (slash <= 0) return null
  const providerID = ref.slice(0, slash)
  const rest = ref.slice(slash + 1)
  const hash = rest.indexOf("#")
  if (hash === -1) return { providerID, modelID: rest }
  return { providerID, modelID: rest.slice(0, hash), variant: rest.slice(hash + 1) }
}
