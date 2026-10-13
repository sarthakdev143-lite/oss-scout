import { describe, expect, test } from "bun:test"
import {
  addedLines,
  classifyUnrelatedPath,
  findUnrelatedChanges,
  parseDiffFiles,
  parseUnifiedDiff,
  unquote,
} from "../src/verify/diff.ts"

/** Real `git diff --cached -M` output (git 2.44): symlink, binary, mode change, new, deleted, modified, rename+edit. */
const FIXTURE_MIXED = [
  "diff --git a/link-to-math b/link-to-math",
  "new file mode 120000",
  "index 0000000..40672cb",
  "--- /dev/null",
  "+++ b/link-to-math",
  "@@ -0,0 +1 @@",
  "+src/math.js",
  "\\ No newline at end of file",
  "diff --git a/logo.png b/logo.png",
  "index 029ace0..d186a24 100644",
  "Binary files a/logo.png and b/logo.png differ",
  "diff --git a/run.sh b/run.sh",
  "old mode 100644",
  "new mode 100755",
  "diff --git a/src/added.js b/src/added.js",
  "new file mode 100644",
  "index 0000000..7b19e95",
  "--- /dev/null",
  "+++ b/src/added.js",
  "@@ -0,0 +1,3 @@",
  "+new file",
  "++++ tricky",
  "+--- tricky",
  "diff --git a/src/gone.js b/src/gone.js",
  "deleted file mode 100644",
  "index 71f1645..0000000",
  "--- a/src/gone.js",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-to be deleted",
  "-second",
  "diff --git a/src/math.js b/src/math.js",
  "index 37f9779..3e6ae0e 100644",
  "--- a/src/math.js",
  "+++ b/src/math.js",
  "@@ -1,4 +1,5 @@",
  " export function add(a, b) {",
  "+  if (b === undefined) return a",
  "   return a + b",
  " }",
  " ",
  "diff --git a/src/old-name.txt b/src/new-name.txt",
  "similarity index 84%",
  "rename from src/old-name.txt",
  "rename to src/new-name.txt",
  "index eb863b6..e830c66 100644",
  "--- a/src/old-name.txt",
  "+++ b/src/new-name.txt",
  "@@ -3,4 +3,4 @@ line two",
  " line three",
  " line four",
  " line five",
  "-line six",
  "+line 6",
  "",
].join("\n")

/** Real git output: CI workflow, path with spaces (tab-suffixed ---/+++), python re-indent, version bump, pure rename, whitespace-only, lockfile. */
const FIXTURE_UNRELATED = [
  "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
  "index 4a79684..a28931a 100644",
  "--- a/.github/workflows/ci.yml",
  "+++ b/.github/workflows/ci.yml",
  "@@ -1,2 +1,2 @@",
  " name: ci",
  "-on: push",
  "+on: [push, pull_request]",
  "diff --git a/dir with space/file name.md b/dir with space/file name.md",
  "index 422c2b7..de98044 100644",
  "--- a/dir with space/file name.md\t",
  "+++ b/dir with space/file name.md\t",
  "@@ -1,2 +1,3 @@",
  " a",
  " b",
  "+c",
  "diff --git a/mod.py b/mod.py",
  "index cbf7e79..709e822 100644",
  "--- a/mod.py",
  "+++ b/mod.py",
  "@@ -1,4 +1,4 @@",
  " def f(x):",
  "     if x:",
  "         return 1",
  "-    return 2",
  "+        return 2",
  "diff --git a/package.json b/package.json",
  "index c5527b2..749be5f 100644",
  "--- a/package.json",
  "+++ b/package.json",
  "@@ -1,5 +1,5 @@",
  " {",
  '   "name": "x",',
  '-  "version": "1.2.3",',
  '+  "version": "1.2.4",',
  '   "main": "index.js"',
  " }",
  "diff --git a/run.sh b/scripts.sh",
  "similarity index 100%",
  "rename from run.sh",
  "rename to scripts.sh",
  "diff --git a/style.js b/style.js",
  "index 37ec54b..8432f0c 100644",
  "--- a/style.js",
  "+++ b/style.js",
  "@@ -1,5 +1,5 @@",
  " function g() {",
  "-  return 1;",
  "+    return 1;",
  " }",
  " function h() {",
  "   return 2;",
  "diff --git a/yarn.lock b/yarn.lock",
  "index f8f19dd..afe234e 100644",
  "--- a/yarn.lock",
  "+++ b/yarn.lock",
  "@@ -1 +1 @@",
  "-lockfileVersion: 1",
  "+lockfileVersion: 2",
  "",
].join("\n")

