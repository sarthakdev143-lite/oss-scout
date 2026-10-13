import { describe, expect, test } from "bun:test"
import type { IssueRecord } from "../src/core/types.ts"
import { createHash } from "node:crypto"
import {
  buildPrBody,
  closeOpenBlocks,
  closesIssue,
  computeDigest,
  ensureDisclosure,
  hasDisclosure,
  referencesIssue,
  visibleMarkdown,
} from "../src/queue/prbody.ts"

const LINE = "Prepared with AI assistance; reviewed and tested by me."

function issue(over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: "acme/widget#42",
    repo: "acme/widget",
    number: 42,
    title: "Crash on zero timeout",
    url: "https://github.com/acme/widget/issues/42",
    body: "",
    labels: ["bug"],
    createdAt: "2026-01-05T09:00:00Z",
    updatedAt: "2026-01-10T09:00:00Z",
    comments: 0,
    kind: "bug",
    status: "selected",
    score: 0.8,
    reasons: [],
    skipReason: null,
    fetchedAt: 0,
    ...over,
  }
}

describe("hasDisclosure", () => {
  test("ignores case, whitespace and markdown emphasis", () => {
    expect(hasDisclosure(`Body\n\n_${LINE}_`, LINE)).toBe(true)
    expect(hasDisclosure(`Body\n\n**prepared  with AI\nassistance;** reviewed and tested by me.`, LINE)).toBe(true)
    expect(hasDisclosure(`> ${LINE.toUpperCase()}`, LINE)).toBe(true)
  })

  test("false when missing or altered", () => {
    expect(hasDisclosure("Just a body", LINE)).toBe(false)
    expect(hasDisclosure("Prepared with assistance; reviewed and tested by me.", LINE)).toBe(false)
    expect(hasDisclosure("anything", "   ")).toBe(false)
  })
})

describe("ensureDisclosure", () => {
  test("appends under a separator when missing", () => {
    expect(ensureDisclosure("Fix the crash.\n\n", LINE)).toBe(`Fix the crash.\n\n---\n${LINE}`)
  })

  test("is idempotent and never removes content", () => {
    const once = ensureDisclosure("Fix the crash.", LINE)
    expect(ensureDisclosure(once, LINE)).toBe(once)
    const already = `Intro\n\n*${LINE}*\n\nTrailer`
    expect(ensureDisclosure(already, LINE)).toBe(already)
  })

  test("empty body becomes just the line; blank line leaves body alone", () => {
    expect(ensureDisclosure("", LINE)).toBe(LINE)
    expect(ensureDisclosure("body", "  ")).toBe("body")
  })
})

describe("referencesIssue", () => {
  test("detects #N, owner/repo#N and the URL but not other numbers", () => {
    const i = issue()
    expect(referencesIssue("Closes #42.", i)).toBe(true)
    expect(referencesIssue("See acme/widget#42", i)).toBe(true)
    expect(referencesIssue("See https://github.com/acme/widget/issues/42 for details", i)).toBe(true)
    expect(referencesIssue("Related: #420 and #4", i)).toBe(false)
    expect(referencesIssue("other/repo#42", i)).toBe(false)
    expect(referencesIssue("https://github.com/acme/widget/issues/421", i)).toBe(false)
  })
})

