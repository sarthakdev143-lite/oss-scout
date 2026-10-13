import type { OssScoutConfig } from "../config/schema.ts"
import type {
  CommandRun,
  DiffStat,
  GateCheck,
  ImplementationOutput,
  IssueKind,
  ProjectInfo,
  TaskKind,
  VerificationReport,
} from "../core/types.ts"
import { hasDisclosure } from "../queue/prbody.ts"
import { isTestFile } from "../workspace/project.ts"
import { addedLines, findUnrelatedChanges, parseUnifiedDiff } from "./diff.ts"
import { scanDiffForSecrets } from "./secrets.ts"

export interface GateInput {
  implementation: ImplementationOutput
  project: ProjectInfo
  issueKind: IssueKind | null
  /**
   * Task kind. A follow-up fix (review feedback on an already-open PR) skips the reproduction check
   * (the original PR covered it) and does not need to touch a test.
   */
  taskKind?: TaskKind | null
  /** Repo PR template (null if none). */
  prTemplate: string | null
  /** Final PR body (after disclosure enforcement). */
  prBody: string
  disclosureLine: string
  config: OssScoutConfig
}

/** Collaborators the gate borrows from other modules; injectable for tests. */
export interface GateDeps {
  isTestFile: (path: string, project: ProjectInfo) => boolean
  hasDisclosure: (body: string, line: string) => boolean
}

const defaultDeps: GateDeps = { isTestFile, hasDisclosure }

/** Whitespace- and case-insensitive containment (local equivalent of prbody.hasDisclosure). */
export function normalizedIncludes(body: string, line: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()
  const needle = norm(line)
  return needle.length > 0 && norm(body).includes(needle)
}

const DOC_EXT_RE = /\.(md|mdx|markdown|rst|txt|adoc|asciidoc)$/i
const NOT_DOC_TXT_RE = /(^|\/)(requirements[^/]*|constraints[^/]*|cmakelists)\.txt$/i

/** Documentation file: prose extension, or anything under a docs/ (or doc/) directory. */
export function isDocPath(path: string): boolean {
  const p = path.replace(/\\/g, "/")
  if (DOC_EXT_RE.test(p) && !NOT_DOC_TXT_RE.test(p)) return true
  return p
    .split("/")
    .slice(0, -1)
    .some((seg) => seg === "docs" || seg === "doc")
}

/** Every changed file is documentation (and there is at least one). */
export function isDocsOnly(stat: DiffStat): boolean {
  return stat.files.length > 0 && stat.files.every((f) => isDocPath(f.path))
}

const check = (name: string, status: GateCheck["status"], detail: string): GateCheck => ({ name, status, detail })

function runPassed(run: CommandRun): boolean {
  return run.exitCode === 0 && !run.timedOut
}

function describeRun(run: CommandRun): string {
  const secs = Math.round(run.durationMs / 1000)
  if (run.timedOut) return `\`${run.command}\` timed out after ${secs}s`
  return run.exitCode === 0 ? `\`${run.command}\` passed (${secs}s)` : `\`${run.command}\` failed with exit code ${run.exitCode}`
}

function testsPass(run: CommandRun | null, docsOnly: boolean): GateCheck {
  if (!run) {
    return docsOnly
      ? check("tests-pass", "skip", "no test run (docs-only change)")
      : check("tests-pass", "fail", "no test run recorded for a code change")
  }
  return check("tests-pass", runPassed(run) ? "pass" : "fail", describeRun(run))
}

function lintPass(run: CommandRun | null, project: ProjectInfo): GateCheck {
  if (!run) {
    return project.lint
      ? check("lint-pass", "fail", `lint command \`${project.lint}\` was not run`)
      : check("lint-pass", "skip", "no lint command detected")
  }
  return check("lint-pass", runPassed(run) ? "pass" : "fail", describeRun(run))
}

