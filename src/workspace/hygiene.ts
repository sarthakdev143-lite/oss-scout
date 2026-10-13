import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, unlinkSync, type Dirent } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { errorMessage } from "../util/log.ts"

/**
 * Work-tree hygiene. The work tree is bind-mounted read-write into the sandbox, and the agent edits
 * it with host-side file tools, so anything sandboxed code leaves behind is attacker-controlled:
 *
 *  - A nested repository (`<dir>/.git` file or directory, or a gitlink) makes host git consult that
 *    repository's own config when it inspects the directory. Every `.git` entry below the work-tree
 *    root is removed before host git touches the tree (SafeGit does this itself on every call).
 *  - A symlink or junction that resolves outside the work tree lets the agent's file tools read or
 *    write host files. Such links are removed after every sandbox run and before every agent turn;
 *    one that appears outside the install-artifact directories aborts the task.
 *
 * The walk never follows links, and nothing outside the work tree is ever touched.
 */

/** Hard cap on directory entries visited by one scan; a bigger tree fails closed. */
export const MAX_SCAN_ENTRIES = 2_000_000

/** The work tree failed an integrity check (planted nested repository or escaping link, unscannable tree). */
export class WorkTreeIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkTreeIntegrityError"
  }
}

export interface RemovedLink {
  /** Path relative to the work-tree root, "/"-separated. */
  path: string
  /** Raw link target as stored on disk. */
  target: string
  /** true when the link lies inside an ignored install-artifact directory (node_modules, venvs, …). */
  inArtifactDir: boolean
}

export interface WorkTreeScan {
  /** `.git` entries (files, directories or links) found below the root and removed. */
  removedGitEntries: string[]
  /** Links resolving outside the work tree that were removed (only when `links` is enabled). */
  removedLinks: RemovedLink[]
  /** Entries visited. */
  entries: number
}

/**
 * true for `.git` and the names a case-insensitive or NTFS file system treats as `.git`
 * (`.GIT`, `.git.`, `.git ` and 8.3 short names such as `GIT~1`).
 */
export function isGitEntryName(name: string): boolean {
  const n = name.toLowerCase().replace(/[. ]+$/, "")
  return n === ".git" || /^git~\d+$/.test(n)
}

const ARTIFACT_DIRS = new Set([
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".ruff_cache",
  "target",
  ".gradle",
  "coverage",
  ".nyc_output",
])

/** Is a work-tree path (relative, "/"-separated) inside an install/build artifact directory (see git.ts EXCLUDE_PATTERNS)? */
export function isInArtifactDir(relPath: string): boolean {
  const parents = relPath.split("/").slice(0, -1)
  if (parents.length === 0) return false
  if (parents[0]!.startsWith(".oss-scout-")) return true
  return parents.some((p) => ARTIFACT_DIRS.has(p) || p.endsWith(".egg-info"))
}

/** true when `child` is `parent` or inside it. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Does the link at `full` resolve (or, when dangling, point lexically) outside the work tree? */
function linkEscapes(root: string, realRoot: string, full: string): { escapes: boolean; target: string } {
  let target: string
  try {
    target = readlinkSync(full)
  } catch {
    return { escapes: true, target: "?" }
  }
  try {
    return { escapes: !within(realRoot, realpathSync(full)), target }
  } catch {
    // Dangling or looping: a write through it would create the target, so judge the path itself.
    if (isAbsolute(target) || /^[A-Za-z]:/.test(target) || target.startsWith("\\") || target.startsWith("/")) {
      return { escapes: true, target }
    }
    return { escapes: !within(root, resolve(dirname(full), target)), target }
  }
}

/** Remove a symlink or junction itself (never its target). */
function removeLink(full: string): void {
  try {
    unlinkSync(full)
  } catch (err) {
    const code = (err as { code?: string }).code
    // Windows directory junctions/symlinks are removed with rmdir.
    if (code === "EPERM" || code === "EISDIR") rmdirSync(full)
    else if (code !== "ENOENT") throw err
  }
}

/** Remove a planted `.git` entry: a link is unlinked (its target is untouched), anything else is deleted. */
function removeGitEntry(full: string): void {
  const st = lstatSync(full)
  if (st.isSymbolicLink()) removeLink(full)
  else rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/**
 * Walk the work tree (lstat semantics, links are never followed) and neutralize what sandboxed code
 * may have planted:
 *  - every `.git` entry below the root is removed (the root's own `.git`, the sandbox's mount point
 *    for the read-only git dir, is removed too but not reported);
 *  - with `links: true`, every symlink/junction resolving outside the work tree is removed.
 * A missing work tree is a no-op. Throws WorkTreeIntegrityError when the tree cannot be scanned
 * (unreadable directory, too many entries) or the root itself is a link.
 */
export function secureWorkTree(workTree: string, opts: { links?: boolean; maxEntries?: number } = {}): WorkTreeScan {
  const root = resolve(workTree)
  const out: WorkTreeScan = { removedGitEntries: [], removedLinks: [], entries: 0 }
  let rootStat
  try {
    rootStat = lstatSync(root)
  } catch {
    return out
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new WorkTreeIntegrityError(`work tree ${root} is not a plain directory`)
  const realRoot = realpathSync(root)
  const max = opts.maxEntries ?? MAX_SCAN_ENTRIES
  const stack: string[] = [""]
  while (stack.length > 0) {
    const rel = stack.pop()!
    const dir = rel ? join(root, rel) : root
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      throw new WorkTreeIntegrityError(`cannot scan the work tree at ${rel || "."}: ${errorMessage(err)}`)
    }
    for (const e of entries) {
      out.entries += 1
      if (out.entries > max) throw new WorkTreeIntegrityError(`work tree has more than ${max} entries; refusing to continue unverified`)
      const childRel = rel ? `${rel}/${e.name}` : e.name
      const full = join(dir, e.name)
      if (isGitEntryName(e.name)) {
        removeGitEntry(full)
        if (rel) out.removedGitEntries.push(childRel)
        continue
      }
      if (e.isSymbolicLink()) {
        if (!opts.links) continue
        const { escapes, target } = linkEscapes(root, realRoot, full)
        if (escapes) {
          removeLink(full)
          out.removedLinks.push({ path: childRel, target, inArtifactDir: isInArtifactDir(childRel) })
        }
        continue
      }
      if (e.isDirectory()) stack.push(childRel)
    }
  }
  return out
}

/** Links found outside install-artifact directories: a sign of a malicious repository. */
export function suspiciousLinks(scan: WorkTreeScan): RemovedLink[] {
  return scan.removedLinks.filter((l) => !l.inArtifactDir)
}

/**
 * Read a work-tree file without following links (relative "/"-separated path, no ".."). null when it
 * is missing, not a regular file, a link, or bigger than `maxBytes`.
 */
export function readWorkTreeFile(workTree: string, relPath: string, maxBytes = 4 * 1024 * 1024): Buffer | null {
  const rel = relPath.replace(/\\/g, "/")
  if (!rel || rel.includes("\0") || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split("/").some((s) => s === ".." || s === "")) return null
  const root = resolve(workTree)
  const full = resolve(root, rel)
  if (!within(root, full) || full === root) return null
  try {
    // Every component must be a real directory/file: no link anywhere on the path.
    let cur = root
    for (const seg of rel.split("/")) {
      cur = join(cur, seg)
      if (lstatSync(cur).isSymbolicLink()) return null
    }
    const st = lstatSync(full)
    if (!st.isFile() || st.size > maxBytes) return null
    return readFileSync(full)
  } catch {
    return null
  }
}
