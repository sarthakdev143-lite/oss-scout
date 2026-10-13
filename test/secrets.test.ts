import { describe, expect, test } from "bun:test"
import { isPlaceholder, matchSecretRule, scanDiffForSecrets, shannonEntropy } from "../src/verify/secrets.ts"

/** Deterministic pseudo-random string so no real-looking secret literal lives in this file. */
function rand(len: number, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", seed = 7): string {
  // mulberry32
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  let out = ""
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(next() * alphabet.length)]
  return out
}

const UPPER_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")

/** Wrap added lines into a one-file unified diff. */
function diffOf(file: string, added: string[]): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,0 +1,${added.length} @@`, ...added.map((l) => `+${l}`), ""].join(
    "\n",
  )
}

describe("matchSecretRule: positives", () => {
  const positives: Array<[string, string]> = [
    ["github-token", `const t = "ghp_${rand(36)}"`],
    ["github-token", `token: gho_${rand(36, undefined, 3)}`],
    ["github-fine-grained-token", `GH=github_pat_${rand(22)}_${rand(59, undefined, 11)}`],
    ["aws-access-key-id", `aws_access_key_id = ${"AKIA" + rand(16, UPPER_DIGITS)}`],
    ["aws-access-key-id", `"${"ASIA" + rand(16, UPPER_DIGITS, 5)}"`],
    ["aws-secret-access-key", `aws_secret_access_key = "${rand(40, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+")}"`],
    ["private-key", "-----BEGIN RSA PRIVATE KEY-----"],
    ["private-key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["private-key", "-----BEGIN PRIVATE KEY-----"],
    ["slack-token", `SLACK=xoxb-${rand(12, "0123456789")}-${rand(24)}`],
    ["slack-webhook", `url = "https://hooks.slack.com/services/T${rand(8, UPPER_DIGITS)}/B${rand(8, UPPER_DIGITS)}/${rand(24)}"`],
    ["stripe-live-key", `stripe.key = "sk_live_${rand(24)}"`],
    ["google-api-key", `key: "AIza${rand(35, undefined, 9)}"`],
    ["openai-anthropic-key", `OPENAI_API_KEY=sk-${rand(48, undefined, 13)}`],
    ["openai-anthropic-key", `const k = "sk-ant-api03-${rand(80, undefined, 17)}"`],
    ["jwt", `Authorization: Bearer ${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "u_8812", role: "admin" })}.${rand(43)}`],
    ["generic-secret-assignment", `const apiKey = "${rand(32, undefined, 21)}"`],
    ["generic-secret-assignment", `client_secret: '${rand(24, "abcdef0123456789", 4)}'`],
    ["generic-secret-assignment", `"password": "Zq8${rand(14, undefined, 33)}"`],
    ["generic-secret-assignment", `DB_PASSWD := "${rand(20, undefined, 41)}"`],
  ]
  for (const [rule, line] of positives) {
    test(`${rule}: ${line.slice(0, 40)}…`, () => {
      expect(matchSecretRule(line, "src/config.ts")).toBe(rule)
    })
  }
})

