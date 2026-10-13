import { describe, expect, test } from "bun:test"
import type { ProjectInfo } from "../src/core/types.ts"
import {
  detectCommitConvention,
  detectProject,
  imageNodeMajor,
  isTestFile,
  majorSatisfies,
  nodeImageForEngines,
  tomlTableKeys,
} from "../src/workspace/project.ts"
import { testConfig } from "./helpers/fakes.ts"

const config = testConfig({})

function detect(files: Record<string, string>, opts: { repo?: string; cfg?: ReturnType<typeof testConfig> } = {}): ProjectInfo {
  return detectProject({
    repo: opts.repo ?? "acme/widget",
    files: Object.keys(files),
    readFile: (p) => files[p] ?? null,
    config: opts.cfg ?? config,
  })
}

const pkg = (obj: Record<string, unknown>) => JSON.stringify(obj)
const scripts = { test: "vitest run", lint: "eslint ." }

describe("detectProject: node", () => {
  test("npm with lockfile → npm ci, npm test, npm run lint, default image", () => {
    const p = detect({ "package.json": pkg({ scripts }), "package-lock.json": "{}", "src/index.ts": "" })
    expect(p.ecosystem).toBe("node")
    expect(p.packageManager).toBe("npm")
    expect(p.image).toBe("node:22-bookworm")
    expect(p.install).toBe("npm ci --no-audit --no-fund")
    expect(p.test).toBe("npm test")
    expect(p.lint).toBe("npm run lint")
  })

  test("npm without lockfile never writes a lockfile into the work tree", () => {
    const p = detect({ "package.json": pkg({ scripts }) })
    expect(p.install).toBe("npm install --no-audit --no-fund --no-package-lock")
    expect(p.notes.join(" ")).toContain("no lockfile")
  })

  test("npm's placeholder test script and missing lint → null commands", () => {
    const p = detect({
      "package.json": pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      "package-lock.json": "{}",
    })
    expect(p.test).toBeNull()
    expect(p.lint).toBeNull()
    expect(p.notes.join(" ")).toContain("placeholder")
  })

  test("pnpm via lockfile uses corepack with shims/caches kept inside the work tree", () => {
    const p = detect({ "package.json": pkg({ scripts }), "pnpm-lock.yaml": "" })
    expect(p.packageManager).toBe("pnpm")
    expect(p.install).toContain("corepack enable --install-directory /tmp/corepack && export PATH=/tmp/corepack:$PATH && ")
    expect(p.install).toContain("COREPACK_HOME=/work/.oss-scout-corepack")
    expect(p.install).toContain("pnpm install --frozen-lockfile")
    expect(p.test).toContain("pnpm run test")
    expect(p.test).toContain("corepack enable")
    expect(p.lint).toContain("pnpm run lint")
  })

  test("yarn classic vs berry", () => {
    const classic = detect({ "package.json": pkg({ scripts }), "yarn.lock": "" })
    expect(classic.packageManager).toBe("yarn")
    expect(classic.install).toContain("yarn install --frozen-lockfile")
    const berry = detect({ "package.json": pkg({ scripts }), "yarn.lock": "", ".yarnrc.yml": "nodeLinker: node-modules" })
    expect(berry.packageManager).toBe("yarn")
    expect(berry.install).toContain("yarn install --immutable")
    expect(berry.install).toContain("YARN_GLOBAL_FOLDER=/work/.oss-scout-yarn")
    expect(berry.test).toContain("yarn run test")
  })

  test("packageManager field wins over lockfiles", () => {
    const p = detect({ "package.json": pkg({ scripts, packageManager: "pnpm@9.12.0+sha512.abc" }), "package-lock.json": "{}" })
    expect(p.packageManager).toBe("pnpm")
    expect(p.install).toContain("pnpm install --no-lockfile")
    const y4 = detect({ "package.json": pkg({ scripts, packageManager: "yarn@4.5.0" }), "yarn.lock": "" })
    expect(y4.install).toContain("--immutable")
    const y1 = detect({ "package.json": pkg({ scripts, packageManager: "yarn@1.22.22" }), "yarn.lock": "", ".yarnrc.yml": "" })
    expect(y1.install).toContain("--frozen-lockfile")
  })

  test("bun lockfile → oven/bun image and bun commands", () => {
    for (const lock of ["bun.lock", "bun.lockb"]) {
      const p = detect({ "package.json": pkg({ scripts }), [lock]: "" })
      expect(p.packageManager).toBe("bun")
      expect(p.image).toBe("oven/bun:1")
      expect(p.install).toBe("bun install --frozen-lockfile")
      expect(p.test).toBe("bun run test")
      expect(p.lint).toBe("bun run lint")
    }
  })

  test("engines.node picks node:<major>-bookworm only when the configured image does not satisfy it", () => {
    const pinned = detect({ "package.json": pkg({ scripts, engines: { node: "^20.11.0" } }), "package-lock.json": "{}" })
    expect(pinned.image).toBe("node:20-bookworm")
    expect(pinned.notes.join(" ")).toContain("engines.node")
    const satisfied = detect({ "package.json": pkg({ scripts, engines: { node: ">=18" } }), "package-lock.json": "{}" })
    expect(satisfied.image).toBe("node:22-bookworm")
    const ancient = detect({ "package.json": pkg({ scripts, engines: { node: "14.x" } }), "package-lock.json": "{}" })
    expect(ancient.image).toBe("node:22-bookworm")
    expect(ancient.notes.join(" ")).toContain("not satisfiable")
    const custom = detect(
      { "package.json": pkg({ scripts, engines: { node: ">=18" } }), "package-lock.json": "{}" },
      { cfg: testConfig({ sandbox: { images: { node: "registry.local/my-node:stable" } } }) },
    )
    expect(custom.image).toBe("registry.local/my-node:stable")
  })

  test("unparseable package.json still yields a usable node project", () => {
    const p = detect({ "package.json": "{ nope", "package-lock.json": "{}" })
    expect(p.ecosystem).toBe("node")
    expect(p.test).toBeNull()
    expect(p.notes.join(" ")).toContain("could not be parsed")
  })
})

