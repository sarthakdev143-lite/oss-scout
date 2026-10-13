import type { DiffFileStat, DiffStat } from "../core/types.ts"

/** One line inside a hunk. `oldLine`/`newLine` are 1-based (0 when not applicable). */
export interface DiffLine {
  kind: "+" | "-" | " "
  text: string
  oldLine: number
  newLine: number
}

export interface DiffHunk {
  header: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface ParsedDiffFile {
  stat: DiffFileStat
  hunks: DiffHunk[]
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parse `git diff` (or plain unified diff) output into per-file stats and hunks. Handles
 * new/deleted/renamed/copied files, binary files, mode changes and quoted paths. Pure.
 */
export function parseDiffFiles(diff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = []
  let cur: ParsedDiffFile | null = null
  let fromGitHeader = false
  let inBinaryPatch = false
  let hunk: DiffHunk | null = null
  let oldLeft = 0
  let newLeft = 0
  let oldNo = 0
  let newNo = 0
  let oldMode: string | null = null
  const lines = diff.split("\n")

  const startFile = (oldPath: string, newPath: string, git: boolean): ParsedDiffFile => {
    const file: ParsedDiffFile = {
      stat: { path: newPath, oldPath: null, additions: 0, deletions: 0, binary: false, status: "modified", modeChange: null },
      hunks: [],
    }
    if (oldPath !== newPath && !git) file.stat.oldPath = oldPath
    files.push(file)
    fromGitHeader = git
    inBinaryPatch = false
    hunk = null
    oldLeft = newLeft = 0
    oldMode = null
    return file
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!

    if (cur && hunk && (oldLeft > 0 || newLeft > 0)) {
      const c = raw[0]
      if (c === "+" && newLeft > 0) {
        hunk.lines.push({ kind: "+", text: raw.slice(1), oldLine: 0, newLine: newNo++ })
        cur.stat.additions++
        newLeft--
        continue
      }
      if (c === "-" && oldLeft > 0) {
        hunk.lines.push({ kind: "-", text: raw.slice(1), oldLine: oldNo++, newLine: 0 })
        cur.stat.deletions++
        oldLeft--
        continue
      }
      if ((c === " " || raw === "" || raw === "\r") && oldLeft > 0 && newLeft > 0) {
        hunk.lines.push({ kind: " ", text: raw.slice(1), oldLine: oldNo++, newLine: newNo++ })
        oldLeft--
        newLeft--
        continue
      }
      if (c === "\\") continue
      // Malformed hunk (counts did not match): fall through and treat the line as a header.
      hunk = null
      oldLeft = newLeft = 0
    }

    if (raw.startsWith("\\")) continue // "\ No newline at end of file"
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw

    if (line.startsWith("diff --git ")) {
      const [a, b] = parseGitHeaderPaths(line.slice("diff --git ".length))
      cur = startFile(a, b, true)
      continue
    }

    // Plain unified diff without git headers: "--- a" followed by "+++ b" starts a file.
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ") && (!cur || !fromGitHeader || cur.hunks.length > 0)) {
      const a = headerPath(line.slice(4))
      const b = headerPath(lines[i + 1]!.replace(/\r$/, "").slice(4))
      cur = startFile(stripPrefix(a, "a/"), stripPrefix(b, "b/"), false)
      if (a === "/dev/null") {
        cur.stat.status = "added"
        cur.stat.path = stripPrefix(b, "b/")
        cur.stat.oldPath = null
      } else if (b === "/dev/null") {
        cur.stat.status = "deleted"
        cur.stat.path = stripPrefix(a, "a/")
        cur.stat.oldPath = null
      } else if (cur.stat.oldPath) {
        cur.stat.status = "renamed"
      }
      i++
      continue
    }

    if (!cur) continue
    if (inBinaryPatch) continue

    const m = HUNK_RE.exec(line)
    if (m) {
      oldNo = Number(m[1])
      newNo = Number(m[3])
      oldLeft = m[2] === undefined ? 1 : Number(m[2])
      newLeft = m[4] === undefined ? 1 : Number(m[4])
      hunk = { header: line, oldStart: oldNo, newStart: newNo, lines: [] }
      cur.hunks.push(hunk)
      continue
    }
    if (cur.hunks.length > 0) continue

    applyExtendedHeader(cur.stat, line, {
      getOldMode: () => oldMode,
      setOldMode: (v) => {
        oldMode = v
      },
      startBinaryPatch: () => {
        inBinaryPatch = true
      },
    })
  }
  return files
}

function applyExtendedHeader(
  stat: DiffFileStat,
  line: string,
  state: { getOldMode(): string | null; setOldMode(v: string): void; startBinaryPatch(): void },
): void {
  let m: RegExpExecArray | null
  if ((m = /^new file mode (\d+)/.exec(line))) {
    stat.status = "added"
    stat.modeChange = modeKind(m[1]!) ?? stat.modeChange
  } else if ((m = /^deleted file mode (\d+)/.exec(line))) {
    stat.status = "deleted"
    const kind = modeKind(m[1]!)
    stat.modeChange = kind === "symlink" || kind === "submodule" ? kind : stat.modeChange
  } else if ((m = /^old mode (\d+)/.exec(line))) {
    state.setOldMode(m[1]!)
  } else if ((m = /^new mode (\d+)/.exec(line))) {
    stat.modeChange = describeModeChange(state.getOldMode() ?? "", m[1]!)
  } else if (line.startsWith("rename from ")) {
    stat.oldPath = unquote(line.slice("rename from ".length))
    stat.status = "renamed"
  } else if (line.startsWith("rename to ")) {
    stat.path = unquote(line.slice("rename to ".length))
    stat.status = "renamed"
  } else if (line.startsWith("copy from ")) {
    stat.oldPath = unquote(line.slice("copy from ".length))
    stat.status = "added"
  } else if (line.startsWith("copy to ")) {
    stat.path = unquote(line.slice("copy to ".length))
    stat.status = "added"
  } else if (/^Binary files .* differ$/.test(line)) {
    stat.binary = true
  } else if (line === "GIT binary patch") {
    stat.binary = true
    state.startBinaryPatch()
  } else if (line.startsWith("--- ")) {
    const p = headerPath(line.slice(4))
    if (p === "/dev/null") stat.status = stat.status === "modified" ? "added" : stat.status
  } else if (line.startsWith("+++ ")) {
    const p = headerPath(line.slice(4))
    if (p === "/dev/null") stat.status = "deleted"
    else if (stat.status !== "renamed" && stat.status !== "deleted") stat.path = stripPrefix(p, "b/")
  }
}

/** Mode → kind: 120000 symlink, 160000 submodule (gitlink), 100755 executable. */
function modeKind(mode: string): string | null {
  if (mode === "120000") return "symlink"
  if (mode === "160000") return "submodule"
  if (mode === "100755") return "executable"
  return null
}

function describeModeChange(oldMode: string, newMode: string): string {
  const kinds = [modeKind(oldMode), modeKind(newMode)]
  for (const k of ["symlink", "submodule", "executable"]) if (kinds.includes(k)) return k
  return `${oldMode || "?"}->${newMode}`
}

/** Path from a "---"/"+++" line: unquoted, without the trailing tab (+ timestamp) git adds. */
function headerPath(s: string): string {
  const trimmed = s.startsWith('"') ? s : s.split("\t")[0]!
  return unquote(trimmed.trim())
}

function stripPrefix(p: string, prefix: string): string {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p
}

/** Split the "a/x b/y" part of a `diff --git` header (handles quoted paths and spaces). */
function parseGitHeaderPaths(rest: string): [string, string] {
  if (rest.startsWith('"')) {
    const end = closingQuote(rest, 0)
    const a = unquote(rest.slice(0, end + 1))
    const b = unquote(rest.slice(end + 2))
    return [stripPrefix(a, "a/"), stripPrefix(b, "b/")]
  }
  const quotedB = rest.indexOf(' "b/')
  if (quotedB !== -1) return [stripPrefix(rest.slice(0, quotedB), "a/"), stripPrefix(unquote(rest.slice(quotedB + 1)), "b/")]
  // Same path on both sides (the common case, also with spaces): "a/<p> b/<p>".
  if (rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2
    const left = rest.slice(0, half)
    const right = rest.slice(half + 1)
    if (rest[half] === " " && left.startsWith("a/") && right.startsWith("b/") && left.slice(2) === right.slice(2)) {
      return [left.slice(2), right.slice(2)]
    }
  }
  const idx = rest.lastIndexOf(" b/")
  if (idx === -1) {
    const sp = rest.indexOf(" ")
    return sp === -1 ? [rest, rest] : [rest.slice(0, sp), rest.slice(sp + 1)]
  }
  return [stripPrefix(rest.slice(0, idx), "a/"), rest.slice(idx + 3)]
}

function closingQuote(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === "\\") i++
    else if (s[i] === '"') return i
  }
  return s.length - 1
}

const ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 }
const utf8 = new TextEncoder()

/** Undo git's C-style path quoting ("caf\303\251.txt" → "café.txt"). */
export function unquote(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s
  const bytes: number[] = []
  const body = s.slice(1, -1)
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch !== "\\") {
      bytes.push(...utf8.encode(ch))
      continue
    }
    const next = body[i + 1] ?? ""
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4))
    if (oct) {
      bytes.push(parseInt(oct[0], 8))
      i += 3
    } else if (next in ESCAPES) {
      bytes.push(ESCAPES[next]!)
      i++
    } else {
      bytes.push(92)
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** Parse `git diff` unified output (incl. new/deleted/renamed/binary/mode changes) into stats. Pure. */
export function parseUnifiedDiff(diff: string): DiffStat {
  const files = parseDiffFiles(diff).map((f) => f.stat)
  return {
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  }
}

/** Added lines per file (without the leading "+"), for scanners. Pure. */
export function addedLines(diff: string): Array<{ file: string; line: number; text: string }> {
  const out: Array<{ file: string; line: number; text: string }> = []
  for (const f of parseDiffFiles(diff)) {
    if (f.stat.binary) continue
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind === "+") out.push({ file: f.stat.path, line: l.newLine, text: l.text.replace(/\r$/, "") })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Unrelated-change detection
// ---------------------------------------------------------------------------

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "poetry.lock",
  "pipfile.lock",
  "pdm.lock",
  "uv.lock",
  "pixi.lock",
  "conda-lock.yml",
  "cargo.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "gradle.lockfile",
  "packages.lock.json",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
  "podfile.lock",
])

