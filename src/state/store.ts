import type { Database } from "bun:sqlite"
import type {
  AuditActor,
  AuditEntry,
  ErrorEntry,
  IssueRecord,
  IssueStatus,
  Millis,
  PrState,
  QueueItem,
  QueueKind,
  QueueStatus,
  RepoRecord,
  RepoSource,
  RepoStatus,
  TaskKind,
  TaskRecord,
  TaskStatus,
  TrackedPr,
  UsageTotals,
} from "../core/types.ts"
import { redact, redactValue } from "../util/redact.ts"

type Row = Record<string, unknown>

function json<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || text === "") return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""))
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0))
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

function inList(values: readonly string[]): { sql: string; params: Record<string, string> } {
  const params: Record<string, string> = {}
  const names = values.map((v, i) => {
    params[`in${i}`] = v
    return `$in${i}`
  })
  return { sql: `(${names.join(", ")})`, params }
}

function asArray<T extends string>(v: T | T[] | undefined): T[] | undefined {
  if (v === undefined) return undefined
  return Array.isArray(v) ? v : [v]
}

/**
 * Task data as persisted: redacted, EXCEPT the implementation diff. The diff is the code that gets
 * reviewed, scanned for secrets by the verification gate and pushed on approval; masking token
 * shapes in it would blind the secrets check and make the reviewed diff differ from the commit.
 */
function persistedTaskData(data: TaskRecord["data"]): unknown {
  const redacted = redactValue(data) as Record<string, unknown>
  const impl = data.implementation
  const out = redacted.implementation
  if (impl && typeof impl.diff === "string" && out && typeof out === "object") {
    redacted.implementation = { ...(out as Record<string, unknown>), diff: impl.diff }
  }
  return redacted
}

/**
 * Typed persistence for every durable entity. All writes are synchronous (bun:sqlite) so a
 * crash never leaves half-written state; multi-row updates use `transaction()`.
 */
export class Store {
  constructor(readonly db: Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  /**
   * BEGIN IMMEDIATE transaction: takes the write lock up front, so a read-check-write inside `fn`
   * (e.g. caps re-check + reserving an approval) is serialized across processes sharing the DB.
   */
  transactionImmediate<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate()
  }

  // -------------------------------------------------------------------------
  // repos
  // -------------------------------------------------------------------------

  private repoFromRow(r: Row): RepoRecord {
    return {
      fullName: str(r.full_name),
      source: str(r.source) as RepoSource,
      sourceDetail: strOrNull(r.source_detail),
      status: str(r.status) as RepoStatus,
      score: numOrNull(r.score),
      reasons: json<string[]>(r.reasons, []),
      skipReason: strOrNull(r.skip_reason),
      policy: json(r.policy, null),
      metrics: json(r.metrics, null),
      discoveredAt: num(r.discovered_at),
      screenedAt: numOrNull(r.screened_at),
      nextScreenAt: numOrNull(r.next_screen_at),
    }
  }

  /** Insert a newly discovered repo; existing rows are left untouched. Returns the stored record and whether it was new. */
  upsertRepoCandidate(
    input: { fullName: string; source: RepoSource; sourceDetail: string | null },
    now: Millis,
  ): { repo: RepoRecord; created: boolean } {
    const existing = this.getRepo(input.fullName)
    if (existing) return { repo: existing, created: false }
    this.db
      .query(
        `INSERT INTO repos(full_name, source, source_detail, status, reasons, discovered_at, next_screen_at)
         VALUES ($full_name, $source, $source_detail, 'candidate', '[]', $now, $now)`,
      )
      .run({ full_name: input.fullName, source: input.source, source_detail: input.sourceDetail, now })
    return { repo: this.getRepo(input.fullName)!, created: true }
  }

  getRepo(fullName: string): RepoRecord | null {
    const r = this.db.query("SELECT * FROM repos WHERE full_name = $n").get({ n: fullName }) as Row | null
    return r ? this.repoFromRow(r) : null
  }

