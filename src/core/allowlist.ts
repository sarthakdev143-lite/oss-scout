import type { OssScoutConfig } from "../config/schema.ts"
import { matchesRepoPattern } from "../util/text.ts"

/** Apply repos.allow / repos.deny. Deny always wins; a non-empty allow list is exclusive. */
export function isRepoAllowed(fullName: string, config: Pick<OssScoutConfig, "repos">): { ok: boolean; reason: string | null } {
  const denied = config.repos.deny.find((p) => matchesRepoPattern(fullName, p))
  if (denied) return { ok: false, reason: `denied by config (repos.deny: ${denied})` }
  if (config.repos.allow.length > 0 && !config.repos.allow.some((p) => matchesRepoPattern(fullName, p))) {
    return { ok: false, reason: "not in repos.allow" }
  }
  return { ok: true, reason: null }
}
