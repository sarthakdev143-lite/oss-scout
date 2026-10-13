/**
 * Dependency-manifest parsers used by discovery. Regex / line based (no parser dependencies),
 * forgiving, and never throwing: malformed input yields whatever could be parsed.
 *
 * Only registry dependencies are reported. Local paths, workspace links, VCS/URL references and
 * unresolved placeholders are skipped, because they do not name a published package.
 */

export type PackageEcosystem = "npm" | "pypi" | "maven"

export interface DependencyRef {
  ecosystem: PackageEcosystem
  /** npm: package name (incl. scope); pypi: PEP 503-normalized name; maven: "groupId:artifactId". */
  name: string
  /** Path of the manifest inside the user's repo. */
  manifestPath: string
  /** devDependencies / test scope / dev groups. */
  dev: boolean
}

/** File basenames recognized as manifests. */
export const MANIFEST_FILENAMES: readonly string[] = Object.freeze([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "libs.versions.toml",
])

type ManifestKind = "npm" | "requirements" | "pyproject" | "pom" | "gradle" | "catalog"

const REQUIREMENTS_FILE = /^(?:requirements[\w.-]*|[\w.-]*[-_]requirements)\.txt$/i
const VERSION_CATALOG = /(?:^|\/)gradle\/[\w-]+\.versions\.toml$/i

function normPath(p: string): string {
  return p.replace(/\\/g, "/")
}

function baseName(p: string): string {
  const s = normPath(p)
  return s.slice(s.lastIndexOf("/") + 1)
}

function manifestKind(path: string): ManifestKind | null {
  const p = normPath(path)
  const base = baseName(p)
  switch (base) {
    case "package.json":
      return "npm"
    case "pyproject.toml":
      return "pyproject"
    case "pom.xml":
      return "pom"
    case "build.gradle":
    case "build.gradle.kts":
      return "gradle"
  }
  if (REQUIREMENTS_FILE.test(base)) return "requirements"
  if (/\.txt$/i.test(base) && /(?:^|\/)requirements\/[^/]+$/i.test(p)) return "requirements"
  if (VERSION_CATALOG.test(p) || base === "libs.versions.toml") return "catalog"
  return null
}

/** true for paths whose basename is a recognized manifest (incl. requirements*.txt). */
export function isManifestPath(path: string): boolean {
  return manifestKind(path) !== null
}

/** Dispatch on the file name. Never throws on malformed input: returns what it can parse. */
export function parseManifest(path: string, text: string): DependencyRef[] {
  try {
    switch (manifestKind(path)) {
      case "npm":
        return parsePackageJson(text, path)
      case "requirements":
        return parseRequirementsTxt(text, path)
      case "pyproject":
        return parsePyprojectToml(text, path)
      case "pom":
        return parsePomXml(text, path)
      case "gradle":
      case "catalog":
        return parseGradle(text, path)
      default:
        return []
    }
  } catch {
    return []
  }
}

/**
 * The package a manifest itself publishes ("name" in package.json, [project].name, Maven
 * groupId:artifactId). Discovery uses it to ignore your own internal packages. Never throws.
 */