  saveRepo(rec: RepoRecord): void {
    this.db
      .query(
        `INSERT INTO repos(full_name, source, source_detail, status, score, reasons, skip_reason, policy, metrics,
                           discovered_at, screened_at, next_screen_at)
         VALUES ($full_name, $source, $source_detail, $status, $score, $reasons, $skip_reason, $policy, $metrics,
                 $discovered_at, $screened_at, $next_screen_at)
         ON CONFLICT(full_name) DO UPDATE SET
           source=excluded.source, source_detail=excluded.source_detail, status=excluded.status, score=excluded.score,
           reasons=excluded.reasons, skip_reason=excluded.skip_reason, policy=excluded.policy, metrics=excluded.metrics,
           screened_at=excluded.screened_at, next_screen_at=excluded.next_screen_at`,
      )
      .run({
        full_name: rec.fullName,
        source: rec.source,
        source_detail: rec.sourceDetail,
        status: rec.status,
        score: rec.score,
        reasons: JSON.stringify(rec.reasons),
        skip_reason: rec.skipReason,
        policy: rec.policy ? JSON.stringify(rec.policy) : null,
        metrics: rec.metrics ? JSON.stringify(rec.metrics) : null,
        discovered_at: rec.discoveredAt,
        screened_at: rec.screenedAt,
        next_screen_at: rec.nextScreenAt,
      })
  }

  listRepos(
    filter: {
      status?: RepoStatus | RepoStatus[]
      /** Only repos with next_screen_at <= this. */
      dueForScreenAt?: Millis
      limit?: number
      orderBy?: "score" | "discovered" | "screened"
    } = {},
  ): RepoRecord[] {
    const where: string[] = []
    let params: Record<string, string | number> = {}
    const statuses = asArray(filter.status)
    if (statuses) {
      const l = inList(statuses)
      where.push(`status IN ${l.sql}`)
      params = { ...params, ...l.params }
    }
    if (filter.dueForScreenAt !== undefined) {
      where.push("(next_screen_at IS NULL OR next_screen_at <= $due)")
      params.due = filter.dueForScreenAt
    }
    const order =
      filter.orderBy === "score"
        ? "ORDER BY score DESC NULLS LAST, full_name"
        : filter.orderBy === "screened"
          ? "ORDER BY screened_at DESC NULLS LAST"
          : "ORDER BY discovered_at ASC, full_name"
    const limit = filter.limit ? `LIMIT ${Math.max(1, Math.floor(filter.limit))}` : ""
    const sql = `SELECT * FROM repos ${where.length ? "WHERE " + where.join(" AND ") : ""} ${order} ${limit}`
    return (this.db.query(sql).all(params) as Row[]).map((r) => this.repoFromRow(r))
  }

  countRepos(): Record<RepoStatus, number> {
    const rows = this.db.query("SELECT status, COUNT(*) AS n FROM repos GROUP BY status").all() as Row[]
    const out: Record<RepoStatus, number> = { candidate: 0, eligible: 0, skipped: 0 }
    for (const r of rows) out[str(r.status) as RepoStatus] = num(r.n)
    return out
  }

  // -------------------------------------------------------------------------
  // issues
  // -------------------------------------------------------------------------

  private issueFromRow(r: Row): IssueRecord {
    return {
      id: str(r.id),
      repo: str(r.repo),
      number: num(r.number),
      title: str(r.title),
      url: str(r.url),
      body: str(r.body),
      labels: json<string[]>(r.labels, []),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
      comments: num(r.comments),
      kind: str(r.kind) as IssueRecord["kind"],
      status: str(r.status) as IssueStatus,
      score: numOrNull(r.score),
      reasons: json<string[]>(r.reasons, []),
      skipReason: strOrNull(r.skip_reason),
      fetchedAt: num(r.fetched_at),
    }
  }