const CI_FILES = new Set([
  ".gitlab-ci.yml",
  ".travis.yml",
  "appveyor.yml",
  ".appveyor.yml",
  "azure-pipelines.yml",
  "jenkinsfile",
  "bitbucket-pipelines.yml",
  ".drone.yml",
  ".cirrus.yml",
  "codecov.yml",
  ".codecov.yml",
  "renovate.json",
  ".renovaterc",
  ".renovaterc.json",
])

const CI_DIRS = [".circleci/", ".buildkite/", ".azure-pipelines/", ".gitlab/"]

const GENERATED_DIRS = new Set([
  "vendor",
  "node_modules",
  "bower_components",
  "dist",
  "build",
  "generated",
  "__generated__",
  "third_party",
  "third-party",
])

const LICENSE_RE = /^(licen[cs]e|copying|copyright|unlicense|notice)(\.(md|txt|rst|markdown))?$|^licen[cs]e-(mit|apache[\w.-]*|bsd[\w.-]*|gpl[\w.-]*)$/i

/** Files where leading indentation is syntax, so a re-indent is a real change. */
const INDENT_SENSITIVE = /\.(py|pyi|ya?ml|coffee|pug|jade|haml|sass|styl|slim|nim|mk)$|(^|\/)(gnu)?makefile$/i

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1)
}

/** Why a path is probably unrelated to a minimal fix, or null. */
export function classifyUnrelatedPath(path: string): string | null {
  const p = path.replace(/\\/g, "/")
  const lower = p.toLowerCase()
  const base = basename(lower)
  if (LOCKFILES.has(base)) return "lockfile changed"
  if (base === ".gitmodules") return "git submodule configuration changed"
  if (lower.startsWith(".github/")) {
    const isTemplate = /(^|\/)(issue_template|pull_request_template|discussion_template)(\/|\.md$)/.test(lower)
    if (lower.startsWith(".github/workflows/") || lower.startsWith(".github/actions/")) return "CI workflow changed"
    if (!isTemplate && !lower.endsWith(".md")) return "repository meta file under .github changed"
    return null
  }
  if (CI_FILES.has(base) && !p.includes("/")) return "CI configuration changed"
  if (base === "jenkinsfile") return "CI configuration changed"
  if (CI_DIRS.some((d) => lower.startsWith(d)) && !lower.endsWith(".md")) return "CI configuration changed"
  if (LICENSE_RE.test(base)) return "license file changed"
  const dirs = lower.split("/").slice(0, -1)
  const gen = dirs.find((d) => GENERATED_DIRS.has(d))
  if (gen) return `vendored/generated directory (${gen}/) changed`
  if (/\.min\.(js|mjs|cjs|css)$/.test(base) || /\.(js|mjs|cjs|css|ts)\.map$/.test(base)) return "minified/generated file changed"
  return null
}

