import { describe, expect, test } from "bun:test"
import type { Exec, ExecResult } from "../src/util/exec.ts"
import { nullLogger } from "../src/util/log.ts"
import {
  buildContainerArgs,
  ContainerSandbox,
  createSandbox,
  sanitizeContainerName,
  validateContainerEnv,
} from "../src/workspace/container.ts"
import { SandboxUnavailableError, type SandboxRunRequest } from "../src/workspace/sandbox.ts"
import { fakeExec, testConfig } from "./helpers/fakes.ts"

const cfg = testConfig({}).sandbox

function req(over: Partial<SandboxRunRequest> = {}): SandboxRunRequest {
  return {
    workTree: "/state/workspaces/t1/repo",
    gitDir: "/state/gitdirs/t1",
    command: "npm test",
    image: "node:22-bookworm",
    network: "none",
    timeoutMs: 60_000,
    label: "oss-scout-t1-test",
    ...over,
  }
}

function valueAfter(argv: string[], flag: string): string[] {
  const out: string[] = []
  argv.forEach((a, i) => {
    if (a === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]!)
  })
  return out
}

describe("buildContainerArgs", () => {
  test("full argv: isolation flags, mounts, env, user, entrypoint", () => {
    const argv = buildContainerArgs("docker", req({ env: { NODE_ENV: "test" } }), cfg, "oss-scout-t1-test-x", { uid: 1000, gid: 1001 })
    expect(argv).toEqual([
      "docker",
      "run",
      "--rm",
      "--name",
      "oss-scout-t1-test-x",
      "--label",
      "oss-scout=1",
      "--network",
      "none",
      "--memory",
      "4g",
      "--memory-swap",
      "4g",
      "--cpus",
      "2",
      "--pids-limit",
      "1024",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--init",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,exec,nosuid,size=2g",
      "--mount",
      "type=bind,source=/state/workspaces/t1/repo,target=/work",
      "--mount",
      "type=bind,source=/state/gitdirs/t1,target=/work/.git,readonly",
      "-w",
      "/work",
      "-e",
      "CI=true",
      "-e",
      "HOME=/tmp/home",
      "-e",
      "NODE_ENV=test",
      "--user",
      "1000:1001",
      "--entrypoint",
      "sh",
      "node:22-bookworm",
      "-lc",
      "npm test",
    ])
  })

  test("install network, no git dir, writable rootfs, no --user on Windows-like hosts, podman", () => {
    const argv = buildContainerArgs("podman", req({ network: "bridge", gitDir: null }), { ...cfg, readOnlyRootfs: false }, "n", null)
    expect(argv[0]).toBe("podman")
    expect(valueAfter(argv, "--network")).toEqual(["bridge"])
    expect(valueAfter(argv, "--mount")).toEqual(["type=bind,source=/state/workspaces/t1/repo,target=/work"])
    expect(argv).not.toContain("--read-only")
    expect(argv).not.toContain("--user")
  })

  test("the git dir is always mounted read-only and only the work tree is writable", () => {
    const mounts = valueAfter(buildContainerArgs("docker", req(), cfg, "n", null), "--mount")
    expect(mounts.filter((m) => m.includes("readonly"))).toEqual(["type=bind,source=/state/gitdirs/t1,target=/work/.git,readonly"])
    expect(mounts).toHaveLength(2)
  })

  test("the command is one argv element after -lc (no host shell involved)", () => {
    const cmd = "npm test; echo $HOME && rm -rf / # not interpreted on the host"
    const argv = buildContainerArgs("docker", req({ command: cmd }), cfg, "n", null)
    expect(argv.slice(-4)).toEqual(["sh", "node:22-bookworm", "-lc", cmd])
  })

  test.each([
    ["GITHUB_TOKEN", "x"],
    ["GH_TOKEN", "x"],
    ["NPM_TOKEN", "x"],
    ["MY_SECRET", "x"],
    ["DB_PASSWORD", "x"],
    ["AWS_REGION", "x"],
    ["OPENAI_BASE", "x"],
    ["ANTHROPIC_MODEL", "x"],
    ["API_KEY", "x"],
    ["X_AUTH", "x"],
    ["FOO", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["FOO", "https://user:pass@example.com/x"],
    ["BAD-NAME", "x"],
    ["FOO", "a\0b"],
  ])("rejects secret-like or malformed env %s=%s", (k, v) => {
    expect(() => buildContainerArgs("docker", req({ env: { [k]: v } }), cfg, "n", null)).toThrow(/sandbox env/)
  })

  test("rejects unsupported network, bad image, unsafe mount paths, bad names, empty command", () => {
    expect(() => buildContainerArgs("docker", req({ network: "host" as "none" }), cfg, "n", null)).toThrow(/network/)
    expect(() => buildContainerArgs("docker", req({ image: "--privileged" }), cfg, "n", null)).toThrow(/image/)
    expect(() => buildContainerArgs("docker", req({ image: "a b" }), cfg, "n", null)).toThrow(/image/)
    expect(() => buildContainerArgs("docker", req({ workTree: "/x,target=/etc" }), cfg, "n", null)).toThrow(/bind mount/)
    expect(() => buildContainerArgs("docker", req({ gitDir: "/g,readonly=false" }), cfg, "n", null)).toThrow(/bind mount/)
    expect(() => buildContainerArgs("docker", req(), cfg, "Bad Name", null)).toThrow(/container name/)
    expect(() => buildContainerArgs("docker", req({ command: "  " }), cfg, "n", null)).toThrow(/empty command/)
  })

  test("validateContainerEnv accepts harmless values", () => {
    expect(() => validateContainerEnv({ NODE_OPTIONS: "--max-old-space-size=2048", PYTHONHASHSEED: "0" })).not.toThrow()
  })

  test("sanitizeContainerName", () => {
    expect(sanitizeContainerName("oss-scout-Task_1/test run")).toBe("oss-scout-task_1-test-run")
    expect(sanitizeContainerName("--x")).toBe("x")
    expect(sanitizeContainerName("!!!")).toBe("oss-scout")
  })
})

function ok(over: Partial<ExecResult> = {}): ExecResult {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 3, ...over }
}

