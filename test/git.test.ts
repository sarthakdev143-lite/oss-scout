import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { execCommand } from "../src/util/exec.ts"
import { redact } from "../src/util/redact.ts"
import { scanDiffForSecrets } from "../src/verify/secrets.ts"
import {
  EXCLUDE_PATTERNS,
  gitlinkPaths,
  gitPathsFor,
  isSafeRefName,
  pushAuthHeader,
  SafeGit,
  type GitPaths,
} from "../src/workspace/git.ts"
import { fakeExec } from "./helpers/fakes.ts"

const T = 60_000
const ID = { name: "Test Bot", email: "bot@example.com" }

/** Plain git for fixture setup (explicit identity, no user/system config). */
function sh(cwd: string, args: string[], env: Record<string, string> = {}): string {
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
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`)
  return res.stdout.toString()
}

const posix = (p: string) => p.replace(/\\/g, "/")

let root: string
let srcDir: string
let srcUrl: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "oss-scout-git-"))
  writeFileSync(join(root, "fixture-gitconfig"), "")
  srcDir = join(root, "src")
  mkdirSync(srcDir)
  sh(srcDir, ["init", "-q", "-b", "main"])
  writeFileSync(join(srcDir, "README.md"), "# demo\n")
  writeFileSync(join(srcDir, ".gitignore"), "dist/\n")
  sh(srcDir, ["add", "-A"])
  sh(srcDir, ["commit", "-q", "-m", "feat: initial commit"])
  writeFileSync(join(srcDir, "index.js"), "module.exports = 1\n")
  sh(srcDir, ["add", "-A"])
  sh(srcDir, ["commit", "-q", "-m", "fix: add index"])
  srcUrl = pathToFileURL(srcDir).href
}, T)

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

let n = 0
function newPaths(): GitPaths {
  n += 1
  const state = join(root, `state-${n}`)
  return gitPathsFor(
    {
      workspacesDir: join(state, "workspaces"),
      gitDirsDir: join(state, "gitdirs"),
      emptyHooksDir: join(state, "empty-hooks"),
      emptyGitConfig: join(state, "empty-gitconfig"),
    },
    `task_${n}`,
  )
}

async function cloned(depth = 50): Promise<{ git: SafeGit; paths: GitPaths }> {
  const paths = newPaths()
  const git = new SafeGit(paths, execCommand)
  await git.clone(srcUrl, { depth, branch: "main" })
  return { git, paths }
}

describe("gitPathsFor", () => {
  const base = { workspacesDir: "/s/workspaces", gitDirsDir: "/s/gitdirs", emptyHooksDir: "/s/hooks", emptyGitConfig: "/s/gitconfig" }

  test("lays out task dir, work tree and a git dir outside the task dir", () => {
    const p = gitPathsFor(base, "task_1")
    expect(p.taskDir).toBe(join("/s/workspaces", "task_1"))
    expect(p.workTree).toBe(join("/s/workspaces", "task_1", "repo"))
    expect(p.gitDir).toBe(join("/s/gitdirs", "task_1"))
    expect(p.hooksDir).toBe("/s/hooks")
    expect(p.globalConfig).toBe("/s/gitconfig")
    expect(relative(p.taskDir, p.gitDir).startsWith("..")).toBe(true)
  })

  test.each(["", ".", "..", "../x", "a/b", "a\\b", "x y", "a;b"])("rejects unsafe task id %p", (id) => {
    expect(() => gitPathsFor(base, id)).toThrow(/invalid task id/)
  })
})

describe("isSafeRefName", () => {
  test("accepts normal branch names and rejects option-like or malformed ones", () => {
    expect(isSafeRefName("oss-scout/42-fix-crash")).toBe(true)
    expect(isSafeRefName("main")).toBe(true)
    for (const bad of ["-f", "--upload-pack=x", "a..b", "a/", "/a", "a.lock", "a b", "a~1", "a:b", ".hidden", "a//b", ""]) {
      expect(isSafeRefName(bad)).toBe(false)
    }
  })
})

describe("SafeGit.clone (real git)", () => {
  test(
    "clones into the work tree with a separate git dir and removes the .git pointer file",
    async () => {
      const { git, paths } = await cloned()
      expect(existsSync(join(paths.workTree, "README.md"))).toBe(true)
      expect(existsSync(join(paths.workTree, ".git"))).toBe(false)
      expect(statSync(paths.gitDir).isDirectory()).toBe(true)
      expect(existsSync(join(paths.gitDir, "HEAD"))).toBe(true)
      expect(relative(paths.taskDir, paths.gitDir).startsWith("..")).toBe(true)
      const exclude = readFileSync(join(paths.gitDir, "info", "exclude"), "utf8")
      for (const p of EXCLUDE_PATTERNS) expect(exclude).toContain(p)
      expect(await git.headSha()).toBe(sh(srcDir, ["rev-parse", "HEAD"]).trim())
      // the hooks dir and global config were created empty
      expect(existsSync(paths.hooksDir)).toBe(true)
      expect(readFileSync(paths.globalConfig, "utf8")).toBe("")
    },
    T,
  )

  test(
    "respects depth (shallow clone)",
    async () => {
      const { git } = await cloned(1)
      const res = await git.run(["rev-list", "--count", "HEAD"])
      expect(res.stdout.trim()).toBe("1")
    },
    T,
  )

  test(
    "re-cloning replaces a stale work tree and git dir",
    async () => {
      const { git, paths } = await cloned()
      writeFileSync(join(paths.workTree, "stale.txt"), "x")
      await git.clone(srcUrl, { depth: 5, branch: "main" })
      expect(existsSync(join(paths.workTree, "stale.txt"))).toBe(false)
      expect(existsSync(join(paths.workTree, "index.js"))).toBe(true)
    },
    T,
  )

  test("refuses non-https/file transports and option-like URLs without running git", async () => {
    const exec = fakeExec()
    const git = new SafeGit(newPaths(), exec)
    for (const url of ["ssh://git@github.com/a/b.git", "git://github.com/a/b.git", "ext::sh -c touch% /tmp/pwned", "--upload-pack=touch x", "http://github.com/a/b.git", "https://x:y@github.com/a/b.git"]) {
      await expect(git.clone(url, { depth: 1 })).rejects.toThrow()
    }
    await expect(git.clone("https://github.com/a/b.git", { depth: 0 })).rejects.toThrow(/depth/)
    await expect(git.clone("https://github.com/a/b.git", { depth: 1, branch: "--evil" })).rejects.toThrow(/branch/)
    expect(exec.calls).toHaveLength(0)
  })

  test("clone argv: hardening flags, protocol allow-list, separate git dir, no tags/submodules", async () => {
    const exec = fakeExec()
    const paths = newPaths()
    const git = new SafeGit(paths, exec)
    await git.clone("https://github.com/acme/widget.git", { depth: 7, branch: "dev" })
    const argv = exec.calls[0]!
    expect(argv[0]).toBe("git")
    expect(argv).not.toContain("--git-dir")
    const s = argv.join(" ")
    expect(s).toContain(`-c core.hooksPath=${paths.hooksDir}`)
    expect(s).toContain("-c core.fsmonitor=false")
    expect(s).toContain("-c credential.helper=")
    expect(s).toContain("-c protocol.allow=never -c protocol.https.allow=always")
    const tailArgs = argv.slice(argv.indexOf("clone"))
    expect(tailArgs).toEqual([
      "clone",
      "--separate-git-dir",
      paths.gitDir,
      "--depth",
      "7",
      "--single-branch",
      "--no-tags",
      "--no-recurse-submodules",
      "--branch",
      "dev",
      "--",
      "https://github.com/acme/widget.git",
      paths.workTree,
    ])
  })
})

describe("SafeGit host safety (real git)", () => {
  test(
    "hooks placed in the git dir never run on commitAll (positive control proves hooks work here)",
    async () => {
      const { git, paths } = await cloned()
      const marker = join(root, `hook-ran-${n}`)
      const hook = `#!/bin/sh\necho ran >> "${posix(marker)}"\n`
      mkdirSync(join(paths.gitDir, "hooks"), { recursive: true })
      for (const name of ["pre-commit", "commit-msg", "post-commit", "post-checkout"]) {
        writeFileSync(join(paths.gitDir, "hooks", name), hook, { mode: 0o755 })
      }
      // Control: plain git with the same git dir DOES run the hooks on this machine.
      sh(root, ["--git-dir", paths.gitDir, "--work-tree", paths.workTree, "commit", "-q", "--allow-empty", "-m", "control"])
      expect(existsSync(marker)).toBe(true)
      rmSync(marker)

      writeFileSync(join(paths.workTree, "change.txt"), "hello\n")
      await git.commitAll("fix: change", ID, false)
      await git.checkoutNewBranch("oss-scout/1-x", "HEAD")
      expect(existsSync(marker)).toBe(false)
    },
    T,
  )

  test(
    "a malicious work-tree .git file, bare-repo files and config cannot redirect or configure host git",
    async () => {
      const { git, paths } = await cloned()
      // An attacker-controlled repo the planted .git file points at, with a hook that would fire.
      const evil = join(root, `evil-${n}`)
      mkdirSync(evil)
      sh(evil, ["init", "-q", "-b", "main"])
      const marker = join(root, `evil-ran-${n}`)
      writeFileSync(join(evil, ".git", "hooks", "post-commit"), `#!/bin/sh\necho pwned > "${posix(marker)}"\n`, { mode: 0o755 })
      writeFileSync(join(paths.workTree, ".git"), `gitdir: ${posix(join(evil, ".git"))}\n`)
      // Bare-repo lookalike + config in the work tree root.
      writeFileSync(join(paths.workTree, "HEAD"), "ref: refs/heads/main\n")
      mkdirSync(join(paths.workTree, "objects"), { recursive: true })
      mkdirSync(join(paths.workTree, "refs"), { recursive: true })
      writeFileSync(
        join(paths.workTree, "config"),
        `[core]\n\tbare = true\n\thooksPath = ${posix(join(evil, ".git", "hooks"))}\n\tfsmonitor = "echo x > ${posix(marker)}"\n`,
      )
      const before = await git.headSha()
      const sha = await git.commitAll("fix: legit change", ID, false)
      expect(sha).not.toBe(before)
      // The commit landed in OUR git dir, not the evil one.
      expect(sh(root, ["--git-dir", paths.gitDir, "rev-parse", "HEAD"]).trim()).toBe(sha)
      expect(() => sh(evil, ["rev-parse", "--verify", "HEAD"])).toThrow()
      expect(existsSync(marker)).toBe(false)
      // The .git pointer was never committed.
      const tree = sh(root, ["--git-dir", paths.gitDir, "ls-tree", "--name-only", "HEAD"])
      expect(tree.split("\n")).not.toContain(".git")
    },
    T,
  )

  test("run passes hardening flags, scrubbed env and a safe cwd (fakeExec)", async () => {
    const prev = process.env.GITHUB_TOKEN
    process.env.GITHUB_TOKEN = "ghp_shouldneverleak000000000000000000000"
    try {
      const calls: Array<{ argv: string[]; opts: unknown }> = []
      const exec = (async (argv: string[], opts?: unknown) => {
        calls.push({ argv, opts })
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 }
      }) as unknown as import("../src/util/exec.ts").Exec
      const paths = newPaths()
      await new SafeGit(paths, exec).run(["status"])
      const { argv, opts } = calls[0]!
      expect(argv.slice(0, 5)).toEqual(["git", "--git-dir", paths.gitDir, "--work-tree", paths.workTree])
      const s = argv.join(" ")
      for (const flag of [
        `core.hooksPath=${paths.hooksDir}`,
        "core.fsmonitor=false",
        "credential.helper=",
        "diff.external=",
        "core.pager=cat",
        "core.autocrlf=false",
        "advice.detachedHead=false",
      ]) {
        expect(s).toContain(`-c ${flag}`)
      }
      expect(argv[argv.length - 1]).toBe("status")
      const o = opts as { env: Record<string, string>; cwd: string }
      expect(o.env.GIT_CONFIG_GLOBAL).toBe(paths.globalConfig)
      expect(o.env.GIT_CONFIG_NOSYSTEM).toBe("1")
      expect(o.env.GIT_TERMINAL_PROMPT).toBe("0")
      expect(o.env.GIT_LFS_SKIP_SMUDGE).toBe("1")
      expect(o.env.GIT_OPTIONAL_LOCKS).toBe("0")
      expect(o.env.GITHUB_TOKEN).toBeUndefined()
      expect(JSON.stringify(o.env)).not.toContain("ghp_shouldneverleak")
      expect(o.cwd).toBe(paths.hooksDir)
    } finally {
      if (prev === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = prev
    }
  })

  test("fails closed when the hooks dir or global config has been tampered with", async () => {
    const exec = fakeExec()
    const paths = newPaths()
    const git = new SafeGit(paths, exec)
    await git.run(["status"])
    writeFileSync(join(paths.hooksDir, "pre-commit"), "#!/bin/sh\n")
    await expect(git.run(["status"])).rejects.toThrow(/hooks dir/)
    rmSync(join(paths.hooksDir, "pre-commit"))
    writeFileSync(paths.globalConfig, "[core]\n\tfsmonitor = evil\n")
    await expect(git.run(["status"])).rejects.toThrow(/not empty/)
    expect(exec.calls).toHaveLength(1)
  })

  test("non-zero exit throws with the subcommand and stderr tail unless allowFailure", async () => {
    const exec = fakeExec(() => ({ exitCode: 128, stderr: "fatal: bad revision 'nope'" }))
    const git = new SafeGit(newPaths(), exec)
    await expect(git.run(["rev-parse", "nope"])).rejects.toThrow("git rev-parse failed: fatal: bad revision 'nope'")
    await expect(git.run(["-c", "a.b=c", "log"])).rejects.toThrow(/^git log failed/)
    const res = await git.run(["rev-parse", "nope"], { allowFailure: true })
    expect(res.exitCode).toBe(128)
    const slow = new SafeGit(newPaths(), fakeExec(() => ({ exitCode: 137, timedOut: true })))
    await expect(slow.run(["fetch"])).rejects.toThrow(/timed out/)
  })
})

