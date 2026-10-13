import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export interface Paths {
  stateDir: string
  dbFile: string
  logFile: string
  /** <workspacesDir>/<taskId>/repo is the clone's work tree; the agent session is located in <workspacesDir>/<taskId>. */
  workspacesDir: string
  /** <gitDirsDir>/<taskId> is the clone's git dir — outside the agent session's directory on purpose. */
  gitDirsDir: string
  /** Each queue item is materialized to <queueDir>/<id>/ (diff.patch, PR_BODY.md, …) for review. */
  queueDir: string
  /** Presence of this file = global kill switch engaged. */
  killFile: string
  /** Empty directory used as core.hooksPath for every host-side git command. */
  emptyHooksDir: string
  /** Empty file used as GIT_CONFIG_GLOBAL so the user's global git config (helpers, hooks) never applies. */
  emptyGitConfig: string
}

/**
 * The oss-scout checkout (the directory holding server.ts and package.json). The opencode plugin
 * looks for its config here (after ~/.oss-scout), never in the project opencode was opened in.
 */
export const PACKAGE_ROOT: string = resolve(fileURLToPath(new URL("../../", import.meta.url)))

export function expandHome(p: string, home: string = homedir()): string {
  if (p === "~") return home
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2))
  return p
}

export function resolvePaths(stateDir: string | null, baseDir?: string): Paths {
  const raw = stateDir ? expandHome(stateDir) : join(homedir(), ".oss-scout")
  const root = isAbsolute(raw) ? raw : resolve(baseDir ?? process.cwd(), raw)
  return {
    stateDir: root,
    dbFile: join(root, "oss-scout.db"),
    logFile: join(root, "logs", "oss-scout.log"),
    workspacesDir: join(root, "workspaces"),
    gitDirsDir: join(root, "gitdirs"),
    queueDir: join(root, "queue"),
    killFile: join(root, "KILL"),
    emptyHooksDir: join(root, "empty-hooks"),
    emptyGitConfig: join(root, "empty-gitconfig"),
  }
}

/** Directory containing `.git` (a directory or a worktree's `.git` file) at or above `dir`, or null. */
export function findGitRoot(dir: string): string | null {
  let current = resolve(dir)
  for (;;) {
    if (existsSync(join(current, ".git"))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}
