/** Injectable clock so scheduling, cooldowns and caps are testable. */
export interface Clock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve()
      const t = setTimeout(done, Math.max(0, ms))
      function done() {
        signal?.removeEventListener("abort", done)
        clearTimeout(t)
        resolve()
      }
      signal?.addEventListener("abort", done, { once: true })
    }),
}

/** Manually-advanced clock for tests. `sleep` advances time instantly. */
export class FakeClock implements Clock {
  constructor(private t: number = Date.UTC(2026, 0, 15, 12, 0, 0)) {}
  now(): number {
    return this.t
  }
  advance(ms: number): void {
    this.t += ms
  }
  set(ms: number): void {
    this.t = ms
  }
  async sleep(ms: number): Promise<void> {
    this.t += Math.max(0, ms)
  }
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** UTC calendar day "YYYY-MM-DD" for budget accounting. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Parse an ISO string to epoch ms; null for null/invalid. */
export function isoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const v = Date.parse(iso)
  return Number.isFinite(v) ? v : null
}