function testsAdded(stat: DiffStat, input: GateInput, docsOnly: boolean, deps: GateDeps): GateCheck {
  if (docsOnly) return check("tests-added", "skip", "docs-only change")
  if (input.issueKind === "docs") return check("tests-added", "skip", "docs issue")
  const tests = stat.files.filter((f) => f.status !== "deleted" && deps.isTestFile(f.path, input.project)).map((f) => f.path)
  if (tests.length > 0) return check("tests-added", "pass", `test files changed: ${tests.join(", ")}`)
  if (input.taskKind === "followup_fix") return check("tests-added", "skip", "follow-up fix for review feedback: no test change required")
  return check("tests-added", "fail", "no test file was added or changed")
}

function reproduction(input: GateInput, stat: DiffStat, deps: GateDeps): GateCheck {
  if (input.taskKind === "followup_fix") return check("reproduction", "skip", "follow-up fix: the original pull request covered reproduction")
  if (input.issueKind !== "bug") return check("reproduction", "skip", "not a bug report")
  if (!input.config.implementation.requireReproduction) return check("reproduction", "skip", "reproduction not required by config")
  const reproduced = input.implementation.reproduced
  // The implementer reports null for follow-up fixes; a contribution's bug fix always reports true/false.
  if (reproduced === null && input.taskKind !== "contribution") return check("reproduction", "skip", "reproduction not applicable to this change")
  if (reproduced !== true) return check("reproduction", "fail", "no failing reproduction test was observed before the fix")
  // A reproduced bug is fixed in the code under test: a change to test files only cannot be the fix.
  const source = stat.files.filter((f) => !deps.isTestFile(f.path, input.project))
  return source.length > 0
    ? check("reproduction", "pass", "a failing test was observed before the fix")
    : check("reproduction", "fail", "a failing test was observed, but the change touches only test files")
}

/**
 * Added lines that skip or focus tests: `it.skip`/`test.only`/`xit(`/`fdescribe(` (JS), pytest and
 * unittest skip/xfail markers, JUnit `@Disabled`/`@Ignore`, Go `t.Skip`, Rust `#[ignore]`.
 */
