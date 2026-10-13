/**
 * The subset of GitHub REST response shapes oss-scout uses. Fields not listed are ignored.
 * Optional fields may be absent depending on endpoint / API version.
 */

export interface GhUser {
  login: string
  id: number
  type: string // "User" | "Bot" | "Organization"
  html_url?: string
}

export interface GhLicense {
  key: string
  name: string
  spdx_id: string | null
}

export interface GhRepo {
  id: number
  name: string
  full_name: string
  owner: GhUser
  private: boolean
  visibility?: string
  fork: boolean
  archived: boolean
  disabled?: boolean
  html_url: string
  clone_url?: string
  description: string | null
  stargazers_count: number
  forks_count: number
  open_issues_count: number
  pushed_at: string | null
  updated_at: string | null
  default_branch: string
  language: string | null
  topics?: string[]
  has_issues: boolean
  has_pull_requests?: boolean
  pull_request_creation_policy?: "all" | "collaborators_only"
  allow_forking?: boolean
  web_commit_signoff_required?: boolean
  license: GhLicense | null
  parent?: { full_name: string; default_branch?: string }
  source?: { full_name: string }
}

export interface GhLabel {
  name: string
}

export interface GhIssue {
  number: number
  title: string
  body: string | null
  state: "open" | "closed"
  state_reason?: string | null
  html_url: string
  user: GhUser | null
  labels: Array<GhLabel | string>
  assignees?: GhUser[] | null
  comments: number
  locked?: boolean
  author_association?: string
  created_at: string
  updated_at: string
  closed_at?: string | null
  /** Present when the "issue" is actually a pull request. */
  pull_request?: { url?: string; html_url?: string; merged_at?: string | null }
  /** Search results only: repository API url, e.g. https://api.github.com/repos/o/r */
  repository_url?: string
}

export interface GhComment {
  id: number
  body: string
  user: GhUser | null
  author_association?: string
  created_at: string
  updated_at: string
  html_url?: string
}

export interface GhReviewComment extends GhComment {
  path?: string
  line?: number | null
  diff_hunk?: string
  in_reply_to_id?: number
  pull_request_review_id?: number | null
}

export interface GhReview {
  id: number
  user: GhUser | null
  body: string | null
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING" | string
  submitted_at?: string | null
  author_association?: string
  commit_id?: string
  html_url?: string
}

export interface GhPull {
  number: number
  title: string
  body?: string | null
  state: "open" | "closed"
  draft?: boolean
  html_url: string
  user: GhUser | null
  author_association?: string
  created_at: string
  updated_at: string
  closed_at: string | null
  merged_at: string | null
  merged?: boolean
  head: { ref: string; sha: string; repo: { full_name: string } | null; label?: string }
  base: { ref: string; sha?: string; repo?: { full_name: string } }
  comments?: number
  review_comments?: number
  additions?: number
  deletions?: number
  changed_files?: number
  maintainer_can_modify?: boolean
}

export interface GhCommit {
  sha: string
  commit: {
    message: string
    author: { name?: string; email?: string; date?: string } | null
    committer: { name?: string; email?: string; date?: string } | null
  }
  author: GhUser | null
  committer: GhUser | null
}

export interface GhContentEntry {
  type: "file" | "dir" | "symlink" | "submodule"
  name: string
  path: string
  size: number
  sha: string
}

export interface GhTreeEntry {
  path: string
  type: "blob" | "tree" | "commit"
  size?: number
  sha: string
}

export interface GhCommunityProfile {
  health_percentage: number
  files: {
    code_of_conduct: { key?: string; name?: string; html_url?: string | null } | null
    code_of_conduct_file: { url?: string; html_url?: string } | null
    contributing: { url?: string; html_url?: string } | null
    issue_template: { url?: string; html_url?: string } | null
    pull_request_template: { url?: string; html_url?: string } | null
    license: { spdx_id?: string | null } | null
    readme: { url?: string; html_url?: string } | null
  }
}

/** Timeline events: only the fields used for linked-PR / claim detection. */
export interface GhTimelineEvent {
  event: string // "cross-referenced" | "connected" | "disconnected" | "assigned" | "commented" | …
  created_at?: string
  actor?: GhUser | null
  source?: {
    type?: string
    issue?: {
      number: number
      state: "open" | "closed"
      html_url?: string
      pull_request?: { merged_at?: string | null; html_url?: string } | null
      repository?: { full_name: string }
      draft?: boolean
    }
  }
  /** Undocumented but observed on connected/disconnected events. */
  subject?: { type?: string; number?: number; state?: string; url?: string; merged_at?: string | null }
  body?: string
  user?: GhUser | null
  author_association?: string
}

export interface RateLimitInfo {
  resource: string
  limit: number
  remaining: number
  /** epoch ms */
  resetAt: number
}

export interface TokenInfo {
  login: string
  /** "classic" (ghp_), "fine-grained" (github_pat_), "other". Never contains the token. */
  kind: "classic" | "fine-grained" | "other"
  /** From X-OAuth-Scopes (classic tokens only). */
  scopes: string[] | null
}
