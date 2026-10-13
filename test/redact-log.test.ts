import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLogger, errorMessage, nullLogger } from "../src/util/log.ts"
import { clearRegisteredSecrets, redact, redactValue, registerSecret } from "../src/util/redact.ts"

afterEach(() => {
  clearRegisteredSecrets()
})

const CLASSIC = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
const FINE = "github_pat_11ABCDEFG0" + "abcdefghijklmnopqrstuvwxyz_0123456789"

// ---------------------------------------------------------------------------
// redact patterns
// ---------------------------------------------------------------------------

describe("redact patterns", () => {
  const cases: Array<[string, string, string]> = [
    ["classic PAT", `token=${CLASSIC} end`, "token=[REDACTED] end"],
    ["OAuth token", `gho_${"x".repeat(36)}`, "[REDACTED]"],
    ["user-to-server token", `ghu_${"y".repeat(36)}`, "[REDACTED]"],
    ["server token", `ghs_${"z".repeat(36)}`, "[REDACTED]"],
    ["refresh token", `ghr_${"w".repeat(36)}`, "[REDACTED]"],
    ["fine-grained PAT", `use ${FINE} now`, "use [REDACTED] now"],
    ["AWS access key", "AKIAIOSFODNN7EXAMPLE", "[REDACTED]"],
    ["AWS temp key", "ASIAIOSFODNN7EXAMPLE", "[REDACTED]"],
    ["Slack token", "xoxb-123456789012-abcdefABCDEF", "[REDACTED]"],
    ["Anthropic key", `sk-ant-${"a".repeat(30)}`, "[REDACTED]"],
    ["OpenAI project key", `sk-proj-${"b".repeat(30)}`, "[REDACTED]"],
    ["generic sk- key", `sk-${"c".repeat(24)}`, "[REDACTED]"],
    ["Google API key", `AIza${"d".repeat(35)}`, "[REDACTED]"],
    ["bearer header", "Authorization: Bearer abc.def-123", "Authorization: Bearer [REDACTED]"],
    ["token header", "authorization: token xyz789", "authorization: token [REDACTED]"],
    ["basic header (git extraheader)", "AUTHORIZATION: basic eC1hY2Nlc3M6c2VjcmV0", "AUTHORIZATION: basic [REDACTED]"],
    ["credentials in URL", "clone https://user:pa55word@github.com/a/b.git", "clone https://[REDACTED]@github.com/a/b.git"],
    ["token-only URL credentials", `http://x-access-token:${"q".repeat(10)}@example.com`, "http://[REDACTED]@example.com"],
  ]
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(redact(input)).toBe(expected)
    })
  }

  test("several secrets in one string", () => {
    expect(redact(`${CLASSIC} and ${FINE} and AKIAIOSFODNN7EXAMPLE`)).toBe("[REDACTED] and [REDACTED] and [REDACTED]")
  })

  test("leaves ordinary text alone", () => {
    for (const s of ["", "hello world", "ghp_short", "sk-tooshort", "https://github.com/acme/widget", "AKIA lowercase"]) {
      expect(redact(s)).toBe(s)
    }
  })

  test("is idempotent", () => {
    const once = redact(`Authorization: Bearer ${CLASSIC}`)
    expect(redact(once)).toBe(once)
  })
})

describe("registered secrets", () => {
  test("exact values are scrubbed everywhere once registered", () => {
    const secret = "my-custom-secret-123"
    expect(redact(`a ${secret} b`)).toBe(`a ${secret} b`)
    registerSecret(secret)
    expect(redact(`a ${secret} b ${secret}`)).toBe("a [REDACTED] b [REDACTED]")
    expect(redact(`prefix${secret}suffix`)).toBe("prefix[REDACTED]suffix")
  })

  test("short, null and undefined values are ignored", () => {
    registerSecret("short")
    registerSecret(null)
    registerSecret(undefined)
    registerSecret("")
    expect(redact("a short story")).toBe("a short story")
  })

  test("clearRegisteredSecrets forgets values", () => {
    registerSecret("forget-me-please")
    clearRegisteredSecrets()
    expect(redact("forget-me-please")).toBe("forget-me-please")
  })
})

// ---------------------------------------------------------------------------
// redactValue
// ---------------------------------------------------------------------------

describe("redactValue", () => {
  test("deep-redacts strings in objects and arrays", () => {
    const input = { a: [`x ${CLASSIC}`, { b: `Authorization: Bearer abc` }], n: 5, ok: true, nil: null }
    expect(redactValue(input)).toEqual({ a: ["x [REDACTED]", { b: "Authorization: Bearer [REDACTED]" }], n: 5, ok: true, nil: null })
    expect(input.a[0]).toBe(`x ${CLASSIC}`)
  })

  test("masks non-empty string values under secret-looking keys", () => {
    const out = redactValue({
      token: "abc",
      GITHUB_TOKEN: "abc",
      apiKey: "k",
      api_key: "k",
      "api-key": "k",
      password: "p",
      passwd: "p",
      client_secret: "s",
      Authorization: "Basic abc",
      privateKey: "-----BEGIN",
      private_key: "x",
      emptyToken: "",
      tokenCount: 12,
      name: "visible",
    })
    expect(out).toEqual({
      token: "[REDACTED]",
      GITHUB_TOKEN: "[REDACTED]",
      apiKey: "[REDACTED]",
      api_key: "[REDACTED]",
      "api-key": "[REDACTED]",
      password: "[REDACTED]",
      passwd: "[REDACTED]",
      client_secret: "[REDACTED]",
      Authorization: "[REDACTED]",
      privateKey: "[REDACTED]",
      private_key: "[REDACTED]",
      emptyToken: "",
      tokenCount: 12,
      name: "visible",
    })
  })

  test("errors become {name, message} with a redacted message", () => {
    const err = new TypeError(`bad ${CLASSIC}`)
    expect(redactValue({ err })).toEqual({ err: { name: "TypeError", message: "bad [REDACTED]" } })
  })

  test("deep nesting is cut off instead of recursing forever", () => {
    const circular: Record<string, unknown> = { v: 1 }
    circular.self = circular
    const out = JSON.stringify(redactValue(circular))
    expect(out).toContain("[…]")
    let deep: unknown = "leaf"
    for (let i = 0; i < 20; i++) deep = { d: deep }
    expect(JSON.stringify(redactValue(deep))).toContain("[…]")
  })

  test("primitives pass through", () => {
    expect(redactValue(3)).toBe(3)
    expect(redactValue(null)).toBeNull()
    expect(redactValue(undefined)).toBeUndefined()
    expect(redactValue(CLASSIC)).toBe("[REDACTED]")
  })
})