  /**
   * Insert or update an issue. An issue already selected/done keeps its status unless `force` is set.
   * A sticky issue (rejected by the human, or its task aborted/failed: see setIssueStatus) always keeps
   * its status and skip reason, even with `force`; only its descriptive fields are refreshed.
   */
  upsertIssue(rec: IssueRecord, opts: { force?: boolean } = {}): void {
    const existing = this.getIssue(rec.id)
    const sticky = existing !== null && this.isIssueSticky(rec.id)
    const status = sticky
      ? existing.status
      : existing && !opts.force && (existing.status === "selected" || existing.status === "done")
        ? existing.status
        : rec.status
    const skipReason = sticky ? existing.skipReason : rec.skipReason
    this.db
      .query(
        `INSERT INTO issues(id, repo, number, title, url, body, labels, created_at, updated_at, comments, kind, status,
                            score, reasons, skip_reason, fetched_at)
         VALUES ($id, $repo, $number, $title, $url, $body, $labels, $created_at, $updated_at, $comments, $kind, $status,
                 $score, $reasons, $skip_reason, $fetched_at)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, url=excluded.url, body=excluded.body, labels=excluded.labels,
           updated_at=excluded.updated_at, comments=excluded.comments, kind=excluded.kind, status=excluded.status,
           score=excluded.score, reasons=excluded.reasons, skip_reason=excluded.skip_reason, fetched_at=excluded.fetched_at`,
      )
      .run({
        id: rec.id,
        repo: rec.repo,
        number: rec.number,
        title: rec.title,
        url: rec.url,
        body: rec.body,
        labels: JSON.stringify(rec.labels),
        created_at: rec.createdAt,
        updated_at: rec.updatedAt,
        comments: rec.comments,
        kind: rec.kind,
        status,
        score: rec.score,
        reasons: JSON.stringify(rec.reasons),
        skip_reason: skipReason,
        fetched_at: rec.fetchedAt,
      })
  }

  getIssue(id: string): IssueRecord | null {
    const r = this.db.query("SELECT * FROM issues WHERE id = $id").get({ id }) as Row | null
    return r ? this.issueFromRow(r) : null
  }

  /**
   * Set an issue's status and skip reason. `sticky: true` marks the decision as final (human reject,
   * task aborted or failed): upsertIssue never overwrites it, and selection never re-candidates it.
   * `sticky: false` clears the mark; leaving it out keeps the current mark.
   */
  setIssueStatus(id: string, status: IssueStatus, skipReason: string | null = null, opts: { sticky?: boolean } = {}): void {
    if (opts.sticky === undefined) {
      this.db.query("UPDATE issues SET status = $status, skip_reason = $skip WHERE id = $id").run({ id, status, skip: skipReason })
      return
    }
    this.db
      .query("UPDATE issues SET status = $status, skip_reason = $skip, sticky = $sticky WHERE id = $id")
      .run({ id, status, skip: skipReason, sticky: opts.sticky ? 1 : 0 })
  }

  /** true when the issue's status is a final human/task decision (see setIssueStatus). Unknown ids: false. */
  isIssueSticky(id: string): boolean {
    const r = this.db.query("SELECT sticky FROM issues WHERE id = $id").get({ id }) as Row | null
    return r !== null && num(r.sticky) === 1
  }

  listIssues(
    filter: { repo?: string; status?: IssueStatus | IssueStatus[]; minScore?: number; limit?: number } = {},
  ): IssueRecord[] {
    const where: string[] = []
    let params: Record<string, string | number> = {}
    if (filter.repo) {
      where.push("repo = $repo")
      params.repo = filter.repo
    }
    const statuses = asArray(filter.status)
    if (statuses) {
      const l = inList(statuses)
      where.push(`status IN ${l.sql}`)
      params = { ...params, ...l.params }
    }
    if (filter.minScore !== undefined) {
      where.push("score >= $min")
      params.min = filter.minScore
    }
    const limit = filter.limit ? `LIMIT ${Math.max(1, Math.floor(filter.limit))}` : ""
    const sql = `SELECT * FROM issues ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY score DESC NULLS LAST, id ${limit}`
    return (this.db.query(sql).all(params) as Row[]).map((r) => this.issueFromRow(r))
  }

  // -------------------------------------------------------------------------
  // tasks
  // -------------------------------------------------------------------------

  private taskFromRow(r: Row): TaskRecord {
    return {
      id: str(r.id),
      kind: str(r.kind) as TaskKind,
      repo: str(r.repo),
      issueId: strOrNull(r.issue_id),
      prId: strOrNull(r.pr_id),
      stage: str(r.stage) as TaskRecord["stage"],
      status: str(r.status) as TaskStatus,
      attempts: num(r.attempts),
      failures: num(r.failures),
      nextRunAt: num(r.next_run_at),
      lastError: strOrNull(r.last_error),
      abortReason: strOrNull(r.abort_reason),
      workspace: strOrNull(r.workspace),
      branch: strOrNull(r.branch),
      tokensUsed: num(r.tokens_used),
      costUsd: num(r.cost_usd),
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
      data: json(r.data, {}),
    }
  }

