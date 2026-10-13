import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { audit, type AppContext } from "../core/context.ts"
import type {
  AuditActor,
  CriticVerdict,
  QueueItem,
  QueueKind,
  QueueStatus,
  VerificationReport,
} from "../core/types.ts"
import { MINUTE } from "../util/clock.ts"
import { tail } from "../util/exec.ts"
import { redact } from "../util/redact.ts"
import { oneLine, truncate, UNTRUSTED_DATA_HEADER } from "../util/text.ts"
import { computeDigest, ensureDisclosure } from "./prbody.ts"

export interface EnqueueInput {
  kind: QueueKind
  repo: string
  issueUrl: string | null
  prUrl: string | null
  taskId: string | null
  title: string
  body: string
  diff: string
  testOutput: string
  critic: CriticVerdict | null
  verification: VerificationReport | null
  branch: string | null
  workspace: string | null
  baseBranch: string | null
  data?: Record<string, unknown>
}

/** Files written to <queueDir>/<id>/ for review. PR_TITLE.txt / PR_BODY.md may be edited by the human. */
export const QUEUE_FILES = {
  title: "PR_TITLE.txt",
  body: "PR_BODY.md",
  diff: "diff.patch",
  testOutput: "test-output.txt",
  review: "REVIEW.md",
} as const

const DEFAULT_MAX_DIFF_CHARS = 12_000
const TEST_OUTPUT_TAIL_CHARS = 4_000
const MAX_TITLE_CHARS = 256

/** First 8 hex chars of the digest: what the human quotes to approve. */
export function digest8(item: Pick<QueueItem, "digest">): string {
  return item.digest.slice(0, 8)
}

/** Exact approval commands for an item (slash command and CLI). */
export function approveCommands(item: Pick<QueueItem, "id" | "digest">): { command: string; cli: string } {
  const d = digest8(item)
  return { command: `/oss-approve ${item.id} ${d}`, cli: `bun src/cli.ts approve ${item.id} ${d}` }
}

/** Statuses whose content may still be edited, rejected or (re-)approved. */
export function isOpenForDecision(item: Pick<QueueItem, "status" | "data">): boolean {
  return item.status === "pending" || item.status === "failed" || (item.status === "approved" && item.data.dryRun === true)
}

/**
 * How long an approved (queue-mode) submission counts as running after it started (data.submittingAt).
 * Longer than the slowest submission (fork, 5-minute push timeout, PR calls with 60 s timeouts), so a
 * submission still running in another process is never resumed or rejected concurrently.
 */
export const SUBMISSION_LEASE_MS = 15 * MINUTE

const IN_FLIGHT_KEY = Symbol.for("oss-scout.submissions-in-flight")

/** Queue item ids whose submission is running in this process (shared by every plugin instance). */
export function submissionsInFlight(): Set<number> {
  const g = globalThis as unknown as Record<symbol, Set<number> | undefined>
  let set = g[IN_FLIGHT_KEY]
  if (!set) {
    set = new Set<number>()
    g[IN_FLIGHT_KEY] = set
  }
  return set
}

/** When the item's queue-mode submission started (data.submittingAt), or null. */
export function submittingAt(item: Pick<QueueItem, "data">): number | null {
  const at = item.data.submittingAt
  return typeof at === "number" && Number.isFinite(at) ? at : null
}

/** An approved queue-mode item whose submission is (probably) still running here or in another process. */
export function isSubmissionRunning(item: Pick<QueueItem, "id" | "status" | "data">, now: number): boolean {
  if (item.status !== "approved" || item.data.dryRun === true) return false
  if (submissionsInFlight().has(item.id)) return true
  const at = submittingAt(item)
  return at !== null && now - at < SUBMISSION_LEASE_MS
}

/**
 * An approved queue-mode item whose submission stopped without finishing (crash, restart, closed
 * opencode). It may be re-approved (resumes; every step is idempotent), rejected or superseded.
 */
