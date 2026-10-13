import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { loadConfig } from "../src/config/load.ts"
import { parseConfig } from "../src/config/schema.ts"
import {
  CODESPACES_TOKEN_ENV,
  CODESPACES_WRITE_TOKEN_ENV,
  codespacesFindings,
  inCodespace,
} from "../src/util/codespaces.ts"
import { PACKAGE_ROOT } from "../src/util/paths.ts"

const PRESET = join(PACKAGE_ROOT, "oss-scout.config.codespaces.json")
const DEVCONTAINER = join(PACKAGE_ROOT, ".devcontainer", "devcontainer.json")
const SETUP = join(PACKAGE_ROOT, ".devcontainer", "setup.sh")

const IN_CODESPACE = { CODESPACES: "true", CODESPACE_NAME: "fluffy-train" }
const findings = (over: Partial<Parameters<typeof codespacesFindings>[0]> = {}) =>
  codespacesFindings({
    env: IN_CODESPACE,
    tokenEnv: CODESPACES_TOKEN_ENV,
    writeTokenEnv: CODESPACES_WRITE_TOKEN_ENV,
    stateDir: "/workspaces/.oss-scout",
    ...over,
  })
const levels = (f: ReturnType<typeof findings>) => f.map((x) => x.level)

describe("codespacesFindings", () => {
  test("nothing outside a codespace", () => {
    expect(inCodespace({})).toBe(false)
    expect(inCodespace({ CODESPACES: "false" })).toBe(false)
    expect(findings({ env: {}, tokenEnv: "GITHUB_TOKEN", stateDir: "/home/me/.oss-scout" })).toEqual([])
  })

  test("a correct setup only reports the codespace", () => {
    const f = findings()
    expect(levels(f)).toEqual(["info"])
    expect(f[0]!.text).toContain("Running in GitHub Codespace fluffy-train")
    expect(findings({ env: { CODESPACES: "true" } })[0]!.text).toStartWith("Running in GitHub Codespace (see")
  })

  test("reading the codespace's own GITHUB_TOKEN is a failure, for either setting", () => {
    const read = findings({ tokenEnv: "GITHUB_TOKEN" })
    expect(levels(read)).toEqual(["info", "fail"])
    expect(read[1]!.text).toStartWith("github.tokenEnv is GITHUB_TOKEN")
    expect(read[1]!.text).toContain(`secret named ${CODESPACES_TOKEN_ENV}`)

    const write = findings({ writeTokenEnv: "GITHUB_TOKEN" })
    expect(levels(write)).toEqual(["info", "fail"])
    expect(write[1]!.text).toContain(`set github.writeTokenEnv to "${CODESPACES_WRITE_TOKEN_ENV}"`)

    expect(levels(findings({ tokenEnv: "GH_TOKEN" }))).toEqual(["info"])
  })

  test("a state dir outside /workspaces is lost on rebuild", () => {
    for (const dir of ["/home/node/.oss-scout", "/workspacesX/.oss-scout", "/tmp/state"]) {
      const f = findings({ stateDir: dir })
      expect(levels(f)).toEqual(["info", "warn"])
      expect(f[1]!.text).toContain(`State dir ${dir} is outside /workspaces`)
    }
    for (const dir of ["/workspaces", "/workspaces/.oss-scout", "/workspaces/state/deep"]) {
      expect(levels(findings({ stateDir: dir }))).toEqual(["info"])
    }
  })
})

describe("Codespaces preset and devcontainer", () => {
  const raw = JSON.parse(readFileSync(PRESET, "utf8")) as Record<string, unknown>
  const preset = parseConfig(raw)

  test("the preset is valid, dry-run, and reads tokens from Codespaces secrets", () => {
    expect(preset.mode).toBe("dry-run")
    expect(preset.github.tokenEnv).toBe(CODESPACES_TOKEN_ENV)
    expect(preset.github.writeTokenEnv).toBe(CODESPACES_WRITE_TOKEN_ENV)
    expect(preset.stateDir).toBe("/workspaces/.oss-scout")
    expect(preset.caps.maxConcurrentTasks).toBe(1)
    // doctor in a codespace has nothing to complain about
    expect(
      levels(
        codespacesFindings({
          env: IN_CODESPACE,
          tokenEnv: preset.github.tokenEnv,
          writeTokenEnv: preset.github.writeTokenEnv,
          stateDir: preset.stateDir!,
        }),
      ),
    ).toEqual(["info"])
  })

  test("the critic uses a different model than the implementer", () => {
    expect(preset.implementation.model).not.toBeNull()
    expect(preset.critic.model).not.toBeNull()
    expect(preset.critic.model).not.toBe(preset.implementation.model)
  })

  test("OSS_SCOUT_CONFIG selects the preset, and the checkout is the home directory", () => {
    const loaded = loadConfig({ directory: PACKAGE_ROOT, env: { OSS_SCOUT_CONFIG: PRESET }, homeDir: join(PACKAGE_ROOT, "no-such-home") })
    expect(loaded.file).toBe(PRESET)
    expect(loaded.config.homeDirectory).toBe(dirname(PRESET))
    expect(loaded.config.github.tokenEnv).toBe(CODESPACES_TOKEN_ENV)
  })

  test("devcontainer.json points at the preset, recommends the matching secrets and runs setup.sh", () => {
    const dc = JSON.parse(readFileSync(DEVCONTAINER, "utf8")) as {
      containerEnv: Record<string, string>
      secrets: Record<string, unknown>
      postCreateCommand: string
      features: Record<string, unknown>
    }
    expect(dc.containerEnv.OSS_SCOUT_CONFIG).toBe("${containerWorkspaceFolder}/oss-scout.config.codespaces.json")
    expect(Object.keys(dc.secrets).sort()).toEqual([preset.github.tokenEnv, preset.github.writeTokenEnv].sort())
    for (const name of Object.keys(dc.secrets)) expect(name).not.toMatch(/^GITHUB_/i)
    expect(Object.keys(dc.features).some((f) => f.includes("/docker-in-docker:"))).toBe(true)
    expect(dc.postCreateCommand).toBe("bash .devcontainer/setup.sh")
    expect(existsSync(SETUP)).toBe(true)
  })

  test("setup.sh creates the preset's state dir and pins its tools", () => {
    const sh = readFileSync(SETUP, "utf8")
    expect(sh).not.toContain("\r")
    expect(sh.match(/^STATE_DIR="([^"]+)"/m)?.[1]).toBe(preset.stateDir!)
    expect(sh).toMatch(/^BUN_VERSION="\d+\.\d+\.\d+"/m)
    expect(sh).toMatch(/^OPENCODE_VERSION="2\.\d+\.\d+"/m)
    expect(sh).toContain("bun install --frozen-lockfile")
  })
})