describe("detectProject: python", () => {
  test("pyproject with test extra, pytest config and ruff → venv inside the work tree", () => {
    const pyproject = [
      "[project]",
      'name = "demo"',
      "[project.optional-dependencies]",
      'test = ["pytest>=7"]',
      'docs = ["sphinx"]',
      "[tool.pytest.ini_options]",
      'addopts = "-ra"',
      "[tool.ruff]",
      "line-length = 100",
    ].join("\n")
    const p = detect({ "pyproject.toml": pyproject, "src/demo/__init__.py": "", "tests/test_demo.py": "" })
    expect(p.ecosystem).toBe("python")
    expect(p.packageManager).toBe("pip")
    expect(p.image).toBe("python:3.12-bookworm")
    expect(p.install).toStartWith("python -m venv --copies .oss-scout-venv && . .oss-scout-venv/bin/activate && ")
    expect(p.install).toContain("pip install -e '.[test]'")
    expect(p.install).not.toContain("docs")
    expect(p.install).toContain("pip install -q pytest")
    expect(p.install).toContain("pip install -q ruff")
    expect(p.test).toBe(". .oss-scout-venv/bin/activate && python -m pytest -q -x")
    expect(p.lint).toBe(". .oss-scout-venv/bin/activate && ruff check . --extend-exclude .oss-scout-venv")
  })

  test("setup.py + requirements files + flake8 in setup.cfg", () => {
    const p = detect({
      "setup.py": "setup(name='x', extras_require={'dev': ['pytest']})",
      "setup.cfg": "[flake8]\nmax-line-length = 100\n",
      "requirements.txt": "requests\n",
      "requirements-dev.txt": "pytest\n",
      "tests/test_x.py": "",
    })
    expect(p.install).toContain("pip install -e '.[dev]'")
    expect(p.install).toContain("pip install -r requirements.txt")
    expect(p.install).toContain("pip install -r requirements-dev.txt")
    expect(p.lint).toContain("flake8 --extend-exclude .oss-scout-venv")
    expect(p.test).toContain("python -m pytest")
  })

  test("requirements-only project without tests → no test command", () => {
    const p = detect({ "requirements.txt": "flask\n", "app.py": "" })
    expect(p.ecosystem).toBe("python")
    expect(p.install).not.toContain("pip install -e")
    expect(p.install).toContain("pip install -r requirements.txt")
    expect(p.test).toBeNull()
    expect(p.lint).toBeNull()
  })

  test("poetry project installs with poetry into the venv, with test/dev groups", () => {
    const pyproject = [
      "[tool.poetry]",
      'name = "demo"',
      "[tool.poetry.dependencies]",
      'python = "^3.10"',
      "[tool.poetry.group.dev.dependencies]",
      'pytest = "^8"',
      "[tool.poetry.group.docs.dependencies]",
      'mkdocs = "*"',
    ].join("\n")
    const p = detect({ "pyproject.toml": pyproject, "poetry.lock": "", "tests/test_a.py": "" })
    expect(p.packageManager).toBe("poetry")
    expect(p.install).toContain("pip install -q poetry")
    expect(p.install).toContain("POETRY_VIRTUALENVS_CREATE=false poetry install --no-interaction --with dev")
    expect(p.install).not.toContain("docs")
    expect(p.test).toContain("pytest")
  })

  test("uv project syncs into the oss-scout venv without removing pip", () => {
    const p = detect({ "pyproject.toml": "[project]\nname='x'\n", "uv.lock": "", "tests/test_a.py": "" })
    expect(p.packageManager).toBe("uv")
    expect(p.install).toContain("UV_PROJECT_ENVIRONMENT=.oss-scout-venv")
    expect(p.install).toContain("uv sync --frozen --inexact")
  })

  test("PEP 735 dependency groups are installed with pip --group", () => {
    const p = detect({ "pyproject.toml": "[project]\nname='x'\n[dependency-groups]\ntest = ['pytest']\nlint = ['ruff']\n", "test_a.py": "" })
    expect(p.install).toContain("pip install --group test")
    expect(p.install).not.toContain("--group lint")
  })

  test("python wins over a docs-only package.json", () => {
    const p = detect({ "pyproject.toml": "[project]\nname='x'\n", "package.json": pkg({ scripts }), "tests/test_a.py": "" })
    expect(p.ecosystem).toBe("python")
  })
})

