/**
 * CLI tests. Every runCli call gets an explicit env WITHOUT tokens, a temp directory holding an
 * oss-scout.config.json whose state dir is inside that temp directory, a fake sandbox (no container
 * runtime is probed) and a fetch that throws (no network). One test spawns the real CLI process.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createApp } from "../src/app.ts"
import {
  contextLine,
  doctorExitCode,
  EXIT_CODES_HELP,
  parseCliArgs,
  plannedEffect,
  runCli,
  type CliInteractive,
  type CliIo,
} from "../src/cli.ts"
import type { QueueItem } from "../src/core/types.ts"
import { DRY_RUN_PREFIX } from "../src/queue/submit.ts"
import { FakeClock } from "../src/util/clock.ts"
import { FakeGitHub, FakeSandbox, ghIssue, ghUser, removeTempDir } from "./helpers/fakes.ts"

const REPO_ROOT = resolve(dirname(import.meta.path), "..")
const TOKEN_VARS = ["GITHUB_TOKEN", "GH_TOKEN", "OSS_SCOUT_WRITE_TOKEN", "OSS_SCOUT_CONFIG"] as const

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function tempDir(prefix = "oss-scout-cli-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => removeTempDir(dir))
  return dir
}

/** Temp dir with oss-scout.config.json (state dir inside it). */
function project(config: Record<string, unknown> = {}): { dir: string; stateDir: string; configFile: string } {
  const dir = tempDir()
  const stateDir = join(dir, "state")
  const configFile = join(dir, "oss-scout.config.json")
  writeFileSync(configFile, JSON.stringify({ stateDir, ...config }))
  return { dir, stateDir, configFile }
}

interface Captured {
  io: CliIo
  out: string[]
  err: string[]
}

function capture(): Captured {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, out, err }
}

const noNetwork = (async (input: unknown) => {
  throw new Error(`no network in tests: ${String(input)}`)
}) as unknown as typeof fetch

/** createApp with a fake sandbox and no network (the env passed by runCli is kept). */
const fakeCreateApp: typeof createApp = (opts) =>
  createApp({ ...opts, fetch: noNetwork, overrides: { ...(opts.overrides ?? {}), sandbox: new FakeSandbox() } })

/** A terminal: `answers` are typed in order; every question asked is recorded. */
function terminal(isTTY: boolean, answers: string[] = []): CliInteractive & { questions: string[] } {
  const questions: string[] = []
  return {
    isTTY,
    questions,
    async prompt(q) {
      questions.push(q)
      const a = answers.shift()
      if (a === undefined) throw new Error("no more input")
      return a
    },
  }
}

/**
 * runCli in `dir` with an env that has no tokens, no terminal unless given, an empty home directory
 * and no checkout fallback (the developer's real ~/.oss-scout is never read).
 */
async function cli(argv: string[], dir: string, env: Record<string, string | undefined> = {}, interactive: CliInteractive = terminal(false)) {
  const c = capture()
  const code = await runCli(argv, { cwd: dir, env, io: c.io, createApp: fakeCreateApp, interactive, homeDir: tempDir("oss-scout-cli-home-"), packageDirectory: null })
  return { code, out: c.out.join("\n"), err: c.err.join("\n") }
}

/** Seed one PR queue item into the project's state dir. */
async function seedItem(dir: string): Promise<QueueItem> {
  const seed = fakeCreateApp({ directory: dir, llm: null, env: {} })
  try {
    return seed.queue.enqueue({
      kind: "pr",
      repo: "acme/widget",
      issueUrl: "https://github.com/acme/widget/issues/42",
      prUrl: null,
      taskId: "task_1",
      title: "fix: handle zero timeout",
      body: "Fixes #42 BODY-MARKER",
      diff: "diff --git a/x b/x\n+DIFF-MARKER\n",
      testOutput: "TEST-OUTPUT-MARKER",
      critic: null,
      verification: null,
      branch: "oss-scout/42-zero-timeout",
      workspace: null,
      baseBranch: "main",
      data: { issueId: "acme/widget#42" },
    })
  } finally {
    await seed.close()
  }
}

/** Read one item back (fresh app on the same state dir). */
async function itemStatus(dir: string, id: number): Promise<string | undefined> {
  const app = fakeCreateApp({ directory: dir, llm: null, env: {} })
  try {
    return app.queue.get(id)?.status
  } finally {
    await app.close()
  }
}

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

