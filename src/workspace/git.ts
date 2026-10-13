import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Exec, ExecResult } from "../util/exec.ts"
import { safeEnv, tail } from "../util/exec.ts"
import type { Paths } from "../util/paths.ts"
import { redact } from "../util/redact.ts"
import { secureWorkTree, WorkTreeIntegrityError, type WorkTreeScan } from "./hygiene.ts"

/**
 * Layout for a task:
 *   <workspacesDir>/<taskId>        task dir: the opencode agent session is located HERE
 *   <workspacesDir>/<taskId>/repo   work tree (mounted rw into the sandbox; the agent edits it)
 *   <gitDirsDir>/<taskId>           git dir: outside the task dir, so neither the agent session nor
 *                                   sandboxed code can modify it (mounted read-only at /work/.git)
 * Host-side git ALWAYS runs with explicit --git-dir/--work-tree, GIT_CONFIG_GLOBAL=<empty file>,
 * GIT_CONFIG_NOSYSTEM=1, core.hooksPath=<empty dir>, so a malicious `.git` file, hook or config
 * written into the work tree can never redirect or configure host git.
 *
 * Nested repositories: sandboxed code (or the agent) can create `<dir>/.git` anywhere in the work
 * tree. Host git treats such a directory as a submodule and, when it inspects it, runs a child git
 * inside it that reads THAT repository's config, which no `-c` override can fully neutralize. So
 * before every host git command that may look at the work tree, SafeGit walks the tree (without
 * following links) and removes every `.git` entry below the root (see hygiene.ts), and it refuses
 * to stage or diff any gitlink (mode 160000) change. Submodule recursion is disabled on every call.
 */
export interface GitPaths {
  taskDir: string
  workTree: string
  gitDir: string
  /** Empty dir used as core.hooksPath (no hooks ever run on the host). */
  hooksDir: string
  /** Empty file used as GIT_CONFIG_GLOBAL. */
  globalConfig: string
}

const TASK_ID_RE = /^[A-Za-z0-9_.-]+$/

/** Throws unless `taskId` is a safe single path segment. */
export function assertTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId) || taskId === "." || taskId === ".." || taskId.length > 128) {
    throw new Error(`invalid task id for a workspace path: ${JSON.stringify(taskId)}`)
  }
}

export function gitPathsFor(
  paths: Pick<Paths, "workspacesDir" | "gitDirsDir" | "emptyHooksDir" | "emptyGitConfig">,
  taskId: string,
): GitPaths {
  assertTaskId(taskId)
  const taskDir = join(paths.workspacesDir, taskId)
  return {
    taskDir,
    workTree: join(taskDir, "repo"),
    gitDir: join(paths.gitDirsDir, taskId),
    hooksDir: paths.emptyHooksDir,
    globalConfig: paths.emptyGitConfig,
  }
}

export interface GitIdentity {
  name: string
  email: string
}

/** Patterns written to <gitDir>/info/exclude: sandbox install artifacts never show up in diffs. */
export const EXCLUDE_PATTERNS = [
  "/.oss-scout-*/",
  "node_modules/",
  "__pycache__/",
  ".pytest_cache/",
  ".venv/",
  "venv/",
  ".tox/",
  ".mypy_cache/",
  ".ruff_cache/",
  "target/",
  ".gradle/",
  "*.pyc",
  "*.egg-info/",
  "coverage/",
  ".nyc_output/",
]

/**
 * `-c` flags applied to every host-side git invocation (including clone). They neutralize hooks,
 * fsmonitor, credential helpers, external diff drivers, pagers, line-ending rewriting, symlink
 * checkout (a tracked symlink could point at host files) and background auto-gc.
 */
export function hardeningFlags(hooksDir: string): string[] {
  const flags = [
    "-c", `core.hooksPath=${hooksDir}`,
    "-c", "core.fsmonitor=false",
    "-c", "credential.helper=",
    "-c", "diff.external=",
    "-c", "core.pager=cat",
    "-c", "core.autocrlf=false",
    "-c", "advice.detachedHead=false",
    "-c", "core.symlinks=false",
    "-c", "gc.auto=0",
    "-c", "maintenance.auto=false",
    "-c", "submodule.recurse=false",
    "-c", "fetch.recurseSubmodules=false",
    "-c", "push.recurseSubmodules=no",
    "-c", "status.submoduleSummary=false",
  ]
  if (process.platform === "win32") flags.push("-c", "core.longpaths=true")
  return flags
}

/**
 * Base environment for host git: no user/system config, no prompts, no LFS smudge, no optional locks,
 * and repository discovery never climbs above the state dir (the parent of the empty global config).
 */
