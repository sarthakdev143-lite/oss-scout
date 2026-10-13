/**
 * Shared domain types. Pure data — no behavior, no imports from other modules.
 * Times are epoch milliseconds (`Millis`) unless the field name ends in `At` and the type is `string`
 * (those are ISO-8601 strings straight from GitHub).
 */

export type Millis = number

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

export type RepoSource = "dependency" | "search" | "manual"
/** candidate = discovered, not yet screened; eligible = passed screening; skipped = hard-skipped (see skipReason). */
export type RepoStatus = "candidate" | "eligible" | "skipped"

export interface RepoRecord {
  /** "owner/name" (case preserved as returned by GitHub). */
  fullName: string
  source: RepoSource
  /** Human-readable provenance, e.g. "npm:zod (used by you/app)" or "search: topic:fastapi". */
  sourceDetail: string | null
  status: RepoStatus
  score: number | null
  /** Scoring reasons, positive and negative, human readable. */
  reasons: string[]
  skipReason: string | null
  policy: RepoPolicy | null
  metrics: RepoMetrics | null
  discoveredAt: Millis
  screenedAt: Millis | null
  nextScreenAt: Millis | null
}

export type AiPolicyClass =
  /** Repo explicitly forbids AI/LLM-generated contributions. Always skipped. */
  | "prohibited"
  /** Repo restricts AI use in ways oss-scout cannot satisfy (e.g. "no AI-generated code", "maintainers only"). Skipped. */
  | "restricted"
  /** Mentions AI with restrictive tone but unclear rules. Skipped when screening.skipUnclearRestrictivePolicy. */
  | "unclear_restrictive"
  /** AI allowed if disclosed. oss-scout always discloses, so allowed. */
  | "disclosure_required"
  /** AI explicitly allowed. */
  | "allowed"
  /** No AI policy found. Allowed (disclosure is always included anyway). */
  | "none_found"

export interface PolicyEvidence {
  file: string
  excerpt: string
  rule: string
}

export interface AiPolicyResult {
  classification: AiPolicyClass
  evidence: PolicyEvidence[]
  requiresDisclosure: boolean
  notes: string[]
}

export type CommitConvention = "conventional" | "none" | "unknown"

export interface RepoPolicy {
  ai: AiPolicyResult
  /** Path of the contributing guide that was read, if any. */
  contributingFile: string | null
  /** Truncated contributing text (for implementation / critic prompts). */
  contributingExcerpt: string | null
  codeOfConductFile: string | null
  prTemplatePath: string | null
  prTemplate: string | null
  /** DCO sign-off required (web_commit_signoff_required or CONTRIBUTING mentions DCO / Signed-off-by). */
  requiresSignoff: boolean
  /** A CLA must be signed. oss-scout cannot sign CLAs; flagged to the human in the queue item. */
  requiresCla: boolean
  /** Guide asks contributors to open/discuss an issue or get assigned before sending a PR. */
  requiresIssueFirst: boolean
  /** Guide reserves "good first issue"-type issues for human newcomers (e.g. LLVM, Node.js). Those issues are skipped. */
  reservesGoodFirstIssues: boolean
  commitConvention: CommitConvention
  notes: string[]
}

export interface RepoMetrics {
  stars: number
  forks: number
  archived: boolean
  disabled: boolean
  isFork: boolean
  /** SPDX id or null. "NOASSERTION" is normalized to null. */
  license: string | null
  defaultBranch: string
  language: string | null
  topics: string[]
  pushedAt: string | null
  hasIssues: boolean
  /** has_pull_requests !== false */
  pullRequestsEnabled: boolean
  prCreationPolicy: "all" | "collaborators_only" | null
  allowForking: boolean
  webCommitSignoffRequired: boolean
  /** Latest maintainer activity seen (merged PR, maintainer review/comment, or commit), ISO string. */
  lastMaintainerActivityAt: string | null
  /** Closed outside-contributor PRs sampled. */
  outsidePrSample: number
  outsidePrMerged: number
  /** outsidePrMerged / outsidePrSample, null when sample is 0. */
  outsideMergeRate: number | null
  medianFirstResponseHours: number | null
  firstResponseSample: number
  openPrCount: number
  /** Open PRs with no update in 90+ days. */
  staleOpenPrCount: number
  hasCi: boolean
  ciProviders: string[]
}

