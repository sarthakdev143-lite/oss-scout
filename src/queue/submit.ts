import { join } from "node:path"
import { audit, type AppContext } from "../core/context.ts"
import type { PrState, QueueItem, QueueStatus } from "../core/types.ts"
import {
  GitHubError,
  KilledError,
  mintWriteAuthorization,
  RateLimitError,
  WriteForbiddenError,
  type WriteAuthorization,
} from "../github/api.ts"
import type { GhComment, GhPull, GhTimelineEvent } from "../github/types.ts"
import { replyBanReason, syncRepoPrs } from "../followup/followup.ts"
import { canSubmitPr, capsSnapshot, type CapsSnapshot } from "../scheduler/caps.ts"
import { repoBlockReason } from "../scheduler/eligibility.ts"
import { hasAiPolicyFlag } from "../screening/policy.ts"
import { isoToMs } from "../util/clock.ts"
import { tail, type Exec, type ExecResult } from "../util/exec.ts"
import { errorMessage } from "../util/log.ts"
import { redact } from "../util/redact.ts"
import { parseIssueId, splitFullName } from "../util/text.ts"
import { gitPathsFor, isSafeRefName, SafeGit, type GitPaths } from "../workspace/git.ts"
import { computeDigest, digestCommitOf, ensureDisclosure, hasDisclosure } from "./prbody.ts"
import {
  ApprovalQueue,
  digest8,
  humanTextNotice,
  isInterruptedSubmission,
  issueIdOf,
  isOpenForDecision,
  isSubmissionRunning,
  needsHumanWrittenBody,
  QUEUE_FILES,
  SUBMISSION_LEASE_MS,
  submissionsInFlight,
  submittingAt,
} from "./queue.ts"

export interface ApprovalResult {
  ok: boolean
  status: QueueStatus
  message: string
  url: string | null
  /** What was (queue mode) or would have been (dry-run) done, step by step. */
  actions: string[]
}

/** The part of SafeGit the executor needs (injectable for tests). */
export interface GitPusher {
  push(remoteUrl: string, localRef: string, remoteBranch: string, token: string): Promise<ExecResult>
}

export interface SubmitDeps {
  makeGit(paths: GitPaths, exec: Exec): GitPusher
}

export const defaultSubmitDeps: SubmitDeps = {
  makeGit: (paths, exec) => new SafeGit(paths, exec),
}

export const DRY_RUN_PREFIX = "DRY-RUN: approved; nothing was written to GitHub."

const TOKEN_HINT =
  'Set OSS_SCOUT_WRITE_TOKEN to a classic PAT with only the "public_repo" scope (fine-grained PATs cannot write to repositories you do not own), then approve again.'

/** A full git commit sha: what pr/fix approvals push (never a branch name). */
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/

/** A submission step failed with a message meant for the human. */
class SubmitFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SubmitFailure"
  }
}

type Via = "cli" | "command"

/** The exact reviewed commit a pr/fix item pushes (data.commitSha, a full sha), or null. */
export function pushCommitOf(item: Pick<QueueItem, "data">): string | null {
  const sha = item.data.commitSha
  return typeof sha === "string" && COMMIT_SHA_RE.test(sha) ? sha : null
}

const iso = (ms: number): string => new Date(ms).toISOString()

/**
 * THE ONLY CODE PATH THAT WRITES TO GITHUB. Called exclusively from human-facing entry points
 * (CLI `approve`, opencode slash command `/oss-approve`) — never from the scheduler or an LLM tool.
 *
 * Steps: validate item is pending (or an interrupted submission) + digest prefix matches + the digest
 * still covers the content and the commit + kill switch off + the repo is still allowed (deny list,
 * current AI policy, not skipped by a re-screen) + the repo's AI rules (no drafted review replies where
 * the policy wants human-written ones, human-written PR description edited by you, one AI-assisted PR
 * at a time) + caps (open PR per repo, weekly cap, cooldown) still OK → atomically re-check the caps and
 * mark approved (one SQLite IMMEDIATE transaction, so concurrent approvals cannot both take the last
 * slot) → in dry-run: record planned actions and stop → in queue mode: mint WriteAuthorization →
 * (pr) ensure fork, push the reviewed commit, create PR (disclosure re-verified), track PR | (reply)
 * post comment (unless a previous attempt already posted it) | (fix) push the reviewed commit to the
 * PR branch → mark submitted (or failed with a clear, actionable message, e.g. fine-grained PAT
 * limitation + manual compare URL).
 */
export async function approveQueueItem(
  ctx: AppContext,
  input: { id: number; digest: string; via: "cli" | "command" },
): Promise<ApprovalResult> {
  return approveQueueItemWith(ctx, input, {})
}