export function gitEnv(paths: Pick<GitPaths, "globalConfig">, extra: Record<string, string> = {}): Record<string, string> {
  return safeEnv({
    GIT_CONFIG_GLOBAL: paths.globalConfig,
    GIT_CEILING_DIRECTORIES: dirname(paths.globalConfig),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0",
    ...extra,
  })
}

/** Accepted push targets: a plain GitHub HTTPS repo URL without credentials. */
export const PUSH_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/

/** Branch/ref names: conservative subset of git's rules; never option-like. */
export function isSafeRefName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.includes("/.") &&
    !name.startsWith(".")
  )
}

function assertRef(kind: string, value: string): void {
  if (!isSafeRefName(value)) throw new Error(`invalid ${kind}: ${JSON.stringify(value)}`)
}

/** A revision argument (sha, branch, HEAD~1…) that cannot be mistaken for an option. */
function assertRev(value: string): void {
  if (!value || value.startsWith("-") || /[\s\0]/.test(value) || value.length > 200) {
    throw new Error(`invalid git revision: ${JSON.stringify(value)}`)
  }
}

/** Clone URLs: https or (tests) file://, never option-like, no embedded credentials. */
function assertCloneUrl(url: string): "https" | "file" {
  if (/[\s\0]/.test(url) || url.startsWith("-")) throw new Error("invalid clone URL")
  if (/^https:\/\/[^/@\s]+\//.test(url)) return "https"
  if (url.startsWith("file://")) return "file"
  throw new Error(`refusing to clone from ${redact(url)}: only https:// (or file:// in tests) is allowed`)
}

/** Name of the git subcommand in an arg list (skips leading `-c key=value` pairs and options). */
function subcommandOf(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "-c") {
      i++
      continue
    }
    if (!a.startsWith("-")) return a
  }
  return args[0] ?? "(none)"
}

/** Subcommands that never read the work tree (no nested-repository scan needed before them). */
const NO_WORK_TREE_SUBCOMMANDS = new Set(["rev-parse", "rev-list", "log", "ls-tree", "cat-file", "show-ref", "for-each-ref", "push"])

/** Paths in `git diff --raw` output whose old or new mode is a gitlink (160000). */
export function gitlinkPaths(raw: string): string[] {
  const out: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const m = /^:(\d{6}) (\d{6}) \S+ \S+ \S+\t(.*)$/.exec(line)
    if (m && (m[1] === "160000" || m[2] === "160000")) out.push(m[3]!)
  }
  return out
}

const GITLINK_PATCH_RE = /^(?:new file mode|deleted file mode|old mode|new mode) 160000$|^index [0-9a-f]+\.\.[0-9a-f]+ 160000$/m

const DEFAULT_TIMEOUT_MS = 2 * 60_000
const CLONE_TIMEOUT_MS = 15 * 60_000
const PUSH_TIMEOUT_MS = 5 * 60_000

/** Remove a directory tree; retries cover transient Windows EBUSY/EPERM. */
export function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

export interface SafeGitOptions {
  timeoutMs?: number
  /** Called when the pre-command scan removed planted `.git` entries (for logging/audit). */
  onSanitized?: (scan: WorkTreeScan) => void
}

export class SafeGit {
  constructor(
    readonly paths: GitPaths,
    readonly exec: Exec,
    readonly opts: SafeGitOptions = {},
  ) {}

  /**
   * Remove every `.git` entry below the work-tree root before host git looks at the tree, so git
   * never treats a planted directory as a nested repository (whose config it would read).
   */
  private sanitizeWorkTree(): void {
    const scan = secureWorkTree(this.paths.workTree, { links: false })
    if (scan.removedGitEntries.length > 0) this.opts.onSanitized?.(scan)
  }

  /**
   * Make sure the hooks dir exists and is empty and the global config file exists and is empty.
   * Fails closed: if anything was planted there, no git command runs.
   */
  private ensureScaffold(): void {
    const { hooksDir, globalConfig } = this.paths
    mkdirSync(hooksDir, { recursive: true })
    if (readdirSync(hooksDir).length > 0) throw new Error(`refusing to run git: hooks dir ${hooksDir} is not empty`)
    if (!existsSync(globalConfig)) {
      mkdirSync(dirname(globalConfig), { recursive: true })
      writeFileSync(globalConfig, "")
    }
    if (statSync(globalConfig).size !== 0) throw new Error(`refusing to run git: ${globalConfig} is not empty`)
  }