describe("ContainerSandbox.available", () => {
  test("ENOENT → CLI not found reason", async () => {
    const exec: Exec = async () => {
      throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" })
    }
    const sb = new ContainerSandbox({ runtime: "docker", exec, config: cfg, log: nullLogger })
    const a = await sb.available()
    expect(a).toEqual({
      ok: false,
      reason: "docker CLI not found on PATH (install Docker Desktop or Podman)",
      runtime: "docker",
      version: null,
    })
  })

  test("non-zero exit → daemon not reachable with stderr tail", async () => {
    const exec = fakeExec(() => ({ exitCode: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" }))
    const sb = new ContainerSandbox({ runtime: "docker", exec, config: cfg, log: nullLogger })
    const a = await sb.available()
    expect(a.ok).toBe(false)
    expect(a.reason).toStartWith("docker daemon not reachable: Cannot connect to the Docker daemon")
    expect(exec.calls[0]).toEqual(["docker", "version", "--format", "{{.Server.Version}}"])
  })

  test("ok → version; result cached for 5 minutes", async () => {
    let t = 1_000_000
    const exec = fakeExec(() => ({ stdout: "27.3.1\n" }))
    const sb = new ContainerSandbox({ runtime: "podman", exec, config: cfg, log: nullLogger, now: () => t })
    expect(await sb.available()).toEqual({ ok: true, reason: null, runtime: "podman", version: "27.3.1" })
    t += 4 * 60_000
    await sb.available()
    expect(exec.calls).toHaveLength(1)
    t += 2 * 60_000
    await sb.available()
    expect(exec.calls).toHaveLength(2)
  })

  test("probe uses a 15 s timeout and a scrubbed env", async () => {
    const seen: Array<{ timeoutMs?: number; env?: Record<string, string | undefined> }> = []
    const prev = process.env.GITHUB_TOKEN
    process.env.GITHUB_TOKEN = "ghp_neverpassed0000000000000000000000000"
    try {
      const exec: Exec = async (_argv, opts) => {
        seen.push(opts ?? {})
        return ok({ stdout: "1.0" })
      }
      await new ContainerSandbox({ runtime: "docker", exec, config: cfg, log: nullLogger }).available()
      expect(seen[0]!.timeoutMs).toBe(15_000)
      expect(seen[0]!.env?.GITHUB_TOKEN).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = prev
    }
  })

  test("createSandbox builds a ContainerSandbox for the configured runtime", () => {
    const sb = createSandbox(testConfig({ sandbox: { runtime: "podman" } }), fakeExec(), nullLogger)
    expect(sb).toBeInstanceOf(ContainerSandbox)
    expect(sb.kind).toBe("podman")
  })
})

describe("ContainerSandbox.run", () => {
  function sandbox(responder: (argv: string[]) => Partial<ExecResult>, config = cfg) {
    const exec = fakeExec(responder)
    const sb = new ContainerSandbox({ runtime: "docker", exec, config, log: nullLogger, now: () => 1_700_000_000_000, user: null })
    return { sb, exec }
  }

  test("inspects the image, runs the container and returns redacted combined output", async () => {
    const { sb, exec } = sandbox((argv) =>
      argv[1] === "run" ? { exitCode: 1, stdout: "1 failing", stderr: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked" } : {},
    )
    const res = await sb.run(req())
    expect(exec.calls.map((c) => c.slice(0, 3))).toEqual([
      ["docker", "image", "inspect"],
      ["docker", "run", "--rm"],
    ])
    expect(res.exitCode).toBe(1)
    expect(res.timedOut).toBe(false)
    expect(res.output).toContain("1 failing")
    expect(res.output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789")
    expect(res.output).toContain("[REDACTED]")
    const runArgv = exec.calls[1]!
    expect(valueAfter(runArgv, "--name")[0]).toStartWith("oss-scout-t1-test-")
    // the image is only inspected once per sandbox instance
    await sb.run(req())
    expect(exec.calls.filter((c) => c[1] === "image")).toHaveLength(1)
  })

  test("pulls a missing image (logged) and throws when the pull fails", async () => {
    const { sb, exec } = sandbox((argv) => (argv[1] === "image" ? { exitCode: 1, stderr: "No such image" } : {}))
    await sb.run(req())
    expect(exec.calls.map((c) => c[1])).toEqual(["image", "pull", "run"])
    expect(exec.calls[1]).toEqual(["docker", "pull", "node:22-bookworm"])

    const failing = sandbox((argv) =>
      argv[1] === "image" ? { exitCode: 1 } : argv[1] === "pull" ? { exitCode: 1, stderr: "manifest unknown" } : {},
    )
    await expect(failing.sb.run(req())).rejects.toThrow(/failed to pull image node:22-bookworm: manifest unknown/)
    expect(failing.exec.calls.some((c) => c[1] === "run")).toBe(false)
  })

  test("timeout → kill and rm -f the named container, timedOut reported", async () => {
    const { sb, exec } = sandbox((argv) => (argv[1] === "run" ? { exitCode: 137, timedOut: true, stdout: "partial" } : {}))
    const res = await sb.run(req({ timeoutMs: 1234 }))
    expect(res.timedOut).toBe(true)
    const name = valueAfter(exec.calls.find((c) => c[1] === "run")!, "--name")[0]!
    expect(exec.calls).toContainEqual(["docker", "kill", name])
    expect(exec.calls).toContainEqual(["docker", "rm", "-f", name])
    expect(res.output).toContain("partial")
  })

  test("cleanup failures after a timeout are swallowed", async () => {
    const exec: Exec = async (argv) => {
      if (argv[1] === "run") return ok({ exitCode: 137, timedOut: true })
      if (argv[1] === "kill" || argv[1] === "rm") throw new Error("boom")
      return ok()
    }
    const sb = new ContainerSandbox({ runtime: "docker", exec, config: cfg, log: nullLogger, user: null })
    expect((await sb.run(req())).timedOut).toBe(true)
  })

  test("passes the request timeout and output cap to exec", async () => {
    const seen: Array<{ argv: string[]; timeoutMs?: number; maxOutputBytes?: number }> = []
    const exec: Exec = async (argv, opts) => {
      seen.push({ argv, timeoutMs: opts?.timeoutMs, maxOutputBytes: opts?.maxOutputBytes })
      return ok()
    }
    await new ContainerSandbox({ runtime: "docker", exec, config: cfg, log: nullLogger, user: null }).run(req({ timeoutMs: 4242 }))
    const run = seen.find((s) => s.argv[1] === "run")!
    expect(run.timeoutMs).toBe(4242)
    expect(run.maxOutputBytes).toBe(cfg.maxOutputBytes)
  })

  test("output is capped at maxOutputBytes", async () => {
    const small = { ...cfg, maxOutputBytes: 1024 }
    const { sb } = sandbox((argv) => (argv[1] === "run" ? { stdout: "x".repeat(5000) + "END" } : {}), small)
    const res = await sb.run(req())
    expect(res.output.length).toBeLessThan(1200)
    expect(res.output.endsWith("END")).toBe(true)
  })

  test("invalid requests are rejected before anything executes", async () => {
    const { sb, exec } = sandbox(() => ({}))
    await expect(sb.run(req({ env: { GITHUB_TOKEN: "x" } }))).rejects.toThrow(/sandbox env/)
    await expect(sb.run(req({ network: "host" as "none" }))).rejects.toThrow(/network/)
    expect(exec.calls).toHaveLength(0)
  })

  test("runtime CLI vanishing mid-run → SandboxUnavailableError", async () => {
    const exec: Exec = async () => {
      throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" })
    }
    const sb = new ContainerSandbox({ runtime: "docker", exec, config: cfg, log: nullLogger, user: null })
    await expect(sb.run(req())).rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  test("docker's own failure (exit 125 + daemon error) is an infrastructure error, not a test failure", async () => {
    const { sb } = sandbox((argv) =>
      argv[1] === "run" ? { exitCode: 125, stderr: "docker: Error response from daemon: invalid mount config" } : {},
    )
    await expect(sb.run(req())).rejects.toThrow(/docker run failed/)
  })


  test("the request signal is forwarded to the run exec and image inspect", async () => {
    const ac = new AbortController()
    const seen: Array<AbortSignal | undefined> = []
    const exec: Exec = async (_argv, opts) => {
      seen.push(opts?.signal)
      return ok()
    }
    await new ContainerSandbox({ runtime: "docker", exec, config: cfg, log: nullLogger, user: null }).run(req({ signal: ac.signal }))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((s) => s === ac.signal)).toBe(true)
  })

  test("abort during the run → kill and rm -f the container, non-zero exit, not a normal result", async () => {
    const ac = new AbortController()
    const calls: string[][] = []
    const exec: Exec = async (argv) => {
      calls.push(argv)
      if (argv[1] === "run") {
        ac.abort() // kill switch / Scheduler.stop() fires mid-run
        return ok({ exitCode: 0, stdout: "partial" })
      }
      return ok()
    }
    const sb = new ContainerSandbox({ runtime: "docker", exec, config: cfg, log: nullLogger, user: null })
    const res = await sb.run(req({ signal: ac.signal }))
    expect(res.timedOut).toBe(false)
    expect(res.exitCode).not.toBe(0)
    const name = valueAfter(calls.find((c) => c[1] === "run")!, "--name")[0]!
    expect(calls).toContainEqual(["docker", "kill", name])
    expect(calls).toContainEqual(["docker", "rm", "-f", name])
  })

  test("already-aborted signal → nothing is executed, a non-zero result is returned", async () => {
    const ac = new AbortController()
    ac.abort()
    const { sb, exec } = sandbox(() => ({}))
    const res = await sb.run(req({ signal: ac.signal }))
    expect(res.exitCode).not.toBe(0)
    expect(exec.calls).toHaveLength(0)
  })
})