  saveTask(rec: TaskRecord): void {
    this.db
      .query(
        `INSERT INTO tasks(id, kind, repo, issue_id, pr_id, stage, status, attempts, failures, next_run_at, last_error,
                           abort_reason, workspace, branch, tokens_used, cost_usd, created_at, updated_at, data)
         VALUES ($id, $kind, $repo, $issue_id, $pr_id, $stage, $status, $attempts, $failures, $next_run_at, $last_error,
                 $abort_reason, $workspace, $branch, $tokens_used, $cost_usd, $created_at, $updated_at, $data)
         ON CONFLICT(id) DO UPDATE SET
           stage=excluded.stage, status=excluded.status, attempts=excluded.attempts, failures=excluded.failures,
           next_run_at=excluded.next_run_at, last_error=excluded.last_error, abort_reason=excluded.abort_reason,
           workspace=excluded.workspace, branch=excluded.branch, tokens_used=excluded.tokens_used,
           cost_usd=excluded.cost_usd, updated_at=excluded.updated_at, data=excluded.data, pr_id=excluded.pr_id,
           issue_id=excluded.issue_id`,
      )
      .run({
        id: rec.id,
        kind: rec.kind,
        repo: rec.repo,
        issue_id: rec.issueId,
        pr_id: rec.prId,
        stage: rec.stage,
        status: rec.status,
        attempts: rec.attempts,
        failures: rec.failures,
        next_run_at: rec.nextRunAt,
        last_error: rec.lastError ? redact(rec.lastError) : null,
        abort_reason: rec.abortReason ? redact(rec.abortReason) : null,
        workspace: rec.workspace,
        branch: rec.branch,
        tokens_used: rec.tokensUsed,
        cost_usd: rec.costUsd,
        created_at: rec.createdAt,
        updated_at: rec.updatedAt,
        data: JSON.stringify(persistedTaskData(rec.data)),
      })
  }

  // -------------------------------------------------------------------------
  // task claims (a scheduler claims a task before running one of its stages)
  // -------------------------------------------------------------------------

  /**
   * Claim a task for `holder` until now + ttlMs. Succeeds when the task is unclaimed, already claimed by
   * `holder`, or the other claim expired. Returns whether `holder` holds the claim afterwards.
   */
  claimTask(id: string, holder: string, ttlMs: number, now: Millis): boolean {
    const res = this.db
      .query(
        `UPDATE tasks SET claimed_by = $holder, claim_expires_at = $exp
         WHERE id = $id AND (claimed_by IS NULL OR claimed_by = $holder OR claim_expires_at IS NULL OR claim_expires_at <= $now)`,
      )
      .run({ id, holder, exp: now + ttlMs, now })
    return res.changes > 0
  }

  /** Extend every claim `holder` has (scheduler heartbeat). Returns the number of renewed claims. */
  renewTaskClaims(holder: string, ttlMs: number, now: Millis): number {
    return this.db.query("UPDATE tasks SET claim_expires_at = $exp WHERE claimed_by = $holder").run({ holder, exp: now + ttlMs }).changes
  }

  releaseTaskClaim(id: string, holder: string): void {
    this.db.query("UPDATE tasks SET claimed_by = NULL, claim_expires_at = NULL WHERE id = $id AND claimed_by = $holder").run({ id, holder })
  }

  /** Current claim holder of a task (null when unclaimed or unknown), regardless of expiry. */
  taskClaimHolder(id: string): string | null {
    const r = this.db.query("SELECT claimed_by FROM tasks WHERE id = $id").get({ id }) as Row | null
    return r ? strOrNull(r.claimed_by) : null
  }

  /**
   * Save the task only while `holder` still holds its claim (another scheduler may have taken over an
   * expired claim, and may even have released it again). Returns false, without writing, when the
   * claim was lost.
   */
  saveTaskIfClaimed(rec: TaskRecord, holder: string): boolean {
    return this.transaction(() => {
      if (this.taskClaimHolder(rec.id) !== holder) return false
      this.saveTask(rec)
      return true
    })
  }