/** approveQueueItem with injectable git (tests use a fake pusher; nothing is pushed). */
export async function approveQueueItemWith(
  ctx: AppContext,
  input: { id: number; digest: string; via: Via },
  deps: Partial<SubmitDeps> = {},
): Promise<ApprovalResult> {
  const d: SubmitDeps = { ...defaultSubmitDeps, ...deps }
  const queue = new ApprovalQueue(ctx)
  const via = String(input.via)

  const item = ctx.store.getQueueItem(input.id)
  if (!item) return { ok: false, status: "failed", message: `queue item ${input.id} not found`, url: null, actions: [] }

  const refuse = (message: string, status: QueueStatus = item.status): ApprovalResult => {
    audit(ctx, "human", "queue.approve", `queue:${item.id}`, "refused", [message], { via, mode: ctx.config.mode })
    return { ok: false, status, message, url: null, actions: [] }
  }

  // Approval is a human act: only the CLI and the slash command may call this (never an LLM tool).
  if (via !== "cli" && via !== "command") return refuse(`approval via "${via}" is not allowed; use /oss-approve or the CLI`)

  // An "approved" (queue-mode) item whose submission is no longer running anywhere was interrupted
  // (crash/restart mid-submission). Re-approving resumes it; every step is idempotent (fork reuse,
  // existing-PR lookup, pushing the same commit, reply already posted).
  const started = ctx.clock.now()
  const interrupted = isInterruptedSubmission(item, started)
  if (!isOpenForDecision(item) && !interrupted) {
    return refuse(`queue item ${item.id} cannot be approved: ${notApprovableReason(item, started)}`)
  }

  const provided = input.digest.trim().toLowerCase()
  if (!/^[0-9a-f]{8,64}$/.test(provided)) {
    return refuse("the digest must be at least the first 8 hex characters shown for the item")
  }
  // Never echo the current digest here: the human must re-read the item to get it.
  if (!item.digest.toLowerCase().startsWith(provided)) {
    return refuse(
      `digest mismatch for queue item ${item.id}: it changed since you reviewed it, or the digest is mistyped. Review it again (bun src/cli.ts show ${item.id}).`,
    )
  }
  if (computeDigest(item) !== item.digest) {
    if (digestCommitOf(item) && computeDigest({ ...item, commitSha: null }) === item.digest) return rebindLegacyDigest(ctx, queue, item, refuse)
    return refuse(`queue item ${item.id} no longer matches its digest (modified outside the queue); refusing to approve`)
  }
  if (ctx.kill.isEngaged()) {
    return refuse(`kill switch is engaged (${ctx.kill.reason() ?? "engaged"}); approvals are refused until it is released`)
  }

  // The repo may have been deny-listed, re-screened to an AI ban, or skipped since the item was queued.
  const blocked = repoBlockReason(ctx, item.repo, item.kind === "pr" ? "contribution" : "followup")
  if (blocked) return supersedeBlocked(ctx, queue, item, blocked, via)

  // Repos whose AI policy wants review replies written by a human: a drafted reply is never posted.
  if (item.kind === "reply") {
    const ban = replyBanReason(ctx.store.getRepo(item.repo)?.policy?.ai)
    if (ban) {
      return refuse(
        `queue item ${item.id} cannot be approved: ${ban}. Answer the review on GitHub yourself${item.prUrl ? ` (${item.prUrl})` : ""}, then reject this draft (/oss-reject ${item.id} <reason>).`,
      )
    }
  }

  // Repos whose AI policy requires human-written PR text: the human must have written/edited the body.
  if (needsHumanWrittenBody(item)) return refuse(humanTextNotice(item.id))

  // pr/fix items push exactly the commit that was reviewed (and digested), never a branch tip.
  if ((item.kind === "pr" || item.kind === "fix") && ctx.config.mode === "queue" && !pushCommitOf(item)) {
    return refuse(
      `queue item ${item.id} has no recorded commit (data.commitSha), and oss-scout only ever pushes the exact commit you reviewed. It cannot be submitted; reject it (/oss-reject ${item.id} <reason>).`,
    )
  }

  let cachedLogin: string | null = null
  const getLogin = async (): Promise<string> => (cachedLogin ??= await ctx.login())

  if (item.kind === "pr") {
    if (ctx.config.mode === "queue") {
      try {
        // One live look at your PRs in this repo (open, and recently closed for the cooldown) instead
        // of relying only on the periodic sync.
        await syncRepoPrs(ctx, await getLogin(), item.repo)
        if (interrupted) {
          const adopted = await adoptExistingPull(ctx, queue, item, await getLogin(), via)
          if (adopted) return adopted
        }
      } catch (err) {
        if (err instanceof RateLimitError) {
          return refuse(`GitHub rate limit reached while checking your PRs in ${item.repo}; nothing was written. Approve again after ${iso(err.resetAt)}.`)
        }
        if (err instanceof KilledError) return refuse(`kill switch is engaged; approvals are refused until it is released`)
        return refuse(`could not check your pull requests in ${item.repo}: ${errorMessage(err)}. Nothing was written; try again later.`)
      }
    }
    const capped = prCapRefusal(ctx, item, capsSnapshot(ctx.store, ctx.config, ctx.clock.now(), { excludeQueueItemId: item.id }))
    if (capped) return interrupted ? failInterrupted(ctx, queue, item, capped, via) : refuse(`${capped}. The item stays in the queue.`)
  }

  try {
    const stale = await staleReason(ctx, item, getLogin)
    if (stale) {
      const superseded = queue.supersede(item.id, stale)
      if (item.kind === "pr") {
        const issueId = issueIdOf(item)
        if (issueId && ctx.store.getIssue(issueId)) ctx.store.setIssueStatus(issueId, "skipped", stale)
      }
      return { ok: false, status: superseded.status, message: `Not approved; item superseded: ${stale}`, url: null, actions: [] }
    }
  } catch (err) {
    if (err instanceof RateLimitError) {
      return refuse(`GitHub rate limit reached while re-checking the item; nothing was written. Approve again after ${iso(err.resetAt)}.`)
    }
    if (err instanceof KilledError) return refuse(`kill switch is engaged; approvals are refused until it is released`)
    return refuse(`could not verify that the item is still current: ${errorMessage(err)}. Nothing was written; try again later.`)
  }

  // --- approved: re-check the caps and reserve the slot atomically -------------------------------
  const now = ctx.clock.now()
  const reservation = reserveApproval(ctx, item, now, via, interrupted)
  if ("refused" in reservation) return refuse(reservation.refused, reservation.status)
  let current = reservation.current
  const commit = pushCommitOf(item)
  audit(ctx, "human", "queue.approve", `queue:${item.id}`, "approved", [], {
    via,
    mode: ctx.config.mode,
    kind: item.kind,
    repo: item.repo,
    digest: digest8(item),
    ...(commit ? { commit } : {}),
    ...(interrupted ? { resumed: true } : {}),
  })

  if (ctx.config.mode !== "queue") {
    let login = "<your-login>"
    try {
      login = await getLogin()
    } catch {
      // planning only; the login is cosmetic here
    }
    const actions = plannedActions(ctx, current, login)
    current = { ...current, data: { ...current.data, dryRun: true, plannedActions: actions } }
    ctx.store.saveQueueItem(current)
    queue.materialize(current)
    audit(ctx, "human", "queue.dry_run", `queue:${item.id}`, "planned", actions, { mode: ctx.config.mode })
    const message = [
      DRY_RUN_PREFIX,
      "Planned actions:",
      ...actions.map((a) => `  - ${a}`),
      `Set "mode": "queue" in the oss-scout config and approve again to submit.`,
    ].join("\n")
    return { ok: true, status: "approved", message, url: null, actions }
  }

  // A reply that a previous attempt may already have posted (timeout after GitHub accepted it, crash)
  // is looked up before posting again; this attempt is recorded before the POST.
  const previousReplyAttempt = typeof item.data.replyAttemptAt === "number" ? item.data.replyAttemptAt : null
  if (item.kind === "reply") {
    current = { ...current, data: { ...current.data, replyAttemptAt: now } }
    ctx.store.saveQueueItem(current)
  }
  queue.materialize(current)
  const actions: string[] = []
  submissionsInFlight().add(current.id)
  try {
    const auth = mintWriteAuthorization({
      queueItemId: current.id,
      itemStatus: current.status,
      itemDigest: current.digest,
      providedDigest: provided,
      actor: "human",
      via: input.via,
      mode: ctx.config.mode,
      now,
    })
    const done = await submit(ctx, current, auth, d, actions, getLogin, previousReplyAttempt)
    const { submittingAt: _s, ...data } = current.data
    const submitted: QueueItem = {
      ...current,
      status: "submitted",
      submittedUrl: done.url,
      prUrl: done.prUrl ?? current.prUrl,
      error: null,
      updatedAt: ctx.clock.now(),
      data: { ...data, ...done.data },
    }
    ctx.store.saveQueueItem(submitted)
    queue.materialize(submitted)
    audit(ctx, "human", "queue.submit", `queue:${item.id}`, "submitted", actions, { url: done.url })
    return { ok: true, status: "submitted", message: `Submitted: ${done.url ?? "(no url)"}`, url: done.url, actions }
  } catch (err) {
    const message = `${failureMessage(err)}\nRetry later with: /oss-approve ${current.id} ${digest8(current)}`
    const { submittingAt: _s, ...data } = current.data
    const failed: QueueItem = { ...current, status: "failed", error: redact(message), updatedAt: ctx.clock.now(), data }
    ctx.store.saveQueueItem(failed)
    queue.materialize(failed)
    audit(ctx, "human", "queue.submit", `queue:${item.id}`, "failed", [message], { actions })
    return { ok: false, status: "failed", message: redact(message), url: null, actions }
  } finally {
    submissionsInFlight().delete(current.id)
  }
}