describe("matchSecretRule: no false positives on typical code", () => {
  const negatives: Array<[string, string]> = [
    ["env lookup", "const token = process.env.GITHUB_TOKEN"],
    ["python env", 'api_key = os.environ["API_KEY"]'],
    ["placeholder", 'const apiKey = "your-api-key-here"'],
    ["template", 'token: "${{ secrets.GITHUB_TOKEN }}"'],
    ["interpolation", 'password = "${DB_PASSWORD}"'],
    ["angle placeholder", 'secret: "<insert secret here>"'],
    ["aws docs example", 'aws_access_key_id = "AKIAIOSFODNN7EXAMPLE"'],
    ["aws docs secret", 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'],
    ["short password", 'password: "hunter2"'],
    ["sentence", 'password: "Password must contain at least 8 characters"'],
    ["low entropy", 'secret = "aaaaaaaaaaaaaaaaaaaa"'],
    ["identifier value", 'tokenType: "refresh-token-header"'],
    ["key name only", 'const TOKEN_ENV = "OSS_SCOUT_WRITE_TOKEN"'],
    ["comparison", 'if (token === "abc123XYZ789qwe456") return'],
    ["key suffix", 'const authorName = "Jane Q Developer"'],
    ["masked", 'password: "************"'],
    ["changeme", 'DB_PASSWORD="changeme12345"'],
    ["placeholder token", "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
    ["fake test token", "ghp_testtoken000000000000000000000000"],
    ["css class", 'className="sk-circle-bounce-delay-animation"'],
    ["sk word", "const risk-assessment-for-the-team = 1"],
    ["jwt.io example", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
    ["plain code", "export function tokenize(input: string): Token[] {"],
    ["url", 'const url = "https://api.example.com/v1/tokens"'],
    ["sha", 'const commit = "3e6ae0e1a2b3c4d5e6f708192a3b4c5d6e7f8091"'],
  ]
  for (const [name, line] of negatives) {
    test(name, () => {
      expect(matchSecretRule(line, "src/config.ts")).toBeNull()
    })
  }

  test("heuristic rule is skipped in test files, strong rules are not", () => {
    const generic = `const token = "${rand(32, undefined, 21)}"`
    expect(matchSecretRule(generic, "src/client.ts")).toBe("generic-secret-assignment")
    for (const path of ["test/client.test.ts", "tests/test_client.py", "src/__tests__/c.ts", "pkg/client_test.go", "src/test/java/FooTest.java", "spec/fixtures/a.json"]) {
      expect(matchSecretRule(generic, path)).toBeNull()
    }
    expect(matchSecretRule(`t = "ghp_${rand(36)}"`, "test/client.test.ts")).toBe("github-token")
  })
})

describe("scanDiffForSecrets", () => {
  test("reports file and new line number, never the value", () => {
    const token = `ghp_${rand(36)}`
    const diff = diffOf("src/config.ts", ["const a = 1", `const t = "${token}"`])
    const findings = scanDiffForSecrets(diff)
    expect(findings).toEqual([{ file: "src/config.ts", line: 2, rule: "github-token" }])
    expect(JSON.stringify(findings)).not.toContain(token)
  })

  test("removed and context lines are ignored", () => {
    const token = `ghp_${rand(36)}`
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      ` const old = "${"AKIA" + rand(16, UPPER_DIGITS)}"`,
      `-const t = "${token}"`,
      "+const t = process.env.TOKEN",
      "",
    ].join("\n")
    expect(scanDiffForSecrets(diff)).toEqual([])
  })

  test("one finding per line, several lines", () => {
    const diff = diffOf("keys.pem", ["-----BEGIN PRIVATE KEY-----", rand(64), "-----END PRIVATE KEY-----"])
    expect(scanDiffForSecrets(diff)).toEqual([{ file: "keys.pem", line: 1, rule: "private-key" }])
  })

  test("typical test code produces no findings", () => {
    const diff = diffOf("test/auth.test.ts", [
      'import { login } from "../src/auth"',
      'const password = "correct horse battery staple"',
      'const token = "test-token-123456789"',
      'const apiKey = "dummy_key_for_tests"',
      `const secret = "${rand(30, undefined, 5)}"`,
      'expect(login({ user: "alice", password: "s3cr3t!" })).toBe(true)',
    ])
    expect(scanDiffForSecrets(diff)).toEqual([])
  })
})

describe("helpers", () => {
  test("shannonEntropy", () => {
    expect(shannonEntropy("")).toBe(0)
    expect(shannonEntropy("aaaa")).toBe(0)
    expect(shannonEntropy("abcd")).toBeCloseTo(2)
    expect(shannonEntropy(rand(64))).toBeGreaterThan(4.5)
  })
  test("isPlaceholder", () => {
    expect(isPlaceholder("${TOKEN}")).toBe(true)
    expect(isPlaceholder("your_token")).toBe(true)
    expect(isPlaceholder(rand(30))).toBe(false)
  })
})