const SKIP_MARKER_RE =
  /(?<![\w.$])(?:it|test|describe|context|suite|specify)\s*\.\s*(?:skip|only|todo|skipIf|runIf|fixme)\b|(?<![\w.$])(?:xit|xtest|xdescribe|xcontext|xspecify|fit|fdescribe|ftest)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail)\s*\(|@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|\bself\.skipTest\s*\(|@(?:Disabled|Ignore)\b|\bt\.Skip(?:f|Now)?\s*\(|#\[ignore\]/

/** Does a (test-file) line skip, focus or disable tests? */
export function addsSkipMarker(line: string): boolean {
  return SKIP_MARKER_RE.test(line)
}

/** Tests must not be deleted (contributions) or skipped/focused (always) to make a change pass. */
function testsNotWeakened(stat: DiffStat, diff: string, input: GateInput, deps: GateDeps): GateCheck {
  const problems: string[] = []
  if (input.taskKind !== "followup_fix") {
    for (const f of stat.files) {
      if (f.status === "deleted" && deps.isTestFile(f.path, input.project)) problems.push(`${f.path}: test file deleted`)
    }
  }
  const marked = new Set<string>()
  for (const { file, line, text } of addedLines(diff)) {
    if (marked.has(file) || !deps.isTestFile(file, input.project) || !addsSkipMarker(text)) continue
    marked.add(file)
    problems.push(`${file}:${line}: adds a skip/only marker`)
  }
  return problems.length === 0
    ? check("tests-not-weakened", "pass", "no test deleted, skipped or focused")
    : check("tests-not-weakened", "fail", problems.slice(0, 10).join("; "))
}

/**
 * Deterministic verification gate. Checks (each pass/fail/skip with detail):
 *  tests-pass, lint-pass, tests-added (non-docs; optional for follow-ups), reproduction (bugs, if
 *  required; not for follow-ups; a test-only change fails), tests-not-weakened (no deleted, skipped
 *  or focused tests), diff-size, files-changed, unrelated-changes, no-secrets, pr-template-filled,
 *  disclosure-present, non-empty-diff. `implementation.diff` must be the RAW diff (not redacted) so
 *  the secrets scan sees real token shapes.
 * `passed` = no check failed. Pure.
 */
export function runVerificationGate(input: GateInput, deps: Partial<GateDeps> = {}): VerificationReport {
  const d: GateDeps = { ...defaultDeps, ...deps }
  const impl = input.implementation
  const limits = input.config.implementation
  const stat = impl.diff.trim() ? parseUnifiedDiff(impl.diff) : impl.diffStat
  const docsOnly = isDocsOnly(stat)
  const lines = stat.additions + stat.deletions
  const unrelated = findUnrelatedChanges(stat, impl.diff)
  const secrets = scanDiffForSecrets(impl.diff)
  const template = input.prTemplate?.trim() ? isTemplateFilled(input.prTemplate, input.prBody) : null

  const checks: GateCheck[] = [
    stat.files.length > 0 && impl.diff.trim()
      ? check("non-empty-diff", "pass", `${stat.files.length} file(s), +${stat.additions}/-${stat.deletions}`)
      : check("non-empty-diff", "fail", "the change is empty"),
    testsPass(impl.finalTestRun, docsOnly),
    lintPass(impl.finalLintRun, input.project),
    testsAdded(stat, input, docsOnly, d),
    reproduction(input, stat, d),
    testsNotWeakened(stat, impl.diff, input, d),
    check("diff-size", lines <= limits.maxDiffLines ? "pass" : "fail", `${lines} changed lines (limit ${limits.maxDiffLines})`),
    check(
      "files-changed",
      stat.files.length <= limits.maxFilesChanged ? "pass" : "fail",
      `${stat.files.length} files changed (limit ${limits.maxFilesChanged})`,
    ),
    unrelated.length === 0
      ? check("unrelated-changes", "pass", "no unrelated changes detected")
      : check("unrelated-changes", "fail", unrelated.join("; ")),
    secrets.length === 0
      ? check("no-secrets", "pass", "no credentials detected in added lines")
      : check("no-secrets", "fail", secrets.map((s) => `${s.file}:${s.line} (${s.rule})`).join("; ")),
    template === null
      ? check("pr-template-filled", "skip", "repository has no PR template")
      : check("pr-template-filled", template.ok ? "pass" : "fail", template.detail),
    d.hasDisclosure(input.prBody, input.disclosureLine)
      ? check("disclosure-present", "pass", "AI disclosure line present")
      : check("disclosure-present", "fail", "AI disclosure line missing from the PR body"),
  ]
  return { passed: checks.every((c) => c.status !== "fail"), checks }
}

// ---------------------------------------------------------------------------
// PR template filling
// ---------------------------------------------------------------------------

interface Heading {
  text: string
  norm: string
  /** 1-6 for ATX headings, 7 for bold-only lines. */
  level: number
  index: number
}

/** Blank out HTML comments while keeping line numbers stable. */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, ""))
}

function normalizeHeading(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function headingsOf(lines: string[]): Heading[] {
  const out: Heading[] = []
  let fence: string | null = null
  lines.forEach((line, index) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (fence === null) fence = f[1]!
      else if (f[1]!.startsWith(fence)) fence = null
      return
    }
    if (fence !== null) return
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    const bold = atx ? null : /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/.exec(line)
    const text = (atx?.[2] ?? bold?.[1] ?? "").replace(/:\s*$/, "").trim()
    const norm = normalizeHeading(text)
    if (norm) out.push({ text, norm, level: atx ? atx[1]!.length : 7, index })
  })
  return out
}

/** Non-blank, non-heading lines of a section (until the next heading of the same or higher level). */
function sectionLines(lines: string[], heads: Heading[], h: Heading): string[] {
  const headIdx = new Set(heads.map((x) => x.index))
  const next = heads.find((x) => x.index > h.index && x.level <= h.level)
  const end = next ? next.index : lines.length
  return lines
    .slice(h.index + 1, end)
    .map((l, i) => (headIdx.has(h.index + 1 + i) ? "" : l.trim()))
    .filter((l) => l !== "")
}