function notApprovableReason(item: QueueItem, now: number): string {
  if (!isSubmissionRunning(item, now)) return `it is ${item.status}`
  const at = submittingAt(item)
  if (submissionsInFlight().has(item.id) || at === null) return "it is being submitted right now"
  return `it is being submitted right now (started ${iso(at)}). If that submission was interrupted, approve again after ${iso(at + SUBMISSION_LEASE_MS)}`
}

/**
 * The item was queued before approval digests covered the commit: bind its digest to the commit it
 * pushes, re-materialize it, and ask the human to review it again (the new digest is never echoed).
 */
function rebindLegacyDigest(
  ctx: AppContext,
  queue: ApprovalQueue,
  item: QueueItem,
  refuse: (message: string) => ApprovalResult,
): ApprovalResult {
  const rebound: QueueItem = { ...item, digest: computeDigest(item), updatedAt: ctx.clock.now() }
  ctx.store.saveQueueItem(rebound)
  queue.materialize(rebound)
  audit(ctx, "system", "queue.digest_rebind", `queue:${item.id}`, "rebound", ["digest now covers the commit that approval pushes"], {
    commit: digestCommitOf(item),
  })
  return refuse(
    `queue item ${item.id} was queued before approval digests covered the exact commit; its digest now includes the commit it will push. Review it again (bun src/cli.ts show ${item.id}) and approve with the new digest.`,
  )
}

