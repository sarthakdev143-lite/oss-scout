import type {
  GhComment,
  GhCommit,
  GhCommunityProfile,
  GhContentEntry,
  GhIssue,
  GhPull,
  GhRepo,
  GhReview,
  GhReviewComment,
  GhTimelineEvent,
  GhTreeEntry,
  GhUser,
  RateLimitInfo,
  TokenInfo,
} from "./types.ts"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** From X-Accepted-GitHub-Permissions, useful on 403. */
    readonly acceptedPermissions: string | null = null,
    readonly path: string | null = null,
  ) {
    super(message)
    this.name = "GitHubError"
  }
  /** 403 "Resource not accessible by personal access token" (fine-grained PAT limitation). */
  get isTokenPermissionError(): boolean {
    return this.status === 403 && /not accessible by (personal access token|integration)/i.test(this.message)
  }
}

/** Primary or secondary rate limit hit. The caller must not retry before `resetAt`. */
export class RateLimitError extends Error {
  constructor(
    message: string,
    /** epoch ms */
    readonly resetAt: number,
    readonly resource: string,
    readonly secondary: boolean,
  ) {
    super(message)
    this.name = "RateLimitError"
  }
}

/** The global kill switch is engaged; no GitHub traffic is allowed. */
export class KilledError extends Error {
  constructor(message = "oss-scout kill switch is engaged") {
    super(message)
    this.name = "KilledError"
  }
}

/** A mutating call was attempted without valid human approval (or not in queue mode). */
export class WriteForbiddenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WriteForbiddenError"
  }
}

// ---------------------------------------------------------------------------
// Write authorization
// ---------------------------------------------------------------------------

const WRITE_AUTH: unique symbol = Symbol("oss-scout.write-authorization")

/**
 * Proof that a human approved a specific queue item. Only `mintWriteAuthorization` creates it,
 * and only the approval executor (`queue/submit.ts`) calls that. Every mutating GitHub method
 * requires one. This is a structural guard against accidental writes from pipeline code.
 */
export interface WriteAuthorization {
  readonly [WRITE_AUTH]: true
  readonly queueItemId: number
  readonly digest: string
  readonly approvedAt: number
  readonly via: "cli" | "command"
}

export function mintWriteAuthorization(input: {
  queueItemId: number
  itemStatus: string
  itemDigest: string
  providedDigest: string
  actor: "human"
  via: "cli" | "command"
  mode: string
  now: number
}): WriteAuthorization {
  if (input.actor !== "human") throw new WriteForbiddenError("only a human can approve GitHub writes")
  if (input.mode !== "queue") throw new WriteForbiddenError(`GitHub writes are disabled in mode "${input.mode}"`)
  if (input.itemStatus !== "approved") throw new WriteForbiddenError(`queue item ${input.queueItemId} is not approved`)
  const provided = input.providedDigest.trim().toLowerCase()
  if (provided.length < 8 || !input.itemDigest.toLowerCase().startsWith(provided)) {
    throw new WriteForbiddenError(`digest mismatch for queue item ${input.queueItemId}`)
  }
  return Object.freeze({
    [WRITE_AUTH]: true as const,
    queueItemId: input.queueItemId,
    digest: input.itemDigest,
    approvedAt: input.now,
    via: input.via,
  })
}

export function isWriteAuthorization(x: unknown): x is WriteAuthorization {
  return typeof x === "object" && x !== null && (x as Record<symbol, unknown>)[WRITE_AUTH] === true
}

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface ListOptions {
  /** Max items to return across pages (default 100). */
  max?: number
  perPage?: number
}

export interface SearchOptions extends ListOptions {
  sort?: string
  order?: "asc" | "desc"
}

export interface CreatePullInput {
  title: string
  body: string
  /** "forkOwner:branch" */
  head: string
  base: string
  draft?: boolean
  maintainerCanModify?: boolean
}

/**
 * Everything oss-scout needs from GitHub. Reads are free to call from any pipeline stage.
 * Writes require a WriteAuthorization minted from a human approval.
 *
 * Implementations MUST: check the kill switch before every request; throw RateLimitError on
 * primary/secondary limits (never busy-retry); use conditional requests (ETag) for cacheable GETs;
 * never log the token.
 */
export interface GitHubApi {
  // --- reads ---
  getAuthenticatedUser(): Promise<GhUser>
  tokenInfo(): Promise<TokenInfo>
  /** Repos owned by the authenticated user (affiliation=owner, sort=pushed). */
  listOwnRepos(opts?: ListOptions): Promise<GhRepo[]>
  getRepo(fullName: string): Promise<GhRepo>
  /** Decoded UTF-8 file content, or null when the file does not exist (404). */
  getFileContent(fullName: string, path: string, ref?: string): Promise<string | null>
  /** Directory listing, or null when the path does not exist. */
  listDirectory(fullName: string, path: string, ref?: string): Promise<GhContentEntry[] | null>
  /** Git tree (recursive). `truncated` trees return what GitHub returned. */
  getTree(fullName: string, ref: string, recursive: boolean): Promise<GhTreeEntry[]>
  /** null when unavailable (e.g. forks). */
  getCommunityProfile(fullName: string): Promise<GhCommunityProfile | null>
  searchRepositories(query: string, opts?: SearchOptions): Promise<GhRepo[]>
  /** Issue/PR search. Query MUST include is:issue or is:pr. Sends advanced_search=true. */
  searchIssues(query: string, opts?: SearchOptions): Promise<GhIssue[]>
  getIssue(fullName: string, number: number): Promise<GhIssue>
  listIssueComments(fullName: string, number: number, opts?: ListOptions & { since?: string }): Promise<GhComment[]>
  listIssueTimeline(fullName: string, number: number, opts?: ListOptions): Promise<GhTimelineEvent[]>
  listPulls(
    fullName: string,
    opts?: ListOptions & { state?: "open" | "closed" | "all"; sort?: "created" | "updated" | "popularity" | "long-running"; direction?: "asc" | "desc"; head?: string },
  ): Promise<GhPull[]>
  getPull(fullName: string, number: number): Promise<GhPull>
  listPullReviews(fullName: string, number: number, opts?: ListOptions): Promise<GhReview[]>
  listPullReviewComments(fullName: string, number: number, opts?: ListOptions & { since?: string }): Promise<GhReviewComment[]>
  listCommits(fullName: string, opts?: ListOptions & { since?: string; sha?: string }): Promise<GhCommit[]>
  /** Last seen rate-limit info per resource (from headers), without a request. */
  rateLimitSnapshot(): RateLimitInfo[]

  // --- writes (human-approved only) ---
  /** POST /repos/{o}/{r}/forks with default_branch_only=true, then poll until the fork is reachable. */
  createFork(auth: WriteAuthorization, fullName: string): Promise<GhRepo>
  createPull(auth: WriteAuthorization, fullName: string, input: CreatePullInput): Promise<GhPull>
  createIssueComment(auth: WriteAuthorization, fullName: string, number: number, body: string): Promise<GhComment>
}
