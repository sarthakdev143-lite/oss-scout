import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { audit, type AppContext } from "../core/context.ts"
import type { CommandRun, CommitConvention, IssueRecord, ProjectInfo, RepoRecord, TaskRecord } from "../core/types.ts"
import { tail } from "../util/exec.ts"
import { errorMessage } from "../util/log.ts"
import { redact } from "../util/redact.ts"
import { slugify } from "../util/text.ts"
import { assertTaskId, gitPathsFor, removeTree, SafeGit, type GitPaths } from "./git.ts"
import { secureWorkTree, suspiciousLinks, WorkTreeIntegrityError, type WorkTreeScan } from "./hygiene.ts"
import { detectCommitConvention, detectProject } from "./project.ts"
import { SandboxInterruptedError, SandboxUnavailableError } from "./sandbox.ts"

export interface PreparedWorkspace {
  taskDir: string
  paths: GitPaths
  git: SafeGit
  project: ProjectInfo
  branch: string
  baseBranch: string
  baseSha: string
  convention: CommitConvention
}

/** Production clone URLs: public GitHub HTTPS, no credentials, no other host. */
export const GITHUB_CLONE_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/

/** Max size of a file read on the host for project detection. */
export const MAX_READ_BYTES = 256 * 1024
/** CommandRun.outputTail size. */
export const OUTPUT_TAIL_CHARS = 20_000

/** "oss-scout/<issue-number>-<slug>" (or "oss-scout/followup-<pr>-<n>" for follow-up fixes). */
export function branchNameFor(issue: IssueRecord): string {
  return `oss-scout/${issue.number}-${slugify(issue.title)}`
}

/** <workspacesDir>/<taskId> */
export function taskDirFor(ctx: Pick<AppContext, "paths">, taskId: string): string {
  assertTaskId(taskId)
  return join(ctx.paths.workspacesDir, taskId)
}

/**
 * Reader for files in the work tree used by project detection: relative paths only, no "..",
 * no symlinks (a tracked symlink could point at host files), at most MAX_READ_BYTES.
 */
export function workTreeReader(workTree: string, maxBytes = MAX_READ_BYTES): (path: string) => string | null {
  const root = resolve(workTree)
  return (path: string) => {
    const rel = path.replace(/\\/g, "/")
    if (!rel || rel.includes("\0") || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith("/")) return null
    if (rel.split("/").some((seg) => seg === "..")) return null
    const full = resolve(root, rel)
    if (!full.startsWith(root + sep)) return null
    try {
      const st = lstatSync(full)
      if (!st.isFile() || st.isSymbolicLink() || st.size > maxBytes) return null
      const real = realpathSync(full)
      const realRoot = realpathSync(root)
      if (!real.startsWith(realRoot + sep)) return null
      return readFileSync(full, "utf8")
    } catch {
      return null
    }
  }
}

function assertCloneUrl(url: string, allowFileUrl: boolean): void {
  if (GITHUB_CLONE_URL_RE.test(url)) return
  if (allowFileUrl && url.startsWith("file://")) return
  throw new Error(`refusing to clone ${redact(url)}: expected https://github.com/<owner>/<name>.git`)
}

/** Log and audit what a work-tree scan removed (planted nested repositories, escaping links). */
function reportScan(ctx: AppContext, taskId: string, scan: WorkTreeScan): void {
  if (scan.removedGitEntries.length === 0 && scan.removedLinks.length === 0) return
  const details = {
    taskId,
    gitEntries: scan.removedGitEntries.slice(0, 20),
    links: scan.removedLinks.slice(0, 20).map((l) => ({ path: l.path, target: redact(l.target), inArtifactDir: l.inArtifactDir })),
  }
  ctx.log.warn("workspace: removed planted entries from the work tree", details)
  const reasons = [
    ...scan.removedGitEntries.slice(0, 5).map((p) => `nested git entry ${p}`),
    ...scan.removedLinks.slice(0, 5).map((l) => `link ${l.path} pointing outside the work tree`),
  ]
  try {
    audit(ctx, "system", "workspace.sanitize", taskId, "removed", reasons, details)
  } catch (err) {
    ctx.log.warn("workspace: audit of the work-tree scan failed", { error: errorMessage(err) })
  }
}

/** Task id of a task dir / git paths (the last path segment of the task dir). */
function taskIdOf(paths: GitPaths): string {
  return basename(paths.taskDir)
}

function gitFor(ctx: AppContext, paths: GitPaths): SafeGit {
  return new SafeGit(paths, ctx.exec, { onSanitized: (scan) => reportScan(ctx, taskIdOf(paths), scan) })
}

/**
 * Neutralize what sandboxed code may have planted in the work tree: nested `.git` entries and
 * links resolving outside the tree are removed (logged and audited). Throws WorkTreeIntegrityError
 * when such a link was found outside the install-artifact directories (a sign of a malicious
 * repository: abort the task) or the tree cannot be scanned. Call it after every sandbox run and
 * before every agent turn.
 */