/** Supersede an item whose repo no longer allows the contribution; a PR item's issue is skipped for good. */
function supersedeBlocked(ctx: AppContext, queue: ApprovalQueue, item: QueueItem, reason: string, via: string): ApprovalResult {
  audit(ctx, "human", "queue.approve", `queue:${item.id}`, "refused", [reason], { via, mode: ctx.config.mode })
  const superseded = queue.supersede(item.id, reason)
  if (item.kind === "pr") {
    const issueId = issueIdOf(item)
    if (issueId && ctx.store.getIssue(issueId)) ctx.store.setIssueStatus(issueId, "skipped", reason, { sticky: true })
  }
  return { ok: false, status: superseded.status, message: `Not approved; item superseded: ${reason}`, url: null, actions: [] }
}

/** Why a PR item may not be submitted now under the caps / one-AI-PR rule (snapshot excludes the item), or null. */
function prCapRefusal(ctx: AppContext, item: QueueItem, snap: CapsSnapshot): string | null {
  const cap = canSubmitPr(snap, item.repo, ctx.config)
  if (!cap.ok) return `cap reached: ${cap.reason}`
  const ai = ctx.store.getRepo(item.repo)?.policy?.ai
  const k = item.repo.toLowerCase()
  const open = (snap.openPrsByRepo[k] ?? 0) + (snap.inFlightByRepo?.[k] ?? 0)
  if (ai && hasAiPolicyFlag(ai, "one_ai_pr_at_a_time") && open > 0) {
    return `${item.repo} allows one AI-assisted PR at a time and you have ${open} open PR(s) there; wait until it is merged or closed`
  }
  return null
}

/** An interrupted submission that can no longer proceed (cap reached since): move it to "failed" so it is not stuck. */
function failInterrupted(ctx: AppContext, queue: ApprovalQueue, item: QueueItem, reason: string, via: string): ApprovalResult {
  const message = `${reason}. The interrupted submission was moved to "failed": approve it again once the cap allows, or reject it (/oss-reject ${item.id} <reason>).`
  const { submittingAt: _s, ...data } = item.data
  const failed: QueueItem = { ...item, status: "failed", error: message, updatedAt: ctx.clock.now(), data }
  ctx.store.saveQueueItem(failed)
  queue.materialize(failed)
  audit(ctx, "human", "queue.approve", `queue:${item.id}`, "refused", [message], { via, mode: ctx.config.mode, interrupted: true })
  return { ok: false, status: "failed", message, url: null, actions: [] }
}

type Reservation = { current: QueueItem } | { refused: string; status: QueueStatus }

/**
 * Mark the item approved in one IMMEDIATE transaction that first re-reads it (it must be unchanged
 * since the checks above) and re-checks the PR caps, counting other approvals still being submitted.
 * Two approvals (even from two processes: CLI and opencode) can therefore never both take the last slot.
 */
function reserveApproval(ctx: AppContext, item: QueueItem, now: number, via: string, interrupted: boolean): Reservation {
  return ctx.store.transactionImmediate((): Reservation => {
    const fresh = ctx.store.getQueueItem(item.id)
    const changed =
      !fresh ||
      fresh.status !== item.status ||
      fresh.digest !== item.digest ||
      fresh.updatedAt !== item.updatedAt ||
      submittingAt(fresh) !== submittingAt(item)
    if (changed) {
      return {
        refused: `queue item ${item.id} changed while it was being approved (another approval, edit or decision); review it again (bun src/cli.ts show ${item.id})`,
        status: fresh?.status ?? item.status,
      }
    }
    if (isSubmissionRunning(fresh, now)) return { refused: `queue item ${item.id} is being submitted right now`, status: fresh.status }
    if (item.kind === "pr") {
      const capped = prCapRefusal(ctx, item, capsSnapshot(ctx.store, ctx.config, now, { excludeQueueItemId: item.id }))
      if (capped) return { refused: `${capped}. The item stays in the queue.`, status: item.status }
    }
    const { dryRun: _dryRun, plannedActions: _planned, submittingAt: _submitting, ...data } = item.data
    const current: QueueItem = {
      ...item,
      status: "approved",
      decidedAt: now,
      decisionReason: `approved by human via ${via}${interrupted ? " (resumed)" : ""}`,
      error: null,
      updatedAt: now,
      // Queue mode: the submission "lease" that tells other processes this item is being submitted.
      data: ctx.config.mode === "queue" ? { ...data, submittingAt: now } : data,
    }
    ctx.store.saveQueueItem(current)
    return { current }
  })
}

/**
 * An interrupted PR submission whose PR already exists (crash after createPull): adopt the PR instead
 * of failing on the caps it now occupies. Read-only.
 */