/** Real git output for a non-ASCII file name (C-quoted with octal escapes). */
const FIXTURE_QUOTED = [
  'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
  "new file mode 100644",
  "index 0000000..587be6b",
  "--- /dev/null",
  '+++ "b/caf\\303\\251.txt"',
  "@@ -0,0 +1 @@",
  "+x",
  "",
].join("\n")

describe("parseUnifiedDiff", () => {
  test("parses every file kind in a real git diff", () => {
    const stat = parseUnifiedDiff(FIXTURE_MIXED)
    const by = Object.fromEntries(stat.files.map((f) => [f.path, f]))
    expect(stat.files.map((f) => f.path)).toEqual([
      "link-to-math",
      "logo.png",
      "run.sh",
      "src/added.js",
      "src/gone.js",
      "src/math.js",
      "src/new-name.txt",
    ])
    expect(by["link-to-math"]).toMatchObject({ status: "added", modeChange: "symlink", additions: 1, deletions: 0 })
    expect(by["logo.png"]).toMatchObject({ status: "modified", binary: true, additions: 0, deletions: 0 })
    expect(by["run.sh"]).toMatchObject({ status: "modified", modeChange: "executable", additions: 0 })
    expect(by["src/added.js"]).toMatchObject({ status: "added", additions: 3, deletions: 0, modeChange: null })
    expect(by["src/gone.js"]).toMatchObject({ status: "deleted", additions: 0, deletions: 2 })
    expect(by["src/math.js"]).toMatchObject({ status: "modified", additions: 1, deletions: 0, oldPath: null })
    expect(by["src/new-name.txt"]).toMatchObject({ status: "renamed", oldPath: "src/old-name.txt", additions: 1, deletions: 1 })
    expect(stat.additions).toBe(6)
    expect(stat.deletions).toBe(3)
  })

  test("lines that look like ---/+++ headers inside a hunk are content", () => {
    const added = parseDiffFiles(FIXTURE_MIXED).find((f) => f.stat.path === "src/added.js")!
    expect(added.hunks[0]!.lines.map((l) => l.text)).toEqual(["new file", "+++ tricky", "--- tricky"])
  })

  test("paths with spaces, pure renames and quoted unicode paths", () => {
    const stat = parseUnifiedDiff(FIXTURE_UNRELATED)
    const spaced = stat.files.find((f) => f.path.startsWith("dir with space"))!
    expect(spaced).toMatchObject({ path: "dir with space/file name.md", status: "modified", additions: 1 })
    const renamed = stat.files.find((f) => f.path === "scripts.sh")!
    expect(renamed).toMatchObject({ status: "renamed", oldPath: "run.sh", additions: 0, deletions: 0 })
    expect(parseUnifiedDiff(FIXTURE_QUOTED).files[0]).toMatchObject({ path: "café.txt", status: "added", additions: 1 })
  })

  test("empty and garbage input", () => {
    expect(parseUnifiedDiff("")).toEqual({ files: [], additions: 0, deletions: 0 })
    expect(parseUnifiedDiff("hello\nworld\n").files).toEqual([])
  })

  test("plain unified diff without git headers", () => {
    const plain = ["--- a/x.txt\t2026-01-01", "+++ b/x.txt\t2026-01-02", "@@ -1,2 +1,2 @@", " keep", "-old", "+new", ""].join("\n")
    expect(parseUnifiedDiff(plain).files).toEqual([
      { path: "x.txt", oldPath: null, additions: 1, deletions: 1, binary: false, status: "modified", modeChange: null },
    ])
  })

  test("CRLF content and GIT binary patch blocks", () => {
    const crlf = "diff --git a/w.txt b/w.txt\r\n--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n"
    expect(parseUnifiedDiff(crlf).files[0]).toMatchObject({ path: "w.txt", additions: 1, deletions: 1 })
    const bin = [
      "diff --git a/img.bin b/img.bin",
      "new file mode 100644",
      "index 0000000..1234567",
      "GIT binary patch",
      "literal 10",
      "Rc${NkV9;oz@Ycg$}",
      "",
      "literal 0",
      "HcmV?d00001",
      "",
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n")
    const files = parseUnifiedDiff(bin).files
    expect(files[0]).toMatchObject({ path: "img.bin", binary: true, status: "added", additions: 0 })
    expect(files[1]).toMatchObject({ path: "a.txt", additions: 1, deletions: 1 })
  })

  test("deleted symlink and submodule mode changes", () => {
    const d = [
      "diff --git a/l b/l",
      "deleted file mode 120000",
      "--- a/l",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-target",
      "diff --git a/sub b/sub",
      "old mode 100644",
      "new mode 160000",
    ].join("\n")
    const files = parseUnifiedDiff(d).files
    expect(files[0]).toMatchObject({ status: "deleted", modeChange: "symlink" })
    expect(files[1]).toMatchObject({ modeChange: "submodule" })
  })
})

describe("unquote", () => {
  test("decodes git C-style quoting", () => {
    expect(unquote('"caf\\303\\251.txt"')).toBe("café.txt")
    expect(unquote('"tab\\there \\"q\\""')).toBe('tab\there "q"')
    expect(unquote("plain")).toBe("plain")
  })
})

describe("addedLines", () => {
  test("reports new-file line numbers from hunk headers", () => {
    const lines = addedLines(FIXTURE_MIXED)
    expect(lines).toContainEqual({ file: "src/math.js", line: 2, text: "  if (b === undefined) return a" })
    expect(lines).toContainEqual({ file: "src/new-name.txt", line: 6, text: "line 6" })
    expect(lines).toContainEqual({ file: "src/added.js", line: 3, text: "--- tricky" })
    expect(lines.filter((l) => l.file === "src/gone.js")).toEqual([])
    expect(lines.filter((l) => l.file === "logo.png")).toEqual([])
  })

  test("strips trailing CR", () => {
    const crlf = "diff --git a/w.txt b/w.txt\n--- a/w.txt\n+++ b/w.txt\n@@ -1 +1 @@\n-a\r\n+b\r\n"
    expect(addedLines(crlf)).toEqual([{ file: "w.txt", line: 1, text: "b" }])
  })
})

describe("findUnrelatedChanges", () => {
  test("flags CI, lockfile, version bump and whitespace-only hunks; keeps real changes", () => {
    const findings = findUnrelatedChanges(parseUnifiedDiff(FIXTURE_UNRELATED), FIXTURE_UNRELATED)
    expect(findings).toContain(".github/workflows/ci.yml: CI workflow changed")
    expect(findings).toContain("yarn.lock: lockfile changed")
    expect(findings).toContain("package.json: version changed (1.2.3 -> 1.2.4)")
    expect(findings).toContain("style.js: whitespace-only change in 1 hunk")
    // Python indentation is syntax: a re-indent is a real change.
    expect(findings.some((f) => f.startsWith("mod.py"))).toBe(false)
    expect(findings.some((f) => f.startsWith("dir with space"))).toBe(false)
    expect(findings.some((f) => f.startsWith("scripts.sh"))).toBe(false)
  })

  test("flags binary files, symlinks and mode changes", () => {
    const findings = findUnrelatedChanges(parseUnifiedDiff(FIXTURE_MIXED), FIXTURE_MIXED)
    expect(findings).toContain("logo.png: binary file changed")
    expect(findings).toContain("run.sh: file mode change (executable)")
    expect(findings).toContain("link-to-math: file mode change (symlink)")
    expect(findings.some((f) => f.startsWith("src/math.js"))).toBe(false)
    expect(findings.some((f) => f.startsWith("src/added.js"))).toBe(false)
  })

  test("a clean focused diff has no findings", () => {
    const clean = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " export function a(x: number) {",
      "-  return x",
      "+  return x ?? 0",
      " }",
      "diff --git a/test/a.test.ts b/test/a.test.ts",
      "--- a/test/a.test.ts",
      "+++ b/test/a.test.ts",
      "@@ -1 +1,2 @@",
      ' test("a", () => {})',
      '+test("zero", () => {})',
    ].join("\n")
    expect(findUnrelatedChanges(parseUnifiedDiff(clean), clean)).toEqual([])
  })

  test("a new file holding only a blank line is not whitespace churn", () => {
    const d = "diff --git a/pkg/__init__.py b/pkg/__init__.py\nnew file mode 100644\n--- /dev/null\n+++ b/pkg/__init__.py\n@@ -0,0 +1 @@\n+\n"
    expect(findUnrelatedChanges(parseUnifiedDiff(d), d)).toEqual([])
  })

  test("CRLF-only line ending change is whitespace-only", () => {
    const d = "diff --git a/r.md b/r.md\n--- a/r.md\n+++ b/r.md\n@@ -1 +1 @@\n-hello\r\n+hello\n"
    expect(findUnrelatedChanges(parseUnifiedDiff(d), d)).toEqual(["r.md: whitespace-only change in 1 hunk"])
  })

  test("pom.xml and pyproject version changes", () => {
    const d = [
      "diff --git a/pom.xml b/pom.xml",
      "--- a/pom.xml",
      "+++ b/pom.xml",
      "@@ -1,3 +1,3 @@",
      " <project>",
      "-  <version>1.0.0</version>",
      "+  <version>1.0.1-SNAPSHOT</version>",
      " </project>",
      "diff --git a/pyproject.toml b/pyproject.toml",
      "--- a/pyproject.toml",
      "+++ b/pyproject.toml",
      "@@ -1,3 +1,3 @@",
      " [project]",
      '-version = "0.4.0"',
      '+version = "0.5.0"',
      ' target-version = "py39"',
    ].join("\n")
    const findings = findUnrelatedChanges(parseUnifiedDiff(d), d)
    expect(findings).toContain("pom.xml: version changed (1.0.0 -> 1.0.1-SNAPSHOT)")
    expect(findings).toContain("pyproject.toml: version changed (0.4.0 -> 0.5.0)")
  })

  test("a non-version edit in package.json is fine", () => {
    const d = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -2,3 +2,3 @@",
      '   "version": "1.2.3",',
      '-  "description": "old"',
      '+  "description": "new"',
    ].join("\n")
    expect(findUnrelatedChanges(parseUnifiedDiff(d), d)).toEqual([])
  })
})

