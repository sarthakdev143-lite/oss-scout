import { addedLines } from "./diff.ts"

export interface SecretFinding {
  file: string
  line: number
  rule: string
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (!s) return 0
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  const n = [...s].length
  for (const c of counts.values()) {
    const p = c / n
    h -= p * Math.log2(p)
  }
  return h
}

const PLACEHOLDER_RE =
  /example|sample|dummy|test|fake|mock|changeme|change[_-]me|placeholder|redacted|your[_-]|xxx|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%\([^)]*\)s|process\.env|os\.environ|getenv|\*{3,}|\.\.\.|123456|abcdefgh/i

/** Obvious placeholder / templated / environment-sourced value. */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value)
}

/** Tests and fixtures routinely contain fake credentials; the heuristic rule skips them. */
const TEST_PATH_RE =
  /(^|\/)(tests?|__tests__|spec|specs|fixtures?|__fixtures__|testdata|__mocks__|mocks?)\/|(^|\/)test_[^/]*$|[._-](test|spec)\.[^/]+$|_test\.[^/]+$|Tests?\.(java|kt|cs|scala)$/i

function charClasses(s: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(s)).length
}

/** A random-looking token body: not a placeholder and not low-entropy filler like "xxxx" or "0000". */
function looksRandom(body: string, minEntropy = 3): boolean {
  return !isPlaceholder(body) && shannonEntropy(body) >= minEntropy
}

interface Rule {
  id: string
  re: RegExp
  /** Extra validation on the match; default: looksRandom on capture group 1 (or the whole match). */
  check?: (m: RegExpExecArray) => boolean
  /** Rule is heuristic and skipped in test/fixture files. */
  heuristic?: boolean
}

function decodeBase64Url(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/")
    return Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf8")
  } catch {
    return null
  }
}

const JWT_EXAMPLE_RE = /john doe|1234567890|example|test|fake|dummy|sample/i

const RULES: Rule[] = [
  {
    id: "private-key",
    re: /-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH|PGP|ENCRYPTED) )?PRIVATE KEY(?: BLOCK)?-----/,
    check: () => true,
  },
  { id: "github-token", re: /\bgh[pousr]_([A-Za-z0-9]{20,255})\b/ },
  { id: "github-fine-grained-token", re: /\bgithub_pat_([A-Za-z0-9_]{22,255})\b/ },
  { id: "aws-access-key-id", re: /\b((?:AKIA|ASIA)[A-Z0-9]{16})\b/ },
  {
    id: "aws-secret-access-key",
    re: /aws_?secret_?access_?key["']?\s*(?::=|=>|:|=)\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i,
    check: (m) => looksRandom(m[1]!, 3.5),
  },
  { id: "slack-token", re: /\bxox[abposr]-([A-Za-z0-9-]{10,})\b/ },
  {
    id: "slack-webhook",
    re: /https:\/\/hooks\.slack\.com\/services\/(T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+)/,
  },
  { id: "stripe-live-key", re: /\b(?:sk|rk)_live_([A-Za-z0-9]{16,})\b/ },
  { id: "google-api-key", re: /\b(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/ },
  {
    id: "openai-anthropic-key",
    re: /\bsk-(?:ant-(?:[a-z]+\d*-)?|proj-|svcacct-|admin-)?([A-Za-z0-9_-]{20,})/,
    check: (m) => charClasses(m[1]!) === 3 && looksRandom(m[1]!, 3.5),
  },
  {
    id: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/,
    check: (m) => {
      const payload = decodeBase64Url(m[1]!)
      return !(payload && JWT_EXAMPLE_RE.test(payload))
    },
  },
  {
    id: "generic-secret-assignment",
    re: /(?:api[_-]?key|secret|passw(?:or)?d|token|auth)["']?\s*(?::=|=>|:|=)\s*["']([^"'\n]{12,})["']/i,
    heuristic: true,
    check: (m) => {
      const value = m[1]!.replace(/^(?:bearer|basic|token)\s+/i, "")
      if (/\s/.test(value) || isPlaceholder(value)) return false
      if (charClasses(value) < 2) return false
      // Hex tops out at 4 bits/char, so random hex secrets need a lower bar than base64-ish ones.
      const hex = /^[0-9a-f]{16,}$/i.test(value)
      return shannonEntropy(value) >= (hex ? 3 : 3.5)
    },
  },
]

/** First rule that flags `text`, or null. */
export function matchSecretRule(text: string, path = ""): string | null {
  const isTest = TEST_PATH_RE.test(path.replace(/\\/g, "/"))
  for (const rule of RULES) {
    if (rule.heuristic && isTest) continue
    const m = rule.re.exec(text)
    if (!m) continue
    const ok = rule.check ? rule.check(m) : looksRandom(m[1] ?? m[0])
    if (ok) return rule.id
  }
  return null
}

/**
 * Scan ADDED lines of a unified diff for credentials (tokens, keys, private keys, high-entropy
 * assignments). At most one finding per line; the matched value is never included. Pure.
 */
export function scanDiffForSecrets(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  for (const { file, line, text } of addedLines(diff)) {
    const rule = matchSecretRule(text, file)
    if (rule) findings.push({ file, line, rule })
  }
  return findings
}