async function adoptExistingPull(
  ctx: AppContext,
  queue: ApprovalQueue,
  item: QueueItem,
  login: string,
  via: string,
): Promise<ApprovalResult | null> {
  if (!item.branch) return null
  const head = `${login}:${item.branch}`
  const pulls = await ctx.github.listPulls(item.repo, { head, state: "all", max: 10 })
  const pull = pulls.find((p) => p.state === "open") ?? pulls[0] ?? null
  if (!pull) return null
  const fork = pull.head.repo?.full_name ?? `${login}/${splitFullName(item.repo).name}`
  trackPull(ctx, item, pull, fork, item.branch)
  const { submittingAt: _s, ...data } = item.data
  const submitted: QueueItem = {
    ...item,
    status: "submitted",
    submittedUrl: pull.html_url,
    prUrl: pull.html_url,
    error: null,
    updatedAt: ctx.clock.now(),
    data: { ...data, prNumber: pull.number, headRepo: fork },
  }
  ctx.store.saveQueueItem(submitted)
  queue.materialize(submitted)
  const actions = [`found existing PR ${pull.html_url} for ${head} (the interrupted submission had opened it); not opening another`]
  audit(ctx, "human", "queue.submit", `queue:${item.id}`, "submitted", actions, { url: pull.html_url, via, resumed: true })
  return { ok: true, status: "submitted", message: `Submitted: ${pull.html_url} (the interrupted submission had already opened it)`, url: pull.html_url, actions }
}

// ---------------------------------------------------------------------------
// freshness (read-only)
// ---------------------------------------------------------------------------

/** Why the item should no longer be submitted (issue closed/assigned/taken, PR closed), or null. */
async function staleReason(ctx: AppContext, item: QueueItem, getLogin: () => Promise<string>): Promise<string | null> {
  if (item.kind === "pr") {
    const issueId = issueIdOf(item)
    if (!issueId) return null
    const { repo, number } = parseIssueId(issueId)
    let issue
    try {
      issue = await ctx.github.getIssue(repo, number)
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 410)) return `issue ${issueId} no longer exists`
      throw err
    }
    if (issue.state !== "open") return `issue ${issueId} was closed${issue.state_reason ? ` (${issue.state_reason})` : ""}`
    const me = (await getLogin()).toLowerCase()
    const others = (issue.assignees ?? []).map((a) => a.login).filter((l) => l.toLowerCase() !== me)
    if (others.length) return `issue ${issueId} is now assigned to ${others.map((l) => `@${l}`).join(", ")}`
    const timeline = await ctx.github.listIssueTimeline(repo, number, { max: 300 })
    const competing = await competingPullRequests(ctx, repo, timeline, me)
    if (competing.length) return `issue ${issueId} already has an open pull request by someone else: ${competing.join(", ")}`
    return null
  }
  if (item.kind === "fix") {
    const n = prNumberOf(item)
    if (n === null) return null
    const pull = await ctx.github.getPull(item.repo, n)
    if (pull.merged_at || pull.merged) return `pull request ${item.repo}#${n} was merged`
    if (pull.state !== "open") return `pull request ${item.repo}#${n} was closed`
  }
  return null
}

function repoFromHtmlUrl(url: string | undefined): string | null {
  const m = url ? /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\//i.exec(url) : null
  return m ? m[1]! : null
}

/** Open PRs in `repo` linked to the issue whose author is not `me` ("owner/repo#n by @x"). */
async function competingPullRequests(ctx: AppContext, repo: string, timeline: GhTimelineEvent[], me: string): Promise<string[]> {
  const linked = new Map<number, string | null>()
  for (const ev of timeline) {
    if (ev.event === "cross-referenced") {
      const src = ev.source?.issue
      if (!src?.pull_request || src.state !== "open" || src.pull_request.merged_at) continue
      const srcRepo = src.repository?.full_name ?? repoFromHtmlUrl(src.html_url) ?? repo
      if (srcRepo.toLowerCase() !== repo.toLowerCase()) continue
      const author = (src as { user?: { login?: string } | null }).user?.login ?? null
      linked.set(src.number, author)
    } else if (ev.event === "connected" || ev.event === "disconnected") {
      const subject = ev.subject
      if (!subject || typeof subject.number !== "number") continue
      if (subject.type && !/pull/i.test(subject.type)) continue
      if (ev.event === "disconnected" || (subject.state ?? "open").toLowerCase() !== "open" || subject.merged_at) {
        linked.delete(subject.number)
      } else if (!linked.has(subject.number)) {
        linked.set(subject.number, null)
      }
    }
  }
  const out: string[] = []
  for (const [number, knownAuthor] of linked) {
    let author = knownAuthor
    if (author === null) {
      const pull = await ctx.github.getPull(repo, number)
      if (pull.state !== "open") continue
      author = pull.user?.login ?? "unknown"
    }
    if (author.toLowerCase() !== me) out.push(`${repo}#${number} by @${author}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// planning (dry-run)
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

function prNumberOf(item: QueueItem): number | null {
  const n = item.data.prNumber
  if (typeof n === "number" && Number.isInteger(n) && n > 0) return n
  const m = item.prUrl ? /\/pull\/(\d+)/.exec(item.prUrl) : null
  return m ? Number(m[1]) : null
}

function forkTarget(item: QueueItem, login: string): string {
  return `${login}/${splitFullName(item.repo).name}`
}

/** "commit 1a2b3c4d5e6f (reviewed)" or the refusal queue mode would give. */
function commitText(item: QueueItem): string {
  const sha = pushCommitOf(item)
  return sha ? `commit ${sha.slice(0, 12)} (the reviewed commit)` : "<no recorded commit: queue mode refuses to submit this item>"
}

/** Exact steps the executor would take for this item. */
export function plannedActions(ctx: AppContext, item: QueueItem, login: string): string[] {
  const dir = join(ctx.paths.queueDir, String(item.id))
  if (item.kind === "pr") {
    const fork = forkTarget(item, login)
    const head = `${login}:${item.branch ?? "<branch>"}`
    const body = ensureDisclosure(item.body, ctx.config.disclosure.line)
    const issueId = issueIdOf(item)
    return [
      `ensure fork ${fork} of ${item.repo} exists (reuse it, or create it with POST /repos/${item.repo}/forks)`,
      `push ${commitText(item)} from task ${item.taskId ?? "<missing>"} to https://github.com/${fork}.git as ${item.branch ?? "<missing>"} (no force)`,
      `look for an existing PR on ${item.repo} with head ${head}`,
      `open PR on ${item.repo}: head ${head} -> base ${item.baseBranch ?? "<missing>"}, title ${JSON.stringify(item.title)}, body from ${join(dir, QUEUE_FILES.body)} (${body.length} chars, AI disclosure included), maintainer_can_modify=true, draft=false`,
      `track the PR for follow-up${issueId ? ` and mark issue ${issueId} done` : ""}`,
    ]
  }
  if (item.kind === "reply") {
    const n = prNumberOf(item)
    const body = ensureDisclosure(item.body, ctx.config.disclosure.replyLine)
    return [
      `post a comment on ${item.repo}#${n ?? "<missing>"}${item.prUrl ? ` (${item.prUrl})` : ""}: body from ${join(dir, QUEUE_FILES.body)} (${body.length} chars, AI disclosure included)`,
    ]
  }
  const headRepo = str(item.data.headRepo) ?? "<your fork>"
  const remoteBranch = str(item.data.remoteBranch) ?? item.branch ?? "<branch>"
  return [
    `push ${commitText(item)} to https://github.com/${headRepo}.git as ${remoteBranch} (no force)${item.prUrl ? `, updating ${item.prUrl}` : ""}`,
  ]
}

