import { describe, expect, test } from "bun:test"
import type { CommandRun, ImplementationOutput, ProjectInfo } from "../src/core/types.ts"
import { parseUnifiedDiff } from "../src/verify/diff.ts"
import {
  addsSkipMarker,
  isDocPath,
  isDocsOnly,
  isTemplateFilled,
  normalizedIncludes,
  runVerificationGate,
  type GateDeps,
  type GateInput,
} from "../src/verify/gate.ts"
import { testConfig } from "./helpers/fakes.ts"

const DISCLOSURE = "Prepared with AI assistance; reviewed and tested by me."

const deps: GateDeps = {
  isTestFile: (p) => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$/.test(p),
  hasDisclosure: normalizedIncludes,
}

const project: ProjectInfo = {
  ecosystem: "node",
  packageManager: "npm",
  image: "node:22-bookworm",
  install: "npm ci",
  test: "npm test",
  lint: "npm run lint",
  testFilePatterns: ["**/*.test.ts"],
  notes: [],
}

function fileDiff(path: string, added: string[], removed: string[] = []): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed.length + 1} +1,${added.length + 1} @@`,
    " // context",
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    "",
  ].join("\n")
}

const CODE_DIFF =
  fileDiff("src/client.ts", ["  if (timeout === 0) return null"], ["  return controller.abort()"]) +
  fileDiff("test/client.test.ts", ['test("zero timeout", () => expect(make(0)).toBeNull())'])

function run(label: CommandRun["label"], exitCode = 0, timedOut = false): CommandRun {
  return {
    label,
    command: label === "lint" ? "npm run lint" : "npm test",
    exitCode,
    timedOut,
    durationMs: 3200,
    outputTail: "",
    network: "none",
    at: 0,
  }
}

function impl(over: Partial<ImplementationOutput> = {}): ImplementationOutput {
  const diff = over.diff ?? CODE_DIFF
  return {
    summary: "Return early for a zero timeout.",
    commitMessage: "fix: handle zero timeout",
    prTitle: "Handle zero timeout",
    prBody: "body",
    testFiles: ["test/client.test.ts"],
    reproduced: true,
    diff,
    diffStat: parseUnifiedDiff(diff),
    commitSha: "abc",
    baseSha: "base",
    finalTestRun: run("test"),
    finalLintRun: run("lint"),
    ...over,
  }
}

function input(over: Partial<GateInput> = {}, cfg: Parameters<typeof testConfig>[0] = {}): GateInput {
  return {
    implementation: impl(),
    project,
    issueKind: "bug",
    prTemplate: null,
    prBody: `Fixes the crash.\n\n---\n${DISCLOSURE}`,
    disclosureLine: DISCLOSURE,
    config: testConfig(cfg),
    ...over,
  }
}

function checkOf(report: ReturnType<typeof runVerificationGate>, name: string) {
  const c = report.checks.find((x) => x.name === name)
  if (!c) throw new Error(`missing check ${name}`)
  return c
}

describe("runVerificationGate", () => {
  test("a good change passes every check, with the exact check names", () => {
    const report = runVerificationGate(input(), deps)
    expect(report.checks.map((c) => c.name)).toEqual([
      "non-empty-diff",
      "tests-pass",
      "lint-pass",
      "tests-added",
      "reproduction",
      "tests-not-weakened",
      "diff-size",
      "files-changed",
      "unrelated-changes",
      "no-secrets",
      "pr-template-filled",
      "disclosure-present",
    ])
    expect(report.passed).toBe(true)
    expect(report.checks.filter((c) => c.status === "fail")).toEqual([])
    expect(checkOf(report, "pr-template-filled").status).toBe("skip")
  })

  test("empty diff fails", () => {
    const r = runVerificationGate(input({ implementation: impl({ diff: "" }) }), deps)
    expect(checkOf(r, "non-empty-diff").status).toBe("fail")
    expect(r.passed).toBe(false)
  })

  test("tests-pass: failing, timed out, missing", () => {
    expect(checkOf(runVerificationGate(input({ implementation: impl({ finalTestRun: run("test", 1) }) }), deps), "tests-pass")).toMatchObject({
      status: "fail",
    })
    const timedOut = checkOf(runVerificationGate(input({ implementation: impl({ finalTestRun: run("test", 0, true) }) }), deps), "tests-pass")
    expect(timedOut.status).toBe("fail")
    expect(timedOut.detail).toContain("timed out")
    expect(checkOf(runVerificationGate(input({ implementation: impl({ finalTestRun: null }) }), deps), "tests-pass").status).toBe("fail")
  })

  test("docs-only change: no test run is a skip, tests-added skipped", () => {
    const diff = fileDiff("docs/guide.md", ["New paragraph."]) + fileDiff("README.md", ["More words."])
    const r = runVerificationGate(
      input({
        issueKind: "docs",
        project: { ...project, test: null, lint: null },
        implementation: impl({ diff, finalTestRun: null, finalLintRun: null, reproduced: null }),
      }),
      deps,
    )
    expect(checkOf(r, "tests-pass").status).toBe("skip")
    expect(checkOf(r, "lint-pass")).toMatchObject({ status: "skip", detail: "no lint command detected" })
    expect(checkOf(r, "tests-added").status).toBe("skip")
    expect(checkOf(r, "reproduction").status).toBe("skip")
    expect(r.passed).toBe(true)
  })

  test("lint-pass: failing lint fails; configured but not run fails", () => {
    expect(checkOf(runVerificationGate(input({ implementation: impl({ finalLintRun: run("lint", 2) }) }), deps), "lint-pass").status).toBe("fail")
    expect(checkOf(runVerificationGate(input({ implementation: impl({ finalLintRun: null }) }), deps), "lint-pass").status).toBe("fail")
  })

  test("tests-added fails for a code change without tests, skipped for docs issues", () => {
    const diff = fileDiff("src/client.ts", ["  return null"])
    expect(checkOf(runVerificationGate(input({ implementation: impl({ diff }) }), deps), "tests-added").status).toBe("fail")
    expect(checkOf(runVerificationGate(input({ issueKind: "docs", implementation: impl({ diff }) }), deps), "tests-added").status).toBe("skip")
  })

  test("deleting a test file does not count as adding tests", () => {
    const diff =
      fileDiff("src/client.ts", ["  return null"]) +
      ["diff --git a/test/old.test.ts b/test/old.test.ts", "deleted file mode 100644", "--- a/test/old.test.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-x", ""].join("\n")
    expect(checkOf(runVerificationGate(input({ implementation: impl({ diff }) }), deps), "tests-added").status).toBe("fail")
  })

  test("reproduction: required for bugs, skipped otherwise", () => {
    expect(checkOf(runVerificationGate(input({ implementation: impl({ reproduced: false }) }), deps), "reproduction").status).toBe("fail")
    expect(checkOf(runVerificationGate(input({ taskKind: "contribution", implementation: impl({ reproduced: null }) }), deps), "reproduction").status).toBe("fail")
    expect(checkOf(runVerificationGate(input({ issueKind: "enhancement", implementation: impl({ reproduced: null }) }), deps), "reproduction").status).toBe(
      "skip",
    )
    const notRequired = input({ implementation: impl({ reproduced: false }) }, { implementation: { requireReproduction: false } })
    expect(checkOf(runVerificationGate(notRequired, deps), "reproduction").status).toBe("skip")
  })

  test("diff-size and files-changed limits", () => {
    const tight = input({}, { implementation: { maxDiffLines: 2, maxFilesChanged: 1 } })
    const r = runVerificationGate(tight, deps)
    expect(checkOf(r, "diff-size")).toMatchObject({ status: "fail", detail: "3 changed lines (limit 2)" })
    expect(checkOf(r, "files-changed")).toMatchObject({ status: "fail", detail: "2 files changed (limit 1)" })
    expect(r.passed).toBe(false)
  })

  test("unrelated changes fail with readable findings", () => {
    const diff = CODE_DIFF + fileDiff("package-lock.json", ['    "x": 1'])
    const c = checkOf(runVerificationGate(input({ implementation: impl({ diff }) }), deps), "unrelated-changes")
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("package-lock.json: lockfile changed")
  })

  test("secrets fail and the detail never contains the value", () => {
    const token = "ghp_" + "Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0Lz3Xc7V"
    const diff = CODE_DIFF + fileDiff("src/config.ts", [`export const t = "${token}"`])
    const c = checkOf(runVerificationGate(input({ implementation: impl({ diff }) }), deps), "no-secrets")
    expect(c.status).toBe("fail")
    expect(c.detail).toBe("src/config.ts:2 (github-token)")
    expect(c.detail).not.toContain(token)
  })

  test("PR template filled / not filled", () => {
    const template = "## Description\n<!-- What does this change? -->\n\n## Testing\n<!-- How was it tested? -->\n"
    const good = `## Description\nReturn early for zero timeout.\n\n## Testing\nAdded a unit test; npm test passes.\n\n${DISCLOSURE}`
    expect(checkOf(runVerificationGate(input({ prTemplate: template, prBody: good }), deps), "pr-template-filled").status).toBe("pass")
    const bad = `${template}\n${DISCLOSURE}`
    const c = checkOf(runVerificationGate(input({ prTemplate: template, prBody: bad }), deps), "pr-template-filled")
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("Description")
  })

  test("disclosure must be present (whitespace/case-insensitive)", () => {
    const missing = runVerificationGate(input({ prBody: "Fixes the crash." }), deps)
    expect(checkOf(missing, "disclosure-present").status).toBe("fail")
    expect(missing.passed).toBe(false)
    const reflowed = runVerificationGate(input({ prBody: "x\n\nprepared with AI assistance;\nreviewed and tested   by me." }), deps)
    expect(checkOf(reflowed, "disclosure-present").status).toBe("pass")
  })

  test("injected disclosure checker is used", () => {
    const r = runVerificationGate(input(), { ...deps, hasDisclosure: () => false })
    expect(checkOf(r, "disclosure-present").status).toBe("fail")
  })

  test("pipeline-logic-2: a reproduced bug whose change touches only test files fails reproduction", () => {
    const testOnly = fileDiff("test/client.test.ts", ['test("zero timeout", () => expect(make(0)).toBeNull())'])
    const r = runVerificationGate(input({ taskKind: "contribution", implementation: impl({ diff: testOnly, reproduced: true }) }), deps)
    expect(checkOf(r, "reproduction").status).toBe("fail")
    expect(checkOf(r, "reproduction").detail).toContain("only test files")
    expect(r.passed).toBe(false)
  })

  test("pipeline-logic-2: deleting a test file or adding a skip/only marker fails tests-not-weakened", () => {
    const deleted =
      CODE_DIFF +
      ["diff --git a/test/old.test.ts b/test/old.test.ts", "deleted file mode 100644", "--- a/test/old.test.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-x", ""].join("\n")
    expect(checkOf(runVerificationGate(input({ implementation: impl({ diff: deleted }) }), deps), "tests-not-weakened").status).toBe("fail")

    const skip =
      fileDiff("src/client.ts", ["  if (timeout === 0) return null"]) +
      fileDiff("test/client.test.ts", ['test.skip("zero timeout", () => expect(make(0)).toBeNull())'])
    const c = checkOf(runVerificationGate(input({ implementation: impl({ diff: skip }) }), deps), "tests-not-weakened")
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("skip/only marker")

    // a skip marker in a non-test (source) file is not flagged
    const srcSkip = CODE_DIFF + fileDiff("src/other.ts", ["// it.only is just a comment here"])
    expect(checkOf(runVerificationGate(input({ implementation: impl({ diff: srcSkip }) }), deps), "tests-not-weakened").status).toBe("pass")
  })

  test("addsSkipMarker recognizes JS/pytest/junit/go/rust skip & focus markers", () => {
    for (const l of ["  it.skip('x', () => {})", "test.only('x')", "describe.skip(", "xit('x')", "fdescribe('x')", "@pytest.mark.skip", "@pytest.mark.xfail(reason='x')", "self.skipTest('x')", "@Disabled", "@Ignore", "t.Skip()", "#[ignore]"]) {
      expect(addsSkipMarker(l)).toBe(true)
    }
    for (const l of ["it('works', () => {})", "const skip = false", "// skip this later", "describe('suite', () => {})", "monitor.only()"]) {
      expect(addsSkipMarker(l)).toBe(false)
    }
  })

  test("pipeline-logic-3: a follow-up fix on a bug PR passes without a reproduction or a test change", () => {
    const sourceOnly = fileDiff("src/client.ts", ["  return create()"], ["  return make()"])
    const r = runVerificationGate(
      input({ taskKind: "followup_fix", issueKind: "bug", implementation: impl({ diff: sourceOnly, reproduced: null }) }),
      deps,
    )
    expect(checkOf(r, "reproduction").status).toBe("skip")
    expect(checkOf(r, "tests-added").status).toBe("skip")
    expect(checkOf(r, "tests-not-weakened").status).toBe("pass")
    expect(r.passed).toBe(true)
  })

  test("pipeline-logic-3: a follow-up fix that deletes its own tests is still allowed, but may not add skip markers", () => {
    const deleteOwnTest =
      fileDiff("src/client.ts", ["  return create()"]) +
      ["diff --git a/test/old.test.ts b/test/old.test.ts", "deleted file mode 100644", "--- a/test/old.test.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-x", ""].join("\n")
    expect(checkOf(runVerificationGate(input({ taskKind: "followup_fix", issueKind: "bug", implementation: impl({ diff: deleteOwnTest, reproduced: null }) }), deps), "tests-not-weakened").status).toBe("pass")
  })
})