// ---------------------------------------------------------------------------
// logger
// ---------------------------------------------------------------------------

describe("createLogger", () => {
  function sinkLogger(level?: "debug" | "info" | "warn" | "error", bindings?: Record<string, unknown>) {
    const lines: string[] = []
    const log = createLogger({ level, bindings, sink: (l) => lines.push(l), now: () => Date.UTC(2026, 9, 11, 8, 0, 0) })
    return { log, lines, records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) }
  }

  test("writes one JSON object per line with ts, level, svc, msg and fields", () => {
    const { log, lines, records } = sinkLogger("debug")
    log.info("hello", { repo: "acme/widget", n: 3 })
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain("\n")
    expect(records()[0]).toEqual({ ts: "2026-10-11T08:00:00.000Z", level: "info", svc: "oss-scout", msg: "hello", repo: "acme/widget", n: 3 })
  })

  test("filters by level (default info)", () => {
    const def = sinkLogger()
    def.log.debug("hidden")
    def.log.info("shown")
    expect(def.records().map((r) => r.msg)).toEqual(["shown"])

    const warn = sinkLogger("warn")
    warn.log.debug("a")
    warn.log.info("b")
    warn.log.warn("c")
    warn.log.error("d")
    expect(warn.records().map((r) => [r.level, r.msg])).toEqual([
      ["warn", "c"],
      ["error", "d"],
    ])

    const dbg = sinkLogger("debug")
    dbg.log.debug("x")
    expect(dbg.records().map((r) => r.level)).toEqual(["debug"])
  })

  test("redacts message, fields and bindings", () => {
    registerSecret("registered-secret-value")
    const { log, lines } = sinkLogger("debug", { token: "binding-token-value" })
    log.warn(`push with ${CLASSIC} failed (registered-secret-value)`, {
      header: `Authorization: Bearer ${FINE}`,
      nested: { password: "hunter2", list: ["registered-secret-value"] },
    })
    const line = lines[0]!
    for (const s of [CLASSIC, FINE, "registered-secret-value", "hunter2", "binding-token-value"]) expect(line).not.toContain(s)
    const rec = JSON.parse(line)
    expect(rec.msg).toBe("push with [REDACTED] failed ([REDACTED])")
    expect(rec.token).toBe("[REDACTED]")
    expect(rec.nested).toEqual({ password: "[REDACTED]", list: ["[REDACTED]"] })
  })

  test("child loggers merge bindings; fields override bindings", () => {
    const { log, records } = sinkLogger("info", { svcPart: "scheduler" })
    const child = log.child({ task: "t1" }).child({ stage: "verify" })
    child.info("step", { stage: "critic" })
    expect(records()[0]).toMatchObject({ svcPart: "scheduler", task: "t1", stage: "critic", msg: "step" })
  })

  test("unserializable fields degrade to a note instead of throwing", () => {
    const { log, records } = sinkLogger()
    expect(() => log.info("big", { n: 10n })).not.toThrow()
    expect(records()[0]).toMatchObject({ level: "info", msg: "big", note: "unserializable fields" })
  })

  test("appends to a log file, creating its directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "oss-scout-log-"))
    try {
      const file = join(dir, "logs", "nested", "oss-scout.log")
      const log = createLogger({ file, level: "info" })
      log.info("one")
      log.error(`two ${CLASSIC}`)
      const lines = readFileSync(file, "utf8").trim().split("\n")
      expect(lines.map((l) => JSON.parse(l).msg)).toEqual(["one", "two [REDACTED]"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("nullLogger is a silent no-op", () => {
    expect(() => {
      nullLogger.debug("x")
      nullLogger.info("x", { a: 1 })
      nullLogger.warn("x")
      nullLogger.error("x")
    }).not.toThrow()
    expect(nullLogger.child({ a: 1 })).toBe(nullLogger)
  })
})

// ---------------------------------------------------------------------------
// errorMessage
// ---------------------------------------------------------------------------

describe("errorMessage", () => {
  test("errors, strings and JSON-able values are stringified and redacted", () => {
    expect(errorMessage(new Error(`failed with ${CLASSIC}`))).toBe("failed with [REDACTED]")
    expect(errorMessage(new RangeError(""))).toBe("RangeError")
    expect(errorMessage(`plain ${FINE}`)).toBe("plain [REDACTED]")
    expect(errorMessage({ code: 1, token: CLASSIC })).toBe('{"code":1,"token":"[REDACTED]"}')
    expect(errorMessage(42)).toBe("42")
    expect(errorMessage(null)).toBe("null")
  })

  test("unstringifiable values fall back to 'unknown error'", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(errorMessage(circular)).toBe("unknown error")
    expect(errorMessage(10n)).toBe("unknown error")
  })
})
