/**
 * execCommand: output redaction (default) vs raw output (diffs fed to the secrets gate), and
 * cancellation. Children are this Bun binary running inline scripts; token-shaped strings are built
 * at runtime (never real tokens).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { execCommand, safeEnv } from "../src/util/exec.ts"
import { clearRegisteredSecrets, registerSecret } from "../src/util/redact.ts"

afterEach(() => {
  clearRegisteredSecrets()
})

/** argv that prints `text` to stdout and `errText` to stderr. */
function printer(text: string, errText = ""): string[] {
  return [process.execPath, "-e", `process.stdout.write(${JSON.stringify(text)}); process.stderr.write(${JSON.stringify(errText)})`]
}

const FAKE_PAT = "ghp_" + "A1b2C3d4".repeat(5)
const FAKE_FINE = "github_pat_" + "Z9y8X7w6".repeat(4)

describe("execCommand redaction", () => {
  test("stdout and stderr are redacted by default (token shapes, credentials in URLs, registered secrets)", async () => {
    const registered = "my-registered-secret-value"
    registerSecret(registered)
    const r = await execCommand(printer(`token=${FAKE_PAT} url=https://alice:pw@host/x reg=${registered}`, `fine=${FAKE_FINE}`), { env: safeEnv() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("token=[REDACTED] url=https://[REDACTED]@host/x reg=[REDACTED]")
    expect(r.stderr).toBe("fine=[REDACTED]")
  })

  test("raw: output is returned verbatim (so the secrets gate sees the real token shapes)", async () => {
    registerSecret("my-registered-secret-value")
    const text = `+const token = '${FAKE_PAT}'\n+const url = 'https://alice:pw@host'\n+reg my-registered-secret-value\n`
    const r = await execCommand(printer(text, `warn ${FAKE_FINE}`), { env: safeEnv(), raw: true })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe(text)
    expect(r.stderr).toBe(`warn ${FAKE_FINE}`)
  })
})

describe("execCommand cancellation", () => {
  test("an already-aborted signal kills the child at once", async () => {
    const ctl = new AbortController()
    ctl.abort()
    const started = Date.now()
    const r = await execCommand([process.execPath, "-e", "setTimeout(() => console.log('finished'), 10000)"], { env: safeEnv(), signal: ctl.signal })
    expect(Date.now() - started).toBeLessThan(8000)
    expect(r.stdout).not.toContain("finished")
    expect(r.exitCode).not.toBe(0)
  })

  test("aborting while running kills the child", async () => {
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 200)
    const r = await execCommand([process.execPath, "-e", "setTimeout(() => console.log('finished'), 10000)"], { env: safeEnv(), signal: ctl.signal })
    expect(r.stdout).not.toContain("finished")
    expect(r.exitCode).not.toBe(0)
  })

  test("an empty argv is rejected", async () => {
    await expect(execCommand([])).rejects.toThrow("exec: empty argv")
  })
})