describe("docs detection", () => {
  test("isDocPath", () => {
    expect(isDocPath("README.md")).toBe(true)
    expect(isDocPath("docs/api/index.js")).toBe(true)
    expect(isDocPath("guide.rst")).toBe(true)
    expect(isDocPath("CHANGES.txt")).toBe(true)
    expect(isDocPath("requirements-dev.txt")).toBe(false)
    expect(isDocPath("CMakeLists.txt")).toBe(false)
    expect(isDocPath("src/index.ts")).toBe(false)
  })
  test("isDocsOnly", () => {
    expect(isDocsOnly(parseUnifiedDiff(fileDiff("README.md", ["x"])))).toBe(true)
    expect(isDocsOnly(parseUnifiedDiff(fileDiff("README.md", ["x"]) + fileDiff("src/a.ts", ["y"])))).toBe(false)
    expect(isDocsOnly(parseUnifiedDiff(""))).toBe(false)
  })
})

describe("isTemplateFilled", () => {
  const TEMPLATE = [
    "## Description",
    "<!-- Please include a summary of the change and which issue is fixed. -->",
    "Fixes # (issue)",
    "",
    "## Type of change",
    "- [ ] Bug fix",
    "- [ ] New feature",
    "",
    "## How Has This Been Tested?",
    "Please describe the tests that you ran.",
    "",
    "## Screenshots (if applicable)",
    "",
    "**Checklist**",
    "- [ ] My code follows the style guidelines",
    "- [ ] I have added tests",
  ].join("\n")

  test("filled template passes", () => {
    const body = [
      "## Description",
      "Return early when the timeout is 0 instead of dereferencing the controller.",
      "",
      "## Type of change",
      "- [x] Bug fix",
      "- [ ] New feature",
      "",
      "## How Has This Been Tested?",
      "Added a regression test; `npm test` passes in the sandbox.",
      "",
      "**Checklist**",
      "- [x] My code follows the style guidelines",
      "- [x] I have added tests",
    ].join("\n")
    const r = isTemplateFilled(TEMPLATE, body)
    expect(r.ok).toBe(true)
  })

  test("unchanged template fails and lists the empty sections", () => {
    const r = isTemplateFilled(TEMPLATE, TEMPLATE)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain("Description")
    expect(r.detail).toContain("How Has This Been Tested?")
    expect(r.detail).not.toContain("Screenshots")
  })

  test("sections left with only HTML comments are empty", () => {
    const t = "## Summary\n<!-- describe -->\n\n## Tests\n<!-- how -->"
    const r = isTemplateFilled(t, "## Summary\n<!-- describe -->\n\n## Tests\nUnit test added.")
    expect(r.ok).toBe(false)
    expect(r.detail).toContain("Summary")
  })

  test("missing headings: at least 70% of required sections must be present", () => {
    const t = "## A section\nx\n## B section\nx\n## C section\nx\n## D section\nx"
    const three = "## A section\nfilled\n## B section\nfilled\n## C section\nfilled"
    expect(isTemplateFilled(t, three).ok).toBe(true)
    const two = "## A section\nfilled\n## B section\nfilled"
    const r = isTemplateFilled(t, two)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain("missing sections: C section, D section")
  })

  test("heading level / bold form may differ; headings inside code fences are ignored", () => {
    const t = "### What\n<!-- -->\n```\n## Not a heading\n```\n### Why\n<!-- -->"
    expect(isTemplateFilled(t, "**What**\nA fix.\n\n## Why\nBecause it crashed.").ok).toBe(true)
  })

  test("checklist-only sections may stay unticked", () => {
    const t = "## Description\n\n## Checklist\n- [ ] I signed the CLA\n- [ ] Docs updated"
    expect(isTemplateFilled(t, "## Description\nFix.\n\n## Checklist\n- [ ] I signed the CLA\n- [ ] Docs updated").ok).toBe(true)
  })

  test("templates without headings: body must differ from the template", () => {
    const t = "Describe your change here.\n- [ ] tests"
    expect(isTemplateFilled(t, t).ok).toBe(false)
    expect(isTemplateFilled(t, "").ok).toBe(false)
    expect(isTemplateFilled(t, "Fix the crash.\n- [x] tests").ok).toBe(true)
  })

  test("placeholder lines do not count as content", () => {
    const t = "## Description\n<!-- -->\n## Notes\n<!-- -->"
    expect(isTemplateFilled(t, "## Description\n...\n## Notes\nTBD").ok).toBe(false)
    expect(isTemplateFilled(t, "## Description\nReal text.\n## Notes\nN/A").ok).toBe(true)
  })
})
