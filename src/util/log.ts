import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { redact, redactValue } from "./redact.ts"

export type LogLevel = "debug" | "info" | "warn" | "error"
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

export interface LoggerOptions {
  level?: LogLevel
  /** JSON-lines file. Created if missing. */
  file?: string | null
  console?: boolean
  bindings?: Record<string, unknown>
  /** For tests: capture lines. */
  sink?: (line: string) => void
  now?: () => number
}

/** Structured JSON-lines logger. Every line is redacted before it is written. */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = ORDER[opts.level ?? "info"]
  const bindings = opts.bindings ?? {}
  const now = opts.now ?? Date.now
  let dirReady = false

  function write(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (ORDER[level] < min) return
    const record = {
      ts: new Date(now()).toISOString(),
      level,
      svc: "oss-scout",
      msg: redact(msg),
      ...(redactValue({ ...bindings, ...(fields ?? {}) }) as Record<string, unknown>),
    }
    let line: string
    try {
      line = JSON.stringify(record)
    } catch {
      line = JSON.stringify({ ts: record.ts, level, svc: "oss-scout", msg: record.msg, note: "unserializable fields" })
    }
    if (opts.sink) opts.sink(line)
    if (opts.file) {
      try {
        if (!dirReady) {
          mkdirSync(dirname(opts.file), { recursive: true })
          dirReady = true
        }
        appendFileSync(opts.file, line + "\n")
      } catch {
        // logging must never crash the pipeline
      }
    }
    if (opts.console) {
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log
      fn(line)
    }
  }

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (b) => createLogger({ ...opts, bindings: { ...bindings, ...b } }),
  }
}

export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger
  },
}

/** Stringify an unknown error safely (redacted). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return redact(err.message || err.name)
  if (typeof err === "string") return redact(err)
  try {
    const s = JSON.stringify(err)
    return s === undefined ? redact(String(err)) : redact(s)
  } catch {
    return "unknown error"
  }
}