export function isInterruptedSubmission(item: Pick<QueueItem, "id" | "status" | "data">, now: number): boolean {
  return item.status === "approved" && item.data.dryRun !== true && !isSubmissionRunning(item, now)
}

/** "https://github.com/o/r/issues/12" → "o/r#12" (null when not an issue URL). */
export function issueIdFromUrl(url: string | null): string | null {
  if (!url) return null
  const m = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/i.exec(url)
  return m ? `${m[1]}#${m[2]}` : null
}

/** The issue id a pr item targets: data.issueId, else derived from issueUrl. */
export function issueIdOf(item: Pick<QueueItem, "data" | "issueUrl">): string | null {
  const fromData = item.data.issueId
  return typeof fromData === "string" && fromData ? fromData : issueIdFromUrl(item.issueUrl)
}

function disclosureFor(ctx: AppContext, kind: QueueKind): string {
  return kind === "reply" ? ctx.config.disclosure.replyLine : ctx.config.disclosure.line
}

function cleanTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim()
  if (!t) throw new Error("title must not be empty")
  return t.length <= MAX_TITLE_CHARS ? t : t.slice(0, MAX_TITLE_CHARS)
}

function iso(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toISOString()
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []
}

/** The repo's AI-contribution rules recorded on the item at enqueue time (data.aiPolicyNotes). */
export function aiRuleNotesOf(item: Pick<QueueItem, "data">): string[] {
  return strings(item.data.aiPolicyNotes)
}

/** A pr item whose repo requires a human-written PR description (data.requiresHumanText). */
export function requiresHumanText(item: Pick<QueueItem, "kind" | "data">): boolean {
  return item.kind === "pr" && item.data.requiresHumanText === true
}

/** requiresHumanText and the human has not edited the body yet: approval is refused until they do. */
export function needsHumanWrittenBody(item: Pick<QueueItem, "kind" | "data">): boolean {
  return requiresHumanText(item) && item.data.humanEditedBody !== true
}

/** What the human must do before approving an item that needs a human-written PR description. */
export function humanTextNotice(id: number): string {
  return `This repository requires the PR description to be written by you. Edit the body (/oss-edit ${id} body … or edit ${QUEUE_FILES.body} then sync) before approving.`
}

const HUMAN_TEXT_DONE = "This repository requires the PR description to be written by you: you have edited the body. Make sure it is your own words before approving."

/** Plain-text lines of the "Repository AI rules" block ([] when the repo set no rules). */
function aiRulesBlock(item: QueueItem): string[] {
  const rules = aiRuleNotesOf(item)
  const human = requiresHumanText(item)
  if (rules.length === 0 && !human) return []
  const lines = ["", "!! Repository AI rules (respect them before approving) !!", ...rules.map((r) => `  - ${r}`)]
  if (human) lines.push(needsHumanWrittenBody(item) ? `  ACTION REQUIRED: ${humanTextNotice(item.id)}` : `  ${HUMAN_TEXT_DONE}`)
  return lines
}

/** Markdown version of aiRulesBlock for REVIEW.md. */
function aiRulesMarkdown(item: QueueItem): string[] {
  const rules = aiRuleNotesOf(item)
  const human = requiresHumanText(item)
  if (rules.length === 0 && !human) return []
  const md = ["", "## Repository AI rules", "", "The repository's AI-contribution policy sets these rules; respect them before approving:", ""]
  md.push(...rules.map((r) => `- ${r}`))
  if (human) {
    md.push("", needsHumanWrittenBody(item) ? `> **Action required:** ${humanTextNotice(item.id)}` : `> ${HUMAN_TEXT_DONE}`)
  }
  return md
}