  getTask(id: string): TaskRecord | null {
    const r = this.db.query("SELECT * FROM tasks WHERE id = $id").get({ id }) as Row | null
    return r ? this.taskFromRow(r) : null
  }

  listTasks(
    filter: {
      status?: TaskStatus | TaskStatus[]
      kind?: TaskKind
      repo?: string
      /** Only tasks with next_run_at <= this. */
      dueAt?: Millis
      limit?: number
    } = {},
  ): TaskRecord[] {
    const where: string[] = []
    let params: Record<string, string | number> = {}
    const statuses = asArray(filter.status)
    if (statuses) {
      const l = inList(statuses)
      where.push(`status IN ${l.sql}`)
      params = { ...params, ...l.params }
    }
    if (filter.kind) {
      where.push("kind = $kind")
      params.kind = filter.kind
    }
    if (filter.repo) {
      where.push("repo = $repo")
      params.repo = filter.repo
    }
    if (filter.dueAt !== undefined) {
      where.push("next_run_at <= $due")
      params.due = filter.dueAt
    }
    const limit = filter.limit ? `LIMIT ${Math.max(1, Math.floor(filter.limit))}` : ""
    const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY next_run_at ASC, created_at ASC ${limit}`
    return (this.db.query(sql).all(params) as Row[]).map((r) => this.taskFromRow(r))
  }

  // -------------------------------------------------------------------------
  // approval queue
  // -------------------------------------------------------------------------

  private queueFromRow(r: Row): QueueItem {
    return {
      id: num(r.id),
      kind: str(r.kind) as QueueKind,
      status: str(r.status) as QueueStatus,
      repo: str(r.repo),
      issueUrl: strOrNull(r.issue_url),
      prUrl: strOrNull(r.pr_url),
      taskId: strOrNull(r.task_id),
      title: str(r.title),
      body: str(r.body),
      diff: str(r.diff),
      testOutput: str(r.test_output),
      critic: json(r.critic, null),
      verification: json(r.verification, null),
      branch: strOrNull(r.branch),
      workspace: strOrNull(r.workspace),
      baseBranch: strOrNull(r.base_branch),
      digest: str(r.digest),
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
      decidedAt: numOrNull(r.decided_at),
      decisionReason: strOrNull(r.decision_reason),
      submittedUrl: strOrNull(r.submitted_url),
      error: strOrNull(r.error),
      data: json(r.data, {}),
    }
  }

  /** Insert a queue item; returns it with its assigned id. */
  insertQueueItem(item: Omit<QueueItem, "id">): QueueItem {
    const res = this.db
      .query(
        `INSERT INTO queue_items(kind, status, repo, issue_url, pr_url, task_id, title, body, diff, test_output, critic,
                                 verification, branch, workspace, base_branch, digest, created_at, updated_at, decided_at,
                                 decision_reason, submitted_url, error, data)
         VALUES ($kind, $status, $repo, $issue_url, $pr_url, $task_id, $title, $body, $diff, $test_output, $critic,
                 $verification, $branch, $workspace, $base_branch, $digest, $created_at, $updated_at, $decided_at,
                 $decision_reason, $submitted_url, $error, $data)`,
      )
      .run(this.queueParams(item))
    return this.getQueueItem(Number(res.lastInsertRowid))!
  }

  saveQueueItem(item: QueueItem): void {
    this.db
      .query(
        `UPDATE queue_items SET kind=$kind, status=$status, repo=$repo, issue_url=$issue_url, pr_url=$pr_url,
           task_id=$task_id, title=$title, body=$body, diff=$diff, test_output=$test_output, critic=$critic,
           verification=$verification, branch=$branch, workspace=$workspace, base_branch=$base_branch, digest=$digest,
           created_at=$created_at, updated_at=$updated_at, decided_at=$decided_at, decision_reason=$decision_reason,
           submitted_url=$submitted_url, error=$error, data=$data
         WHERE id = $id`,
      )
      .run({ ...this.queueParams(item), id: item.id })
  }

  private queueParams(item: Omit<QueueItem, "id">) {
    return {
      kind: item.kind,
      status: item.status,
      repo: item.repo,
      issue_url: item.issueUrl,
      pr_url: item.prUrl,
      task_id: item.taskId,
      title: item.title,
      body: item.body,
      diff: item.diff,
      test_output: redact(item.testOutput),
      critic: item.critic ? JSON.stringify(item.critic) : null,
      verification: item.verification ? JSON.stringify(item.verification) : null,
      branch: item.branch,
      workspace: item.workspace,
      base_branch: item.baseBranch,
      digest: item.digest,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
      decided_at: item.decidedAt,
      decision_reason: item.decisionReason,
      submitted_url: item.submittedUrl,
      error: item.error ? redact(item.error) : null,
      data: JSON.stringify(redactValue(item.data)),
    }
  }

  getQueueItem(id: number): QueueItem | null {
    const r = this.db.query("SELECT * FROM queue_items WHERE id = $id").get({ id }) as Row | null
    return r ? this.queueFromRow(r) : null
  }

  listQueue(filter: { status?: QueueStatus | QueueStatus[]; repo?: string; kind?: QueueKind; limit?: number } = {}): QueueItem[] {
    const where: string[] = []
    let params: Record<string, string | number> = {}
    const statuses = asArray(filter.status)
    if (statuses) {
      const l = inList(statuses)
      where.push(`status IN ${l.sql}`)
      params = { ...params, ...l.params }
    }
    if (filter.repo) {
      where.push("repo = $repo")
      params.repo = filter.repo
    }
    if (filter.kind) {
      where.push("kind = $kind")
      params.kind = filter.kind
    }
    const limit = filter.limit ? `LIMIT ${Math.max(1, Math.floor(filter.limit))}` : ""
    const sql = `SELECT * FROM queue_items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id ASC ${limit}`
    return (this.db.query(sql).all(params) as Row[]).map((r) => this.queueFromRow(r))
  }

  countQueue(): Record<QueueStatus, number> {
    const rows = this.db.query("SELECT status, COUNT(*) AS n FROM queue_items GROUP BY status").all() as Row[]
    const out: Record<QueueStatus, number> = {
      pending: 0,
      approved: 0,
      submitted: 0,
      rejected: 0,
      failed: 0,
      superseded: 0,
    }
    for (const r of rows) out[str(r.status) as QueueStatus] = num(r.n)
    return out
  }

  // -------------------------------------------------------------------------
  // tracked PRs
  // -------------------------------------------------------------------------

  private prFromRow(r: Row): TrackedPr {
    return {
      id: str(r.id),
      repo: str(r.repo),
      number: num(r.number),
      url: str(r.url),
      queueItemId: numOrNull(r.queue_item_id),
      branch: strOrNull(r.branch),
      headRepo: strOrNull(r.head_repo),
      state: str(r.state) as PrState,
      openedAt: num(r.opened_at),
      closedAt: numOrNull(r.closed_at),
      mergedAt: numOrNull(r.merged_at),
      lastPolledAt: numOrNull(r.last_polled_at),
      lastSeenActivityAt: strOrNull(r.last_seen_activity_at),
      data: json(r.data, {}),
    }
  }

  upsertPr(pr: TrackedPr): void {
    this.db
      .query(
        `INSERT INTO prs(id, repo, number, url, queue_item_id, branch, head_repo, state, opened_at, closed_at, merged_at,
                         last_polled_at, last_seen_activity_at, data)
         VALUES ($id, $repo, $number, $url, $queue_item_id, $branch, $head_repo, $state, $opened_at, $closed_at, $merged_at,
                 $last_polled_at, $last_seen_activity_at, $data)
         ON CONFLICT(id) DO UPDATE SET
           url=excluded.url, queue_item_id=COALESCE(excluded.queue_item_id, prs.queue_item_id),
           branch=COALESCE(excluded.branch, prs.branch), head_repo=COALESCE(excluded.head_repo, prs.head_repo),
           state=excluded.state, closed_at=excluded.closed_at, merged_at=excluded.merged_at,
           last_polled_at=excluded.last_polled_at, last_seen_activity_at=excluded.last_seen_activity_at, data=excluded.data`,
      )
      .run({
        id: pr.id,
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
        queue_item_id: pr.queueItemId,
        branch: pr.branch,
        head_repo: pr.headRepo,
        state: pr.state,
        opened_at: pr.openedAt,
        closed_at: pr.closedAt,
        merged_at: pr.mergedAt,
        last_polled_at: pr.lastPolledAt,
        last_seen_activity_at: pr.lastSeenActivityAt,
        data: JSON.stringify(redactValue(pr.data)),
      })
  }

  getPr(id: string): TrackedPr | null {
    const r = this.db.query("SELECT * FROM prs WHERE id = $id").get({ id }) as Row | null
    return r ? this.prFromRow(r) : null
  }

  listPrs(filter: { state?: PrState | PrState[]; repo?: string } = {}): TrackedPr[] {
    const where: string[] = []
    let params: Record<string, string | number> = {}
    const states = asArray(filter.state)
    if (states) {
      const l = inList(states)
      where.push(`state IN ${l.sql}`)
      params = { ...params, ...l.params }
    }
    if (filter.repo) {
      where.push("repo = $repo")
      params.repo = filter.repo
    }
    const sql = `SELECT * FROM prs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY opened_at ASC`
    return (this.db.query(sql).all(params) as Row[]).map((r) => this.prFromRow(r))
  }

  // -------------------------------------------------------------------------
  // audit + errors
  // -------------------------------------------------------------------------

  audit(entry: {
    actor: AuditActor
    action: string
    subject?: string | null
    decision?: string | null
    reasons?: string[]
    details?: Record<string, unknown>
    ts: Millis
  }): void {
    this.db
      .query(
        `INSERT INTO audit(ts, actor, action, subject, decision, reasons, details)
         VALUES ($ts, $actor, $action, $subject, $decision, $reasons, $details)`,
      )
      .run({
        ts: entry.ts,
        actor: entry.actor,
        action: entry.action,
        subject: entry.subject ?? null,
        decision: entry.decision ?? null,
        reasons: JSON.stringify((entry.reasons ?? []).map((r) => redact(r))),
        details: JSON.stringify(redactValue(entry.details ?? {})),
      })
  }

  listAudit(filter: { action?: string; actionPrefix?: string; subject?: string; sinceTs?: Millis; limit?: number } = {}): AuditEntry[] {
    const where: string[] = []
    const params: Record<string, string | number> = {}
    if (filter.action) {
      where.push("action = $action")
      params.action = filter.action
    }
    if (filter.actionPrefix) {
      where.push("action LIKE $prefix")
      params.prefix = `${filter.actionPrefix}%`
    }
    if (filter.subject) {
      where.push("subject = $subject")
      params.subject = filter.subject
    }
    if (filter.sinceTs !== undefined) {
      where.push("ts >= $since")
      params.since = filter.sinceTs
    }
    const limit = `LIMIT ${Math.max(1, Math.floor(filter.limit ?? 100))}`
    const sql = `SELECT * FROM audit ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC, id DESC ${limit}`
    return (this.db.query(sql).all(params) as Row[]).map((r) => ({
      id: num(r.id),
      ts: num(r.ts),
      actor: str(r.actor) as AuditActor,
      action: str(r.action),
      subject: strOrNull(r.subject),
      decision: strOrNull(r.decision),
      reasons: json<string[]>(r.reasons, []),
      details: json<Record<string, unknown>>(r.details, {}),
    }))
  }

  /** Keep only the newest `maxRows` audit entries (bounded growth); returns how many were deleted. */
  pruneAudit(maxRows: number): number {
    const keep = Math.max(1, Math.floor(maxRows))
    const row = this.db.query("SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET $off").get({ off: keep - 1 }) as Row | null
    if (!row) return 0
    return this.db.query("DELETE FROM audit WHERE id < $min").run({ min: num(row.id) }).changes
  }

  recordError(scope: string, message: string, details: Record<string, unknown>, ts: Millis): void {
    this.db
      .query("INSERT INTO errors(ts, scope, message, details) VALUES ($ts, $scope, $message, $details)")
      .run({ ts, scope, message: redact(message), details: JSON.stringify(redactValue(details)) })
    // keep the table bounded
    this.db.query("DELETE FROM errors WHERE id NOT IN (SELECT id FROM errors ORDER BY id DESC LIMIT 500)").run()
  }

  listErrors(limit = 10): ErrorEntry[] {
    return (this.db.query(`SELECT * FROM errors ORDER BY id DESC LIMIT ${Math.max(1, Math.floor(limit))}`).all() as Row[]).map(
      (r) => ({
        id: num(r.id),
        ts: num(r.ts),
        scope: str(r.scope),
        message: str(r.message),
        details: json<Record<string, unknown>>(r.details, {}),
      }),
    )
  }

  // -------------------------------------------------------------------------
  // LLM usage (budget)
  // -------------------------------------------------------------------------

  addUsage(day: string, tokens: number, costUsd: number): void {
    this.db
      .query(
        `INSERT INTO usage(day, tokens, cost_usd, calls) VALUES ($day, $tokens, $cost, 1)
         ON CONFLICT(day) DO UPDATE SET tokens = tokens + $tokens, cost_usd = cost_usd + $cost, calls = calls + 1`,
      )
      .run({ day, tokens: Math.max(0, Math.round(tokens)), cost: Math.max(0, costUsd) })
  }

  getUsage(day: string): UsageTotals {
    const r = this.db.query("SELECT * FROM usage WHERE day = $day").get({ day }) as Row | null
    return r ? { tokens: num(r.tokens), costUsd: num(r.cost_usd), calls: num(r.calls) } : { tokens: 0, costUsd: 0, calls: 0 }
  }

  // -------------------------------------------------------------------------
  // key/value
  // -------------------------------------------------------------------------

  getKv<T>(key: string): T | null {
    const r = this.db.query("SELECT value FROM kv WHERE key = $key").get({ key }) as Row | null
    return r ? json<T | null>(r.value, null) : null
  }

  setKv(key: string, value: unknown, now: Millis): void {
    this.db
      .query(
        `INSERT INTO kv(key, value, updated_at) VALUES ($key, $value, $now)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run({ key, value: JSON.stringify(value ?? null), now })
  }

