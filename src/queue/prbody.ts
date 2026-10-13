import { createHash } from "node:crypto"
import type { IssueRecord, QueueKind } from "../core/types.ts"

/**
 * PR body assembly and disclosure enforcement. Pure functions: every PR body and reply that
 * reaches the approval queue goes through `ensureDisclosure`, and approval re-verifies it.
 *
 * Disclosure checks look only at text GitHub actually renders visibly: HTML comments (closed, or
 * an unclosed `<!--` up to the end), fenced code blocks, collapsed `<details>` blocks, inline code
 * and strikethrough do not count. A disclosure hidden in any of those is appended again, visibly.
 */

/** Lowercase, drop markdown emphasis/code/quote markers, collapse whitespace. */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`~>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

function isClosingFence(line: string, fence: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
  return !!m && m[1]![0] === fence[0] && m[1]!.length >= fence.length
}

interface MarkdownScan {
  /** Rendered-visible text (comments, fences, details, inline code, strikethrough removed). */
  visible: string
  /** Opening fence still open at the end of the text, if any. */
  openFence: string | null
  /** An `<!--` is still open at the end of the text. */
  openComment: boolean
  /** Number of `<details>` blocks still open at the end of the text. */
  openDetails: number
}

function scanMarkdown(text: string): MarkdownScan {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  let fence: string | null = null
  let inComment = false
  const out: string[] = []
  for (const line of lines) {
    if (fence) {
      if (isClosingFence(line, fence)) fence = null
      continue
    }
    if (!inComment) {
      const m = FENCE_OPEN.exec(line)
      if (m) {
        fence = m[1]!
        continue
      }
    }
    let rest = line
    let visible = ""
    while (rest.length > 0) {
      if (inComment) {
        const end = rest.indexOf("-->")
        if (end === -1) break
        rest = rest.slice(end + 3)
        inComment = false
      } else {
        const start = rest.indexOf("<!--")
        if (start === -1) {
          visible += rest
          break
        }
        visible += rest.slice(0, start)
        rest = rest.slice(start + 4)
        inComment = true
      }
    }
    out.push(visible)
  }

  let visible = out.join("\n").replace(/<details\b[^>]*>[\s\S]*?<\/details\s*>/gi, " ")
  const unclosedDetails = visible.search(/<details\b/i)
  let openDetails = 0
  if (unclosedDetails !== -1) {
    openDetails = (visible.slice(unclosedDetails).match(/<details\b/gi) ?? []).length
    visible = visible.slice(0, unclosedDetails)
  }
  visible = visible
    .replace(/(`+)[^`]*?\1/g, " ")
    .replace(/~~[\s\S]*?~~/g, " ")
    .replace(/~[^~\n]+~/g, " ")
  return { visible, openFence: fence, openComment: inComment, openDetails }
}

/** The part of a markdown body GitHub renders as visible text (see module comment). */
export function visibleMarkdown(text: string): string {
  return scanMarkdown(text).visible
}

/**
 * Close an unterminated code fence, HTML comment or `<details>` block at the end of `body`, so
 * that whatever is appended afterwards (closing reference, verification, disclosure) is visible.
 */
export function closeOpenBlocks(body: string): string {
  const scan = scanMarkdown(body)
  let out = body.trimEnd()
  if (scan.openFence) out = `${out}\n${scan.openFence}`
  if (scan.openComment) out = `${out}\n-->`
  for (let i = 0; i < scan.openDetails; i++) out = `${out}\n</details>`
  return out
}

/** true if `body` visibly contains the disclosure line (whitespace/case/markdown-emphasis-insensitive). */
export function hasDisclosure(body: string, line: string): boolean {
  const needle = normalizeForMatch(line)
  return needle.length > 0 && normalizeForMatch(visibleMarkdown(body)).includes(needle)
}

/** Append the disclosure line (under a separator, outside any open block) if not visibly present. Idempotent. */
export function ensureDisclosure(body: string, line: string): string {
  const disclosure = line.trim()
  if (!normalizeForMatch(disclosure) || hasDisclosure(body, disclosure)) return body
  const base = body.trim() ? closeOpenBlocks(body) : ""
  return base ? `${base}\n\n---\n${disclosure}` : disclosure
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Regex alternatives matching a reference to the issue (#N, owner/repo#N, its URL). */
function issueRefPatterns(issue: Pick<IssueRecord, "repo" | "number" | "url">): string[] {
  const n = issue.number
  const refs = [`(?<![\\w/#])#${n}(?!\\d)`, `${escapeRegExp(issue.repo)}#${n}(?!\\d)`]
  if (issue.url.length > 0) refs.push(`${escapeRegExp(issue.url.replace(/\/+$/, ""))}(?![\\d])`)
  return refs
}

/** Does `text` already reference the issue (#N, owner/repo#N, or its URL)? */
export function referencesIssue(text: string, issue: Pick<IssueRecord, "repo" | "number" | "url">): boolean {
  const n = issue.number
  const shortRef = new RegExp(`(^|[^\\w/#])#${n}(?!\\d)`, "m")
  const fullRef = new RegExp(`${escapeRegExp(issue.repo)}#${n}(?!\\d)`, "i")
  const urlRef = new RegExp(`${escapeRegExp(issue.url.replace(/\/+$/, ""))}(?![\\d])`, "i")
  return shortRef.test(text) || fullRef.test(text) || (issue.url.length > 0 && urlRef.test(text))
}

/**
 * Does the visible text close the issue on merge ("Fixes #N", "closes: owner/repo#N", "Resolves <url>")?
 * Mentions without a closing keyword ("the crash reported in #N", "Related: #N") do not count.
 */
export function closesIssue(text: string, issue: Pick<IssueRecord, "repo" | "number" | "url">): boolean {
  const keyword = "\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s*"
  return new RegExp(`${keyword}(?:${issueRefPatterns(issue).join("|")})`, "i").test(visibleMarkdown(text))
}

/** An explicit partial-work reference ("Part of #N", "partially addresses #N", "towards #N"): no closing keyword is added. */
function partiallyReferencesIssue(text: string, issue: Pick<IssueRecord, "repo" | "number" | "url">): boolean {
  const marker = "\\b(?:part\\s+of|partial(?:ly)?(?:\\s+(?:fix(?:es)?|address(?:es)?|resolves?)(?:\\s+for)?)?|towards?)\\s*:?\\s*"
  return new RegExp(`${marker}(?:${issueRefPatterns(issue).join("|")})`, "i").test(visibleMarkdown(text))
}

/** A heading (markdown or bold line) that introduces a testing/verification section. */
const TESTING_SECTION =
  /^[ \t]*(?:#{1,6}[ \t]*|\*\*[ \t]*|__[ \t]*)(?:how (?:has |have |was |were |is |did |to )?(?:this|it|the changes?|these changes|i|you)?[ \t]*(?:been )?(?:tested|verified|test|verify)|testing|tests?\b|test plan|verification|validation)/im

/** Unfilled closing-keyword placeholder line from a PR template, e.g. "Fixes #" or "Closes # <issue>". */
const CLOSING_PLACEHOLDER = /^([ \t]*(?:[-*][ \t]+)?)(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)[ \t]*:?[ \t]*#[ \t]*(?:<[^>\n]*>|\[[^\]\n]*\]|\([^)\n]*\)|_+|x+|n+)?[ \t]*$/im

function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim()
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/**
 * Final PR body: the implementer's draft (template-filled when the repo has one), a closing
 * reference ("Fixes #N") when targeting the default branch and the draft has no closing keyword
 * for the issue yet, a short "How this was tested" section with the sandboxed test command/result,
 * and the disclosure line. Anything appended lands outside unterminated comments/fences.
 */
export function buildPrBody(input: {
  drafted: string
  issue: IssueRecord | null
  template: string | null
  testSummary: string
  disclosureLine: string
  /** Add "Fixes #N" when the body does not already close the issue. */
  closingReference: boolean
}): string {
  // An empty draft falls back to the repo template so the human sees (and the gate flags) what is missing.
  const raw = input.drafted.trim() || (input.template ?? "").trim()
  let body = raw ? closeOpenBlocks(raw) : ""

  if (input.closingReference && input.issue && !closesIssue(body, input.issue) && !partiallyReferencesIssue(body, input.issue)) {
    const fixes = `Fixes #${input.issue.number}`
    if (CLOSING_PLACEHOLDER.test(body)) body = body.replace(CLOSING_PLACEHOLDER, (_m, indent: string) => `${indent}${fixes}`)
    else body = body ? `${body}\n\n${fixes}` : fixes
  }

  const summary = input.testSummary.trim()
  if (summary) {
    if (TESTING_SECTION.test(visibleMarkdown(body))) body = `${body}\n\n_Sandboxed verification: ${oneLine(summary, 300)}_`
    else body = `${body}\n\n### Verification\n\n${summary}`
  }

  return ensureDisclosure(body.trim(), input.disclosureLine)
}

/** Fields the approval digest covers. `commitSha` (or `data.commitSha`) binds pr/fix items to the reviewed commit. */
export interface DigestInput {
  kind: QueueKind
  repo: string
  title: string
  body: string
  diff: string
  /** Explicit commit; `null` = none. When omitted, `data.commitSha` is used. */
  commitSha?: string | null
  data?: Record<string, unknown>
}

/** The commit an item's digest binds to (explicit commitSha, else data.commitSha), or null. */
export function digestCommitOf(item: DigestInput): string | null {
  if (item.commitSha !== undefined) return item.commitSha || null
  const sha = item.data?.commitSha
  return typeof sha === "string" && sha.length > 0 ? sha : null
}

/**
 * sha256 hex over kind/repo/title/body/diff, plus the commit sha when the item has one (pr/fix items
 * push exactly that commit). Items without a commit keep the original 5-field digest. Approval
 * requires quoting >= 8 leading chars.
 */
export function computeDigest(item: DigestInput): string {
  const fields: string[] = [item.kind, item.repo, item.title, item.body, item.diff]
  const commit = digestCommitOf(item)
  if (commit) fields.push(commit)
  return createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex")
}
