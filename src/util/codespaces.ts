/**
 * GitHub Codespaces specifics, reported by `doctor` (see docs/CODESPACES.md).
 *
 * A codespace sets its own GITHUB_TOKEN, scoped to the repository the codespace was created from, so
 * oss-scout must read its token from another variable (Codespaces secret names cannot start with
 * GITHUB_). Everything outside /workspaces is deleted when the codespace's container is rebuilt.
 */

type Env = Readonly<Record<string, string | undefined>>

/** Directory a codespace keeps across container rebuilds. */
export const CODESPACES_PERSISTENT_DIR = "/workspaces"

/** Token variables used by oss-scout.config.codespaces.json (names of Codespaces secrets). */
export const CODESPACES_TOKEN_ENV = "OSS_SCOUT_GITHUB_TOKEN"
export const CODESPACES_WRITE_TOKEN_ENV = "OSS_SCOUT_WRITE_TOKEN"

export interface DoctorFinding {
  level: "info" | "warn" | "fail"
  text: string
}

/** Codespaces sets CODESPACES=true in every codespace. */
export function inCodespace(env: Env): boolean {
  return env.CODESPACES === "true"
}

/** Doctor findings for a codespace; empty anywhere else. `stateDir` is the resolved state directory. */
export function codespacesFindings(input: { env: Env; tokenEnv: string; writeTokenEnv: string; stateDir: string }): DoctorFinding[] {
  if (!inCodespace(input.env)) return []
  const name = input.env.CODESPACE_NAME?.trim()
  const out: DoctorFinding[] = [{ level: "info", text: `Running in GitHub Codespace${name ? ` ${name}` : ""} (see docs/CODESPACES.md)` }]

  const tokenSettings = [
    { setting: "github.tokenEnv", value: input.tokenEnv, use: CODESPACES_TOKEN_ENV },
    { setting: "github.writeTokenEnv", value: input.writeTokenEnv, use: CODESPACES_WRITE_TOKEN_ENV },
  ]
  for (const t of tokenSettings) {
    if (t.value !== "GITHUB_TOKEN") continue
    out.push({
      level: "fail",
      text: `${t.setting} is GITHUB_TOKEN, which in a codespace is the codespace's own token for this repository only. Add a Codespaces secret named ${t.use} and set ${t.setting} to "${t.use}" (oss-scout.config.codespaces.json does).`,
    })
  }

  const dir = input.stateDir.replace(/\\/g, "/")
  if (dir !== CODESPACES_PERSISTENT_DIR && !dir.startsWith(`${CODESPACES_PERSISTENT_DIR}/`)) {
    out.push({
      level: "warn",
      text: `State dir ${input.stateDir} is outside ${CODESPACES_PERSISTENT_DIR}: rebuilding the codespace deletes it (queue, history and cap counters). Set "stateDir" to "${CODESPACES_PERSISTENT_DIR}/.oss-scout".`,
    })
  }
  return out
}
