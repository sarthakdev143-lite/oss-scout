import type { OssScoutConfig } from "../config/schema.ts"
import type { CommitConvention, ProjectInfo } from "../core/types.ts"

/**
 * Project detection. Every command runs in a FRESH container (`sh -lc`, cwd /work = the work
 * tree), so anything an install produces must live inside the work tree: ecosystem dirs
 * (node_modules, target, .gradle) or ignored `.oss-scout-*` dirs (see git.ts EXCLUDE_PATTERNS).
 */

type ReadFile = (path: string) => string | null

/** Test-file regexes (as strings) per ecosystem; matched against "/"-separated repo paths. */
export const TEST_FILE_PATTERNS: Record<ProjectInfo["ecosystem"], string[]> = {
  node: [
    "(^|/)(__tests__|__test__|__mocks__|tests?|specs?|e2e)/",
    "\\.(test|spec|e2e)\\.[cm]?[jt]sx?$",
    "\\.(test|spec)\\.(vue|svelte|astro)$",
  ],
  python: ["(^|/)tests?/", "(^|/)test_[^/]*\\.py$", "_tests?\\.py$", "(^|/)conftest\\.py$"],
  "java-maven": ["(^|/)src/(test|it|integrationTest)/", "(Test|Tests|IT|TestCase)\\.(java|kt|groovy|scala)$"],
  "java-gradle": ["(^|/)src/(test|it|integrationTest|testFixtures)/", "(Test|Tests|IT|TestCase|Spec)\\.(java|kt|groovy|scala)$"],
  unknown: [
    "(^|/)(__tests__|tests?|specs?)/",
    "\\.(test|spec)\\.[cm]?[jt]sx?$",
    "(^|/)test_[^/]*\\.py$",
    "_test\\.(py|go|rs|rb)$",
    "(^|/)src/test/",
    "Tests?\\.(java|kt)$",
  ],
}

const NPM_PLACEHOLDER_TEST = /no test specified/i
const VENV = ".oss-scout-venv"
const ACTIVATE = `. ${VENV}/bin/activate`

/**
 * Detect ecosystem, package manager, container image and install/test/lint commands from the
 * repo's files. Applies config.implementation.overrides[repo]. Pure.
 */
export function detectProject(input: {
  repo: string
  files: string[]
  readFile: (path: string) => string | null
  config: OssScoutConfig
}): ProjectInfo {
  const files = new Set(input.files.map(normalizePath))
  const detected = detectEcosystem(files, input.readFile, input.config)
  return applyOverrides(detected, input.repo, input.config)
}