// ---------------------------------------------------------------------------
// execution (queue mode)
// ---------------------------------------------------------------------------

interface SubmitOutcome {
  url: string | null
  prUrl: string | null
  data: Record<string, unknown>
}

function auditWrite(
  ctx: AppContext,
  item: QueueItem,
  action: string,
  decision: "attempt" | "ok" | "failed",
  details: Record<string, unknown>,
): void {
  audit(ctx, "human", decision === "attempt" ? "github.write.attempt" : "github.write", `queue:${item.id}`, decision, [action], {
    action,
    repo: item.repo,
    ...details,
  })
}

/** Run one write; audits the attempt and the outcome. */
async function write<T>(
  ctx: AppContext,
  item: QueueItem,
  action: string,
  details: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  auditWrite(ctx, item, action, "attempt", details)
  try {
    const out = await fn()
    auditWrite(ctx, item, action, "ok", details)
    return out
  } catch (err) {
    auditWrite(ctx, item, action, "failed", { ...details, error: errorMessage(err) })
    throw err
  }
}

async function submit(
  ctx: AppContext,
  item: QueueItem,
  auth: WriteAuthorization,
  deps: SubmitDeps,
  actions: string[],
  getLogin: () => Promise<string>,
  previousReplyAttempt: number | null,
): Promise<SubmitOutcome> {
  switch (item.kind) {
    case "pr":
      return submitPr(ctx, item, auth, deps, actions, getLogin)
    case "reply":
      return submitReply(ctx, item, auth, actions, getLogin, previousReplyAttempt)
    case "fix":
      return submitFix(ctx, item, deps, actions, getLogin)
  }
}

function requireToken(ctx: AppContext): string {
  const token = ctx.secrets.writeToken()
  if (!token) throw new SubmitFailure(`no token available for git push. Set OSS_SCOUT_WRITE_TOKEN (or GITHUB_TOKEN). ${TOKEN_HINT}`)
  return token
}

/**
 * Push EXACTLY the reviewed commit (data.commitSha) to `remoteBranch` on `target` (`<sha>:refs/heads/<branch>`,
 * never force). The local branch may have moved on since review (e.g. a later follow-up fix in the same
 * workspace); that never changes what an approval pushes.
 */
async function pushCommit(ctx: AppContext, item: QueueItem, deps: SubmitDeps, target: string, remoteBranch: string): Promise<string> {
  const commit = pushCommitOf(item)
  if (!commit) throw new SubmitFailure(`queue item ${item.id} has no recorded commit (data.commitSha); oss-scout only pushes the exact commit you reviewed`)
  // Follow-up fixes may reuse the original task's workspace (and therefore its git dir).
  const workspaceTaskId = str(item.data.workspaceTaskId) ?? item.taskId
  if (!workspaceTaskId) throw new SubmitFailure(`queue item ${item.id} has no task workspace to push from`)
  if (!isSafeRefName(commit) || !isSafeRefName(remoteBranch)) throw new SubmitFailure(`invalid commit or branch name for queue item ${item.id}`)
  const token = requireToken(ctx)
  const git = deps.makeGit(gitPathsFor(ctx.paths, workspaceTaskId), ctx.exec)
  await write(ctx, item, "git.push", { target, branch: remoteBranch, commit }, async () => {
    const r = await git.push(`https://github.com/${target}.git`, commit, remoteBranch, token)
    if (r.exitCode === 0 && !r.timedOut) return
    const detail = tail(redact((r.stderr || r.stdout).split(token).join("[REDACTED]").trim()), 800)
    throw new SubmitFailure(
      `git push to ${target} failed (${r.timedOut ? "timed out" : `exit code ${r.exitCode}`}): ${detail || "no output"}\n` +
        `Hint: the write token must be allowed to push to ${target}. A fine-grained PAT needs "Contents: write" on the fork, and the fork must be included in the token's repository access ("All repositories", or add it under "Only select repositories"). ${TOKEN_HINT}`,
    )
  })
  return commit
}