describe("SafeGit work-tree operations (real git)", () => {
  let git: SafeGit
  let paths: GitPaths
  let base: string

  beforeAll(async () => {
    ;({ git, paths } = await cloned())
    base = await git.headSha()
    await git.checkoutNewBranch("oss-scout/7-demo", base)
  }, T)

  afterEach(async () => {
    await git.resetHard(base)
  }, T)

  test(
    "recentSubjects returns newest first",
    async () => {
      expect(await git.recentSubjects(10)).toEqual(["fix: add index", "feat: initial commit"])
      expect(await git.recentSubjects(1)).toEqual(["fix: add index"])
    },
    T,
  )

  test(
    "listFiles: tracked + untracked, excluding .gitignore and info/exclude, odd names intact",
    async () => {
      writeFileSync(join(paths.workTree, "new file ü.txt"), "x")
      mkdirSync(join(paths.workTree, "dist"))
      writeFileSync(join(paths.workTree, "dist", "bundle.js"), "x")
      mkdirSync(join(paths.workTree, "node_modules", "dep"), { recursive: true })
      writeFileSync(join(paths.workTree, "node_modules", "dep", "index.js"), "x")
      const files = await git.listFiles()
      expect(files).toContain("README.md")
      expect(files).toContain("index.js")
      expect(files).toContain("new file ü.txt")
      expect(files.some((f) => f.startsWith("dist/"))).toBe(false)
      expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false)
    },
    T,
  )

  test(
    "diffAgainst includes modified and untracked files and skips excluded artifacts",
    async () => {
      writeFileSync(join(paths.workTree, "index.js"), "module.exports = 2\n")
      writeFileSync(join(paths.workTree, "added.test.js"), "test('x', () => {})\n")
      mkdirSync(join(paths.workTree, ".oss-scout-venv", "bin"), { recursive: true })
      writeFileSync(join(paths.workTree, ".oss-scout-venv", "bin", "python"), "x")
      mkdirSync(join(paths.workTree, "node_modules"), { recursive: true })
      writeFileSync(join(paths.workTree, "node_modules", "x.js"), "x")
      mkdirSync(join(paths.workTree, "__pycache__"), { recursive: true })
      writeFileSync(join(paths.workTree, "__pycache__", "m.cpython-312.pyc"), "x")
      const diff = await git.diffAgainst(base)
      expect(diff).toContain("diff --git a/index.js b/index.js")
      expect(diff).toContain("+module.exports = 2")
      expect(diff).toContain("diff --git a/added.test.js b/added.test.js")
      expect(diff).toContain("new file mode")
      expect(diff).not.toContain(".oss-scout-venv")
      expect(diff).not.toContain("node_modules")
      expect(diff).not.toContain("__pycache__")
    },
    T,
  )

  test(
    "commitAll: author/committer identity, signoff trailer, returns the new sha",
    async () => {
      writeFileSync(join(paths.workTree, "a.txt"), "a\n")
      const sha1 = await git.commitAll("fix: no signoff", ID, false)
      expect(sha1).toBe(await git.headSha())
      expect((await git.run(["log", "-1", "--format=%B"])).stdout).not.toContain("Signed-off-by")
      writeFileSync(join(paths.workTree, "b.txt"), "b\n")
      const sha2 = await git.commitAll("fix: with signoff", ID, true)
      expect(sha2).not.toBe(sha1)
      const msg = (await git.run(["log", "-1", "--format=%B"])).stdout
      expect(msg).toContain("Signed-off-by: Test Bot <bot@example.com>")
      const who = (await git.run(["log", "-1", "--format=%an|%ae|%cn|%ce"])).stdout.trim()
      expect(who).toBe("Test Bot|bot@example.com|Test Bot|bot@example.com")
      await expect(git.commitAll("x", { name: "a\nb", email: "e@x" }, false)).rejects.toThrow(/identity/)
      await expect(git.commitAll("   ", ID, false)).rejects.toThrow(/empty/)
    },
    T,
  )

  test(
    "resetHard restores tracked files, removes untracked ones and keeps ignored install artifacts",
    async () => {
      writeFileSync(join(paths.workTree, "README.md"), "changed\n")
      writeFileSync(join(paths.workTree, "untracked.txt"), "x")
      mkdirSync(join(paths.workTree, "newdir"))
      writeFileSync(join(paths.workTree, "newdir", "f.txt"), "x")
      mkdirSync(join(paths.workTree, "node_modules", "dep"), { recursive: true })
      writeFileSync(join(paths.workTree, "node_modules", "dep", "keep.js"), "x")
      mkdirSync(join(paths.workTree, ".oss-scout-venv"), { recursive: true })
      writeFileSync(join(paths.workTree, ".oss-scout-venv", "pyvenv.cfg"), "x")
      await git.resetHard(base)
      expect(readFileSync(join(paths.workTree, "README.md"), "utf8")).toBe("# demo\n")
      expect(existsSync(join(paths.workTree, "untracked.txt"))).toBe(false)
      expect(existsSync(join(paths.workTree, "newdir"))).toBe(false)
      expect(existsSync(join(paths.workTree, "node_modules", "dep", "keep.js"))).toBe(true)
      expect(existsSync(join(paths.workTree, ".oss-scout-venv", "pyvenv.cfg"))).toBe(true)
      await expect(git.resetHard("--hard")).rejects.toThrow(/invalid git revision/)
    },
    T,
  )

  test(
    "checkoutNewBranch creates/resets a branch at the start point and rejects bad names",
    async () => {
      writeFileSync(join(paths.workTree, "c.txt"), "c\n")
      await git.commitAll("fix: c", ID, false)
      await git.checkoutNewBranch("oss-scout/8-other", base)
      expect(await git.headSha()).toBe(base)
      expect((await git.run(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("oss-scout/8-other")
      await expect(git.checkoutNewBranch("-b", base)).rejects.toThrow(/invalid branch/)
      await git.checkoutNewBranch("oss-scout/7-demo", base)
    },
    T,
  )
})

describe("SafeGit.push", () => {
  const token = "ghp_pushtoken1234567890abcdefghijklmnop"

  test("token only travels in GIT_CONFIG_VALUE_0 (base64 extraheader), never in argv", async () => {
    const seen: Array<{ argv: string[]; env: Record<string, string> }> = []
    const exec = (async (argv: string[], opts?: { env?: Record<string, string> }) => {
      seen.push({ argv, env: opts?.env ?? {} })
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 }
    }) as unknown as import("../src/util/exec.ts").Exec
    const paths = newPaths()
    const git = new SafeGit(paths, exec)
    const res = await git.push("https://github.com/me/widget.git", "oss-scout/42-fix", "oss-scout/42-fix", token)
    expect(res.exitCode).toBe(0)
    const { argv, env } = seen[0]!
    for (const a of argv) expect(a).not.toContain(token)
    expect(argv.join(" ")).not.toContain(Buffer.from(`x-access-token:${token}`).toString("base64"))
    expect(argv.slice(-4)).toEqual(["push", "--no-verify", "https://github.com/me/widget.git", "oss-scout/42-fix:refs/heads/oss-scout/42-fix"])
    expect(argv.join(" ")).toContain("-c credential.helper=")
    expect(argv.join(" ")).toContain(`-c core.hooksPath=${paths.hooksDir}`)
    expect(env.GIT_CONFIG_COUNT).toBe("1")
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader")
    expect(env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`)
    expect(env.GIT_CONFIG_VALUE_0).toBe(pushAuthHeader(token))
    expect(env.GIT_TERMINAL_PROMPT).toBe("0")
  })

  test("failure is returned (not thrown) with the token redacted from output", async () => {
    const header = pushAuthHeader(token)
    const exec = fakeExec(() => ({ exitCode: 128, stderr: `remote: denied for ${token}\n> ${header}`, stdout: token }))
    const git = new SafeGit(newPaths(), exec)
    const res = await git.push("https://github.com/me/widget", "HEAD", "oss-scout/1-x", token)
    expect(res.exitCode).toBe(128)
    expect(res.stderr).not.toContain(token)
    expect(res.stderr).not.toContain(header.split(" ").pop()!)
    expect(res.stdout).not.toContain(token)
    expect(res.stderr).toContain("[REDACTED]")
  })

  test("rejects non-GitHub, credentialed or non-https remotes and bad refs before running git", async () => {
    const exec = fakeExec()
    const git = new SafeGit(newPaths(), exec)
    for (const url of [
      "http://github.com/me/widget.git",
      "https://x-access-token:abc@github.com/me/widget.git",
      "https://evil.example.com/me/widget.git",
      "git@github.com:me/widget.git",
      "https://github.com/me/widget.git/../../other",
      "https://github.com/me",
    ]) {
      await expect(git.push(url, "HEAD", "b", token)).rejects.toThrow(/refusing to push/)
    }
    await expect(git.push("https://github.com/me/w.git", "--force", "b", token)).rejects.toThrow(/local ref/)
    await expect(git.push("https://github.com/me/w.git", "HEAD", "a:b", token)).rejects.toThrow(/remote branch/)
    await expect(git.push("https://github.com/me/w.git", "HEAD", "b", "")).rejects.toThrow(/token/)
    expect(exec.calls).toHaveLength(0)
  })
})

describe("SafeGit nested-repository defense (isolation-1, real git)", () => {
  /** Plant a nested repo at <workTree>/<dir> whose clean filter writes `marker` when git hashes a.txt. */
  function plantNestedRepo(workTree: string, dir: string, marker: string): string {
    const evil = join(workTree, dir)
    mkdirSync(evil, { recursive: true })
    sh(evil, ["init", "-q", "-b", "main"])
    writeFileSync(join(evil, "a.txt"), "hello\n")
    sh(evil, ["add", "a.txt"])
    sh(evil, ["commit", "-q", "-m", "x"])
    writeFileSync(join(evil, ".gitattributes"), "* filter=pwn\n")
    const cmd = `sh -c 'echo PWNED-from-host-git > "${posix(marker)}"; cat'`
    sh(evil, ["config", "filter.pwn.clean", cmd])
    // rewrite a.txt at the same size with a fresh mtime so git must re-hash it (running the filter)
    writeFileSync(join(evil, "a.txt"), "HELLO\n")
    const future = new Date(Date.now() + 10_000)
    utimesSync(join(evil, "a.txt"), future, future)
    return join(evil, ".git")
  }

  test(
    "two diffs over a planted nested repo run nothing on the host, and the nested repo is gone",
    async () => {
      const { git, paths } = await cloned()
      const base = await git.headSha()
      await git.checkoutNewBranch("oss-scout/1-x", base)
      const marker = join(root, `pwned-${n}.txt`)
      const nestedGit = plantNestedRepo(paths.workTree, "build-cache", marker)

      writeFileSync(join(paths.workTree, "index.js"), "module.exports = 2\n")
      const d1 = await git.diffAgainst(base)
      const d2 = await git.diffAgainst(base) // the attack needed this second call to fire
      expect(existsSync(marker)).toBe(false)
      // the nested repo was removed, so it is neither a gitlink nor diffed
      expect(existsSync(nestedGit)).toBe(false)
      for (const d of [d1, d2]) {
        expect(d).not.toContain("160000")
        expect(d).not.toContain("Subproject commit")
      }
      // the legit edit is still in the diff
      expect(d2).toContain("module.exports = 2")
    },
    T,
  )

  test(
    "commitAll over a planted nested repo commits the real change and runs nothing",
    async () => {
      const { git, paths } = await cloned()
      base_commit: {
        const base = await git.headSha()
        await git.checkoutNewBranch("oss-scout/2-y", base)
      }
      const marker = join(root, `pwned-commit-${n}.txt`)
      plantNestedRepo(paths.workTree, "deps/vendored", marker)
      writeFileSync(join(paths.workTree, "index.js"), "module.exports = 3\n")
      const sha = await git.commitAll("fix: change", ID, false)
      expect(existsSync(marker)).toBe(false)
      // nothing was committed as a submodule/gitlink (the nested .git was removed; leftover plain
      // files are harmless and visible in the diff). The legit change is present.
      const tree = sh(root, ["--git-dir", paths.gitDir, "ls-tree", "-r", sha])
      expect(tree).not.toContain("160000")
      expect(tree).not.toContain("commit ")
      expect(tree).toContain("\tindex.js")
    },
    T,
  )

  test("a committed gitlink (submodule) in the diff is refused rather than silently emitted", async () => {
    const { git, paths } = await cloned()
    const base = await git.headSha()
    await git.checkoutNewBranch("oss-scout/3-z", base)
    // Commit a gitlink straight into our git dir (what a dirty submodule would leave), then diff it.
    sh(root, ["--git-dir", paths.gitDir, "--work-tree", paths.workTree, "update-index", "--add", "--cacheinfo", `160000,${base},sub`])
    const withLink = sh(root, ["--git-dir", paths.gitDir, "-c", "user.name=x", "-c", "user.email=x@y", "commit", "-q", "-m", "add submodule"]) && git
    void withLink
    await expect(git.diffCommits(base, "HEAD")).rejects.toThrow(/submodule|gitlink/i)
  })

  test("every host git invocation carries submodule-recursion-off and transport-off flags", async () => {
    const exec = fakeExec()
    const paths = newPaths()
    await new SafeGit(paths, exec).run(["status"])
    const s = exec.calls[0]!.join(" ")
    expect(s).toContain("-c submodule.recurse=false")
    expect(s).toContain("-c protocol.allow=never")
    expect(s).toContain("-c fetch.recurseSubmodules=false")
  })

  test("the git dir is discovered explicitly: GIT_CEILING_DIRECTORIES keeps discovery inside the state dir", async () => {
    const calls: Array<{ env: Record<string, string> }> = []
    const exec = (async (_argv: string[], opts?: { env?: Record<string, string> }) => {
      calls.push({ env: opts?.env ?? {} })
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 }
    }) as unknown as import("../src/util/exec.ts").Exec
    const paths = newPaths()
    await new SafeGit(paths, exec).run(["status"])
    expect(calls[0]!.env.GIT_CEILING_DIRECTORIES).toBe(join(paths.globalConfig, ".."))
  })

  test("onSanitized reports planted .git entries removed before a command", async () => {
    const { paths } = await cloned()
    mkdirSync(join(paths.workTree, "cache", ".git"), { recursive: true })
    const seen: string[][] = []
    const git = new SafeGit(paths, execCommand, { onSanitized: (scan) => seen.push(scan.removedGitEntries) })
    await git.run(["status", "--porcelain"], { allowFailure: true })
    expect(seen.flat()).toContain("cache/.git")
    expect(existsSync(join(paths.workTree, "cache", ".git"))).toBe(false)
  })

  test(
    "the raw diff (not redacted) carries real token shapes so the secrets gate catches them (secrets-1/docs-1)",
    async () => {
      const { git, paths } = await cloned()
      const base = await git.headSha()
      await git.checkoutNewBranch("oss-scout/5-secret", base)
      const token = "ghp_" + "Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0Lz3Xc7V"
      writeFileSync(join(paths.workTree, "config.js"), `module.exports = { token: "${token}" }\n`)
      const workDiff = await git.diffAgainst(base)
      expect(workDiff).toContain(token)
      expect(workDiff).not.toContain("[REDACTED]")
      expect(scanDiffForSecrets(workDiff).map((f) => f.rule)).toContain("github-token")
      // The committed diff (base..commit, what the queue shows and what is pushed) is identical.
      const sha = await git.commitAll("chore: config", ID, false)
      const commitDiff = await git.diffCommits(base, sha)
      expect(commitDiff).toContain(token)
      expect(scanDiffForSecrets(commitDiff).map((f) => f.rule)).toContain("github-token")
      // A redacted copy (the old behavior) would have hidden the token from the scan.
      expect(scanDiffForSecrets(redact(commitDiff))).toEqual([])
    },
    T,
  )

  test("gitlinkPaths parses raw diff lines", () => {
    const raw = ":000000 160000 00000 abcd A\tsub\n:100644 100644 1 2 M\tfile.ts\n:160000 000000 abcd 0 D\tgone"
    expect(gitlinkPaths(raw).sort()).toEqual(["gone", "sub"])
    expect(gitlinkPaths("")).toEqual([])
  })

  test(
    "diffCommits returns exactly the committed change (base..commit), unaffected by later work-tree edits",
    async () => {
      const { git, paths } = await cloned()
      const base = await git.headSha()
      await git.checkoutNewBranch("oss-scout/4-w", base)
      writeFileSync(join(paths.workTree, "index.js"), "module.exports = 9\n")
      const sha = await git.commitAll("fix: nine", ID, false)
      // dirty the work tree afterwards
      writeFileSync(join(paths.workTree, "index.js"), "module.exports = 999\n")
      writeFileSync(join(paths.workTree, "extra.txt"), "later\n")
      const committed = await git.diffCommits(base, sha)
      expect(committed).toContain("module.exports = 9")
      expect(committed).not.toContain("module.exports = 999")
      expect(committed).not.toContain("extra.txt")
    },
    T,
  )
})