describe("parseCliArgs", () => {
  test("command and rest are passed through", () => {
    expect(parseCliArgs(["status"])).toEqual({ configPath: null, command: "status", rest: [] })
    expect(parseCliArgs(["approve", "3", "1a2b3c4d"])).toEqual({ configPath: null, command: "approve", rest: ["3", "1a2b3c4d"] })
    // options after the command belong to the command
    expect(parseCliArgs(["edit", "3", "body", "--config", "x"])).toEqual({
      configPath: null,
      command: "edit",
      rest: ["3", "body", "--config", "x"],
    })
  })

  test("no command means help; --help / -h too", () => {
    expect(parseCliArgs([])).toEqual({ configPath: null, command: "help", rest: [] })
    expect(parseCliArgs(["--help"])).toEqual({ configPath: null, command: "help", rest: [] })
    expect(parseCliArgs(["-h", "status"])).toEqual({ configPath: null, command: "help", rest: [] })
  })

  test("--config, -c and --config= select the config file", () => {
    expect(parseCliArgs(["--config", "a.json", "status"])).toEqual({ configPath: "a.json", command: "status", rest: [] })
    expect(parseCliArgs(["-c", "b.json", "queue", "all"])).toEqual({ configPath: "b.json", command: "queue", rest: ["all"] })
    expect(parseCliArgs(["--config=c.json", "doctor"])).toEqual({ configPath: "c.json", command: "doctor", rest: [] })
    expect(parseCliArgs(["--config", "d.json"])).toEqual({ configPath: "d.json", command: "help", rest: [] })
  })

  test("-- ends the options", () => {
    expect(parseCliArgs(["--", "--weird"])).toEqual({ configPath: null, command: "--weird", rest: [] })
    expect(parseCliArgs(["--config", "a.json", "--", "show", "1"])).toEqual({ configPath: "a.json", command: "show", rest: ["1"] })
  })

  test("errors: missing config path, unknown option", () => {
    for (const argv of [["--config"], ["--config", ""], ["-c"], ["--config="]]) {
      const r = parseCliArgs(argv)
      expect("error" in r && r.error).toContain("needs a path")
    }
    const unknown = parseCliArgs(["--verbose", "status"])
    expect("error" in unknown && unknown.error).toContain("unknown option --verbose")
  })
})