export function sanitizeWorkTree(ctx: AppContext, paths: GitPaths): WorkTreeScan {
  const scan = secureWorkTree(paths.workTree, { links: true })
  reportScan(ctx, taskIdOf(paths), scan)
  const bad = suspiciousLinks(scan)
  if (bad.length > 0) {
    const list = bad.slice(0, 5).map((l) => l.path).join(", ")
    throw new WorkTreeIntegrityError(`sandboxed code created links pointing outside the work tree (removed): ${list}`)
  }
  return scan
}

/**
 * Clone the upstream (public, unauthenticated, read-only) into <taskDir>, create the task branch,
 * detect the project. Idempotent: re-running after a crash reuses or recreates the clone.
 * Nothing is forked or pushed here (that happens only after human approval).
 *
 * `options.allowFileUrl` is TEST-ONLY: it lets tests clone a local fixture repo via file://.
 */
export async function prepareWorkspace(
  ctx: AppContext,
  input: { task: TaskRecord; repo: RepoRecord; issue: IssueRecord | null; branch: string; baseBranch: string; cloneUrl: string },
  options: { allowFileUrl?: boolean } = {},
): Promise<PreparedWorkspace> {
  const { task, repo, branch, baseBranch, cloneUrl } = input
  assertCloneUrl(cloneUrl, options.allowFileUrl === true)
  const paths = gitPathsFor(ctx.paths, task.id)
  const git = gitFor(ctx, paths)
  const log = ctx.log.child({ task: task.id, repo: repo.fullName })

  const persistedBase = typeof task.data.baseSha === "string" && task.data.baseSha ? task.data.baseSha : null
  let baseSha: string | null = null
  if (await git.isUsable()) {
    try {
      if (persistedBase) await git.resetHard(persistedBase)
      baseSha = persistedBase ?? (await git.headSha())
      log.info("workspace: reusing existing clone", { baseSha })
    } catch (err) {
      log.warn("workspace: existing clone unusable; re-cloning", { error: errorMessage(err) })
      baseSha = null
    }
  }
  if (baseSha === null) {
    log.info("workspace: cloning", { url: cloneUrl, baseBranch, depth: ctx.config.implementation.cloneDepth })
    await git.clone(cloneUrl, { depth: ctx.config.implementation.cloneDepth, branch: baseBranch })
    baseSha = await git.headSha()
  }

  if (task.kind === "followup_fix" && branch === baseBranch) await git.checkout(branch)
  else await git.checkoutNewBranch(branch, baseSha)

  const files = await git.listFiles()
  const project = detectProject({ repo: repo.fullName, files, readFile: workTreeReader(paths.workTree), config: ctx.config })
  let convention = detectCommitConvention(await git.recentSubjects(30))
  if (convention === "unknown" && repo.policy) convention = repo.policy.commitConvention

  log.info("workspace: prepared", { branch, baseSha, ecosystem: project.ecosystem, packageManager: project.packageManager })
  return { taskDir: paths.taskDir, paths, git, project, branch, baseBranch, baseSha, convention }
}

/** Re-open a prepared workspace from persisted task data (resume after restart). */
export function openWorkspace(ctx: AppContext, task: TaskRecord): { paths: GitPaths; git: SafeGit } {
  const paths = gitPathsFor(ctx.paths, task.id)
  return { paths, git: gitFor(ctx, paths) }
}

function timeoutFor(ctx: AppContext, label: CommandRun["label"]): number {
  const t = ctx.config.sandbox.timeouts
  const minutes = label === "install" ? t.installMinutes : label === "lint" ? t.lintMinutes : t.testMinutes
  return Math.round(minutes * 60_000)
}

/**
 * Run an install/test/lint command for the project in the sandbox with the right image,
 * network (install: config.sandbox.installNetwork; everything else: none) and timeout.
 *
 * Afterwards the work tree is sanitized (sanitizeWorkTree): planted nested repositories and links
 * escaping the tree are removed, and WorkTreeIntegrityError is thrown for an escaping link outside
 * the install-artifact directories. `signal` aborts the run (the container is killed) and then
 * SandboxInterruptedError is thrown: an interrupted run is never reported as a failed command.
 */