function normalizeForWhitespace(lines: string[], indentSensitive: boolean): string {
  if (indentSensitive) {
    return lines
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l !== "")
      .join("\n")
  }
  return lines.join("").replace(/\s+/g, "")
}

function isWhitespaceOnlyHunk(h: DiffHunk, indentSensitive: boolean): boolean {
  const removed = h.lines.filter((l) => l.kind === "-").map((l) => l.text)
  const added = h.lines.filter((l) => l.kind === "+").map((l) => l.text)
  if (removed.length === 0 && added.length === 0) return false
  return normalizeForWhitespace(removed, indentSensitive) === normalizeForWhitespace(added, indentSensitive)
}

interface VersionRule {
  file: RegExp
  value: RegExp
}

const VERSION_RULES: VersionRule[] = [
  { file: /(^|\/)(package|composer)\.json$/i, value: /^\s*"version"\s*:\s*"([^"]*)"/ },
  { file: /(^|\/)(pyproject\.toml|cargo\.toml|setup\.cfg)$/i, value: /^\s*version\s*=\s*["']?([^"'\s#]+)["']?/ },
  { file: /(^|\/)setup\.py$/i, value: /\bversion\s*=\s*["']([^"']+)["']/ },
  { file: /(^|\/)pom\.xml$/i, value: /<version>\s*([^<\s]+)\s*<\/version>/ },
  { file: /(^|\/)build\.gradle(\.kts)?$/i, value: /^\s*version\s*=?\s*["']([^"']+)["']/ },
  { file: /(^|\/)gradle\.properties$/i, value: /^\s*version\s*=\s*(\S+)/ },
]

function versionChange(f: ParsedDiffFile): string | null {
  const rule = VERSION_RULES.find((r) => r.file.test(f.stat.path))
  if (!rule) return null
  const removed: string[] = []
  const added: string[] = []
  for (const h of f.hunks) {
    for (const l of h.lines) {
      const m = rule.value.exec(l.text)
      if (!m) continue
      if (l.kind === "-") removed.push(m[1]!)
      else if (l.kind === "+") added.push(m[1]!)
    }
  }
  if (removed.length === 0 || added.length === 0) return null
  const before = removed.join(",")
  const after = added.join(",")
  return before === after ? null : `version changed (${removed[0]} -> ${added[0]})`
}

/**
 * Changes that are probably unrelated to a minimal fix: lockfiles, CI/workflow files, license files,
 * vendored/generated dirs, binary files, symlinks, mode changes, whitespace-only hunks. Returns
 * human-readable findings (empty = clean). Pure.
 */
export function findUnrelatedChanges(stat: DiffStat, diff: string): string[] {
  const findings: string[] = []
  for (const f of stat.files) {
    const reasons = new Set<string>()
    for (const p of [f.path, f.oldPath]) {
      const why = p ? classifyUnrelatedPath(p) : null
      if (why) reasons.add(why)
    }
    if (f.binary) reasons.add("binary file changed")
    if (f.modeChange) reasons.add(`file mode change (${f.modeChange})`)
    for (const r of reasons) findings.push(`${f.path}: ${r}`)
  }
  for (const f of parseDiffFiles(diff)) {
    if (f.stat.binary) continue
    const sensitive = INDENT_SENSITIVE.test(f.stat.path)
    // Whitespace churn only makes sense for edits; a new or removed file is judged by its path.
    const edited = f.stat.status === "modified" || f.stat.status === "renamed"
    const wsHunks = edited ? f.hunks.filter((h) => isWhitespaceOnlyHunk(h, sensitive)).length : 0
    if (wsHunks > 0) findings.push(`${f.stat.path}: whitespace-only change in ${wsHunks} hunk${wsHunks === 1 ? "" : "s"}`)
    const version = versionChange(f)
    if (version) findings.push(`${f.stat.path}: ${version}`)
  }
  return [...new Set(findings)]
}