export interface ScoreResult {
  /** 0..1 */
  score: number
  reasons: string[]
  /** Non-null = must skip regardless of score. */
  hardSkip: string | null
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export type IssueKind = "bug" | "docs" | "tests" | "enhancement" | "other"
export type IssueStatus = "candidate" | "selected" | "skipped" | "done"

export interface IssueRecord {
  /** "owner/name#123" */
  id: string
  repo: string
  number: number
  title: string
  url: string
  body: string
  labels: string[]
  createdAt: string
  updatedAt: string
  comments: number
  kind: IssueKind
  status: IssueStatus
  score: number | null
  reasons: string[]
  skipReason: string | null
  fetchedAt: Millis
}

// ---------------------------------------------------------------------------
// Tasks (durable, resumable units of work)
// ---------------------------------------------------------------------------

export type TaskKind = "contribution" | "followup_fix"
export type TaskStage = "prepare" | "baseline" | "implement" | "verify" | "critic" | "enqueue" | "done"
/**
 * active  = runnable when nextRunAt <= now
 * waiting = blocked on something external (budget, sandbox missing, rate limit); retried at nextRunAt
 * done    = queued for approval (terminal)
 * aborted = gave up with abortReason (terminal)
 * failed  = unexpected error budget exhausted (terminal)
 */
export type TaskStatus = "active" | "waiting" | "done" | "aborted" | "failed"

export type Ecosystem = "node" | "python" | "java-maven" | "java-gradle" | "unknown"

export interface ProjectInfo {
  ecosystem: Ecosystem
  packageManager: string | null
  /** Container image used for every command of this project. */
  image: string
  install: string | null
  test: string | null
  lint: string | null
  /** Globs/regexes (as strings) that identify test files, used by the verification gate. */
  testFilePatterns: string[]
  notes: string[]
}

export interface CommandRun {
  label: "install" | "test" | "lint" | "custom"
  command: string
  exitCode: number
  timedOut: boolean
  durationMs: number
  /** Last N KB of combined stdout/stderr (redacted). */
  outputTail: string
  network: "none" | "bridge"
  at: Millis
}

export interface AttemptLog {
  attempt: number
  phase: "reproduce" | "fix"
  ok: boolean
  summary: string
  runs: CommandRun[]
  at: Millis
}

export interface DiffFileStat {
  path: string
  /** For renames, the old path. */
  oldPath: string | null
  additions: number
  deletions: number
  binary: boolean
  status: "added" | "modified" | "deleted" | "renamed"
  /** File mode change to/from symlink or executable. */
  modeChange: string | null
}

export interface DiffStat {
  files: DiffFileStat[]
  additions: number
  deletions: number
}

export interface ImplementationOutput {
  /** What changed and why (from the implementer). */
  summary: string
  commitMessage: string
  prTitle: string
  /** PR body as drafted (before disclosure is enforced). */
  prBody: string
  testFiles: string[]
  /** true = failing test observed before the fix; null = not applicable (docs) */
  reproduced: boolean | null
  diff: string
  diffStat: DiffStat
  commitSha: string | null
  baseSha: string
  finalTestRun: CommandRun | null
  finalLintRun: CommandRun | null
}

export type CheckStatus = "pass" | "fail" | "skip"

export interface GateCheck {
  name: string
  status: CheckStatus
  detail: string
}

export interface VerificationReport {
  passed: boolean
  checks: GateCheck[]
}

export interface CriticVerdict {
  verdict: "approve" | "reject"
  /** 0..1 */
  confidence: number
  reasons: string[]
  requiredChanges: string[]
  model: string | null
  /** Raw model output (truncated). */
  raw: string
}

export interface TaskData {
  project?: ProjectInfo
  baseBranch?: string
  baseSha?: string
  /** Fork owner/name the branch will be pushed to (filled at approval). */
  baseline?: CommandRun[]
  attemptsLog?: AttemptLog[]
  implementation?: ImplementationOutput
  verification?: VerificationReport
  critic?: CriticVerdict
  sessionId?: string
  queueItemId?: number
  /** For followup_fix tasks: the review feedback to address. */
  feedback?: string
  [key: string]: unknown
}

export interface TaskRecord {
  id: string
  kind: TaskKind
  repo: string
  issueId: string | null
  /** For followup_fix: "owner/name#prNumber". */
  prId: string | null
  stage: TaskStage
  status: TaskStatus
  /** Implementation attempts consumed. */
  attempts: number
  /** Consecutive infrastructure failures (drives exponential backoff). */
  failures: number
  nextRunAt: Millis
  lastError: string | null
  abortReason: string | null
  /** Task directory <workspacesDir>/<taskId> (contains the repo/ work tree; the git dir is <gitDirsDir>/<taskId>). */
  workspace: string | null
  branch: string | null
  tokensUsed: number
  costUsd: number
  createdAt: Millis
  updatedAt: Millis
  data: TaskData
}

// ---------------------------------------------------------------------------
// Approval queue
// ---------------------------------------------------------------------------

/** pr = open a new PR; reply = post a comment on one of your PRs; fix = push a follow-up commit to your PR branch. */
export type QueueKind = "pr" | "reply" | "fix"
/**
 * pending   = awaiting human review
 * approved  = human approved; in dry-run nothing was written (see data.plannedActions)
 * submitted = human approved and the write succeeded (queue mode)
 * rejected  = human rejected (decisionReason)
 * failed    = approved but the write failed (error)
 * superseded= replaced by a newer item (e.g. PR closed meanwhile)
 */
export type QueueStatus = "pending" | "approved" | "submitted" | "rejected" | "failed" | "superseded"

export interface QueueItem {
  id: number
  kind: QueueKind
  status: QueueStatus
  repo: string
  issueUrl: string | null
  /** For reply/fix: the PR being followed up. For pr: set after submission. */
  prUrl: string | null
  taskId: string | null
  title: string
  body: string
  diff: string
  testOutput: string
  critic: CriticVerdict | null
  verification: VerificationReport | null
  /** Local branch holding the commit(s) to push (pr/fix). */
  branch: string | null
  /** Task directory holding the worktree/gitdir (pr/fix). */
  workspace: string | null
  /** Upstream base branch (pr). */
  baseBranch: string | null
  /** sha256 over kind+repo+title+body+diff; the human must quote its first 8 chars to approve. */
  digest: string
  createdAt: Millis
  updatedAt: Millis
  decidedAt: Millis | null
  decisionReason: string | null
  submittedUrl: string | null
  error: string | null
  data: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Submitted PR tracking
// ---------------------------------------------------------------------------

export type PrState = "open" | "merged" | "closed"

export interface TrackedPr {
  /** "owner/name#123" */
  id: string
  repo: string
  number: number
  url: string
  queueItemId: number | null
  /** Branch name on the fork. */
  branch: string | null
  /** "you/fork-name" */
  headRepo: string | null
  state: PrState
  openedAt: Millis
  closedAt: Millis | null
  mergedAt: Millis | null
  lastPolledAt: Millis | null
  /** ISO timestamp of the newest review/comment already processed. */
  lastSeenActivityAt: string | null
  data: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditActor = "scout" | "human" | "critic" | "system"

export interface AuditEntry {
  id: number
  ts: Millis
  actor: AuditActor
  /** Dotted action name, e.g. "repo.skip", "issue.select", "queue.approve", "github.write". */
  action: string
  /** What the action is about, e.g. "owner/repo", "owner/repo#12", "queue:7". */
  subject: string | null
  decision: string | null
  reasons: string[]
  details: Record<string, unknown>
}

export interface ErrorEntry {
  id: number
  ts: Millis
  scope: string
  message: string
  details: Record<string, unknown>
}

export interface UsageTotals {
  tokens: number
  costUsd: number
  calls: number
}
