import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Global kill switch backed by a file so it works across processes (plugin, CLI, multiple
 * opencode locations) and survives restarts. While engaged: the scheduler does nothing, the
 * GitHub client refuses every request, and approvals are refused.
 */
export class KillSwitch {
  constructor(readonly file: string) {}

  isEngaged(): boolean {
    return existsSync(this.file)
  }

  reason(): string | null {
    if (!this.isEngaged()) return null
    try {
      return readFileSync(this.file, "utf8").trim() || "engaged"
    } catch {
      return "engaged"
    }
  }

  engage(reason: string, now: number): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${new Date(now).toISOString()} ${reason}\n`)
  }

  release(): void {
    rmSync(this.file, { force: true })
  }
}