/** Human notes derived from item data (policy requirements, summaries, planned actions). */
export function itemNotes(item: QueueItem): string[] {
  const d = item.data
  const notes: string[] = []
  if (d.requiresCla === true) notes.push("This repo requires a CLA. oss-scout cannot sign it: sign it yourself (the CLA bot will ask on the PR).")
  if (d.requiresIssueFirst === true)
    notes.push("CONTRIBUTING asks contributors to discuss or claim the issue before opening a PR. Consider commenting on the issue first.")
  if (d.requiresSignoff === true) notes.push("DCO sign-off is required; the commit carries Signed-off-by.")
  if (typeof d.aiPolicy === "string" && d.aiPolicy) notes.push(`AI policy: ${d.aiPolicy}`)
  notes.push(...strings(d.notes))
  if (typeof d.summary === "string" && d.summary.trim()) notes.push(`Summary: ${d.summary.trim()}`)
  return notes
}

function activityLines(item: QueueItem): string[] {
  const act = item.data.activity
  if (!Array.isArray(act)) return []
  const out: string[] = []
  for (const a of act) {
    if (!a || typeof a !== "object") continue
    const r = a as Record<string, unknown>
    const where = typeof r.path === "string" && r.path ? ` on ${r.path}${typeof r.line === "number" ? `:${r.line}` : ""}` : ""
    const state = typeof r.state === "string" && r.state ? ` [${r.state}]` : ""
    const body = typeof r.body === "string" ? r.body.replace(/\s+/g, " ").trim() : ""
    out.push(`@${String(r.author ?? "?")} (${String(r.kind ?? "comment")}${state}${where}): ${truncate(body, 400)}`)
  }
  return out
}

function checksTableMd(v: VerificationReport | null): string[] {
  if (!v) return ["_No verification report._"]
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
  return [
    `Overall: **${v.passed ? "passed" : "FAILED"}**`,
    "",
    "| Check | Status | Detail |",
    "|---|---|---|",
    ...v.checks.map((c) => `| ${esc(c.name)} | ${c.status} | ${esc(c.detail)} |`),
  ]
}

/** Absolute paths of an item's materialized review files. */
export function reviewFilePaths(queueDir: string, id: number): { review: string; diff: string; body: string; testOutput: string } {
  const dir = join(queueDir, String(id))
  return {
    review: join(dir, QUEUE_FILES.review),
    diff: join(dir, QUEUE_FILES.diff),
    body: join(dir, QUEUE_FILES.body),
    testOutput: join(dir, QUEUE_FILES.testOutput),
  }
}

/** Notes derived only from boolean policy fields (fixed text, safe to show to an LLM). */
function fixedPolicyNotes(item: QueueItem): string[] {
  const d = item.data
  const notes: string[] = []
  if (d.requiresCla === true) notes.push("This repo requires a CLA; sign it yourself (the CLA bot will ask on the PR).")
  if (d.requiresIssueFirst === true) notes.push("CONTRIBUTING asks contributors to discuss or claim the issue before opening a PR.")
  if (d.requiresSignoff === true) notes.push("DCO sign-off is required; the commit carries Signed-off-by.")
  return notes
}

/** Display-safe status word (dry-run approvals and interrupted submissions are marked). */
function statusLabel(item: Pick<QueueItem, "id" | "status" | "data">, now: number = Date.now()): string {
  if (item.status === "approved" && item.data.dryRun === true) return "approved (dry-run: nothing written)"
  if (isInterruptedSubmission(item, now)) return "approved (submission interrupted)"
  return item.status
}

/** What the human can do with an interrupted submission. */
function interruptedHint(item: Pick<QueueItem, "id" | "digest">): string {
  const cmd = approveCommands(item)
  return `Submission interrupted: approve again to resume it (${cmd.command}; steps already done are reused) or reject it (/oss-reject ${item.id} <reason>).`
}

/**
 * LLM-safe summary of a queue item, for tool results and slash-command posts (both can end up in a
 * model's context). It carries no diff, PR/comment body, test output or critic free text: only
 * fixed-vocabulary facts (kind, status, digest, check names + results, critic verdict + confidence,
 * the repo's AI rules from our own note table) and the paths of the review files. Third-party-derived
 * strings (repo, links, title, error) come last, single-line and truncated, under UNTRUSTED_DATA_HEADER.
 * The full review is `formatItem` (CLI) or the files in <queueDir>/<id>/.
 */