describe("classifyUnrelatedPath", () => {
  const cases: Array<[string, string | null]> = [
    ["package-lock.json", "lockfile changed"],
    ["packages/web/pnpm-lock.yaml", "lockfile changed"],
    ["poetry.lock", "lockfile changed"],
    ["go.sum", "lockfile changed"],
    [".github/workflows/test.yml", "CI workflow changed"],
    [".github/dependabot.yml", "repository meta file under .github changed"],
    [".github/CODEOWNERS", "repository meta file under .github changed"],
    [".github/PULL_REQUEST_TEMPLATE.md", null],
    [".github/ISSUE_TEMPLATE/bug.yml", null],
    [".github/CONTRIBUTING.md", null],
    [".gitlab-ci.yml", "CI configuration changed"],
    [".circleci/config.yml", "CI configuration changed"],
    ["Jenkinsfile", "CI configuration changed"],
    ["LICENSE", "license file changed"],
    ["COPYING.txt", "license file changed"],
    ["LICENSE-MIT", "license file changed"],
    ["src/notice.ts", null],
    ["src/license-checker.js", null],
    ["vendor/lib/x.go", "vendored/generated directory (vendor/) changed"],
    ["packages/a/dist/index.js", "vendored/generated directory (dist/) changed"],
    ["node_modules/x/index.js", "vendored/generated directory (node_modules/) changed"],
    ["src/__generated__/schema.ts", "vendored/generated directory (__generated__/) changed"],
    ["public/app.min.js", "minified/generated file changed"],
    ["public/app.js.map", "minified/generated file changed"],
    ["src/index.ts", null],
    ["docs/guide.md", null],
    ["test/build.test.ts", null],
  ]
  for (const [path, expected] of cases) {
    test(`${path} -> ${expected ?? "ok"}`, () => {
      expect(classifyUnrelatedPath(path)).toBe(expected)
    })
  }
})