  private async exec0(argv: string[], subcmd: string, opts: GitRunOptions): Promise<ExecResult> {
    this.ensureScaffold()
    // cwd is the (verified empty) hooks dir: never the work tree or task dir, so a planted
    // `git.exe` there can never be picked up by Windows' current-directory executable lookup.
    const res = await this.exec(argv, {
      cwd: this.paths.hooksDir,
      env: gitEnv(this.paths, opts.env),
      timeoutMs: opts.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(opts.raw ? { raw: true } : {}),
    })
    if (!opts.allowFailure) {
      if (res.timedOut) throw new Error(`git ${subcmd} timed out`)
      if (res.exitCode !== 0) {
        const detail = tail(redact((res.stderr || res.stdout).trim()), 2000)
        throw new Error(`git ${subcmd} failed: ${detail || `exit code ${res.exitCode}`}`)
      }
    }
    return res
  }

  /**
   * Run git with --git-dir/--work-tree, hardening -c flags and every network transport disabled (push
   * re-enables https only). Env is scrubbed (no tokens). Unless the subcommand never reads the work
   * tree, planted `.git` entries are removed first.
   */
  run(args: string[], opts: GitRunOptions = {}): Promise<ExecResult> {
    const { gitDir, workTree, hooksDir } = this.paths
    const subcmd = subcommandOf(args)
    if (!NO_WORK_TREE_SUBCOMMANDS.has(subcmd)) this.sanitizeWorkTree()
    const argv = ["git", "--git-dir", gitDir, "--work-tree", workTree, ...hardeningFlags(hooksDir), "-c", "protocol.allow=never", ...args]
    return this.exec0(argv, subcmd, opts)
  }

  /** Clone with a separate git dir; no submodules, no LFS smudge, no checkout hooks. */
  async clone(url: string, opts: { depth: number; branch?: string }): Promise<void> {
    const scheme = assertCloneUrl(url)
    if (!Number.isInteger(opts.depth) || opts.depth < 1) throw new Error(`invalid clone depth: ${opts.depth}`)
    if (opts.branch !== undefined) assertRef("branch", opts.branch)
    const { taskDir, workTree, gitDir, hooksDir } = this.paths
    mkdirSync(taskDir, { recursive: true })
    removeTree(workTree)
    removeTree(gitDir)
    mkdirSync(dirname(gitDir), { recursive: true })
    // Only the URL's own transport is allowed (no ext::, ssh, git:// or redirects to them).
    const protocol = ["-c", "protocol.allow=never", "-c", `protocol.${scheme}.allow=always`]
    const argv = [
      "git",
      ...hardeningFlags(hooksDir),
      ...protocol,
      "clone",
      "--separate-git-dir",
      gitDir,
      "--depth",
      String(opts.depth),
      "--single-branch",
      "--no-tags",
      "--no-recurse-submodules",
      ...(opts.branch ? ["--branch", opts.branch] : []),
      "--",
      url,
      workTree,
    ]
    await this.exec0(argv, "clone", { timeoutMs: Math.max(this.opts.timeoutMs ?? 0, CLONE_TIMEOUT_MS) })
    // Host git always passes --git-dir explicitly; the pointer file would only help sandboxed code.
    rmSync(join(workTree, ".git"), { recursive: true, force: true })
    mkdirSync(join(gitDir, "info"), { recursive: true })
    writeFileSync(
      join(gitDir, "info", "exclude"),
      ["# oss-scout: sandbox/install artifacts are never part of a change", ...EXCLUDE_PATTERNS, ""].join("\n"),
    )
  }

  async checkoutNewBranch(name: string, startPoint: string): Promise<void> {
    assertRef("branch", name)
    assertRev(startPoint)
    await this.run(["checkout", "-B", name, startPoint, "--"])
  }

  /** Switch to an existing local branch. */
  async checkout(name: string): Promise<void> {
    assertRef("branch", name)
    await this.run(["checkout", name, "--"])
  }