export function formatItemSummary(item: QueueItem, queueDir: string, now: number = Date.now()): string {
  const files = reviewFilePaths(queueDir, item.id)
  const lines: string[] = []
  lines.push(`Queue item #${item.id} (summary; the full review happens in a terminal or in the files below)`)
  lines.push(`Kind:    ${item.kind}    Status: ${statusLabel(item, now)}`)
  lines.push(`Digest:  ${digest8(item)}`)

  const v = item.verification
  if (v) {
    const checks = v.checks.map((c) => `${oneLine(c.name, 40)}=${c.status}`)
    lines.push(`Verification: ${v.passed ? "passed" : "FAILED"}${checks.length ? ` (${checks.join(", ")})` : ""}`)
  } else if (item.kind === "pr") {
    lines.push("Verification: (no report)")
  }
  if (item.critic) {
    const conf = Number.isFinite(item.critic.confidence) ? item.critic.confidence.toFixed(2) : "?"
    lines.push(`Critic:  ${item.critic.verdict} (confidence ${conf})`)
  } else if (item.kind === "pr") {
    lines.push("Critic:  (no verdict)")
  }

  const rules = aiRuleNotesOf(item).map((r) => oneLine(r, 200))
  if (rules.length) lines.push("Repository AI rules (respect them before approving):", ...rules.map((r) => `  - ${r}`))
  if (requiresHumanText(item)) {
    lines.push(needsHumanWrittenBody(item) ? `ACTION REQUIRED: ${humanTextNotice(item.id)}` : HUMAN_TEXT_DONE)
  }
  const notes = fixedPolicyNotes(item)
  if (notes.length) lines.push("Notes:", ...notes.map((n) => `  - ${n}`))

  lines.push(
    "",
    "Review files (open them in your editor):",
    `  ${files.review}`,
    `  ${files.diff}`,
    `  ${files.body}`,
    `  ${files.testOutput}`,
    `Full review: bun src/cli.ts show ${item.id} in a terminal`,
  )
  if (isOpenForDecision(item)) {
    const cmd = approveCommands(item)
    // Model-visible text: only the slash command, never a shell command line that approves.
    lines.push(`Approve (human only, after the full review): ${cmd.command}`)
  } else if (isInterruptedSubmission(item, now)) {
    lines.push(interruptedHint(item))
  }

  lines.push("", UNTRUSTED_DATA_HEADER)
  lines.push(`Repo:    ${oneLine(item.repo, 100)}`)
  if (item.issueUrl) lines.push(`Issue:   ${oneLine(item.issueUrl, 200)}`)
  if (item.prUrl) lines.push(`PR:      ${oneLine(item.prUrl, 200)}`)
  if (item.submittedUrl) lines.push(`Submitted: ${oneLine(item.submittedUrl, 200)}`)
  lines.push(`Title:   ${oneLine(item.title, 120)}`)
  if (item.error) lines.push(`Error:   ${oneLine(item.error, 200)}`)
  return lines.join("\n")
}

function criticLines(c: CriticVerdict | null): string[] {
  if (!c) return ["(no critic verdict)"]
  return [
    `${c.verdict} (confidence ${c.confidence.toFixed(2)}${c.model ? `, model ${c.model}` : ""})`,
    ...c.reasons.map((r) => `- ${r}`),
    ...c.requiredChanges.map((r) => `- required change: ${r}`),
  ]
}

/**
 * The approval queue. Every GitHub write starts here as a pending item that a human must approve
 * (see queue/submit.ts). This class never talks to GitHub.
 */
export class ApprovalQueue {
  constructor(readonly ctx: AppContext) {}