function detectEcosystem(files: Set<string>, readFile: ReadFile, config: OssScoutConfig): ProjectInfo {
  if (files.has("pom.xml")) return detectMaven(files, config)
  if (["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].some((f) => files.has(f))) {
    return detectGradle(files, config)
  }
  if (["pyproject.toml", "setup.py", "setup.cfg"].some((f) => files.has(f))) return detectPython(files, readFile, config)
  if (files.has("package.json")) return detectNode(files, readFile, config)
  if ([...files].some((f) => /^requirements[^/]*\.txt$/.test(f))) return detectPython(files, readFile, config)
  return {
    ecosystem: "unknown",
    packageManager: null,
    image: config.sandbox.images.fallback,
    install: null,
    test: null,
    lint: null,
    testFilePatterns: TEST_FILE_PATTERNS.unknown,
    notes: ["unrecognized ecosystem: no install/test/lint commands detected (configure implementation.overrides)"],
  }
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

interface PackageJson {
  packageManager?: unknown
  scripts?: Record<string, unknown>
  engines?: { node?: unknown }
}

type NodePm = "npm" | "pnpm" | "yarn" | "yarn-berry" | "bun"

function parseJson(text: string | null): PackageJson | null {
  if (!text) return null
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === "object" && !Array.isArray(v) ? (v as PackageJson) : null
  } catch {
    return null
  }
}

function detectNodePm(pkg: PackageJson | null, files: Set<string>): { pm: NodePm; locked: boolean } {
  const field = typeof pkg?.packageManager === "string" ? pkg.packageManager.trim() : ""
  const m = /^(npm|pnpm|yarn|bun)@(\d+)/.exec(field)
  const berryMarker = files.has(".yarnrc.yml")
  if (m) {
    const name = m[1]!
    const major = Number(m[2])
    if (name === "pnpm") return { pm: "pnpm", locked: files.has("pnpm-lock.yaml") }
    if (name === "yarn") return { pm: major >= 2 ? "yarn-berry" : "yarn", locked: files.has("yarn.lock") }
    if (name === "bun") return { pm: "bun", locked: files.has("bun.lock") || files.has("bun.lockb") }
    return { pm: "npm", locked: files.has("package-lock.json") || files.has("npm-shrinkwrap.json") }
  }
  if (files.has("pnpm-lock.yaml")) return { pm: "pnpm", locked: true }
  if (files.has("yarn.lock")) return { pm: berryMarker ? "yarn-berry" : "yarn", locked: true }
  if (files.has("bun.lock") || files.has("bun.lockb")) return { pm: "bun", locked: true }
  return { pm: "npm", locked: files.has("package-lock.json") || files.has("npm-shrinkwrap.json") }
}

/** Corepack shims + caches inside the work tree so offline test runs find the same pnpm/yarn. */
const COREPACK_PREFIX =
  "export COREPACK_HOME=/work/.oss-scout-corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0 " +
  "YARN_GLOBAL_FOLDER=/work/.oss-scout-yarn YARN_ENABLE_TELEMETRY=0 && " +
  "corepack enable --install-directory /tmp/corepack && export PATH=/tmp/corepack:$PATH && "

function nodeInstall(pm: NodePm, locked: boolean): string {
  switch (pm) {
    case "npm":
      return locked ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund --no-package-lock"
    case "pnpm":
      return (
        COREPACK_PREFIX +
        `pnpm install ${locked ? "--frozen-lockfile" : "--no-lockfile"} --store-dir /work/.oss-scout-pnpm-store`
      )
    case "yarn":
      return COREPACK_PREFIX + `yarn install ${locked ? "--frozen-lockfile" : "--no-lockfile"} --non-interactive`
    case "yarn-berry":
      return COREPACK_PREFIX + (locked ? "yarn install --immutable" : "yarn install")
    case "bun":
      return locked ? "bun install --frozen-lockfile" : "bun install --no-save"
  }
}

function nodeRun(pm: NodePm, script: string): string {
  switch (pm) {
    case "npm":
      return script === "test" ? "npm test" : `npm run ${script}`
    case "pnpm":
      return COREPACK_PREFIX + `pnpm run ${script}`
    case "yarn":
    case "yarn-berry":
      return COREPACK_PREFIX + `yarn run ${script}`
    case "bun":
      return `bun run ${script}`
  }
}

function detectNode(files: Set<string>, readFile: ReadFile, config: OssScoutConfig): ProjectInfo {
  const notes: string[] = []
  const pkg = parseJson(readFile("package.json"))
  if (!pkg) notes.push("package.json could not be parsed")
  const { pm, locked } = detectNodePm(pkg, files)
  if (!locked) notes.push(`no lockfile for ${pm}: dependency versions are not pinned`)
  const scripts = pkg?.scripts ?? {}
  const testScript = typeof scripts.test === "string" ? scripts.test : null
  const hasTest = testScript !== null && !NPM_PLACEHOLDER_TEST.test(testScript) && testScript.trim().length > 0
  if (!hasTest) notes.push(testScript ? "scripts.test is npm's placeholder" : "no scripts.test in package.json")
  const hasLint = typeof scripts.lint === "string" && scripts.lint.trim().length > 0

  let image = config.sandbox.images.node
  if (pm === "bun") image = "oven/bun:1"
  else {
    const engines = typeof pkg?.engines?.node === "string" ? pkg.engines.node : null
    const pick = engines ? nodeImageForEngines(engines, config.sandbox.images.node) : null
    if (pick && pick.image !== image) {
      image = pick.image
      notes.push(`engines.node "${engines}" → ${image}`)
    } else if (pick?.note) notes.push(pick.note)
  }
  if ((pm === "pnpm" || pm === "yarn" || pm === "yarn-berry") && (imageNodeMajor(image) ?? 0) >= 25) {
    notes.push("corepack is not bundled with Node >= 25 images; pnpm/yarn commands may fail")
  }
  return {
    ecosystem: "node",
    packageManager: pm === "yarn-berry" ? "yarn" : pm,
    image,
    install: nodeInstall(pm, locked),
    test: hasTest ? nodeRun(pm, "test") : null,
    lint: hasLint ? nodeRun(pm, "lint") : null,
    testFilePatterns: TEST_FILE_PATTERNS.node,
    notes,
  }
}

/** Major version in a "node:22-bookworm"-style tag, or null. */
export function imageNodeMajor(image: string): number | null {
  const m = /^(?:[\w.-]+\/)*node:(\d+)(?:[.-]|$)/.exec(image)
  return m ? Number(m[1]) : null
}

const NODE_MAJORS = [26, 25, 24, 23, 22, 21, 20, 19, 18]

/**
 * Pick an image for `engines.node`. Keeps the configured image when its major satisfies the
 * range; otherwise picks the newest major ≥ 18 that does (node:<major>-bookworm).
 */
export function nodeImageForEngines(range: string, configured: string): { image: string; note: string | null } {
  const current = imageNodeMajor(configured)
  if (current !== null && majorSatisfies(range, current)) return { image: configured, note: null }
  const best = NODE_MAJORS.find((m) => majorSatisfies(range, m))
  if (best === undefined) {
    return { image: configured, note: `engines.node "${range}" not satisfiable with Node >= 18; using ${configured}` }
  }
  if (current === null && !/^\s*[\^~=v]?\s*\d+(\.(\d+|x|\*))?(\.(\d+|x|\*))?\s*$/.test(range)) {
    // Custom image with unknown major and no explicit pin: trust the configured image.
    return { image: configured, note: null }
  }
  return { image: `node:${best}-bookworm`, note: null }
}

/** Does some version with major `major` satisfy the semver range? (major-level approximation) */
export function majorSatisfies(range: string, major: number): boolean {
  const groups = range.split("||").map((g) => g.trim())
  return groups.some((g) => groupSatisfies(g, major))
}

function groupSatisfies(group: string, major: number): boolean {
  if (group === "" || group === "*" || /^x$/i.test(group) || group === "latest") return true
  const hyphen = /^v?(\S+)\s+-\s+v?(\S+)$/.exec(group)
  if (hyphen) return comparatorOk(">=", hyphen[1]!, major) && comparatorOk("<=", hyphen[2]!, major)
  const tokens = group.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean)
  return tokens.every((t) => {
    const m = /^(>=|<=|>|<|=|\^|~)?v?(.*)$/.exec(t)
    return m ? comparatorOk(m[1] ?? "=", m[2]!, major) : true
  })
}