  async headSha(): Promise<string> {
    const res = await this.run(["rev-parse", "HEAD"])
    const sha = res.stdout.trim()
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) throw new Error(`git rev-parse returned an unexpected value: ${sha.slice(0, 80)}`)
    return sha
  }

  /** true when the git dir holds a usable repository with a HEAD commit. */
  async isUsable(): Promise<boolean> {
    if (!existsSync(this.paths.gitDir) || !existsSync(this.paths.workTree)) return false
    try {
      const res = await this.run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { allowFailure: true })
      return res.exitCode === 0 && res.stdout.trim().length > 0
    } catch {
      return false
    }
  }

  async recentSubjects(n: number): Promise<string[]> {
    const count = Math.max(1, Math.floor(n))
    const res = await this.run(["log", "-n", String(count), "--format=%s"])
    return res.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  /** Tracked + untracked files (respecting .gitignore). */
  async listFiles(): Promise<string[]> {
    const res = await this.run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    return [...new Set(res.stdout.split("\0").filter((s) => s.length > 0))]
  }

  /**
   * `git add -A`, then refuse when the index now adds, changes or removes a gitlink (submodule)
   * relative to HEAD. The pre-command scan already removed nested repositories, so a gitlink change
   * means the work tree was tampered with.
   */
  private async stageAll(): Promise<void> {
    await this.run(["add", "-A"])
    const raw = await this.run(["diff", "--cached", "--raw", "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD", "--"])
    const links = gitlinkPaths(raw.stdout)
    if (links.length > 0) {
      throw new WorkTreeIntegrityError(`refusing to stage a git submodule (gitlink) change: ${links.slice(0, 5).join(", ")}`)
    }
  }

  /**
   * Unified diff of the work tree (including new files) against `baseSha`, binary-safe (no textconv,
   * no ext diff). RAW (not redacted): the secrets gate must see real token shapes. Never log it.
   */
  async diffAgainst(baseSha: string): Promise<string> {
    assertRev(baseSha)
    await this.stageAll()
    const res = await this.run(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "-M", baseSha, "--"], { raw: true })
    if (GITLINK_PATCH_RE.test(res.stdout)) throw new WorkTreeIntegrityError("refusing a diff that changes a git submodule (gitlink)")
    return res.stdout
  }

  /**
   * Unified diff between two commits (e.g. base..commitSha right after committing): exactly the
   * committed content, independent of the work tree. RAW (not redacted); never log it.
   */
  async diffCommits(fromRev: string, toRev: string): Promise<string> {
    assertRev(fromRev)
    assertRev(toRev)
    const res = await this.run(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", fromRev, toRev, "--"], { raw: true })
    if (GITLINK_PATCH_RE.test(res.stdout)) throw new WorkTreeIntegrityError("refusing a commit that changes a git submodule (gitlink)")
    return res.stdout
  }

  /** Stage everything and commit; returns the new sha. `signoff` adds Signed-off-by. Never runs hooks. */
  async commitAll(message: string, author: GitIdentity, signoff: boolean): Promise<string> {
    assertIdentity(author)
    if (!message.trim()) throw new Error("commit message is empty")
    await this.stageAll()
    const env = {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    }
    await this.run(
      [
        "-c", `user.name=${author.name}`,
        "-c", `user.email=${author.email}`,
        "-c", "commit.gpgsign=false",
        "commit",
        "--no-verify",
        ...(signoff ? ["-s"] : []),
        "-m",
        message,
      ],
      { env },
    )
    return this.headSha()
  }

  /** Discard work-tree changes back to `ref` (tracked + untracked). */
  async resetHard(ref: string): Promise<void> {
    assertRev(ref)
    await this.run(["reset", "--hard", ref, "--"])
    // No -x: ignored install artifacts (node_modules, .oss-scout-venv, …) survive between attempts.
    await this.run(["clean", "-fd"])
  }

  /**
   * Push `localRef` to `remoteUrl` as `remoteBranch`. The token is passed only via GIT_CONFIG_* env
   * (http.extraHeader), never argv, URL or config files. Hooks disabled, --no-verify.
   */
  async push(remoteUrl: string, localRef: string, remoteBranch: string, token: string): Promise<ExecResult> {
    if (!PUSH_URL_RE.test(remoteUrl)) throw new Error(`refusing to push to ${redact(remoteUrl)}: not a plain https://github.com/<owner>/<repo> URL`)
    assertRef("local ref", localRef)
    assertRef("remote branch", remoteBranch)
    if (!token || /[\s\0]/.test(token)) throw new Error("push requires a non-empty token without whitespace")
    const header = pushAuthHeader(token)
    // run() disables every transport; a push re-enables https (and only https).
    const args = ["-c", "protocol.https.allow=always", "push", "--no-verify", remoteUrl, `${localRef}:refs/heads/${remoteBranch}`]
    if (args.some((a) => a.includes(token))) throw new Error("refusing to push: token would appear in argv")
    const res = await this.run(args, {
      allowFailure: true,
      timeoutMs: Math.max(this.opts.timeoutMs ?? 0, PUSH_TIMEOUT_MS),
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: header,
      },
    })
    const scrub = (s: string) => redact(s.split(token).join("[REDACTED]").split(header).join("[REDACTED]"))
    return { ...res, stdout: scrub(res.stdout), stderr: scrub(res.stderr) }
  }
}

export interface GitRunOptions {
  timeoutMs?: number
  env?: Record<string, string>
  allowFailure?: boolean
  /** Unredacted stdout/stderr (diffs for the secrets gate). Never log such output. */
  raw?: boolean
}

/** `AUTHORIZATION: basic base64("x-access-token:<token>")`, the header actions/checkout uses. */
export function pushAuthHeader(token: string): string {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`
}

function assertIdentity(id: GitIdentity): void {
  const bad = (s: string) => !s.trim() || /[<>\r\n\0]/.test(s)
  if (bad(id.name) || bad(id.email)) throw new Error("invalid commit identity")
}