describe("detectProject: java", () => {
  test("maven with wrapper → offline test with local repo inside the work tree", () => {
    const p = detect({ "pom.xml": "<project/>", mvnw: "", ".mvn/wrapper/maven-wrapper.properties": "" })
    expect(p.ecosystem).toBe("java-maven")
    expect(p.packageManager).toBe("mvnw")
    expect(p.image).toBe("maven:3.9-eclipse-temurin-21")
    expect(p.install).toContain("sh ./mvnw -B -ntp -Dmaven.repo.local=.oss-scout-m2 -DskipTests dependency:go-offline test-compile")
    expect(p.install).toContain("MAVEN_USER_HOME=/work/.oss-scout-mvnw")
    expect(p.test).toContain("sh ./mvnw -B -ntp -o -Dmaven.repo.local=.oss-scout-m2 test")
    expect(p.lint).toBeNull()
  })

  test("maven without wrapper uses mvn", () => {
    const p = detect({ "pom.xml": "<project/>" })
    expect(p.packageManager).toBe("maven")
    expect(p.install).toContain("mvn -B -ntp -Dmaven.repo.local=.oss-scout-m2 -DskipTests dependency:go-offline test-compile")
    expect(p.test).toContain("mvn -B -ntp -o -Dmaven.repo.local=.oss-scout-m2 test")
  })

  test("gradle with and without wrapper", () => {
    const w = detect({ "build.gradle.kts": "", "settings.gradle.kts": "", gradlew: "" })
    expect(w.ecosystem).toBe("java-gradle")
    expect(w.packageManager).toBe("gradlew")
    expect(w.image).toBe("gradle:8.10-jdk21")
    expect(w.install).toStartWith("sh ./gradlew --no-daemon -g .oss-scout-gradle testClasses")
    expect(w.test).toBe("sh ./gradlew --no-daemon -g .oss-scout-gradle --offline test")
    const g = detect({ "build.gradle": "" })
    expect(g.install).toStartWith("gradle --no-daemon -g .oss-scout-gradle testClasses")
    expect(g.test).toBe("gradle --no-daemon -g .oss-scout-gradle --offline test")
  })
})

describe("detectProject: unknown + overrides", () => {
  test("unknown ecosystem → fallback image, null commands, a note", () => {
    const p = detect({ "main.go": "", "go.mod": "" })
    expect(p.ecosystem).toBe("unknown")
    expect(p.image).toBe("debian:bookworm")
    expect(p.install).toBeNull()
    expect(p.test).toBeNull()
    expect(p.lint).toBeNull()
    expect(p.notes.length).toBeGreaterThan(0)
  })

  test("overrides apply with a case-insensitive repo key; null disables a command", () => {
    const cfg = testConfig({
      implementation: { overrides: { "Acme/Widget": { test: "npm run test:unit", lint: null, image: "node:20-bookworm" } } },
    })
    const p = detect({ "package.json": pkg({ scripts }), "package-lock.json": "{}" }, { repo: "acme/widget", cfg })
    expect(p.test).toBe("npm run test:unit")
    expect(p.lint).toBeNull()
    expect(p.image).toBe("node:20-bookworm")
    expect(p.install).toBe("npm ci --no-audit --no-fund")
    expect(p.notes.join(" ")).toContain("override")
    const other = detect({ "package.json": pkg({ scripts }), "package-lock.json": "{}" }, { repo: "acme/other", cfg })
    expect(other.lint).toBe("npm run lint")
  })

  test("overrides can give an unknown project commands", () => {
    const cfg = testConfig({ implementation: { overrides: { "acme/go": { install: "true", test: "go test ./...", image: "golang:1.23" } } } })
    const p = detect({ "go.mod": "" }, { repo: "acme/go", cfg })
    expect(p.test).toBe("go test ./...")
    expect(p.image).toBe("golang:1.23")
  })
})