async function ensureFork(
  ctx: AppContext,
  item: QueueItem,
  auth: WriteAuthorization,
  login: string,
  actions: string[],
): Promise<string> {
  const upstream = item.repo.toLowerCase()
  const candidate = forkTarget(item, login)
  if (candidate.toLowerCase() === upstream) {
    actions.push(`${item.repo} is your own repository; pushing the branch there`)
    return item.repo
  }
  try {
    const existing = await ctx.githubWriter.getRepo(candidate)
    const parent = existing.parent?.full_name.toLowerCase()
    const source = existing.source?.full_name.toLowerCase()
    if (existing.fork && (parent === upstream || source === upstream)) {
      actions.push(`reused fork ${existing.full_name}`)
      return existing.full_name
    }
  } catch (err) {
    if (!(err instanceof GitHubError && err.status === 404)) throw err
  }
  try {
    const fork = await write(ctx, item, "createFork", { target: item.repo }, () => ctx.githubWriter.createFork(auth, item.repo))
    actions.push(`created fork ${fork.full_name}`)
    return fork.full_name
  } catch (err) {
    if (err instanceof GitHubError && err.status === 403) {
      throw new SubmitFailure(
        `GitHub refused to create a fork of ${item.repo} with this token (403: ${err.message}). ` +
          `Fork it yourself at https://github.com/${item.repo}/fork (keep the name), then approve again. ${TOKEN_HINT}`,
      )
    }
    throw err
  }
}

function prState(pull: GhPull): PrState {
  if (pull.merged_at || pull.merged) return "merged"
  return pull.state === "closed" ? "closed" : "open"
}

/** Track a PR opened for (or adopted by) a pr item, and mark its issue done. */
function trackPull(ctx: AppContext, item: QueueItem, pull: GhPull, fork: string, branch: string, state: PrState = prState(pull)): string {
  const now = ctx.clock.now()
  const prId = `${item.repo}#${pull.number}`
  const tracked = ctx.store.getPr(prId)
  const { external: _external, ...prevData } = tracked?.data ?? {}
  const issueId = issueIdOf(item)
  ctx.store.upsertPr({
    id: prId,
    repo: item.repo,
    number: pull.number,
    url: pull.html_url,
    queueItemId: item.id,
    branch,
    headRepo: fork,
    state,
    openedAt: tracked?.openedAt ?? now,
    closedAt: state === "open" ? null : (isoToMs(pull.closed_at) ?? now),
    mergedAt: state === "merged" ? (isoToMs(pull.merged_at) ?? now) : null,
    lastPolledAt: tracked?.lastPolledAt ?? null,
    lastSeenActivityAt: tracked?.lastSeenActivityAt ?? null,
    data: { ...prevData, issueId, title: item.title },
  })
  if (issueId && ctx.store.getIssue(issueId)) ctx.store.setIssueStatus(issueId, "done")
  return prId
}

async function submitPr(
  ctx: AppContext,
  item: QueueItem,
  auth: WriteAuthorization,
  deps: SubmitDeps,
  actions: string[],
  getLogin: () => Promise<string>,
): Promise<SubmitOutcome> {
  const { branch, baseBranch } = item
  if (!item.taskId || !branch || !baseBranch) {
    throw new SubmitFailure(`queue item ${item.id} is missing its task, branch or base branch; it cannot be submitted`)
  }
  const login = await getLogin()
  const fork = await ensureFork(ctx, item, auth, login, actions)
  const forkOwner = splitFullName(fork).owner

  const commit = await pushCommit(ctx, item, deps, fork, branch)
  actions.push(`pushed commit ${commit.slice(0, 12)} to ${fork} as ${branch}`)

  const head = `${forkOwner}:${branch}`
  const existing = await ctx.github.listPulls(item.repo, { head, state: "all", max: 10 })
  let pull = existing.find((p) => p.state === "open") ?? existing[0] ?? null
  // A PR we just created is open by definition; an existing one keeps the state GitHub reports.
  const state: PrState = pull ? prState(pull) : "open"
  if (pull) {
    actions.push(`found existing PR ${pull.html_url} for ${head}; not opening another`)
  } else {
    const line = ctx.config.disclosure.line
    const body = ensureDisclosure(item.body, line)
    if (!hasDisclosure(body, line)) throw new SubmitFailure("refusing to open a PR whose body lacks a visible AI disclosure line")
    try {
      pull = await write(ctx, item, "createPull", { target: item.repo, head, base: baseBranch }, () =>
        ctx.githubWriter.createPull(auth, item.repo, {
          title: item.title,
          body,
          head,
          base: baseBranch,
          maintainerCanModify: true,
          draft: false,
        }),
      )
    } catch (err) {
      if (err instanceof GitHubError && err.isTokenPermissionError) {
        const dir = join(ctx.paths.queueDir, String(item.id))
        throw new SubmitFailure(
          [
            `GitHub refused to open the pull request with this token (403: ${err.message}).`,
            "Fine-grained personal access tokens cannot open PRs on repositories you don't own.",
            `The branch is already pushed to ${fork}. Either:`,
            `  - ${TOKEN_HINT}`,
            `  - or open the PR yourself: https://github.com/${item.repo}/compare/${baseBranch}...${forkOwner}:${branch}?expand=1`,
            `    title: ${join(dir, QUEUE_FILES.title)}`,
            `    body:  ${join(dir, QUEUE_FILES.body)} (keep the AI disclosure line)`,
          ].join("\n"),
        )
      }
      throw err
    }
    actions.push(`opened PR ${pull.html_url}`)
  }

  const prId = trackPull(ctx, item, pull, fork, branch, state)
  actions.push(`tracking ${prId}`)
  return { url: pull.html_url, prUrl: pull.html_url, data: { prNumber: pull.number, headRepo: fork } }
}

