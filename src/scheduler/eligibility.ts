import { isRepoAllowed } from "../core/allowlist.ts"
import type { AppContext } from "../core/context.ts"
import { policyBlocks } from "../screening/policy.ts"

/**
 * May oss-scout (still) work on / submit to this repo? Re-checked before every task stage, at approval
 * and by the scheduler's queue sweep, because a re-screen can find a new AI ban or flip the repo to
 * skipped, and the user can deny-list it, while a task or queue item is in flight.
 *
 * scope "contribution" (new PRs: contribution tasks, pr items): blocked when the repo is denied by
 *   config, its current AI policy blocks AI contributions, or it is now skipped (any reason).
 * scope "followup" (your existing PR: follow-up fix tasks, fix/reply items): blocked when denied by
 *   config or the AI policy blocks AI contributions. A skip for other reasons (e.g. activity) does not
 *   stop answering reviews on a PR you already opened.
 *
 * Returns the reason, or null when allowed.
 */
export function repoBlockReason(
  ctx: Pick<AppContext, "store" | "config">,
  repo: string,
  scope: "contribution" | "followup",
): string | null {
  const allowed = isRepoAllowed(repo, ctx.config)
  if (!allowed.ok) return `${repo} is ${allowed.reason ?? "not allowed by config"}`
  const rec = ctx.store.getRepo(repo)
  const ai = rec?.policy?.ai
  if (ai) {
    const blocked = policyBlocks(ai, ctx.config.screening.skipUnclearRestrictivePolicy)
    if (blocked) return `${repo}: ${blocked}`
  }
  if (scope === "contribution" && rec?.status === "skipped") {
    return `${repo} is now skipped${rec.skipReason ? `: ${rec.skipReason}` : ""}`
  }
  return null
}