  /** Insert a pending item: enforces disclosure (pr: PR body; reply: reply line), computes digest, materializes files, audits. */
  enqueue(input: EnqueueInput): QueueItem {
    const now = this.ctx.clock.now()
    const title = cleanTitle(input.title)
    const body = ensureDisclosure(input.body, disclosureFor(this.ctx, input.kind))
    const digest = computeDigest({ kind: input.kind, repo: input.repo, title, body, diff: input.diff, data: input.data ?? {} })
    const item = this.ctx.store.insertQueueItem({
      kind: input.kind,
      status: "pending",
      repo: input.repo,
      issueUrl: input.issueUrl,
      prUrl: input.prUrl,
      taskId: input.taskId,
      title,
      body,
      diff: input.diff,
      testOutput: input.testOutput,
      critic: input.critic,
      verification: input.verification,
      branch: input.branch,
      workspace: input.workspace,
      baseBranch: input.baseBranch,
      digest,
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
      decisionReason: null,
      submittedUrl: null,
      error: null,
      data: input.data ?? {},
    })
    this.materialize(item)
    audit(this.ctx, "scout", "queue.enqueue", `queue:${item.id}`, "pending", [item.title], {
      kind: item.kind,
      repo: item.repo,
      taskId: item.taskId,
      digest: digest8(item),
    })
    return item
  }

  get(id: number): QueueItem | null {
    return this.ctx.store.getQueueItem(id)
  }

  list(filter: { status?: QueueStatus | QueueStatus[] } = {}): QueueItem[] {
    return this.ctx.store.listQueue(filter)
  }