const normalizeComment = (s: string): string => s.replace(/\r\n?/g, "\n").trim()

/** A comment of yours on the PR, created since `since` (minus a margin), whose body is exactly `body`. */
async function findPostedReply(
  ctx: AppContext,
  repo: string,
  n: number,
  body: string,
  login: string,
  since: number,
): Promise<GhComment | null> {
  const comments = await ctx.github.listIssueComments(repo, n, { since: new Date(since - 10 * 60_000).toISOString(), max: 100 })
  const want = normalizeComment(body)
  const me = login.toLowerCase()
  return comments.find((c) => (c.user?.login ?? "").toLowerCase() === me && normalizeComment(c.body ?? "") === want) ?? null
}

async function submitReply(
  ctx: AppContext,
  item: QueueItem,
  auth: WriteAuthorization,
  actions: string[],
  getLogin: () => Promise<string>,
  previousAttempt: number | null,
): Promise<SubmitOutcome> {
  const n = prNumberOf(item)
  if (n === null) throw new SubmitFailure(`reply item ${item.id} has no PR number`)
  const line = ctx.config.disclosure.replyLine
  const body = ensureDisclosure(item.body, line)
  if (!hasDisclosure(body, line)) throw new SubmitFailure("refusing to post a reply that lacks a visible AI disclosure line")
  // A retry (failed/interrupted earlier attempt): GitHub may have accepted the comment before the
  // timeout or crash. Never post it twice.
  if (previousAttempt !== null) {
    const posted = await findPostedReply(ctx, item.repo, n, body, await getLogin(), previousAttempt)
    if (posted) {
      const url = posted.html_url ?? item.prUrl
      actions.push(`the reply was already posted by an earlier attempt${url ? ` (${url})` : ""}; not posting it again`)
      return { url, prUrl: item.prUrl, data: {} }
    }
  }
  const comment = await write(ctx, item, "createIssueComment", { target: `${item.repo}#${n}` }, () =>
    ctx.githubWriter.createIssueComment(auth, item.repo, n, body),
  )
  const url = comment.html_url ?? item.prUrl
  actions.push(`commented on ${item.repo}#${n}${url ? ` (${url})` : ""}`)
  return { url, prUrl: item.prUrl, data: {} }
}

async function submitFix(
  ctx: AppContext,
  item: QueueItem,
  deps: SubmitDeps,
  actions: string[],
  getLogin: () => Promise<string>,
): Promise<SubmitOutcome> {
  const n = prNumberOf(item)
  const tracked = n !== null ? ctx.store.getPr(`${item.repo}#${n}`) : null
  const headRepo = str(item.data.headRepo) ?? tracked?.headRepo ?? null
  const remoteBranch = str(item.data.remoteBranch) ?? tracked?.branch ?? item.branch
  if (!headRepo || !remoteBranch) {
    throw new SubmitFailure(`fix item ${item.id} is missing the PR's branch or head repository`)
  }
  const login = await getLogin()
  if (splitFullName(headRepo).owner.toLowerCase() !== login.toLowerCase()) {
    throw new SubmitFailure(`refusing to push to ${headRepo}: it is not a repository owned by ${login}`)
  }
  const commit = await pushCommit(ctx, item, deps, headRepo, remoteBranch)
  actions.push(`pushed commit ${commit.slice(0, 12)} to ${headRepo} (${remoteBranch})`)
  return { url: item.prUrl, prUrl: item.prUrl, data: {} }
}

/** Human-readable, actionable failure text (always redacted). */
function failureMessage(err: unknown): string {
  if (err instanceof SubmitFailure) return redact(err.message)
  if (err instanceof RateLimitError) {
    return `GitHub ${err.secondary ? "secondary " : ""}rate limit reached (${err.resource}); submission stopped. Completed steps (fork, push) are reused on retry. Approve again after ${new Date(err.resetAt).toISOString()}.`
  }
  if (err instanceof KilledError) return "The kill switch was engaged during submission; nothing further was written. Release it, then approve again."
  if (err instanceof WriteForbiddenError) return `GitHub write refused: ${redact(err.message)}. Check that "mode" is "queue".`
  if (err instanceof GitHubError) {
    const perms = err.acceptedPermissions ? ` (token needs: ${err.acceptedPermissions})` : ""
    return `GitHub API error ${err.status}: ${redact(err.message)}${perms}`
  }
  return `submission failed: ${errorMessage(err)}`
}