describe("doctorExitCode", () => {
  test("2 only when a line starts with [FAIL]", () => {
    expect(doctorExitCode("oss-scout doctor\n[ok]   Config\n[WARN] Sandbox")).toBe(0)
    expect(doctorExitCode("oss-scout doctor\n[FAIL] GITHUB_TOKEN is not set")).toBe(2)
    expect(doctorExitCode("[info] mentions [FAIL] inline")).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// runCli (in-process, injected io, no tokens)
// ---------------------------------------------------------------------------

describe("runCli", () => {
  test("help: exit 0, lists the commands and the exit codes", async () => {
    const { dir } = project()
    const r = await cli(["help"], dir)
    expect(r.code).toBe(0)
    expect(r.err).toBe("")
    for (const name of ["status", "queue", "show <id>", "approve <id> <digest>", "doctor", "config-schema"]) expect(r.out).toContain(name)
    expect(r.out).toContain(EXIT_CODES_HELP)
    expect((await cli([], dir)).out).toBe(r.out)
  })

  test("status: exit 0 and reads the config's state dir", async () => {
    const { dir, stateDir } = project()
    const r = await cli(["status"], dir)
    expect(r.code).toBe(0)
    expect(r.out).toStartWith("oss-scout status at")
    expect(r.out).toContain("GitHub: token MISSING")
    expect(r.out).toContain("sandbox fake 1.0 available")
    expect(existsSync(join(stateDir, "oss-scout.db"))).toBe(true)
  })

  test("doctor without a token: [FAIL] and exit 2 (output on stdout)", async () => {
    const { dir, configFile } = project()
    const r = await cli(["doctor"], dir)
    expect(r.code).toBe(2)
    expect(r.out).toContain("[FAIL] GITHUB_TOKEN is not set")
    expect(r.out).toContain(`[ok]   Config: ${configFile}`)
    expect(r.err).toBe("")
  })

  test("doctor with a (fake, never used for network) token and no failure: exit 0", async () => {
    const { dir } = project()
    const c = capture()
    const createWithTokenInfo: typeof createApp = (opts) => {
      const app = fakeCreateApp(opts)
      ;(app.ctx.github as { tokenInfo: () => Promise<unknown> }).tokenInfo = async () => ({
        login: "me",
        kind: "classic",
        scopes: ["public_repo"],
      })
      return app
    }
    const env = { GITHUB_TOKEN: "ghp_" + "f".repeat(36) }
    const code = await runCli(["doctor"], { cwd: dir, env, io: c.io, createApp: createWithTokenInfo })
    expect(c.out.join("\n")).not.toContain("[FAIL]")
    expect(c.out.join("\n")).not.toContain(env.GITHUB_TOKEN)
    expect(code).toBe(0)
  })

  test("unknown command: exit 1 with error: on stderr", async () => {
    const { dir } = project()
    const r = await cli(["frobnicate"], dir)
    expect(r.code).toBe(1)
    expect(r.err).toStartWith("error:")
    expect(r.err).toContain('unknown command "frobnicate"')
    expect(r.out).toBe("")
  })

  test("unknown option: exit 1 before any app is created", async () => {
    const { dir } = project()
    let created = false
    const c = capture()
    const code = await runCli(["--verbose", "status"], {
      cwd: dir,
      env: {},
      io: c.io,
      createApp: (opts) => {
        created = true
        return fakeCreateApp(opts)
      },
    })
    expect(code).toBe(1)
    expect(created).toBe(false)
    expect(c.err.join("\n")).toStartWith("error: unknown option --verbose")
  })

  test("config-schema works without any config (and even with a missing --config)", async () => {
    const empty = tempDir("oss-scout-cli-empty-")
    for (const argv of [["config-schema"], ["schema"], ["--config", "missing.json", "config-schema"]]) {
      const r = await cli(argv, empty)
      expect(r.code).toBe(0)
      const schema = JSON.parse(r.out) as { type: string; properties: Record<string, unknown> }
      expect(schema.type).toBe("object")
      expect(schema.properties.mode).toBeDefined()
    }
    expect(existsSync(join(empty, "state"))).toBe(false)
  })

  test("--config pointing to a missing file: exit 1", async () => {
    const { dir } = project()
    const r = await cli(["--config", "missing.json", "status"], dir)
    expect(r.code).toBe(1)
    expect(r.err).toStartWith("error:")
    expect(r.err).toContain("oss-scout config not found")
    expect(r.err).toContain("missing.json")
  })

  test("--config selects another config file", async () => {
    const { dir } = project()
    const other = tempDir("oss-scout-cli-other-")
    const otherState = join(other, "state")
    const otherConfig = join(other, "custom.json")
    writeFileSync(otherConfig, JSON.stringify({ stateDir: otherState, mode: "off" }))
    const r = await cli(["--config", otherConfig, "status"], dir)
    expect(r.code).toBe(0)
    expect(r.out).toContain("Mode: off")
    expect(existsSync(join(otherState, "oss-scout.db"))).toBe(true)
  })

  test("approve without a digest: exit 1 and nothing is approved", async () => {
    const { dir } = project()
    const tty = terminal(true)
    const r = await cli(["approve", "1"], dir, {}, tty)
    expect(r.code).toBe(1)
    expect(r.err).toStartWith("error: missing digest")
    const missingId = await cli(["approve"], dir, {}, tty)
    expect(missingId.code).toBe(1)
    expect(missingId.err).toStartWith("error: missing queue item id")
    expect(tty.questions).toEqual([])
  })

  test("show prints the full review view in the CLI", async () => {
    const { dir } = project()
    await seedItem(dir)
    const r = await cli(["show", "1"], dir)
    expect(r.code).toBe(0)
    for (const m of ["BODY-MARKER", "DIFF-MARKER", "TEST-OUTPUT-MARKER"]) expect(r.out).toContain(m)
  })
})

// ---------------------------------------------------------------------------
// human presence: approve / resume / edit need an interactive terminal
// ---------------------------------------------------------------------------

describe("interactive-only commands", () => {
  test("without a terminal approve, resume, edit and sync refuse before any app is created", async () => {
    const { dir } = project()
    const cases: Array<[string[], string]> = [
      [["approve", "1", "abcdef12"], "error: approval must be run interactively by a human in a terminal"],
      [["oss_scout_approve", "1", "abcdef12"], "error: approval must be run interactively by a human in a terminal"],
      [["resume"], "error: releasing the kill switch must be run interactively by a human in a terminal"],
      [["edit", "1", "body", "x"], "error: editing a queue item must be run interactively by a human in a terminal"],
      [["sync", "1"], "error: editing a queue item must be run interactively by a human in a terminal"],
    ]
    for (const [argv, message] of cases) {
      let created = false
      const c = capture()
      const code = await runCli(argv, {
        cwd: dir,
        env: {},
        io: c.io,
        interactive: terminal(false),
        createApp: (opts) => {
          created = true
          return fakeCreateApp(opts)
        },
      })
      expect(`${argv[0]}:${code}`).toBe(`${argv[0]}:1`)
      expect(c.err.join("\n")).toBe(message)
      expect(created).toBe(false)
    }
    // read-only and stopping commands still work without a terminal
    expect((await cli(["queue"], dir)).code).toBe(0)
    expect((await cli(["kill", "test"], dir)).code).toBe(0)
  })

  test("approve shows what will happen and needs the repository name typed; anything else aborts", async () => {
    const { dir, configFile, stateDir } = project()
    const item = await seedItem(dir)
    const digest = item.digest.slice(0, 8)

    for (const typed of ["yes", "", "ACME/WIDGET", "acme/widget2"]) {
      const tty = terminal(true, [typed])
      const r = await cli(["approve", "1", digest], dir, {}, tty)
      expect(r.code).toBe(1)
      expect(r.err).toBe("error: approval aborted: the confirmation did not match the repository name; nothing was approved")
      expect(tty.questions).toEqual(["Type the repository name (acme/widget) to approve; anything else aborts: "])
      expect(r.out).toContain("About to approve queue item #1 (pending):")
      expect(r.out).toContain("Repository: acme/widget")
      expect(r.out).toContain("Kind:       pull request")
      expect(r.out).toContain("Title:      fix: handle zero timeout")
      expect(r.out).toContain(`Digest:     ${digest}`)
      expect(r.out).toContain("Mode is dry-run: nothing is written to GitHub")
      expect(r.out).toContain(`(config: ${configFile}; state dir: ${stateDir})`)
      expect(await itemStatus(dir, 1)).toBe("pending")
    }
    // end of input (Ctrl+D) aborts too
    const eof = await cli(["approve", "1", digest], dir, {}, terminal(true, []))
    expect(eof.code).toBe(1)
    expect(await itemStatus(dir, 1)).toBe("pending")
  })

  test("approve with the typed repository name goes through (dry-run here: nothing written)", async () => {
    const { dir, stateDir } = project()
    const item = await seedItem(dir)
    const tty = terminal(true, ["  acme/widget  "])
    const writer = new FakeGitHub()
    // GitHub is in-memory: the issue is open and unclaimed (the approval freshness check)
    const withFakeGitHub: typeof createApp = (opts) =>
      fakeCreateApp({
        ...opts,
        overrides: {
          github: new FakeGitHub({
            getIssue: async (_repo, n) => ghIssue({ number: n }),
            listIssueTimeline: async () => [],
            getAuthenticatedUser: async () => ghUser("me"),
          }),
          githubWriter: writer,
          clock: new FakeClock(),
        },
      })
    const c = capture()
    const code = await runCli(["approve", "1", item.digest.slice(0, 8)], {
      cwd: dir,
      env: { GITHUB_TOKEN: "ghp_" + "f".repeat(36) },
      io: c.io,
      createApp: withFakeGitHub,
      interactive: tty,
      homeDir: tempDir("oss-scout-cli-home-"),
      packageDirectory: null,
    })
    const out = c.out.join("\n")
    expect(c.err.join("\n")).toBe("")
    expect(code).toBe(0)
    expect(out).toContain(DRY_RUN_PREFIX)
    expect(out).toContain(`state dir: ${stateDir})`)
    expect(tty.questions).toHaveLength(1)
    expect(writer.calls).toHaveLength(0)
    expect(await itemStatus(dir, 1)).toBe("approved")
  })

  test("approve of an unknown item: no prompt, exit 1", async () => {
    const { dir } = project()
    const tty = terminal(true, ["acme/widget"])
    const r = await cli(["approve", "9", "abcdef12"], dir, {}, tty)
    expect(r.code).toBe(1)
    expect(r.err).toBe("error: queue item 9 not found")
    expect(tty.questions).toEqual([])
  })

  test("in queue mode the summary says what will be written to GitHub", () => {
    expect(plannedEffect({ kind: "pr", repo: "acme/widget", branch: "oss-scout/1-x", prUrl: null }, "queue")).toBe(
      "This will create or reuse your fork of acme/widget, push branch oss-scout/1-x to it and open a pull request against acme/widget on GitHub.",
    )
    expect(plannedEffect({ kind: "reply", repo: "acme/widget", branch: null, prUrl: "https://github.com/acme/widget/pull/7" }, "queue")).toContain(
      "post the drafted reply as a public comment on https://github.com/acme/widget/pull/7",
    )
    expect(plannedEffect({ kind: "fix", repo: "acme/widget", branch: "b", prUrl: "https://github.com/acme/widget/pull/7" }, "queue")).toContain(
      "push the reviewed follow-up commit",
    )
    expect(plannedEffect({ kind: "pr", repo: "acme/widget", branch: "b", prUrl: null }, "off")).toContain("Mode is off: nothing is written to GitHub")
    // display-safe: control characters in third-party text cannot drive the terminal
    expect(plannedEffect({ kind: "pr", repo: "acme/widget\u001b[2J", branch: "b\nfake line", prUrl: null }, "queue")).not.toMatch(/[\u001b\n]/)
  })

  test("resume needs \"resume\" typed while the kill switch is engaged", async () => {
    const { dir, stateDir } = project()
    expect((await cli(["kill", "panic"], dir)).out).toContain(`(config: `)
    const killFile = join(stateDir, "KILL")
    expect(existsSync(killFile)).toBe(true)

    const no = terminal(true, ["y"])
    const refused = await cli(["resume"], dir, {}, no)
    expect(refused.code).toBe(1)
    expect(refused.err).toBe("error: resume aborted: the kill switch stays engaged")
    expect(refused.out).toMatch(/The kill switch is ENGAGED: .*panic/)
    expect(refused.out).toContain(`state dir: ${stateDir})`)
    expect(no.questions).toEqual(['Type "resume" to release it; anything else aborts: '])
    expect(existsSync(killFile)).toBe(true)

    const yes = terminal(true, ["resume"])
    const released = await cli(["resume"], dir, {}, yes)
    expect(released.code).toBe(0)
    expect(released.out).toContain("Kill switch released")
    expect(existsSync(killFile)).toBe(false)

    // nothing engaged: no question
    const idle = terminal(true)
    expect((await cli(["resume"], dir, {}, idle)).out).toContain("Kill switch is not engaged")
    expect(idle.questions).toEqual([])
  })

  test("kill names the config and state dir it used, and warns when running on built-in defaults", async () => {
    const empty = tempDir("oss-scout-cli-noconfig-")
    const r = await cli(["--config", join(empty, "nope.json"), "kill"], empty)
    expect(r.code).toBe(1)
    const { dir, configFile, stateDir } = project()
    const ok = await cli(["kill", "stop"], dir)
    expect(ok.out).toContain(`(config: ${configFile}; state dir: ${stateDir})`)
    expect(contextLine({ loaded: { config: {} as never, file: null, baseDir: empty }, ctx: { paths: { stateDir: "/s" } } as never })).toBe(
      "(config: built-in defaults (no config file found; pass --config <path> or set OSS_SCOUT_CONFIG); state dir: /s)",
    )
  })
})

// ---------------------------------------------------------------------------
// the real process
// ---------------------------------------------------------------------------

describe("bun src/cli.ts (spawned)", () => {
  test("help exits 0 and lists the commands, without any token", () => {
    const { configFile, stateDir } = project()
    const env: Record<string, string | undefined> = { ...process.env }
    for (const k of TOKEN_VARS) delete env[k]
    env.OSS_SCOUT_CONFIG = configFile
    const proc = Bun.spawnSync([process.execPath, "src/cli.ts", "help"], {
      cwd: REPO_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = proc.stdout.toString()
    expect(proc.exitCode).toBe(0)
    expect(stdout).toContain("oss-scout commands")
    for (const name of ["status", "queue", "show <id>", "approve <id> <digest>", "reject", "doctor"]) expect(stdout).toContain(name)
    expect(stdout).toContain(EXIT_CODES_HELP)
    expect(proc.stderr.toString()).toBe("")
    // the configured state dir was used (not ~/.oss-scout)
    expect(existsSync(join(stateDir, "oss-scout.db"))).toBe(true)
  })

  test("approve and resume refuse when stdin is not a terminal (e.g. an agent's shell tool)", () => {
    const { configFile } = project()
    const env: Record<string, string | undefined> = { ...process.env }
    for (const k of TOKEN_VARS) delete env[k]
    env.OSS_SCOUT_CONFIG = configFile
    for (const [argv, message] of [
      [["approve", "1", "abcdef12"], "error: approval must be run interactively by a human in a terminal"],
      [["resume"], "error: releasing the kill switch must be run interactively by a human in a terminal"],
    ] as const) {
      const proc = Bun.spawnSync([process.execPath, "src/cli.ts", ...argv], {
        cwd: REPO_ROOT,
        env,
        stdin: new TextEncoder().encode("acme/widget\nresume\n"),
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(proc.exitCode).toBe(1)
      expect(proc.stderr.toString().trim()).toBe(message)
      expect(proc.stdout.toString()).toBe("")
    }
  })
})