  deleteKv(key: string): void {
    this.db.query("DELETE FROM kv WHERE key = $key").run({ key })
  }

  // -------------------------------------------------------------------------
  // leader lease (one scheduler across opencode locations / processes)
  // -------------------------------------------------------------------------

  /** Acquire or renew a lease. Returns true when `holder` holds it afterwards. */
  tryAcquireLease(name: string, holder: string, ttlMs: number, now: Millis): boolean {
    return this.transaction(() => {
      const r = this.db.query("SELECT holder, expires_at FROM leases WHERE name = $name").get({ name }) as Row | null
      if (r && str(r.holder) !== holder && num(r.expires_at) > now) return false
      this.db
        .query(
          `INSERT INTO leases(name, holder, expires_at) VALUES ($name, $holder, $exp)
           ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at`,
        )
        .run({ name, holder, exp: now + ttlMs })
      return true
    })
  }

  releaseLease(name: string, holder: string): void {
    this.db.query("DELETE FROM leases WHERE name = $name AND holder = $holder").run({ name, holder })
  }

  getLease(name: string): { holder: string; expiresAt: Millis } | null {
    const r = this.db.query("SELECT holder, expires_at FROM leases WHERE name = $name").get({ name }) as Row | null
    return r ? { holder: str(r.holder), expiresAt: num(r.expires_at) } : null
  }

