import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { IssueRecord, ProjectInfo, RepoRecord, TaskRecord } from "../src/core/types.ts"
import { execCommand } from "../src/util/exec.ts"
import { gitPathsFor } from "../src/workspace/git.ts"
import {
  isGitEntryName,
  isInArtifactDir,
  readWorkTreeFile,
  secureWorkTree,
  suspiciousLinks,
  WorkTreeIntegrityError,
} from "../src/workspace/hygiene.ts"
import { SandboxInterruptedError, SandboxUnavailableError } from "../src/workspace/sandbox.ts"
import {
  branchNameFor,
  openWorkspace,
  prepareWorkspace,
  pruneWorkspaces,
  removeWorkspace,
  runProjectCommand,
  taskDirFor,
  workTreeReader,
} from "../src/workspace/workspace.ts"
import { fakeExec, makeTestContext, type TestContext } from "./helpers/fakes.ts"

const T = 60_000

function sh(cwd: string, args: string[]): string {
  const res = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(cwd, "..", "fixture-gitconfig"),
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`)
  return res.stdout.toString()
}

function repoRecord(over: Partial<RepoRecord> = {}): RepoRecord {
  return {
    fullName: "acme/widget",
    source: "search",
    sourceDetail: null,
    status: "eligible",
    score: 0.8,
    reasons: [],
    skipReason: null,
    policy: null,
    metrics: null,
    discoveredAt: 0,
    screenedAt: 0,
    nextScreenAt: null,
    ...over,
  }
}

function issueRecord(over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: "acme/widget#42",
    repo: "acme/widget",
    number: 42,
    title: "Crash when options.timeout is 0!",
    url: "https://github.com/acme/widget/issues/42",
    body: "",
    labels: ["bug"],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    comments: 0,
    kind: "bug",
    status: "selected",
    score: 0.7,
    reasons: [],
    skipReason: null,
    fetchedAt: 0,
    ...over,
  }
}

let taskSeq = 0
function taskRecord(over: Partial<TaskRecord> = {}): TaskRecord {
  taskSeq += 1
  return {
    id: `task_${taskSeq}`,
    kind: "contribution",
    repo: "acme/widget",
    issueId: "acme/widget#42",
    prId: null,
    stage: "prepare",
    status: "active",
    attempts: 0,
    failures: 0,
    nextRunAt: 0,
    lastError: null,
    abortReason: null,
    workspace: null,
    branch: null,
    tokensUsed: 0,
    costUsd: 0,
    createdAt: 0,
    updatedAt: 0,
    data: {},
    ...over,
  }
}

const project: ProjectInfo = {
  ecosystem: "node",
  packageManager: "npm",
  image: "node:22-bookworm",
  install: "npm ci",
  test: "npm test",
  lint: null,
  testFilePatterns: [],
  notes: [],
}

let root: string
let srcDir: string
let srcUrl: string
let ctx: TestContext

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "oss-scout-ws-"))
  writeFileSync(join(root, "fixture-gitconfig"), "")
  srcDir = join(root, "src")
  mkdirSync(srcDir)
  sh(srcDir, ["init", "-q", "-b", "main"])
  writeFileSync(join(srcDir, "package.json"), JSON.stringify({ name: "widget", scripts: { test: "vitest run", lint: "eslint ." } }))
  writeFileSync(join(srcDir, "package-lock.json"), "{}")
  sh(srcDir, ["add", "-A"])
  sh(srcDir, ["commit", "-q", "-m", "feat: initial"])
  for (const subject of ["fix: a", "fix(core): b", "docs: c", "chore: d", "Merge pull request #3"]) {
    writeFileSync(join(srcDir, "CHANGELOG.md"), subject)
    sh(srcDir, ["add", "-A"])
    sh(srcDir, ["commit", "-q", "-m", subject])
  }
  sh(srcDir, ["checkout", "-q", "-b", "feature/x"])
  writeFileSync(join(srcDir, "feature.js"), "1")
  sh(srcDir, ["add", "-A"])
  sh(srcDir, ["commit", "-q", "-m", "feat: feature branch"])
  sh(srcDir, ["checkout", "-q", "main"])
  srcUrl = pathToFileURL(srcDir).href
  ctx = makeTestContext({ exec: execCommand })
}, T)

afterAll(() => {
  ctx?.cleanup()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe("naming", () => {
  test("branchNameFor uses the issue number and a slug of the title", () => {
    expect(branchNameFor(issueRecord())).toBe("oss-scout/42-crash-when-options-timeout-is-0")
    expect(branchNameFor(issueRecord({ number: 7, title: "!!!" }))).toBe("oss-scout/7-change")
  })

  test("taskDirFor is <workspacesDir>/<taskId> and rejects traversal", () => {
    expect(taskDirFor(ctx, "task_9")).toBe(join(ctx.paths.workspacesDir, "task_9"))
    expect(() => taskDirFor(ctx, "../x")).toThrow(/invalid task id/)
  })

  test("openWorkspace derives paths from the task id", () => {
    const task = taskRecord()
    const { paths, git } = openWorkspace(ctx, task)
    expect(paths).toEqual(gitPathsFor(ctx.paths, task.id))
    expect(git.paths).toBe(paths)
  })
})

describe("prepareWorkspace", () => {
  test("production paths only accept https://github.com/<owner>/<name>.git (nothing is executed otherwise)", async () => {
    const c = makeTestContext({ exec: fakeExec() })
    try {
      const base = { task: taskRecord(), repo: repoRecord(), issue: issueRecord(), branch: "oss-scout/42-x", baseBranch: "main" }
      for (const cloneUrl of [
        srcUrl,
        "http://github.com/acme/widget.git",
        "https://github.com/acme/widget",
        "https://gitlab.com/acme/widget.git",
        "https://tok:x@github.com/acme/widget.git",
        "git@github.com:acme/widget.git",
        "https://github.com/acme/widget.git --upload-pack=x",
      ]) {
        await expect(prepareWorkspace(c, { ...base, cloneUrl })).rejects.toThrow(/refusing to clone/)
      }
      expect((c.exec as ReturnType<typeof fakeExec>).calls).toHaveLength(0)
    } finally {
      c.cleanup()
    }
  })

  test(
    "clones, creates the task branch, detects the project and the commit convention",
    async () => {
      const task = taskRecord()
      const ws = await prepareWorkspace(
        ctx,
        { task, repo: repoRecord(), issue: issueRecord(), branch: "oss-scout/42-crash", baseBranch: "main", cloneUrl: srcUrl },
        { allowFileUrl: true },
      )
      const paths = gitPathsFor(ctx.paths, task.id)
      expect(ws.paths).toEqual(paths)
      expect(ws.taskDir).toBe(join(ctx.paths.workspacesDir, task.id))
      expect(ws.baseSha).toBe(sh(srcDir, ["rev-parse", "main"]).trim())
      expect(ws.branch).toBe("oss-scout/42-crash")
      expect(ws.baseBranch).toBe("main")
      expect((await ws.git.run(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("oss-scout/42-crash")
      expect(ws.project.ecosystem).toBe("node")
      expect(ws.project.install).toBe("npm ci --no-audit --no-fund")
      expect(ws.project.test).toBe("npm test")
      expect(ws.convention).toBe("conventional")
      expect(existsSync(join(paths.workTree, ".git"))).toBe(false)
      expect(existsSync(join(paths.workTree, "feature.js"))).toBe(false)
    },
    T,
  )

  test(
    "is idempotent: a second run reuses the clone, resets to the persisted base and keeps ignored artifacts",
    async () => {
      const task = taskRecord()
      const input = { task, repo: repoRecord(), issue: issueRecord(), branch: "oss-scout/42-crash", baseBranch: "main", cloneUrl: srcUrl }
      const first = await prepareWorkspace(ctx, input, { allowFileUrl: true })
      const wt = first.paths.workTree
      mkdirSync(join(wt, "node_modules", "dep"), { recursive: true })
      writeFileSync(join(wt, "node_modules", "dep", "keep.js"), "x")
      writeFileSync(join(wt, "package.json"), "{}")
      writeFileSync(join(wt, "stray.txt"), "x")
      await first.git.commitAll("wip", { name: "A", email: "a@b.c" }, false)

      const again = await prepareWorkspace(ctx, { ...input, task: { ...task, data: { baseSha: first.baseSha } } }, { allowFileUrl: true })
      expect(again.baseSha).toBe(first.baseSha)
      expect(await again.git.headSha()).toBe(first.baseSha)
      expect(existsSync(join(wt, "node_modules", "dep", "keep.js"))).toBe(true) // not re-cloned
      expect(existsSync(join(wt, "stray.txt"))).toBe(false)
      expect(again.project.test).toBe("npm test")
    },
    T,
  )

  test(
    "re-clones when the existing git dir is broken",
    async () => {
      const task = taskRecord()
      const input = { task, repo: repoRecord(), issue: null, branch: "oss-scout/1-x", baseBranch: "main", cloneUrl: srcUrl }
      const first = await prepareWorkspace(ctx, input, { allowFileUrl: true })
      writeFileSync(join(first.paths.workTree, "marker.txt"), "x")
      rmSync(join(first.paths.gitDir, "HEAD"))
      const again = await prepareWorkspace(ctx, input, { allowFileUrl: true })
      expect(again.baseSha).toBe(first.baseSha)
      expect(existsSync(join(first.paths.workTree, "marker.txt"))).toBe(false)
    },
    T,
  )

  test(
    "follow-up fix on the PR branch itself just checks it out",
    async () => {
      const task = taskRecord({ kind: "followup_fix", issueId: null, prId: "acme/widget#5" })
      const ws = await prepareWorkspace(
        ctx,
        { task, repo: repoRecord(), issue: null, branch: "feature/x", baseBranch: "feature/x", cloneUrl: srcUrl },
        { allowFileUrl: true },
      )
      expect((await ws.git.run(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("feature/x")
      expect(ws.baseSha).toBe(sh(srcDir, ["rev-parse", "feature/x"]).trim())
      expect(existsSync(join(ws.paths.workTree, "feature.js"))).toBe(true)
    },
    T,
  )

  test(
    "falls back to the screened policy's convention when history is too short",
    async () => {
      const short = join(root, "short")
      mkdirSync(short)
      sh(short, ["init", "-q", "-b", "main"])
      writeFileSync(join(short, "README.md"), "x")
      sh(short, ["add", "-A"])
      sh(short, ["commit", "-q", "-m", "init"])
      const policy = { commitConvention: "conventional" } as RepoRecord["policy"]
      const ws = await prepareWorkspace(
        ctx,
        { task: taskRecord(), repo: repoRecord({ policy }), issue: null, branch: "oss-scout/2-y", baseBranch: "main", cloneUrl: pathToFileURL(short).href },
        { allowFileUrl: true },
      )
      expect(ws.convention).toBe("conventional")
      expect(ws.project.ecosystem).toBe("unknown")
    },
    T,
  )
})

describe("workTreeReader", () => {
  test("reads relative files only, refusing traversal, absolute paths, big files and symlinks", () => {
    const wt = join(root, "reader", "repo")
    mkdirSync(join(wt, "sub"), { recursive: true })
    writeFileSync(join(wt, "sub", "a.txt"), "hello")
    writeFileSync(join(root, "reader", "secret.txt"), "top secret")
    writeFileSync(join(wt, "big.txt"), "x".repeat(256 * 1024 + 1))
    const read = workTreeReader(wt)
    expect(read("sub/a.txt")).toBe("hello")
    expect(read("sub\\a.txt")).toBe("hello")
    expect(read("../secret.txt")).toBeNull()
    expect(read("sub/../../secret.txt")).toBeNull()
    expect(read(join(root, "reader", "secret.txt"))).toBeNull()
    expect(read("/etc/passwd")).toBeNull()
    expect(read("big.txt")).toBeNull()
    expect(read("missing.txt")).toBeNull()
    expect(read("sub")).toBeNull()
    let linked = false
    try {
      symlinkSync(join(root, "reader", "secret.txt"), join(wt, "link.txt"))
      linked = true
    } catch {
      // symlink creation needs privileges on some Windows setups
    }
    if (linked) expect(read("link.txt")).toBeNull()
  })
})

describe("runProjectCommand", () => {
  const taskId = "task_run"
  const paths = () => gitPathsFor(ctx.paths, taskId)

  test("install runs with the install network and install timeout", async () => {
    ctx.sandbox.runs.length = 0
    ctx.sandbox.responder = () => ({ exitCode: 0, output: "added 10 packages", durationMs: 42 })
    const run = await runProjectCommand(ctx, { paths: paths(), project, label: "install", command: "npm ci", taskId })
    const req = ctx.sandbox.runs[0]!
    expect(req).toEqual({
      workTree: paths().workTree,
      gitDir: paths().gitDir,
      command: "npm ci",
      image: "node:22-bookworm",
      network: "bridge",
      timeoutMs: 20 * 60_000,
      label: "oss-scout-task_run-install",
    })
    expect(run).toEqual({
      label: "install",
      command: "npm ci",
      exitCode: 0,
      timedOut: false,
      durationMs: 42,
      outputTail: "added 10 packages",
      network: "bridge",
      at: ctx.clock.now(),
    })
  })

  test("test/lint/custom always run without network, with their own timeouts", async () => {
    const c = makeTestContext({
      config: { sandbox: { installNetwork: "bridge", timeouts: { installMinutes: 30, testMinutes: 7, lintMinutes: 3 } } },
    })
    try {
      for (const label of ["test", "lint", "custom"] as const) {
        const run = await runProjectCommand(c, { paths: gitPathsFor(c.paths, taskId), project, label, command: "x", taskId })
        expect(run.network).toBe("none")
      }
      expect(c.sandbox.runs.map((r) => [r.network, r.timeoutMs, r.label])).toEqual([
        ["none", 7 * 60_000, "oss-scout-task_run-test"],
        ["none", 3 * 60_000, "oss-scout-task_run-lint"],
        ["none", 7 * 60_000, "oss-scout-task_run-custom"],
      ])
    } finally {
      c.cleanup()
    }
  })

  test("installNetwork none is honored for installs", async () => {
    const c = makeTestContext({ config: { sandbox: { installNetwork: "none" } } })
    try {
      await runProjectCommand(c, { paths: gitPathsFor(c.paths, taskId), project, label: "install", command: "x", taskId })
      expect(c.sandbox.runs[0]!.network).toBe("none")
    } finally {
      c.cleanup()
    }
  })

  test("no sandbox → SandboxUnavailableError and nothing runs", async () => {
    const c = makeTestContext()
    try {
      c.sandbox.availability = { ok: false, reason: "docker CLI not found on PATH", runtime: "docker", version: null }
      const p = runProjectCommand(c, { paths: gitPathsFor(c.paths, taskId), project, label: "test", command: "npm test", taskId })
      await expect(p).rejects.toBeInstanceOf(SandboxUnavailableError)
      await expect(p).rejects.toThrow("sandbox unavailable: docker CLI not found on PATH")
      expect(c.sandbox.runs).toHaveLength(0)
    } finally {
      c.cleanup()
    }
  })

  test("output tail is redacted and bounded; timeouts are reported", async () => {
    const c = makeTestContext()
    try {
      c.sandbox.responder = () => ({
        exitCode: 137,
        timedOut: true,
        output: "x".repeat(30_000) + " ghp_abcdefghijklmnopqrstuvwxyz0123456789 END",
      })
      const run = await runProjectCommand(c, { paths: gitPathsFor(c.paths, taskId), project, label: "test", command: "npm test", taskId })
      expect(run.timedOut).toBe(true)
      expect(run.exitCode).toBe(137)
      expect(run.outputTail.length).toBeLessThanOrEqual(20_100)
      expect(run.outputTail).not.toContain("ghp_")
      expect(run.outputTail.endsWith("END")).toBe(true)
      await expect(
        runProjectCommand(c, { paths: gitPathsFor(c.paths, taskId), project, label: "test", command: " ", taskId }),
      ).rejects.toThrow(/no test command/)
    } finally {
      c.cleanup()
    }
  })
})

describe("removeWorkspace", () => {
  test("removes the task dir and its git dir", () => {
    const paths = gitPathsFor(ctx.paths, "task_rm")
    mkdirSync(join(paths.workTree, "a"), { recursive: true })
    writeFileSync(join(paths.workTree, "a", "f.txt"), "x")
    mkdirSync(join(paths.gitDir, "objects"), { recursive: true })
    writeFileSync(join(paths.gitDir, "objects", "pack.idx"), "x", { mode: 0o444 })
    removeWorkspace(ctx, paths.taskDir)
    expect(existsSync(paths.taskDir)).toBe(false)
    expect(existsSync(paths.gitDir)).toBe(false)
    expect(existsSync(ctx.paths.workspacesDir)).toBe(true)
  })

  test("refuses anything that is not strictly inside the workspaces or gitdirs dir", () => {
    mkdirSync(ctx.paths.workspacesDir, { recursive: true })
    const outside = mkdtempSync(join(tmpdir(), "oss-scout-outside-"))
    try {
      for (const p of [
        ctx.paths.workspacesDir,
        ctx.paths.gitDirsDir,
        ctx.paths.stateDir,
        outside,
        ctx.paths.workspacesDir + "-evil",
        join(ctx.paths.workspacesDir, ".."),
        join(ctx.paths.workspacesDir, "x", "..", ".."),
      ]) {
        expect(() => removeWorkspace(ctx, p)).toThrow(/refusing to remove/)
      }
      expect(existsSync(outside)).toBe(true)
      expect(existsSync(ctx.paths.workspacesDir)).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("removing a prepared workspace (real clone with read-only pack files) works", async () => {
    const task = taskRecord()
    const ws = await prepareWorkspace(
      ctx,
      { task, repo: repoRecord(), issue: null, branch: "oss-scout/3-z", baseBranch: "main", cloneUrl: srcUrl },
      { allowFileUrl: true },
    )
    removeWorkspace(ctx, ws.taskDir)
    expect(existsSync(ws.taskDir)).toBe(false)
    expect(existsSync(ws.paths.gitDir)).toBe(false)
  }, T)
})

/** Directory link (junction on Windows, symlink elsewhere); false when the platform refuses. */
function tryDirLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir")
    return true
  } catch {
    return false
  }
}

/** File/dangling symlink (needs privileges on Windows); false when refused. */
function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path)
    return true
  } catch {
    return false
  }
}

describe("work-tree hygiene (isolation-1, isolation-3)", () => {
  function tree(): { root: string; wt: string; outside: string } {
    const r = mkdtempSync(join(tmpdir(), "oss-scout-hyg-"))
    const wt = join(r, "repo")
    const outside = join(r, "outside")
    mkdirSync(join(wt, "src"), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(wt, "src", "index.js"), "1")
    writeFileSync(join(outside, "host-secret.txt"), "host data")
    return { root: r, wt, outside }
  }

  test("isGitEntryName covers case and NTFS aliases of .git, nothing else", () => {
    for (const n of [".git", ".GIT", ".Git", ".git.", ".git ", ".git. .", "GIT~1", "git~12"]) expect(isGitEntryName(n)).toBe(true)
    for (const n of ["git", ".gitignore", ".gitattributes", ".gitmodules", ".github", "x.git", ".git2", "git~"]) expect(isGitEntryName(n)).toBe(false)
  })

  test("removes nested .git directories and files at any depth (and the root mount point) but nothing else", () => {
    const { root: r, wt } = tree()
    try {
      mkdirSync(join(wt, ".git"))
      mkdirSync(join(wt, "build-cache", ".git", "refs"), { recursive: true })
      writeFileSync(join(wt, "build-cache", ".git", "config"), "[core]\n")
      writeFileSync(join(wt, "build-cache", "a.txt"), "kept")
      mkdirSync(join(wt, "node_modules", "pkg"), { recursive: true })
      writeFileSync(join(wt, "node_modules", "pkg", ".git"), "gitdir: ../../../elsewhere\n")
      writeFileSync(join(wt, ".gitignore"), "x\n")
      const scan = secureWorkTree(wt, { links: true })
      expect(scan.removedGitEntries.sort()).toEqual(["build-cache/.git", "node_modules/pkg/.git"])
      expect(existsSync(join(wt, ".git"))).toBe(false)
      expect(existsSync(join(wt, "build-cache", ".git"))).toBe(false)
      expect(existsSync(join(wt, "node_modules", "pkg", ".git"))).toBe(false)
      expect(existsSync(join(wt, "build-cache", "a.txt"))).toBe(true)
      expect(existsSync(join(wt, ".gitignore"))).toBe(true)
      expect(existsSync(join(wt, "src", "index.js"))).toBe(true)
      // a missing work tree is a no-op
      expect(secureWorkTree(join(r, "missing")).entries).toBe(0)
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  test("links escaping the tree are removed (never their targets); links inside the tree are kept; the walk never follows links", () => {
    const { root: r, wt, outside } = tree()
    try {
      mkdirSync(join(outside, ".git"))
      writeFileSync(join(outside, ".git", "HEAD"), "ref: refs/heads/main\n")
      mkdirSync(join(wt, "node_modules", ".bin"), { recursive: true })
      if (!tryDirLink(outside, join(wt, "docs"))) return // links unsupported here
      tryDirLink(outside, join(wt, "node_modules", "escape"))
      tryDirLink(join(wt, "src"), join(wt, "node_modules", "inside"))
      const scan = secureWorkTree(wt, { links: true })
      const removed = scan.removedLinks.map((l) => [l.path, l.inArtifactDir]).sort()
      expect(removed).toEqual([
        ["docs", false],
        ["node_modules/escape", true],
      ])
      expect(suspiciousLinks(scan).map((l) => l.path)).toEqual(["docs"])
      expect(existsSync(join(wt, "docs"))).toBe(false)
      expect(existsSync(join(wt, "node_modules", "inside", "index.js"))).toBe(true)
      // targets untouched, and the outside repository was never walked into
      expect(readFileSync(join(outside, "host-secret.txt"), "utf8")).toBe("host data")
      expect(existsSync(join(outside, ".git", "HEAD"))).toBe(true)
      expect(scan.removedGitEntries).toEqual([])
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  test("links: false (what SafeGit uses) leaves links alone", () => {
    const { root: r, wt, outside } = tree()
    try {
      if (!tryDirLink(outside, join(wt, "docs"))) return
      expect(secureWorkTree(wt, { links: false }).removedLinks).toEqual([])
      expect(existsSync(join(wt, "docs"))).toBe(true)
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  test("dangling absolute symlinks escape; relative ones that stay inside do not", () => {
    const { root: r, wt } = tree()
    try {
      if (!trySymlink("/usr/local/bin/python3.12", join(wt, "py"))) return // needs symlink privileges on Windows
      trySymlink("../src/missing.js", join(wt, "src", "rel-inside"))
      trySymlink("../../../../etc/passwd", join(wt, "src", "rel-outside"))
      const scan = secureWorkTree(wt, { links: true })
      expect(scan.removedLinks.map((l) => l.path).sort()).toEqual(["py", "src/rel-outside"])
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  test("fails closed on a tree that is too large to verify and on a work tree that is itself a link", () => {
    const { root: r, wt, outside } = tree()
    try {
      expect(() => secureWorkTree(wt, { maxEntries: 1 })).toThrow(WorkTreeIntegrityError)
      if (tryDirLink(outside, join(r, "linked-repo"))) {
        expect(() => secureWorkTree(join(r, "linked-repo"))).toThrow(/not a plain directory/)
      }
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  test("isInArtifactDir and readWorkTreeFile", () => {
    expect(isInArtifactDir("node_modules/a/b.js")).toBe(true)
    expect(isInArtifactDir(".oss-scout-venv/bin/python")).toBe(true)
    expect(isInArtifactDir("pkg/.venv/lib/x")).toBe(true)
    expect(isInArtifactDir("src/node_modules")).toBe(false)
    expect(isInArtifactDir("src/x.js")).toBe(false)
    const { root: r, wt, outside } = tree()
    try {
      expect(readWorkTreeFile(wt, "src/index.js")?.toString()).toBe("1")
      expect(readWorkTreeFile(wt, "../outside/host-secret.txt")).toBeNull()
      expect(readWorkTreeFile(wt, "missing.js")).toBeNull()
      if (tryDirLink(outside, join(wt, "docs"))) expect(readWorkTreeFile(wt, "docs/host-secret.txt")).toBeNull()
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })
})

describe("runProjectCommand: hygiene and interruption", () => {
  const taskId = "task_hyg"

  test("planted nested repositories and escaping links in artifact dirs are removed after the run and audited", async () => {
    const c = makeTestContext()
    const outside = mkdtempSync(join(tmpdir(), "oss-scout-out-"))
    try {
      const paths = gitPathsFor(c.paths, taskId)
      mkdirSync(paths.workTree, { recursive: true })
      let linked = false
      c.sandbox.responder = (req) => {
        mkdirSync(join(req.workTree, "vendor-cache", ".git"), { recursive: true })
        mkdirSync(join(req.workTree, "node_modules"), { recursive: true })
        linked = tryDirLink(outside, join(req.workTree, "node_modules", "evil"))
        return { exitCode: 0 }
      }
      const run = await runProjectCommand(c, { paths, project, label: "install", command: "npm ci", taskId })
      expect(run.exitCode).toBe(0)
      expect(existsSync(join(paths.workTree, "vendor-cache", ".git"))).toBe(false)
      if (linked) expect(existsSync(join(paths.workTree, "node_modules", "evil"))).toBe(false)
      expect(existsSync(outside)).toBe(true)
      const rows = c.store.db.query("SELECT action, subject FROM audit WHERE action = 'workspace.sanitize'").all() as Array<{ subject: string }>
      expect(rows.map((x) => x.subject)).toEqual([taskId])
    } finally {
      rmSync(outside, { recursive: true, force: true })
      c.cleanup()
    }
  })

  test("an escaping link outside the artifact dirs fails the command with WorkTreeIntegrityError", async () => {
    const c = makeTestContext()
    const outside = mkdtempSync(join(tmpdir(), "oss-scout-out-"))
    try {
      const paths = gitPathsFor(c.paths, taskId)
      mkdirSync(join(paths.workTree, "docs"), { recursive: true })
      let linked = false
      c.sandbox.responder = (req) => {
        linked = tryDirLink(outside, join(req.workTree, "docs", "notes"))
        return { exitCode: 0 }
      }
      let error: unknown = null
      try {
        await runProjectCommand(c, { paths, project, label: "test", command: "npm test", taskId })
      } catch (err) {
        error = err
      }
      if (!linked) return // links cannot be created on this machine
      expect(error).toBeInstanceOf(WorkTreeIntegrityError)
      expect(String(error)).toContain("docs/notes")
      expect(existsSync(join(paths.workTree, "docs", "notes"))).toBe(false)
      expect(existsSync(outside)).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
      c.cleanup()
    }
  })

  test("the signal is passed to the sandbox; an aborted run throws SandboxInterruptedError instead of reporting a failure", async () => {
    const c = makeTestContext()
    try {
      const paths = gitPathsFor(c.paths, taskId)
      const ac = new AbortController()
      const seen: Array<AbortSignal | undefined> = []
      c.sandbox.responder = (req) => {
        seen.push(req.signal)
        ac.abort()
        return { exitCode: 137, output: "killed" }
      }
      const p = runProjectCommand(c, { paths, project, label: "install", command: "npm ci", taskId, signal: ac.signal })
      await expect(p).rejects.toBeInstanceOf(SandboxInterruptedError)
      expect(seen).toEqual([ac.signal])
      // already aborted: nothing runs at all
      await expect(runProjectCommand(c, { paths, project, label: "test", command: "npm test", taskId, signal: ac.signal })).rejects.toBeInstanceOf(
        SandboxInterruptedError,
      )
      expect(c.sandbox.runs).toHaveLength(1)
    } finally {
      c.cleanup()
    }
  })
})

describe("pruneWorkspaces (durability-6)", () => {
  const DAY = 24 * 60 * 60_000

  function makeWs(c: TestContext, id: string, ageMs: number): ReturnType<typeof gitPathsFor> {
    const paths = gitPathsFor(c.paths, id)
    mkdirSync(join(paths.workTree, "node_modules", "dep"), { recursive: true })
    writeFileSync(join(paths.workTree, "node_modules", "dep", "index.js"), "x")
    mkdirSync(join(paths.gitDir, "objects"), { recursive: true })
    writeFileSync(join(paths.gitDir, "HEAD"), "ref: refs/heads/main\n")
    age(c, ageMs, paths.workTree, paths.taskDir, paths.gitDir)
    return paths
  }

  function age(c: TestContext, ageMs: number, ...paths: string[]): void {
    const t = new Date(c.clock.now() - ageMs)
    for (const p of paths) utimesSync(p, t, t)
  }

  test("removes old workspaces and orphan git dirs of tasks not kept; keeps recent and kept ones", () => {
    const c = makeTestContext()
    const outside = mkdtempSync(join(tmpdir(), "oss-scout-out-"))
    try {
      writeFileSync(join(outside, "keep.txt"), "k")
      const old = makeWs(c, "task_old", 10 * DAY)
      const kept = makeWs(c, "task_kept", 10 * DAY)
      const recent = makeWs(c, "task_recent", 60 * 60_000)
      // a link planted in the old work tree must not lead the removal outside
      tryDirLink(outside, join(old.workTree, "escape"))
      age(c, 10 * DAY, old.workTree)
      // orphan git dir (its task dir is already gone), old
      const orphan = gitPathsFor(c.paths, "task_orphan")
      mkdirSync(orphan.gitDir, { recursive: true })
      age(c, 10 * DAY, orphan.gitDir)
      // a stray file in the workspaces dir is ignored
      writeFileSync(join(c.paths.workspacesDir, "README.txt"), "x")

      const { removed } = pruneWorkspaces(c, { keepTaskIds: new Set(["task_kept"]), olderThanMs: 7 * DAY })
      expect(removed.sort()).toEqual([old.gitDir, old.taskDir, orphan.gitDir].sort())
      expect(existsSync(old.taskDir)).toBe(false)
      expect(existsSync(old.gitDir)).toBe(false)
      expect(existsSync(orphan.gitDir)).toBe(false)
      expect(existsSync(kept.taskDir)).toBe(true)
      expect(existsSync(kept.gitDir)).toBe(true)
      expect(existsSync(recent.taskDir)).toBe(true)
      expect(existsSync(join(c.paths.workspacesDir, "README.txt"))).toBe(true)
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("k")
      // nothing left to prune; invalid thresholds are refused
      expect(pruneWorkspaces(c, { keepTaskIds: new Set(["task_kept"]), olderThanMs: 7 * DAY }).removed).toEqual([])
      expect(() => pruneWorkspaces(c, { keepTaskIds: new Set(), olderThanMs: Number.NaN })).toThrow(/olderThanMs/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
      c.cleanup()
    }
  })

  test("recent git activity keeps a workspace even when the task dir itself is old; missing dirs are fine", () => {
    const c = makeTestContext()
    const empty = makeTestContext()
    try {
      const p = makeWs(c, "task_busy", 10 * DAY)
      age(c, DAY, p.gitDir)
      expect(pruneWorkspaces(c, { keepTaskIds: new Set(), olderThanMs: 7 * DAY }).removed).toEqual([])
      expect(existsSync(p.taskDir)).toBe(true)
      expect(pruneWorkspaces(empty, { keepTaskIds: new Set(), olderThanMs: 0 }).removed).toEqual([])
    } finally {
      c.cleanup()
      empty.cleanup()
    }
  })
})