  /** Compact table: id, kind, status, repo, title, digest prefix. */
  formatList(items: QueueItem[]): string {
    if (items.length === 0) return "Approval queue is empty."
    const status = (i: QueueItem) => (i.status === "approved" && i.data.dryRun === true ? "approved(dry-run)" : i.status)
    const rows = [
      ["ID", "KIND", "STATUS", "REPO", "DIGEST", "TITLE"],
      ...items.map((i) => [String(i.id), i.kind, status(i), i.repo, digest8(i), truncate(i.title, 70).split("\n")[0]!]),
    ]
    const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => r[col]!.length)))
    return rows
      .map((r) => r.map((cell, col) => (col === r.length - 1 ? cell : cell.padEnd(widths[col]!))).join("  "))
      .join("\n")
  }

  /** LLM-safe summary (tools, slash commands): see formatItemSummary. */
  formatItemSummary(item: QueueItem): string {
    return formatItemSummary(item, this.ctx.paths.queueDir, this.ctx.clock.now())
  }

  /**
   * Full review view: links, title, body, diff (optionally truncated), verification, critic notes, test
   * output tail, approve hint. Contains third-party text: show it to the human (CLI), never to an LLM.
   */
  formatItem(item: QueueItem, opts: { maxDiffChars?: number } = {}): string {
    const maxDiff = opts.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS
    const dir = this.itemDir(item.id)
    const lines: string[] = []
    lines.push(`Queue item #${item.id}: ${item.title}`)
    lines.push(`Repo:    ${item.repo} (https://github.com/${item.repo})`)
    lines.push(`Kind:    ${item.kind}    Status: ${item.status}${item.data.dryRun === true ? " (dry-run: nothing written)" : ""}`)
    if (item.issueUrl) lines.push(`Issue:   ${item.issueUrl}`)
    if (item.prUrl) lines.push(`PR:      ${item.prUrl}`)
    if (item.branch) lines.push(`Branch:  ${item.branch}${item.baseBranch ? ` -> base ${item.baseBranch}` : ""}`)
    lines.push(`Digest:  ${digest8(item)}`)
    lines.push(`Created: ${iso(item.createdAt)}`)
    if (item.decidedAt !== null) lines.push(`Decided: ${iso(item.decidedAt)}${item.decisionReason ? ` (${item.decisionReason})` : ""}`)
    if (item.submittedUrl) lines.push(`Submitted: ${item.submittedUrl}`)
    if (item.error) lines.push(`Error:   ${item.error}`)
    lines.push(`Files:   ${dir}`)
    lines.push(...aiRulesBlock(item))

    if (isOpenForDecision(item)) {
      const cmd = approveCommands(item)
      lines.push("")
      lines.push(`Approve: ${cmd.command}    (CLI: ${cmd.cli})`)
      lines.push(`Reject:  /oss-reject ${item.id} <reason>    (CLI: bun src/cli.ts reject ${item.id} "<reason>")`)
      lines.push(
        `Edit:    edit ${QUEUE_FILES.title} / ${QUEUE_FILES.body} in ${dir}, then bun src/cli.ts sync ${item.id} (editing changes the digest)`,
      )
    } else if (isInterruptedSubmission(item, this.ctx.clock.now())) {
      lines.push("", interruptedHint(item))
    }

    const planned = strings(item.data.plannedActions)
    if (planned.length) lines.push("", "Planned actions (dry-run):", ...planned.map((a) => `  - ${a}`))

    if (item.verification) {
      lines.push("", `Verification: ${item.verification.passed ? "passed" : "FAILED"}`)
      for (const c of item.verification.checks) lines.push(`  [${c.status}] ${c.name}: ${c.detail}`)
    }
    if (item.kind === "pr" || item.critic) lines.push("", "Critic:", ...criticLines(item.critic).map((l) => `  ${l}`))

    const notes = itemNotes(item)
    if (notes.length) lines.push("", "Notes:", ...notes.map((n) => `  - ${n}`))
    const activity = activityLines(item)
    if (activity.length) lines.push("", "Responding to:", ...activity.map((a) => `  - ${a}`))

    lines.push("", "----- Title -----", item.title)
    lines.push("", "----- Body -----", item.body)
    if (item.diff) {
      const diff =
        item.diff.length > maxDiff
          ? `${item.diff.slice(0, maxDiff)}\n[…diff truncated: ${item.diff.length - maxDiff} more chars; full diff in ${join(dir, QUEUE_FILES.diff)}]`
          : item.diff
      lines.push("", "----- Diff -----", diff)
    }
    if (item.testOutput) lines.push("", "----- Test output (tail) -----", tail(redact(item.testOutput), TEST_OUTPUT_TAIL_CHARS))
    return lines.join("\n")
  }

  /**
   * Reject an item: pending, dry-run-approved, failed, or an interrupted submission (approved in queue
   * mode, but no longer running anywhere). The issue of a rejected PR item is never picked again.
   */
  reject(id: number, reason: string, actor: AuditActor): QueueItem {
    const item = this.require(id)
    const now = this.ctx.clock.now()
    const interrupted = isInterruptedSubmission(item, now)
    if (!isOpenForDecision(item) && !interrupted) {
      const running = isSubmissionRunning(item, now) ? " (its submission is running right now)" : ""
      throw new Error(
        `queue item ${id} is ${item.status}${running}; only pending, dry-run-approved, failed or interrupted items can be rejected`,
      )
    }
    const why = reason.trim() || "no reason given"
    const updated: QueueItem = { ...item, status: "rejected", decisionReason: why, decidedAt: now, updatedAt: now }
    this.ctx.store.saveQueueItem(updated)
    if (item.kind === "pr") {
      const issueId = issueIdOf(item)
      if (issueId && this.ctx.store.getIssue(issueId)) {
        this.ctx.store.setIssueStatus(issueId, "skipped", `rejected by human: ${why}`, { sticky: true })
      }
    }
    this.materialize(updated)
    audit(this.ctx, actor, "queue.reject", `queue:${id}`, "rejected", [why], {
      kind: item.kind,
      repo: item.repo,
      ...(interrupted ? { interruptedSubmission: true } : {}),
    })
    return updated
  }

  /** Pending items only. Re-enforces disclosure, recomputes digest, re-materializes, audits. */
  editBody(id: number, body: string, actor: AuditActor): QueueItem {
    return this.applyEdit(id, { body }, actor)
  }

  editTitle(id: number, title: string, actor: AuditActor): QueueItem {
    return this.applyEdit(id, { title }, actor)
  }

  /** Re-read PR_TITLE.txt / PR_BODY.md the human edited in <queueDir>/<id>/ and apply them. */
  syncFromFiles(id: number, actor: AuditActor): QueueItem {
    const item = this.require(id)
    const dir = this.itemDir(id)
    const read = (name: string): string | null => {
      const p = join(dir, name)
      return existsSync(p) ? readFileSync(p, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n") : null
    }
    const change: { title?: string; body?: string } = {}
    const titleFile = read(QUEUE_FILES.title)
    if (titleFile !== null && titleFile.trim()) {
      const title = cleanTitle(titleFile)
      if (title !== item.title) change.title = title
    }
    const bodyFile = read(QUEUE_FILES.body)
    if (bodyFile !== null && bodyFile.trimEnd() !== item.body.trimEnd()) change.body = bodyFile.trimEnd()
    if (change.title === undefined && change.body === undefined) return item
    return this.applyEdit(id, change, actor)
  }

  /** Mark open (or interrupted) items superseded (e.g. the PR they reply to was closed). */
  supersede(id: number, reason: string): QueueItem {
    const item = this.require(id)
    if (item.status === "superseded") return item
    const now = this.ctx.clock.now()
    if (!isOpenForDecision(item) && !isInterruptedSubmission(item, now)) {
      throw new Error(`queue item ${id} is ${item.status}; it cannot be superseded`)
    }
    const updated: QueueItem = { ...item, status: "superseded", decisionReason: reason, decidedAt: now, updatedAt: now }
    this.ctx.store.saveQueueItem(updated)
    this.materialize(updated)
    audit(this.ctx, "system", "queue.supersede", `queue:${id}`, "superseded", [reason], { kind: item.kind, repo: item.repo })
    return updated
  }

  /** Directory where the item is materialized for review. */
  itemDir(id: number): string {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`invalid queue item id: ${id}`)
    return join(this.ctx.paths.queueDir, String(id))
  }

  /** (Re)write the review files for an item. Called on every change. */
  materialize(item: QueueItem): void {
    const dir = this.itemDir(item.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, QUEUE_FILES.title), `${item.title}\n`)
    writeFileSync(join(dir, QUEUE_FILES.body), item.body.endsWith("\n") ? item.body : `${item.body}\n`)
    writeFileSync(join(dir, QUEUE_FILES.diff), item.diff)
    writeFileSync(join(dir, QUEUE_FILES.testOutput), redact(item.testOutput))
    writeFileSync(join(dir, QUEUE_FILES.review), this.reviewMarkdown(item))
  }

  private reviewMarkdown(item: QueueItem): string {
    const cmd = approveCommands(item)
    const md: string[] = [
      `# Queue item #${item.id}: ${item.title}`,
      "",
      `- Kind: \`${item.kind}\``,
      `- Status: \`${item.status}\`${item.data.dryRun === true ? " (dry-run: nothing was written to GitHub)" : ""}`,
      `- Repo: [${item.repo}](https://github.com/${item.repo})`,
    ]
    if (item.issueUrl) md.push(`- Issue: ${item.issueUrl}`)
    if (item.prUrl) md.push(`- Pull request: ${item.prUrl}`)
    if (item.branch) md.push(`- Branch: \`${item.branch}\`${item.baseBranch ? ` → base \`${item.baseBranch}\`` : ""}`)
    md.push(`- Digest: \`${digest8(item)}\``)
    if (item.submittedUrl) md.push(`- Submitted: ${item.submittedUrl}`)
    if (item.error) md.push(`- Error: ${item.error}`)
    if (item.decisionReason) md.push(`- Decision: ${item.decisionReason}`)
    md.push(...aiRulesMarkdown(item))

    md.push("", "## Approve", "")
    if (isOpenForDecision(item)) {
      md.push(
        "In opencode:",
        "",
        "```",
        cmd.command,
        "```",
        "",
        "Or from a terminal in the oss-scout directory:",
        "",
        "```",
        cmd.cli,
        "```",
        "",
        `To change the title or body, edit \`${QUEUE_FILES.title}\` / \`${QUEUE_FILES.body}\` in this folder and run \`bun src/cli.ts sync ${item.id}\`. Editing changes the digest; use the new one to approve.`,
        "",
        `To reject: \`/oss-reject ${item.id} <reason>\` or \`bun src/cli.ts reject ${item.id} "<reason>"\`.`,
      )
    } else if (isInterruptedSubmission(item, this.ctx.clock.now())) {
      md.push(interruptedHint(item))
    } else {
      md.push(`No decision pending (status: ${item.status}).`)
    }

    const planned = strings(item.data.plannedActions)
    if (planned.length) md.push("", "## Planned actions (dry-run)", "", ...planned.map((a) => `- ${a}`))

    if (item.kind === "pr" || item.verification) md.push("", "## Verification", "", ...checksTableMd(item.verification))
    if (item.kind === "pr" || item.critic) md.push("", "## Critic", "", ...criticLines(item.critic))

    const notes = itemNotes(item)
    if (notes.length) md.push("", "## Notes", "", ...notes.map((n) => `- ${n}`))
    const activity = activityLines(item)
    if (activity.length) md.push("", "## Responding to", "", ...activity.map((a) => `- ${a}`))

    md.push(
      "",
      "## Files",
      "",
      `- \`${QUEUE_FILES.title}\`: title (editable)`,
      `- \`${QUEUE_FILES.body}\`: ${item.kind === "reply" ? "comment" : "PR"} body (editable; the AI disclosure line is always kept)`,
      `- \`${QUEUE_FILES.diff}\`: the change`,
      `- \`${QUEUE_FILES.testOutput}\`: sandboxed test output`,
      "",
    )
    return md.join("\n")
  }

  private require(id: number): QueueItem {
    const item = this.ctx.store.getQueueItem(id)
    if (!item) throw new Error(`queue item ${id} not found`)
    return item
  }

  /**
   * Apply a title/body change: re-enforce disclosure, recompute digest, reset to pending, re-materialize,
   * audit. A body change by the human sets data.humanEditedBody (repos requiring human-written PR text);
   * a body change by anyone else (scout/LLM tool) clears it again.
   */
  private applyEdit(id: number, change: { title?: string; body?: string }, actor: AuditActor): QueueItem {
    const item = this.require(id)
    if (!isOpenForDecision(item)) {
      throw new Error(`queue item ${id} is ${item.status}; only pending, dry-run-approved or failed items can be edited`)
    }
    const title = change.title === undefined ? item.title : cleanTitle(change.title)
    const body = change.body === undefined ? item.body : ensureDisclosure(change.body, disclosureFor(this.ctx, item.kind))
    if (title === item.title && body === item.body) return item

    const digest = computeDigest({ kind: item.kind, repo: item.repo, title, body, diff: item.diff, data: item.data })
    const now = this.ctx.clock.now()
    const { dryRun: _dryRun, plannedActions: _planned, humanEditedBody: _edited, ...rest } = item.data
    const bodyChanged = body !== item.body
    const humanEdited = bodyChanged ? actor === "human" : item.data.humanEditedBody === true
    const data: Record<string, unknown> = humanEdited ? { ...rest, humanEditedBody: true } : rest
    const updated: QueueItem = {
      ...item,
      title,
      body,
      digest,
      status: "pending",
      decidedAt: null,
      decisionReason: null,
      error: null,
      updatedAt: now,
      data,
    }
    this.ctx.store.saveQueueItem(updated)
    this.materialize(updated)
    const fields = [title !== item.title ? "title" : null, bodyChanged ? "body" : null].filter((f): f is string => f !== null)
    audit(this.ctx, actor, "queue.edit", `queue:${id}`, "edited", fields, {
      oldDigest: digest8(item),
      newDigest: digest8(updated),
      previousStatus: item.status,
      humanEditedBody: humanEdited,
    })
    return updated
  }
}