function comparatorOk(op: string, version: string, major: number): boolean {
  const parts = version.split(".")
  const head = parts[0] ?? ""
  if (head === "" || head === "*" || /^x$/i.test(head)) return true
  const n = Number.parseInt(head, 10)
  if (!Number.isFinite(n)) return true
  const rest = parts.slice(1).some((p) => /^\d+$/.test(p) && Number(p) > 0)
  switch (op) {
    case ">=":
      return major >= n
    case ">":
      return rest || parts.length > 1 ? major >= n : major > n
    case "<":
      return rest ? major <= n : major < n
    case "<=":
      return major <= n
    default:
      return major === n
  }
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PY_REQUIREMENT_FILES = [
  "requirements.txt",
  "requirements-dev.txt",
  "requirements_dev.txt",
  "requirements-test.txt",
  "requirements_test.txt",
  "requirements-tests.txt",
  "test-requirements.txt",
  "dev-requirements.txt",
  "requirements/dev.txt",
  "requirements/test.txt",
  "requirements/tests.txt",
]
const PY_TEST_GROUPS = ["test", "tests", "testing", "dev"]

/** Keys of a TOML table like `[project.optional-dependencies]` (simple line-based scan). */
export function tomlTableKeys(toml: string, table: string): string[] {
  const keys: string[] = []
  let inTable = false
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim()
    const header = /^\[([^\]]+)\]\s*(#.*)?$/.exec(line)
    if (header && !line.startsWith("[[")) {
      inTable = header[1]!.trim() === table
      continue
    }
    if (line.startsWith("[[")) {
      inTable = false
      continue
    }
    if (!inTable) continue
    const key = /^"?([A-Za-z0-9_.-]+)"?\s*=/.exec(line)
    if (key) keys.push(key[1]!)
  }
  return keys
}