export async function runProjectCommand(
  ctx: AppContext,
  input: { paths: GitPaths; project: ProjectInfo; label: CommandRun["label"]; command: string; taskId: string; signal?: AbortSignal },
): Promise<CommandRun> {
  const { paths, project, label, command, taskId, signal } = input
  if (!command.trim()) throw new Error(`no ${label} command to run`)
  if (signal?.aborted) throw new SandboxInterruptedError()
  const availability = await ctx.sandbox.available()
  if (!availability.ok) throw new SandboxUnavailableError(availability.reason ?? `${availability.runtime} unavailable`)
  const network = label === "install" ? ctx.config.sandbox.installNetwork : "none"
  const timeoutMs = timeoutFor(ctx, label)
  const result = await ctx.sandbox.run({
    workTree: paths.workTree,
    gitDir: paths.gitDir,
    command,
    image: project.image,
    network,
    timeoutMs,
    label: `oss-scout-${taskId}-${label}`,
    ...(signal ? { signal } : {}),
  })
  sanitizeWorkTree(ctx, paths)
  if (signal?.aborted) throw new SandboxInterruptedError()
  return {
    label,
    command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    outputTail: tail(redact(result.output), OUTPUT_TAIL_CHARS),
    network,
    at: ctx.clock.now(),
  }
}

/** true when `child` is strictly inside `parent` (not equal, no "..", same drive). */
function isStrictlyUnder(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/** Most recent mtime of a path (lstat: links are never followed); null when it does not exist. */
function mtimeOf(path: string): number | null {
  try {
    return lstatSync(path).mtimeMs
  } catch {
    return null
  }
}

const TASK_DIR_NAME_RE = /^[A-Za-z0-9_.-]+$/

/**
 * Remove the workspaces (task dir + git dir) of tasks that are not in `keepTaskIds` and whose
 * directories have not been touched for `olderThanMs` (newest mtime of the task dir, its work tree
 * and its git dir). Orphan git dirs are pruned the same way. Only direct children of
 * paths.workspacesDir / paths.gitDirsDir are considered; links are never followed or removed
 * through. Returns the removed paths. Failures are logged and skipped.
 */
export function pruneWorkspaces(ctx: AppContext, opts: { keepTaskIds: Set<string>; olderThanMs: number }): { removed: string[] } {
  const removed: string[] = []
  if (!Number.isFinite(opts.olderThanMs) || opts.olderThanMs < 0) throw new Error(`pruneWorkspaces: invalid olderThanMs ${opts.olderThanMs}`)
  const cutoff = ctx.clock.now() - opts.olderThanMs
  const { workspacesDir, gitDirsDir } = ctx.paths
  const candidates = new Set<string>()
  for (const dir of [workspacesDir, gitDirsDir]) {
    let names: string[] = []
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.isSymbolicLink())
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const name of names) if (TASK_DIR_NAME_RE.test(name) && name !== "." && name !== "..") candidates.add(name)
  }
  for (const id of [...candidates].sort()) {
    if (opts.keepTaskIds.has(id)) continue
    try {
      assertTaskId(id)
      const paths = gitPathsFor(ctx.paths, id)
      const times = [paths.taskDir, paths.workTree, paths.gitDir].map(mtimeOf).filter((t): t is number => t !== null)
      if (times.length === 0 || Math.max(...times) > cutoff) continue
      const isDir = (p: string): boolean | null => {
        try {
          const st = lstatSync(p)
          return st.isDirectory() && !st.isSymbolicLink()
        } catch {
          return null
        }
      }
      const task = isDir(paths.taskDir)
      const git = isDir(paths.gitDir)
      if (task === false || git === false) {
        ctx.log.warn("workspace: prune skipped a non-directory entry", { task: id })
        continue
      }
      if (task) {
        // Removes <workspacesDir>/<id> and its git dir <gitDirsDir>/<id>.
        removeWorkspace(ctx, paths.taskDir)
        removed.push(paths.taskDir)
        if (git) removed.push(paths.gitDir)
      } else if (git) {
        removeWorkspace(ctx, paths.gitDir)
        removed.push(paths.gitDir)
      }
    } catch (err) {
      ctx.log.warn("workspace: prune failed", { task: id, error: errorMessage(err) })
    }
  }
  if (removed.length > 0) ctx.log.info("workspace: pruned old workspaces", { count: removed.length })
  return { removed }
}

/** Delete a task directory (only ever under paths.workspacesDir). */
export function removeWorkspace(ctx: AppContext, taskDir: string): void {
  const target = resolve(taskDir)
  const { workspacesDir, gitDirsDir } = ctx.paths
  const inWorkspaces = isStrictlyUnder(workspacesDir, target)
  if (!inWorkspaces && !isStrictlyUnder(gitDirsDir, target)) {
    throw new Error(`refusing to remove ${target}: not inside ${workspacesDir} or ${gitDirsDir}`)
  }
  if (existsSync(target)) removeTree(target)
  // A task dir <workspacesDir>/<id> owns the git dir <gitDirsDir>/<id>; remove it too.
  if (inWorkspaces && resolve(dirname(target)) === resolve(workspacesDir)) {
    const gitDir = join(gitDirsDir, basename(target))
    if (isStrictlyUnder(gitDirsDir, gitDir) && existsSync(gitDir)) removeTree(gitDir)
  }
  ctx.log.info("workspace: removed", { taskDir: target })
}