export function declaredPackageName(path: string, text: string): { ecosystem: PackageEcosystem; name: string } | null {
  try {
    switch (manifestKind(path)) {
      case "npm": {
        const name = parseJsonObject(text)?.name
        return typeof name === "string" && isNpmName(name) ? { ecosystem: "npm", name } : null
      }
      case "pyproject": {
        const doc = parseToml(text)
        const raw = asRecord(doc.project)?.name ?? asRecord(asRecord(asRecord(doc.tool)?.poetry))?.name
        const name = typeof raw === "string" ? pep508Name(raw) : null
        return name ? { ecosystem: "pypi", name } : null
      }
      case "pom": {
        const id = pomIdentity(prepareXml(text))
        return id.groupId && id.artifactId && MAVEN_ID.test(id.groupId) && MAVEN_ID.test(id.artifactId)
          ? { ecosystem: "maven", name: `${id.groupId}:${id.artifactId}` }
          : null
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return isRecord(v) ? v : null
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function entriesOf(v: unknown): Array<[string, unknown]> {
  return isRecord(v) ? Object.entries(v) : []
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Keep one entry per (ecosystem, name, manifest); a runtime occurrence wins over a dev one. */
export function dedupeDeps(deps: DependencyRef[]): DependencyRef[] {
  const byKey = new Map<string, DependencyRef>()
  for (const d of deps) {
    const key = `${d.ecosystem}\u0000${d.name}\u0000${d.manifestPath}`
    const prev = byKey.get(key)
    if (!prev) byKey.set(key, d)
    else if (prev.dev && !d.dev) byKey.set(key, { ...prev, dev: false })
  }
  return [...byKey.values()]
}

const DEV_TOKENS = new Set([
  "dev",
  "devel",
  "develop",
  "development",
  "test",
  "tests",
  "testing",
  "lint",
  "linting",
  "linter",
  "doc",
  "docs",
  "documentation",
  "ci",
  "typing",
  "types",
  "typecheck",
  "mypy",
  "style",
  "format",
  "formatting",
  "qa",
  "check",
  "checks",
  "bench",
  "benchmark",
  "benchmarks",
  "coverage",
  "cov",
  "e2e",
  "perf",
])

/** Group / extra / file names that denote development-only dependencies ("dev", "test", "docs", …). */
export function isDevGroupName(name: string): boolean {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((t) => DEV_TOKENS.has(t))
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

const NPM_NAME = /^(?:@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i
const NPM_SECTIONS: ReadonlyArray<readonly [string, boolean]> = [
  ["dependencies", false],
  ["optionalDependencies", false],
  ["peerDependencies", false],
  ["devDependencies", true],
]

function isNpmName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && NPM_NAME.test(name)
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(stripBom(text)))
  } catch {
    return null
  }
}

/**
 * The registry package a dependency entry refers to, or null for non-registry specs
 * (workspace:, file:, link:, portal:, git URLs, GitHub shorthands, tarball URLs, paths).
 * `npm:` aliases resolve to the real package; `catalog:` keeps the key.
 */
export function npmRegistryName(key: string, spec: unknown): string | null {
  if (typeof spec !== "string") return null
  const s = spec.trim()
  const alias = /^npm:(.+)$/i.exec(s)
  if (alias) {
    const target = alias[1]!.trim()
    const at = target.indexOf("@", 1)
    const real = at === -1 ? target : target.slice(0, at)
    return isNpmName(real) ? real : null
  }
  if (/^catalog:/i.test(s)) return isNpmName(key) ? key : null
  if (s.includes(":") || s.includes("/") || s.includes("\\") || s.startsWith(".")) return null
  return isNpmName(key) ? key : null
}

export function parsePackageJson(text: string, path: string): DependencyRef[] {
  const json = parseJsonObject(text)
  if (!json) return []
  const out: DependencyRef[] = []
  for (const [section, dev] of NPM_SECTIONS) {
    for (const [key, spec] of entriesOf(json[section])) {
      const name = npmRegistryName(key, spec)
      if (name) out.push({ ecosystem: "npm", name, manifestPath: path, dev })
    }
  }
  return dedupeDeps(out)
}

// ---------------------------------------------------------------------------
// Python (requirements.txt, pyproject.toml)
// ---------------------------------------------------------------------------

/** PEP 503 normalization: runs of "-", "_", "." become "-", lowercased. */
export function normalizePypiName(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase()
}

const PEP508 = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*([\s\S]*)$/

/**
 * Normalized project name of a PEP 508 requirement, or null for direct references
 * ("name @ url") and anything that does not look like a requirement.
 */
export function pep508Name(spec: string): string | null {
  const m = PEP508.exec(spec.trim())
  if (!m) return null
  const rest = m[2]!.trim()
  if (rest && !/^[(<>=!~;,]/.test(rest)) return null
  return normalizePypiName(m[1]!)
}

function isUrlOrPath(s: string): boolean {
  return (
    /^[A-Za-z][\w+.-]*:\/\//.test(s) ||
    /^(?:\.{1,2}(?:[/\\]|$)|[/\\~]|file:|[A-Za-z]:[/\\])/i.test(s) ||
    /\.(?:whl|tar\.gz|tgz|zip|tar\.bz2)$/i.test(s)
  )
}

function requirementsFileIsDev(path: string): boolean {
  const p = normPath(path).replace(/\.txt$/i, "")
  return isDevGroupName(p)
}

/**
 * requirements*.txt: joins "\" continuations, strips comments, ignores options (-r/-c includes,
 * -e editables, index flags) and per-requirement flags (--hash), skips VCS/URL/path lines and
 * direct references, strips extras/specifiers/markers and PEP 503-normalizes names.
 * Files named for dev/test/docs/lint (e.g. requirements-dev.txt, requirements/test.txt) are dev.
 */
export function parseRequirementsTxt(text: string, path: string): DependencyRef[] {
  const dev = requirementsFileIsDev(path)
  const out: DependencyRef[] = []
  const joined = stripBom(text).replace(/\\\r?\n/g, "")
  for (const raw of joined.split(/\r?\n/)) {
    let line = raw.replace(/(^|\s)#.*$/, "").trim()
    if (!line || line.startsWith("-")) continue
    const opt = line.search(/\s--[A-Za-z]/)
    if (opt !== -1) line = line.slice(0, opt).trim()
    if (!line || isUrlOrPath(line)) continue
    const name = pep508Name(line)
    if (name) out.push({ ecosystem: "pypi", name, manifestPath: path, dev })
  }
  return dedupeDeps(out)
}

/** A Poetry dependency value that refers to the package index (not git/path/url). */
function poetryRegistrySpec(spec: unknown): boolean {
  if (typeof spec === "string") return true
  if (Array.isArray(spec)) return spec.length > 0 && spec.every(poetryRegistrySpec)
  if (isRecord(spec)) return !("git" in spec || "path" in spec || "url" in spec)
  return false
}

/**
 * pyproject.toml: [project].dependencies, [project.optional-dependencies] (dev-ish extras → dev),
 * [dependency-groups] (dev), [tool.poetry.dependencies] (python skipped),
 * [tool.poetry.group.*.dependencies] and legacy [tool.poetry.dev-dependencies] (dev).
 */
export function parsePyprojectToml(text: string, path: string): DependencyRef[] {
  const doc = parseToml(text)
  const out: DependencyRef[] = []
  const addSpec = (spec: unknown, dev: boolean) => {
    if (typeof spec !== "string") return // e.g. {include-group = "x"}
    const name = pep508Name(spec)
    if (name) out.push({ ecosystem: "pypi", name, manifestPath: path, dev })
  }
  const addPoetry = (table: unknown, dev: boolean) => {
    for (const [key, spec] of entriesOf(table)) {
      if (key.toLowerCase() === "python" || !poetryRegistrySpec(spec)) continue
      const name = pep508Name(key)
      if (name) out.push({ ecosystem: "pypi", name, manifestPath: path, dev })
    }
  }

  const project = asRecord(doc.project)
  for (const spec of asArray(project?.dependencies)) addSpec(spec, false)
  for (const [extra, list] of entriesOf(project?.["optional-dependencies"])) {
    for (const spec of asArray(list)) addSpec(spec, isDevGroupName(extra))
  }
  for (const [, list] of entriesOf(doc["dependency-groups"])) {
    for (const spec of asArray(list)) addSpec(spec, true)
  }
  const poetry = asRecord(asRecord(doc.tool)?.poetry)
  addPoetry(poetry?.dependencies, false)
  addPoetry(poetry?.["dev-dependencies"], true)
  for (const [group, def] of entriesOf(poetry?.group)) {
    addPoetry(asRecord(def)?.dependencies, group.toLowerCase() !== "main")
  }
  return dedupeDeps(out)
}

// ---------------------------------------------------------------------------
// Maven (pom.xml)
// ---------------------------------------------------------------------------

const MAVEN_ID = /^[A-Za-z0-9_.-]+$/

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Text of the first `<name>` element without child elements (trimmed), or undefined. */
export function xmlTag(xml: string, name: string): string | undefined {
  const m = new RegExp(String.raw`<${escapeRe(name)}\b[^>]*>\s*([^<]*?)\s*</${escapeRe(name)}>`).exec(xml)
  return m ? m[1] : undefined
}

/** Inner XML of every `<name>…</name>` block (non-nested). */
export function xmlBlocks(xml: string, name: string): string[] {
  const re = new RegExp(String.raw`<${escapeRe(name)}\b[^>]*>([\s\S]*?)</${escapeRe(name)}>`, "g")
  return [...xml.matchAll(re)].map((m) => m[1]!)
}

export function removeXmlBlocks(xml: string, names: readonly string[]): string {
  let out = xml
  for (const n of names) {
    out = out.replace(new RegExp(String.raw`<${escapeRe(n)}\b[^>]*>[\s\S]*?</${escapeRe(n)}>`, "g"), "")
    out = out.replace(new RegExp(String.raw`<${escapeRe(n)}\b[^>]*/>`, "g"), "")
  }
  return out
}

/** Strip comments/CDATA and sections whose <dependency>/<groupId> are not project dependencies. */
function prepareXml(text: string): string {
  const xml = stripBom(text)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
  return removeXmlBlocks(xml, ["build", "reporting", "exclusions", "pluginRepositories", "distributionManagement"])
}

interface PomIdentity {
  /** Declared or inherited from <parent>. */
  groupId: string | undefined
  /** groupId written in this POM (not inherited). */
  ownGroupId: string | undefined
  artifactId: string | undefined
  version: string | undefined
  parent: { groupId: string | undefined; artifactId: string | undefined; version: string | undefined } | null
  props: Record<string, string>
}

function pomIdentity(xml: string): PomIdentity {
  const parentXml = xmlBlocks(xml, "parent")[0]
  const parent = parentXml
    ? { groupId: xmlTag(parentXml, "groupId"), artifactId: xmlTag(parentXml, "artifactId"), version: xmlTag(parentXml, "version") }
    : null
  const props: Record<string, string> = {}
  for (const block of xmlBlocks(xml, "properties")) {
    for (const m of block.matchAll(/<([A-Za-z0-9_.-]+)\b[^>]*>\s*([^<]*?)\s*<\/\1>/g)) props[m[1]!] = m[2]!
  }
  const top = removeXmlBlocks(xml, ["parent", "dependencyManagement", "dependencies", "profiles", "properties", "modules"])
  const ownGroupId = xmlTag(top, "groupId")
  return {
    groupId: ownGroupId ?? parent?.groupId,
    ownGroupId,
    artifactId: xmlTag(top, "artifactId"),
    version: xmlTag(top, "version") ?? parent?.version,
    parent,
    props,
  }
}

/** Replace ${x} from <properties> and project built-ins; unknown placeholders are left as-is. */
function interpolatePom(value: string, id: PomIdentity): string {
  const builtins: Record<string, string | undefined> = {
    "project.groupId": id.groupId,
    "pom.groupId": id.groupId,
    groupId: id.groupId,
    "project.artifactId": id.artifactId,
    "pom.artifactId": id.artifactId,
    artifactId: id.artifactId,
    "project.version": id.version,
    "pom.version": id.version,
    version: id.version,
    "project.parent.groupId": id.parent?.groupId,
    "project.parent.version": id.parent?.version,
  }
  let out = value
  for (let i = 0; i < 3 && out.includes("${"); i++) {
    out = out.replace(/\$\{([^}]+)\}/g, (whole, k: string) => id.props[k] ?? builtins[k] ?? whole)
  }
  return out
}

const SELF_GROUP_REF = /^\$\{(?:project\.|pom\.)?(?:parent\.)?groupId\}$/

/**
 * pom.xml: <dependencies> (incl. <dependencyManagement> and profiles) plus the <parent> POM.
 * Test scope → dev; system scope, sibling modules (${project.groupId} or your own groupId) and
 * unresolvable placeholders are skipped. Plugin dependencies and exclusions are ignored.
 */
export function parsePomXml(text: string, path: string): DependencyRef[] {
  const xml = prepareXml(text)
  const id = pomIdentity(xml)
  const out: DependencyRef[] = []
  const push = (g: string, a: string, dev: boolean) => {
    if (!MAVEN_ID.test(g) || !MAVEN_ID.test(a)) return
    if (id.ownGroupId && g === id.ownGroupId) return
    out.push({ ecosystem: "maven", name: `${g}:${a}`, manifestPath: path, dev })
  }

  if (id.parent?.groupId && id.parent.artifactId) {
    push(interpolatePom(id.parent.groupId, id), interpolatePom(id.parent.artifactId, id), false)
  }
  const managed = xmlBlocks(xml, "dependencyManagement").join("\n")
  const direct = removeXmlBlocks(xml, ["dependencyManagement"])
  for (const source of [managed, direct]) {
    for (const dep of xmlBlocks(source, "dependency")) {
      const rawGroup = xmlTag(dep, "groupId")
      const rawArtifact = xmlTag(dep, "artifactId")
      if (!rawGroup || !rawArtifact || SELF_GROUP_REF.test(rawGroup)) continue
      const scope = (xmlTag(dep, "scope") ?? "").toLowerCase()
      if (scope === "system") continue
      push(interpolatePom(rawGroup, id), interpolatePom(rawArtifact, id), scope === "test")
    }
  }
  return dedupeDeps(out)
}

// ---------------------------------------------------------------------------
// Gradle (build.gradle, build.gradle.kts, gradle/libs.versions.toml)
// ---------------------------------------------------------------------------

/** Standard and source-set-prefixed configuration names (implementation, testImplementation, jvmMainApi, kapt, …). */
const GRADLE_CONFIG = String.raw`(?:[a-z][A-Za-z0-9]*?)?(?:[Ii]mplementation|[Aa]pi|[Cc]ompileOnly(?:Api)?|[Rr]untimeOnly|[Aa]nnotationProcessor|[Kk]apt|[Kk]sp|[Cc]ompile|[Rr]untime)|classpath|developmentOnly`
const GRADLE_STRING = new RegExp(
  String.raw`\b(${GRADLE_CONFIG})\s*\(?\s*(?:(?:platform|enforcedPlatform)\s*\(\s*)?["']([A-Za-z0-9_.\-]+):([A-Za-z0-9_.\-]+)(?::[^"'\n]*)?["']`,
  "g",
)
const GRADLE_MAP = new RegExp(
  String.raw`\b(${GRADLE_CONFIG})\s*\(?\s*group\s*[:=]\s*["']([^"'\n]+)["']\s*,\s*name\s*[:=]\s*["']([^"'\n]+)["']`,
  "g",
)
const GRADLE_KOTLIN = new RegExp(String.raw`\b(${GRADLE_CONFIG})\s*\(\s*kotlin\s*\(\s*["']([A-Za-z0-9-]+)["']`, "g")

function gradleConfigIsDev(config: string): boolean {
  return /test/i.test(config) || config === "developmentOnly" || config === "classpath"
}

function stripGradleComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1")
}

/**
 * build.gradle / build.gradle.kts: "group:artifact[:version]" strings (Groovy and Kotlin DSL,
 * optionally inside platform()/enforcedPlatform()), map notation and kotlin("x") shorthands.
 * Test configurations, developmentOnly and buildscript classpath are dev. Catalog accessors
 * (libs.x) are covered by parsing gradle/libs.versions.toml, which this function also handles.
 */
export function parseGradle(text: string, path: string): DependencyRef[] {
  if (/\.toml$/i.test(path)) return parseVersionCatalog(text, path)
  const src = stripGradleComments(stripBom(text))
  const out: DependencyRef[] = []
  const push = (config: string, g: string, a: string) => {
    if (MAVEN_ID.test(g) && MAVEN_ID.test(a)) {
      out.push({ ecosystem: "maven", name: `${g}:${a}`, manifestPath: path, dev: gradleConfigIsDev(config) })
    }
  }
  for (const m of src.matchAll(GRADLE_STRING)) push(m[1]!, m[2]!, m[3]!)
  for (const m of src.matchAll(GRADLE_MAP)) push(m[1]!, m[2]!.trim(), m[3]!.trim())
  for (const m of src.matchAll(GRADLE_KOTLIN)) push(m[1]!, "org.jetbrains.kotlin", `kotlin-${m[2]!}`)
  return dedupeDeps(out)
}

/** gradle/libs.versions.toml [libraries]: "g:a:v", { module = "g:a" }, { group, name }. Scope is unknown → runtime. */
export function parseVersionCatalog(text: string, path: string): DependencyRef[] {
  const doc = parseToml(text)
  const out: DependencyRef[] = []
  for (const [, lib] of entriesOf(doc.libraries)) {
    let coords: [string | undefined, string | undefined] = [undefined, undefined]
    if (typeof lib === "string") {
      const [g, a] = lib.split(":")
      coords = [g, a]
    } else if (isRecord(lib)) {
      if (typeof lib.module === "string") {
        const [g, a] = lib.module.split(":")
        coords = [g, a]
      } else if (typeof lib.group === "string" && typeof lib.name === "string") {
        coords = [lib.group, lib.name]
      }
    }
    const [g, a] = coords
    if (g && a && MAVEN_ID.test(g.trim()) && MAVEN_ID.test(a.trim())) {
      out.push({ ecosystem: "maven", name: `${g.trim()}:${a.trim()}`, manifestPath: path, dev: false })
    }
  }
  return dedupeDeps(out)
}

// ---------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------

type TomlTable = Record<string, unknown>

/**
 * Parse TOML with Bun's built-in parser, falling back to `parseTomlLite` when it is
 * unavailable or rejects the document (Bun rejects date/time values). Never throws.
 */
export function parseToml(text: string): TomlTable {
  const bun = (globalThis as { Bun?: { TOML?: { parse(input: string): unknown } } }).Bun
  if (bun?.TOML) {
    try {
      const doc = bun.TOML.parse(stripBom(text))
      if (isRecord(doc)) return doc
    } catch {
      // Bun throws a BuildMessage (not an Error) on unsupported or malformed input.
    }
  }
  return parseTomlLite(text)
}

class TomlSyntaxError extends Error {}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])
const BARE_KEY = /[A-Za-z0-9_-]+/y
const ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" }

function unescapeBasic(raw: string): string {
  return raw.replace(/\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|\n\s*|(.))/g, (whole, u4?: string, u8?: string, ch?: string) => {
    const hex = u4 ?? u8
    if (hex) {
      const cp = parseInt(hex, 16)
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
    }
    if (ch === undefined) return "" // line-ending backslash
    return ESCAPES[ch] ?? whole
  })
}

function tableAt(root: TomlTable, keys: string[]): TomlTable {
  let cur = root
  for (const k of keys) {
    if (UNSAFE_KEYS.has(k)) throw new TomlSyntaxError(k)
    const next = cur[k]
    if (isRecord(next)) cur = next
    else if (Array.isArray(next) && isRecord(next[next.length - 1])) cur = next[next.length - 1] as TomlTable
    else {
      const created: TomlTable = {}
      cur[k] = created
      cur = created
    }
  }
  return cur
}

function appendArrayTable(root: TomlTable, keys: string[]): TomlTable {
  const parent = tableAt(root, keys.slice(0, -1))
  const last = keys[keys.length - 1]!
  if (UNSAFE_KEYS.has(last)) throw new TomlSyntaxError(last)
  const existing = parent[last]
  const list = Array.isArray(existing) ? existing : []
  const created: TomlTable = {}
  list.push(created)
  parent[last] = list
  return created
}

function setKey(table: TomlTable, keys: string[], value: unknown): void {
  const target = tableAt(table, keys.slice(0, -1))
  const last = keys[keys.length - 1]!
  if (UNSAFE_KEYS.has(last)) throw new TomlSyntaxError(last)
  target[last] = value
}

/**
 * Forgiving reader for the TOML subset manifests use: tables, arrays of tables, dotted and
 * quoted keys, strings (all four forms), multi-line arrays, inline tables, booleans and numbers.
 * Other scalars (dates, times) are kept as raw strings. Lines it cannot parse are skipped.
 */
export function parseTomlLite(text: string): TomlTable {
  const s = stripBom(text).replace(/\r\n?/g, "\n")
  const root: TomlTable = {}
  let table: TomlTable = root
  let i = 0

  const fail = (): never => {
    throw new TomlSyntaxError(`TOML syntax error at ${i}`)
  }
  const skipSpaces = () => {
    while (s[i] === " " || s[i] === "\t") i++
  }
  const skipComment = () => {
    if (s[i] === "#") while (i < s.length && s[i] !== "\n") i++
  }
  const skipBlank = () => {
    for (;;) {
      skipSpaces()
      skipComment()
      if (s[i] !== "\n") return
      i++
    }
  }
  const readString = (): string => {
    for (const delim of ['"""', "'''"]) {
      if (s.startsWith(delim, i)) {
        const end = s.indexOf(delim, i + 3)
        if (end < 0) fail()
        const raw = s.slice(i + 3, end).replace(/^\n/, "")
        i = end + 3
        return delim === '"""' ? unescapeBasic(raw) : raw
      }
    }
    const quote = s[i]!
    i++
    const start = i
    while (i < s.length && s[i] !== quote && s[i] !== "\n") i += quote === '"' && s[i] === "\\" ? 2 : 1
    if (s[i] !== quote) fail()
    const raw = s.slice(start, i)
    i++
    return quote === '"' ? unescapeBasic(raw) : raw
  }
  const readKey = (): string[] => {
    const parts: string[] = []
    for (;;) {
      skipSpaces()
      if (s[i] === '"' || s[i] === "'") parts.push(readString())
      else {
        BARE_KEY.lastIndex = i
        const m = BARE_KEY.exec(s)
        if (!m) fail()
        parts.push(m![0])
        i += m![0].length
      }
      skipSpaces()
      if (s[i] !== ".") return parts
      i++
    }
  }
  const readValue = (depth: number): unknown => {
    if (depth > 32) fail()
    skipSpaces()
    const c = s[i]
    if (c === '"' || c === "'") return readString()
    if (c === "[") {
      i++
      const list: unknown[] = []
      for (;;) {
        skipBlank()
        if (s[i] === "]") {
          i++
          return list
        }
        list.push(readValue(depth + 1))
        skipBlank()
        if (s[i] === ",") i++
        else if (s[i] === "]") {
          i++
          return list
        } else fail()
      }
    }
    if (c === "{") {
      i++
      const obj: TomlTable = {}
      for (;;) {
        skipBlank()
        if (s[i] === "}") {
          i++
          return obj
        }
        const keys = readKey()
        if (s[i] !== "=") fail()
        i++
        setKey(obj, keys, readValue(depth + 1))
        skipBlank()
        if (s[i] === ",") i++
        else if (s[i] === "}") {
          i++
          return obj
        } else fail()
      }
    }
    const start = i
    while (i < s.length && !",]}\n#".includes(s[i]!)) i++
    const raw = s.slice(start, i).trim()
    if (!raw) fail()
    if (raw === "true" || raw === "false") return raw === "true"
    if (/^[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ""))
    return raw
  }

  while (i < s.length) {
    try {
      skipBlank()
      if (i >= s.length) break
      if (s[i] === "[") {
        table = {} // orphan until the header parses, so a broken header never pollutes another table
        const isArray = s[i + 1] === "["
        i += isArray ? 2 : 1
        const keys = readKey()
        if (isArray ? !s.startsWith("]]", i) : s[i] !== "]") fail()
        i += isArray ? 2 : 1
        table = isArray ? appendArrayTable(root, keys) : tableAt(root, keys)
      } else {
        const keys = readKey()
        if (s[i] !== "=") fail()
        i++
        setKey(table, keys, readValue(0))
      }
      skipSpaces()
      skipComment()
      if (i < s.length && s[i] !== "\n") fail()
    } catch {
      while (i < s.length && s[i] !== "\n") i++
    }
  }
  return root
}