function hasTomlTable(toml: string, table: string): boolean {
  const esc = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^\\s*\\[${esc}\\]`, "m").test(toml)
}

function detectPython(files: Set<string>, readFile: ReadFile, config: OssScoutConfig): ProjectInfo {
  const notes: string[] = []
  const pyproject = files.has("pyproject.toml") ? (readFile("pyproject.toml") ?? "") : ""
  const setupCfg = files.has("setup.cfg") ? (readFile("setup.cfg") ?? "") : ""
  const toxIni = files.has("tox.ini") ? (readFile("tox.ini") ?? "") : ""
  const setupPy = files.has("setup.py") ? (readFile("setup.py") ?? "") : ""
  const installable = files.has("pyproject.toml") || files.has("setup.py") || files.has("setup.cfg")
  const isPoetry = hasTomlTable(pyproject, "tool.poetry") && files.has("poetry.lock")
  const isUv = files.has("uv.lock") && installable
  let pm = "pip"

  // --copies: the venv's interpreter is a copy, not an absolute link to /usr/local/bin/python. Links
  // that resolve outside the work tree are removed after every sandbox run (hygiene.ts), because on
  // the host they would point at host files the agent's file tools could follow.
  const steps = [`python -m venv --copies ${VENV}`, ACTIVATE, "python -m pip install -q -U pip"]
  if (isPoetry) {
    pm = "poetry"
    const groups = [...pyproject.matchAll(/^\s*\[tool\.poetry\.group\.([A-Za-z0-9_-]+)\.dependencies\]/gm)]
      .map((m) => m[1]!)
      .filter((g) => PY_TEST_GROUPS.includes(g))
    steps.push(
      "pip install -q poetry",
      `POETRY_VIRTUALENVS_CREATE=false poetry install --no-interaction${groups.length ? ` --with ${groups.join(",")}` : ""}`,
    )
  } else if (isUv) {
    pm = "uv"
    steps.push("pip install -q uv", `UV_PROJECT_ENVIRONMENT=${VENV} UV_PYTHON_DOWNLOADS=never uv sync --frozen --inexact --all-extras`)
  } else if (installable) {
    const extras = [
      ...tomlTableKeys(pyproject, "project.optional-dependencies"),
      ...[...setupPy.matchAll(/["'](test|tests|testing|dev)["']\s*:/g)].map((m) => m[1]!),
      ...tomlTableKeys(setupCfg.replace(/^\[options\.extras_require\]/m, "[extras]"), "extras"),
    ].filter((e, i, all) => PY_TEST_GROUPS.includes(e) && all.indexOf(e) === i)
    steps.push(extras.length ? `pip install -e '.[${extras.join(",")}]'` : "pip install -e .")
    const groups = tomlTableKeys(pyproject, "dependency-groups").filter((g) => PY_TEST_GROUPS.includes(g))
    for (const g of groups) steps.push(`pip install --group ${g}`)
    if (hasTomlTable(pyproject, "tool.pdm")) notes.push("pdm project: installed with pip (dev groups may be missing)")
    if (hasTomlTable(pyproject, "tool.hatch.envs.default") || hasTomlTable(pyproject, "tool.hatch.envs.test")) {
      notes.push("hatch environments are ignored; installed with pip")
    }
  }
  if (!isPoetry && !isUv) {
    for (const req of PY_REQUIREMENT_FILES) if (files.has(req)) steps.push(`pip install -r ${req}`)
  }

  const ruff =
    files.has("ruff.toml") || files.has(".ruff.toml") || hasTomlTable(pyproject, "tool.ruff") || /^\s*\[tool\.ruff\./m.test(pyproject)
  const flake8 = files.has(".flake8") || /^\s*\[flake8\]/m.test(setupCfg) || /^\s*\[flake8\]/m.test(toxIni)
  const hasPytestConfig =
    files.has("pytest.ini") ||
    hasTomlTable(pyproject, "tool.pytest.ini_options") ||
    /^\s*\[tool:pytest\]/m.test(setupCfg) ||
    /^\s*\[pytest\]/m.test(toxIni)
  const hasTests = [...files].some((f) => /(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/.test(f) || /(^|\/)tests?\/[^/]+\.py$/.test(f))

  steps.push("(python -m pytest --version >/dev/null 2>&1 || pip install -q pytest)")
  if (ruff) steps.push("(command -v ruff >/dev/null 2>&1 || pip install -q ruff)")
  else if (flake8) steps.push("(command -v flake8 >/dev/null 2>&1 || pip install -q flake8)")
  if (files.has("tox.ini") || files.has("noxfile.py")) notes.push("tox/nox configuration ignored; pytest runs directly")

  const test = hasPytestConfig || hasTests ? `${ACTIVATE} && python -m pytest -q -x` : null
  if (!test) notes.push("no pytest configuration or test files found")
  const lint = ruff
    ? `${ACTIVATE} && ruff check . --extend-exclude ${VENV}`
    : flake8
      ? `${ACTIVATE} && flake8 --extend-exclude ${VENV}`
      : null
  return {
    ecosystem: "python",
    packageManager: pm,
    image: config.sandbox.images.python,
    install: steps.join(" && "),
    test,
    lint,
    testFilePatterns: TEST_FILE_PATTERNS.python,
    notes,
  }
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

function detectMaven(files: Set<string>, config: OssScoutConfig): ProjectInfo {
  const wrapper = files.has("mvnw")
  // MAVEN_CONFIG from the official image would be passed to mvn as an argument; the wrapper keeps
  // its Maven distribution inside the work tree so offline runs find it.
  const prefix = `unset MAVEN_CONFIG; export MAVEN_USER_HOME=/work/.oss-scout-mvnw MAVEN_OPTS="-Duser.home=/tmp/home"; `
  const mvn = wrapper ? "sh ./mvnw" : "mvn"
  const repo = "-Dmaven.repo.local=.oss-scout-m2"
  return {
    ecosystem: "java-maven",
    packageManager: wrapper ? "mvnw" : "maven",
    image: config.sandbox.images.maven,
    install:
      prefix +
      `${mvn} -B -ntp ${repo} -DskipTests dependency:go-offline test-compile && ` +
      // Resolve surefire providers too (go-offline misses them) without running any test.
      `(${mvn} -B -ntp -q ${repo} test -Dtest=OssScoutNoSuchTest -Dsurefire.failIfNoSpecifiedTests=false -DfailIfNoTests=false >/dev/null 2>&1 || true)`,
    test: prefix + `${mvn} -B -ntp -o ${repo} test`,
    lint: null,
    testFilePatterns: TEST_FILE_PATTERNS["java-maven"],
    notes: wrapper ? [] : ["no Maven wrapper; using the image's mvn"],
  }
}

function detectGradle(files: Set<string>, config: OssScoutConfig): ProjectInfo {
  const wrapper = files.has("gradlew")
  const g = `${wrapper ? "sh ./gradlew" : "gradle"} --no-daemon -g .oss-scout-gradle`
  return {
    ecosystem: "java-gradle",
    packageManager: wrapper ? "gradlew" : "gradle",
    image: config.sandbox.images.gradle,
    install:
      `${g} testClasses && ` +
      // Resolve test runtime deps (engines/launchers) for the offline test run; best effort.
      `(${g} -q dependencies --configuration testRuntimeClasspath >/dev/null 2>&1 || true)`,
    test: `${g} --offline test`,
    lint: null,
    testFilePatterns: TEST_FILE_PATTERNS["java-gradle"],
    notes: wrapper ? [] : ["no Gradle wrapper; using the image's gradle"],
  }
}

// ---------------------------------------------------------------------------
// Overrides / helpers
// ---------------------------------------------------------------------------

function applyOverrides(project: ProjectInfo, repo: string, config: OssScoutConfig): ProjectInfo {
  const overrides = config.implementation.overrides
  const key = Object.keys(overrides).find((k) => k.toLowerCase() === repo.toLowerCase())
  const o = key ? overrides[key] : undefined
  if (!o) return project
  const out = { ...project, notes: [...project.notes] }
  const applied: string[] = []
  if (o.install !== undefined) {
    out.install = o.install
    applied.push("install")
  }
  if (o.test !== undefined) {
    out.test = o.test
    applied.push("test")
  }
  if (o.lint !== undefined) {
    out.lint = o.lint
    applied.push("lint")
  }
  if (o.image !== undefined) {
    out.image = o.image
    applied.push("image")
  }
  if (applied.length) out.notes.push(`config override applied (${applied.join(", ")})`)
  return out
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "")
}

const CONVENTIONAL_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?!?: \S/

/** Conventional Commits if most recent subjects match `type(scope)!: subject`. */
export function detectCommitConvention(subjects: string[]): CommitConvention {
  const list = subjects.map((s) => s.trim()).filter((s) => s.length > 0)
  if (list.length < 5) return "unknown"
  const matches = list.filter((s) => CONVENTIONAL_RE.test(s)).length
  return matches / list.length >= 0.6 ? "conventional" : "none"
}

const patternCache = new Map<string, RegExp | null>()

function compile(pattern: string): RegExp | null {
  if (!patternCache.has(pattern)) {
    try {
      patternCache.set(pattern, new RegExp(pattern))
    } catch {
      patternCache.set(pattern, null)
    }
  }
  return patternCache.get(pattern) ?? null
}

/** true if `path` looks like a test file for this project. */
export function isTestFile(path: string, project: ProjectInfo): boolean {
  const p = normalizePath(path)
  const patterns = project.testFilePatterns.length ? project.testFilePatterns : TEST_FILE_PATTERNS.unknown
  return patterns.some((pat) => compile(pat)?.test(p) ?? false)
}