  // -------------------------------------------------------------------------
  // HTTP cache (GitHub conditional requests)
  // -------------------------------------------------------------------------

  getHttpCache(key: string): { etag: string | null; lastModified: string | null; body: string; fetchedAt: Millis } | null {
    const r = this.db.query("SELECT * FROM http_cache WHERE key = $key").get({ key }) as Row | null
    return r
      ? { etag: strOrNull(r.etag), lastModified: strOrNull(r.last_modified), body: str(r.body), fetchedAt: num(r.fetched_at) }
      : null
  }

  setHttpCache(key: string, entry: { etag: string | null; lastModified: string | null; body: string }, now: Millis): void {
    this.db
      .query(
        `INSERT INTO http_cache(key, etag, last_modified, body, fetched_at) VALUES ($key, $etag, $lm, $body, $now)
         ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified,
           body = excluded.body, fetched_at = excluded.fetched_at`,
      )
      .run({ key, etag: entry.etag, lm: entry.lastModified, body: entry.body, now })
  }

  /** Delete cached GitHub responses fetched before `olderThan`; returns how many were deleted. */
  pruneHttpCache(olderThan: Millis): number {
    return this.db.query("DELETE FROM http_cache WHERE fetched_at < $t").run({ t: olderThan }).changes
  }
}