describe("buildPrBody", () => {
  const base = {
    issue: issue(),
    template: null,
    testSummary: "`npm test` passed in the sandbox (412 tests, network none).",
    disclosureLine: LINE,
    closingReference: true,
  }

  test("adds Fixes #N once, a Verification section and the disclosure", () => {
    const body = buildPrBody({ ...base, drafted: "## Summary\nHandle a zero timeout." })
    expect(body.match(/Fixes #42/g)?.length).toBe(1)
    expect(body).toContain("### Verification\n\n`npm test` passed")
    expect(body.endsWith(`---\n${LINE}`)).toBe(true)
    expect(body.indexOf("Fixes #42")).toBeLessThan(body.indexOf("### Verification"))
  })

  test("does not add Fixes when the draft already references the issue", () => {
    for (const drafted of ["Fixes #42", "Closes https://github.com/acme/widget/issues/42", "Part of acme/widget#42"]) {
      const body = buildPrBody({ ...base, drafted })
      expect(body.startsWith(drafted)).toBe(true)
      expect(body.match(/#42|issues\/42/g)?.length).toBe(1)
    }
  })

  test("is stable when rebuilt from its own output", () => {
    const once = buildPrBody({ ...base, drafted: "Handle zero timeout." })
    const twice = buildPrBody({ ...base, drafted: once })
    expect(twice.match(/Fixes #42/g)?.length).toBe(1)
    expect(twice.match(/### Verification/g)?.length).toBe(1)
    expect(twice.match(new RegExp(LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1)
  })

  test("no closing reference when not targeting the default branch or no issue", () => {
    expect(buildPrBody({ ...base, drafted: "x", closingReference: false })).not.toContain("Fixes")
    expect(buildPrBody({ ...base, drafted: "x", issue: null })).not.toContain("Fixes")
  })

  test("fills an unfilled closing placeholder from the template instead of appending", () => {
    const body = buildPrBody({ ...base, drafted: "## Description\nFix it.\n\n## Related issue\nCloses #\n" })
    expect(body).toContain("## Related issue\nFixes #42")
    expect(body).not.toContain("Closes #\n")
    expect(body.match(/Fixes #42/g)?.length).toBe(1)
  })

  test("keeps an existing testing section and only adds a brief sandbox note", () => {
    const drafted = "## Summary\nFix.\n\n## How Has This Been Tested?\nAdded a regression test."
    const body = buildPrBody({ ...base, drafted })
    expect(body).not.toContain("### Verification")
    expect(body).toContain("_Sandboxed verification: `npm test` passed in the sandbox")
  })

  test("empty draft falls back to the template; empty test summary adds nothing", () => {
    const body = buildPrBody({ ...base, drafted: "  ", template: "## Summary\n<!-- describe -->", testSummary: "" })
    expect(body.startsWith("## Summary")).toBe(true)
    expect(body).not.toContain("Verification")
    expect(hasDisclosure(body, LINE)).toBe(true)
  })
})

describe("computeDigest", () => {
  const item = { kind: "pr" as const, repo: "acme/widget", title: "Fix", body: "Body", diff: "diff --git a b" }

  test("is a stable sha256 hex", () => {
    const d = computeDigest(item)
    expect(d).toMatch(/^[0-9a-f]{64}$/)
    expect(computeDigest({ ...item })).toBe(d)
  })

  test("changes when any field changes", () => {
    const d = computeDigest(item)
    expect(computeDigest({ ...item, body: "Body!" })).not.toBe(d)
    expect(computeDigest({ ...item, title: "Fix!" })).not.toBe(d)
    expect(computeDigest({ ...item, diff: "" })).not.toBe(d)
    expect(computeDigest({ ...item, repo: "acme/other" })).not.toBe(d)
    expect(computeDigest({ ...item, kind: "reply" })).not.toBe(d)
  })

  test("field boundaries cannot be shifted to collide", () => {
    expect(computeDigest({ ...item, title: "ab", body: "c" })).not.toBe(computeDigest({ ...item, title: "a", body: "bc" }))
  })
})

describe("computeDigest: commit binding", () => {
  const item = { kind: "pr" as const, repo: "acme/widget", title: "Fix", body: "Body", diff: "diff --git a b" }
  const sha = "0123456789abcdef0123456789abcdef01234567"

  test("items without a commit keep the original 5-field digest", () => {
    const legacy = createHash("sha256").update(JSON.stringify(["pr", "acme/widget", "Fix", "Body", "diff --git a b"]), "utf8").digest("hex")
    expect(computeDigest(item)).toBe(legacy)
    expect(computeDigest({ ...item, data: {} })).toBe(legacy)
    expect(computeDigest({ ...item, commitSha: null, data: { commitSha: sha } })).toBe(legacy)
  })

  test("the commit (explicit or data.commitSha) is covered: a different commit changes the digest", () => {
    const bound = computeDigest({ ...item, data: { commitSha: sha } })
    expect(bound).not.toBe(computeDigest(item))
    expect(computeDigest({ ...item, commitSha: sha })).toBe(bound)
    expect(computeDigest({ ...item, data: { commitSha: "f".repeat(40) } })).not.toBe(bound)
  })
})

const FENCE = "```"

describe("disclosure must be visible when rendered", () => {
  test("hidden in a comment, an unclosed comment, a code block, collapsed details, strikethrough or inline code: not present", () => {
    for (const hidden of [
      `Fix it.\n\n<!-- ${LINE} -->`,
      `Fix it.\n\n<!-- note\n${LINE}`,
      `Fix it.\n\n${FENCE}\n${LINE}\n${FENCE}`,
      `Fix it.\n\n~~~text\n${LINE}`,
      `Fix it.\n\n<details><summary>more</summary>\n\n${LINE}\n</details>`,
      `Fix it.\n\n~~${LINE}~~`,
      "Fix it. `" + LINE + "`",
    ]) {
      expect(hasDisclosure(hidden, LINE)).toBe(false)
      const fixed = ensureDisclosure(hidden, LINE)
      expect(fixed.startsWith(hidden.trimEnd())).toBe(true)
      expect(hasDisclosure(fixed, LINE)).toBe(true)
      expect(ensureDisclosure(fixed, LINE)).toBe(fixed)
    }
  })

  test("an unterminated comment or fence is closed before the disclosure is appended", () => {
    const body = ensureDisclosure("## Description\nFix.\n\n<!-- Thanks for contributing! Please make sure", LINE)
    expect(body).toContain(`Please make sure\n-->\n\n---\n${LINE}`)
    expect(visibleMarkdown(body)).toContain(LINE)
    expect(closeOpenBlocks(`text\n${FENCE}js\ncode`)).toBe(`text\n${FENCE}js\ncode\n${FENCE}`)
    expect(closeOpenBlocks("a <!-- b")).toBe("a <!-- b\n-->")
    expect(closeOpenBlocks("plain")).toBe("plain")
  })

  test("visible text keeps prose, drops comments and code", () => {
    expect(visibleMarkdown("a <!-- b --> c `d` e").replace(/\s+/g, " ").trim()).toBe("a c e")
  })
})

describe("closing reference", () => {
  const i = issue()

  test("closesIssue needs a closing keyword; a plain mention does not close", () => {
    expect(closesIssue("Fixes #42", i)).toBe(true)
    expect(closesIssue("closes: acme/widget#42", i)).toBe(true)
    expect(closesIssue("Resolves https://github.com/acme/widget/issues/42", i)).toBe(true)
    expect(closesIssue("This addresses the crash reported in #42.", i)).toBe(false)
    expect(closesIssue("Related: #42", i)).toBe(false)
    expect(closesIssue("Fixes #420", i)).toBe(false)
    expect(closesIssue("<!-- Fixes #42 -->", i)).toBe(false)
  })

  const base = { issue: i, template: null, testSummary: "", disclosureLine: LINE, closingReference: true }

  test("a non-closing mention still gets Fixes #N", () => {
    const body = buildPrBody({ ...base, drafted: "This change addresses the crash reported in #42 by returning early." })
    expect(body).toContain("\n\nFixes #42")
  })

  test("a template placeholder is filled even when the issue is mentioned elsewhere", () => {
    const body = buildPrBody({ ...base, drafted: "## Description\nSee #42.\n\n## Related issue\nRelated: #42\nFixes #\n" })
    expect(body).toContain("Related: #42\nFixes #42")
    expect(body.match(/Fixes #42/g)?.length).toBe(1)
  })

  test("an explicit partial reference is respected", () => {
    expect(buildPrBody({ ...base, drafted: "Part of #42: the first half." })).not.toContain("Fixes #42")
  })

  test("a draft ending in an unclosed comment: Fixes, verification and disclosure stay visible", () => {
    const drafted = "## Description\n\nFixes the crash.\n\n## Checklist\n\n- [x] tests\n\n<!-- Thanks for contributing! Please make sure"
    const body = buildPrBody({ ...base, drafted, testSummary: "npm test passed" })
    const visible = visibleMarkdown(body)
    expect(visible).toContain("Fixes #42")
    expect(visible).toContain("npm test passed")
    expect(visible).toContain(LINE)
    expect(hasDisclosure(body, LINE)).toBe(true)
  })
})