describe("helpers", () => {
  test("majorSatisfies handles common engines ranges", () => {
    expect(majorSatisfies(">=18", 22)).toBe(true)
    expect(majorSatisfies("^20.11.0", 22)).toBe(false)
    expect(majorSatisfies("^20.11.0", 20)).toBe(true)
    expect(majorSatisfies("18.x || 20.x", 20)).toBe(true)
    expect(majorSatisfies("18.x || 20.x", 22)).toBe(false)
    expect(majorSatisfies(">=18 <21", 20)).toBe(true)
    expect(majorSatisfies(">=18 <21", 22)).toBe(false)
    expect(majorSatisfies(">= 18.0.0 < 20.5.0", 20)).toBe(true)
    expect(majorSatisfies("18 - 20", 19)).toBe(true)
    expect(majorSatisfies("18 - 20", 21)).toBe(false)
    expect(majorSatisfies("*", 22)).toBe(true)
    expect(majorSatisfies(">20", 20)).toBe(false)
    expect(majorSatisfies(">20.1.0", 20)).toBe(true)
  })

  test("nodeImageForEngines / imageNodeMajor", () => {
    expect(imageNodeMajor("node:22-bookworm")).toBe(22)
    expect(imageNodeMajor("docker.io/library/node:20")).toBe(20)
    expect(imageNodeMajor("oven/bun:1")).toBeNull()
    expect(nodeImageForEngines("~18.17", "node:22-bookworm").image).toBe("node:18-bookworm")
    expect(nodeImageForEngines(">=16", "node:22-bookworm").image).toBe("node:22-bookworm")
  })

  test("tomlTableKeys reads keys of one table only", () => {
    const toml = '[a]\nx = 1\n[b.c]\ntest = ["p"]\n"dev" = [\n  "pytest==8",\n]\n[[d]]\ny = 2\n'
    expect(tomlTableKeys(toml, "b.c")).toEqual(["test", "dev", "pytest"])
    expect(tomlTableKeys(toml, "a")).toEqual(["x"])
    expect(tomlTableKeys(toml, "zzz")).toEqual([])
  })
})

describe("detectCommitConvention", () => {
  test("fewer than 5 subjects → unknown", () => {
    expect(detectCommitConvention(["feat: a", "fix: b", "chore: c", "docs: d"])).toBe("unknown")
    expect(detectCommitConvention([])).toBe("unknown")
  })

  test("≥ 60% conventional → conventional; otherwise none", () => {
    const conv = ["feat(api): add x", "fix!: drop y", "chore: deps", "docs: readme", "Merge pull request #1"]
    expect(detectCommitConvention(conv)).toBe("conventional")
    const none = ["Add x", "Fix y", "Update README", "feat: z", "Bump deps"]
    expect(detectCommitConvention(none)).toBe("none")
    // "feat:x" (no space) and unknown types do not count
    expect(detectCommitConvention(["feat:x", "feature: y", "fix: z", "Fix a", "Fix b"])).toBe("none")
  })

  test("blank subjects are ignored", () => {
    expect(detectCommitConvention(["", " ", "fix: a", "fix: b", "fix: c", "fix: d"])).toBe("unknown")
  })
})

describe("isTestFile", () => {
  const node = detect({ "package.json": pkg({ scripts }), "package-lock.json": "{}" })
  const py = detect({ "pyproject.toml": "[project]\nname='x'\n" })
  const mvn = detect({ "pom.xml": "" })

  test.each([
    ["src/__tests__/a.ts", true],
    ["src/a.test.ts", true],
    ["src/a.spec.tsx", true],
    ["test/unit/a.js", true],
    ["src\\a.test.mjs", true],
    ["src/contest.ts", false],
    ["src/index.ts", false],
  ])("node %s → %p", (path, expected) => {
    expect(isTestFile(path, node)).toBe(expected)
  })

  test.each([
    ["tests/test_api.py", true],
    ["pkg/test_util.py", true],
    ["pkg/util_test.py", true],
    ["conftest.py", true],
    ["pkg/latest.py", false],
    ["pkg/api.py", false],
  ])("python %s → %p", (path, expected) => {
    expect(isTestFile(path, py)).toBe(expected)
  })

  test.each([
    ["src/test/java/com/acme/FooTest.java", true],
    ["module/src/test/resources/x.json", true],
    ["src/main/java/com/acme/FooIT.java", true],
    ["src/main/java/com/acme/Latest.java", false],
  ])("maven %s → %p", (path, expected) => {
    expect(isTestFile(path, mvn)).toBe(expected)
  })

  test("invalid patterns are ignored; empty patterns fall back to generic ones", () => {
    const broken: ProjectInfo = { ...node, testFilePatterns: ["(", "\\.test\\.js$"] }
    expect(isTestFile("a.test.js", broken)).toBe(true)
    const empty: ProjectInfo = { ...node, testFilePatterns: [] }
    expect(isTestFile("tests/x.py", empty)).toBe(true)
  })
})