const CHECKBOX_RE = /^[-*+]\s+\[[ xX]\]/
const PLACEHOLDER_LINE_RE = /^(\.{2,}|…|todo|tbd|<[^>]*>|[-*+_]+|\[[ xX]?\])$/i
const OPTIONAL_RE = /optional|if applicable|if any\b|if relevant|if needed|when applicable|if appropriate/i

const normLine = (l: string) => l.toLowerCase().replace(/\s+/g, " ").trim()

function sectionFilled(templateSection: string[], bodySection: string[]): boolean {
  const tText = new Set(templateSection.filter((l) => !CHECKBOX_RE.test(l)).map(normLine))
  const tBoxes = templateSection.filter((l) => CHECKBOX_RE.test(l))
  const bBoxes = bodySection.filter((l) => CHECKBOX_RE.test(l))
  const fresh = bodySection.filter((l) => !CHECKBOX_RE.test(l) && !tText.has(normLine(l)) && !PLACEHOLDER_LINE_RE.test(l))
  if (fresh.length > 0) return true
  if (bBoxes.some((l) => /\[[xX]\]/.test(l))) return true
  return tText.size === 0 && tBoxes.length > 0 && bBoxes.length > 0
}

function headingMatches(templateNorm: string, bodyNorm: string): boolean {
  if (templateNorm === bodyNorm) return true
  const [short, long] = templateNorm.length <= bodyNorm.length ? [templateNorm, bodyNorm] : [bodyNorm, templateNorm]
  return short.length >= 4 && long.includes(short)
}

/** Template headings are kept and every section has real content (no leftover placeholders/HTML comments only). */
export function isTemplateFilled(template: string, body: string): { ok: boolean; detail: string } {
  const rawTemplateLines = template.replace(/\r\n/g, "\n").split("\n")
  const tLines = stripComments(template.replace(/\r\n/g, "\n")).split("\n")
  const bLines = stripComments(body.replace(/\r\n/g, "\n")).split("\n")
  const tHeads = headingsOf(tLines)
  const bHeads = headingsOf(bLines)

  if (tHeads.length === 0) {
    const t = tLines.map(normLine).filter(Boolean).join("\n")
    const b = bLines.map(normLine).filter(Boolean).join("\n")
    if (!b) return { ok: false, detail: "PR body is empty" }
    if (b === t) return { ok: false, detail: "PR body is the unchanged template" }
    return { ok: true, detail: "template has no headings; body has its own content" }
  }

  const seen = new Set<string>()
  const missing: string[] = []
  const empty: string[] = []
  let required = 0
  let present = 0
  for (const th of tHeads) {
    if (seen.has(th.norm)) continue
    seen.add(th.norm)
    const tSection = sectionLines(tLines, tHeads, th)
    // Optional = the heading or its own text (comments included, children excluded) says so.
    const ownEnd = tHeads.find((x) => x.index > th.index)?.index ?? rawTemplateLines.length
    const optional = OPTIONAL_RE.test(rawTemplateLines.slice(th.index, ownEnd).join("\n"))
    const bh = bHeads.find((h) => headingMatches(th.norm, h.norm))
    if (!optional) required++
    if (!bh) {
      if (!optional) missing.push(th.text)
      continue
    }
    if (!optional) present++
    if (!optional && !sectionFilled(tSection, sectionLines(bLines, bHeads, bh))) empty.push(th.text)
  }

  const ratio = required === 0 ? 1 : present / required
  const ok = ratio >= 0.7 && empty.length === 0
  if (ok) {
    const extra = missing.length ? `; missing: ${missing.join(", ")}` : ""
    return { ok, detail: `${present}/${required} required template sections present and filled${extra}` }
  }
  const parts: string[] = []
  if (missing.length) parts.push(`missing sections: ${missing.join(", ")}`)
  if (empty.length) parts.push(`empty or placeholder-only sections: ${empty.join(", ")}`)
  parts.push(`${present}/${required} required sections present`)
  return { ok, detail: parts.join("; ") }
}
