import { describe, expect, test } from "bun:test"
import {
  declaredPackageName,
  isDevGroupName,
  isManifestPath,
  MANIFEST_FILENAMES,
  normalizePypiName,
  npmRegistryName,
  parseGradle,
  parseManifest,
  parsePackageJson,
  parsePomXml,
  parsePyprojectToml,
  parseRequirementsTxt,
  parseToml,
  parseTomlLite,
  parseVersionCatalog,
  pep508Name,
  type DependencyRef,
} from "../src/discovery/manifests.ts"

/** "name" or "name (dev)" for compact assertions. */
function names(deps: DependencyRef[]): string[] {
  return deps.map((d) => (d.dev ? `${d.name} (dev)` : d.name))
}

describe("manifest paths", () => {
  test("MANIFEST_FILENAMES lists the supported basenames", () => {
    expect([...MANIFEST_FILENAMES]).toEqual([
      "package.json",
      "requirements.txt",
      "pyproject.toml",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "libs.versions.toml",
    ])
  })

  test.each([
    ["package.json", true],
    ["packages/core/package.json", true],
    ["requirements.txt", true],
    ["requirements-dev.txt", true],
    ["requirements_test.txt", true],
    ["dev-requirements.txt", true],
    ["requirements/base.txt", true],
    ["backend/requirements/prod.txt", true],
    ["pyproject.toml", true],
    ["pom.xml", true],
    ["module/pom.xml", true],
    ["build.gradle", true],
    ["app/build.gradle.kts", true],
    ["gradle/libs.versions.toml", true],
    ["gradle\\libs.versions.toml", true],
    ["package-lock.json", false],
    ["Package.json", false],
    ["requirements.in", false],
    ["constraints.txt", false],
    ["notes/readme.txt", false],
    ["settings.gradle", false],
    ["Cargo.toml", false],
    ["", false],
  ])("isManifestPath(%p) = %p", (path, expected) => {
    expect(isManifestPath(path)).toBe(expected)
  })

  test("isDevGroupName", () => {
    for (const n of ["dev", "test", "tests", "docs", "lint", "typing", "requirements-dev", "Dev_Tools-test"]) {
      expect(isDevGroupName(n)).toBe(true)
    }
    for (const n of ["postgres", "server", "all", "requirements", "devtools", "contest"]) expect(isDevGroupName(n)).toBe(false)
  })
})

describe("package.json", () => {
  const pkg = `\uFEFF${JSON.stringify(
    {
      name: "@me/app",
      dependencies: {
        zod: "^3.23.0",
        "@babel/core": "7.x",
        react: "*",
        latest: "latest",
        empty: "",
        "my-lib": "workspace:*",
        local: "file:../local",
        linked: "link:../linked",
        portal: "portal:../p",
        gitdep: "git+ssh://git@github.com:npm/cli.git#v1.0.27",
        ghshort: "github:user/repo#branch",
        bare: "expressjs/express",
        tarball: "https://example.com/pkg.tgz",
        aliased: "npm:lodash-es@4.17.21",
        scopedAlias: "npm:@scope/real@^1.0.0",
        fromCatalog: "catalog:",
        relative: "../sibling",
        "Bad Name!": "1.0.0",
        notAString: 5,
      },
      devDependencies: { typescript: "5.9.3", zod: "^3.0.0", vitest: "^2" },
      peerDependencies: { "react-dom": ">=18" },
      optionalDependencies: { fsevents: "^2.3.0" },
      bundleDependencies: ["zod"],
    },
    null,
    2,
  )}`

  test("keeps registry specs from all sections with dev flags", () => {
    const deps = parsePackageJson(pkg, "package.json")
    expect(names(deps)).toEqual([
      "zod",
      "@babel/core",
      "react",
      "latest",
      "empty",
      "lodash-es",
      "@scope/real",
      "fromCatalog",
      "fsevents",
      "react-dom",
      "typescript (dev)",
      "vitest (dev)",
    ])
    expect(deps.every((d) => d.ecosystem === "npm" && d.manifestPath === "package.json")).toBe(true)
  })

  test("a runtime occurrence wins over a dev one", () => {
    const deps = parsePackageJson(JSON.stringify({ devDependencies: { a: "1" }, dependencies: { a: "1" } }), "p/package.json")
    expect(deps).toEqual([{ ecosystem: "npm", name: "a", manifestPath: "p/package.json", dev: false }])
  })

  test("invalid JSON, non-object roots and non-object sections yield nothing", () => {
    expect(parsePackageJson("{ not json", "package.json")).toEqual([])
    expect(parsePackageJson("[1,2]", "package.json")).toEqual([])
    expect(parsePackageJson("", "package.json")).toEqual([])
    expect(parsePackageJson(JSON.stringify({ dependencies: ["zod"], devDependencies: "x" }), "package.json")).toEqual([])
  })

  test("npmRegistryName rules", () => {
    expect(npmRegistryName("zod", "^3")).toBe("zod")
    expect(npmRegistryName("x", "npm:@scope/pkg@1.0.0")).toBe("@scope/pkg")
    expect(npmRegistryName("x", "npm:plain")).toBe("plain")
    expect(npmRegistryName("x", "workspace:^")).toBeNull()
    expect(npmRegistryName("x", "git://github.com/a/b.git")).toBeNull()
    expect(npmRegistryName("x", "a/b#v1")).toBeNull()
    expect(npmRegistryName("x", { version: "1" })).toBeNull()
  })
})

describe("requirements.txt", () => {
  const sample = [
    "\uFEFF# comment",
    "-r base.txt",
    "--requirement=dev.txt",
    "-c constraints.txt",
    "-i https://pypi.org/simple",
    "--extra-index-url https://example.com/simple",
    'requests [security] >= 2.8.1, == 2.8.* ; python_version < "2.7"',
    "Django>=4.2,<5  # inline comment",
    "fastapi[standard]==0.110.0 \\",
    "    --hash=sha256:abc \\",
    "    --hash=sha256:def",
    "urllib3 @ https://github.com/urllib3/urllib3/archive/refs/tags/1.26.8.zip",
    "MyProject @ git+https://github.com/me/MyProject.git@v1.0#subdirectory=pkg",
    "git+https://github.com/psf/black.git@main#egg=black",
    "-e git+ssh://git@github.com/org/thing.git#egg=thing",
    "-e .",
    "./downloads/numpy-1.9.2-cp34-none-win32.whl",
    "/abs/path/pkg",
    "file:///tmp/pkg",
    "https://example.com/pkg-1.0.tar.gz",
    "zope.interface",
    "Typing_Extensions~=4.0",
    'pywin32; sys_platform == "win32"',
    "foo==1.0#not-a-comment",
    "pydantic (>=2,<3)",
    "not a requirement line",
    "requests",
    "",
  ].join("\r\n")

  test("parses names and skips options, VCS, URLs and paths", () => {
    expect(names(parseRequirementsTxt(sample, "requirements.txt"))).toEqual([
      "requests",
      "django",
      "fastapi",
      "zope-interface",
      "typing-extensions",
      "pywin32",
      "foo",
      "pydantic",
    ])
  })

  test("dev detection from the file name", () => {
    const one = "pytest>=8\n"
    expect(parseRequirementsTxt(one, "requirements-dev.txt")[0]?.dev).toBe(true)
    expect(parseRequirementsTxt(one, "requirements/test.txt")[0]?.dev).toBe(true)
    expect(parseRequirementsTxt(one, "docs/requirements.txt")[0]?.dev).toBe(true)
    expect(parseRequirementsTxt(one, "requirements.txt")[0]?.dev).toBe(false)
    expect(parseRequirementsTxt(one, "requirements/prod.txt")[0]?.dev).toBe(false)
    expect(parseRequirementsTxt(one, "backend/requirements.txt")[0]?.dev).toBe(false)
  })

  test("empty and comment-only files", () => {
    expect(parseRequirementsTxt("", "requirements.txt")).toEqual([])
    expect(parseRequirementsTxt("# nothing\n\n   # here\n", "requirements.txt")).toEqual([])
  })

  test("PEP 503 normalization and PEP 508 names", () => {
    expect(normalizePypiName("Zope.Interface")).toBe("zope-interface")
    expect(normalizePypiName("a__b--c..d")).toBe("a-b-c-d")
    expect(pep508Name("Flask[async]>=2")).toBe("flask")
    expect(pep508Name("name @ https://x/y.zip")).toBeNull()
    expect(pep508Name("two words")).toBeNull()
    expect(pep508Name("-bad")).toBeNull()
  })
})

describe("pyproject.toml", () => {
  const pep621 = `
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "My.Project"
requires-python = ">=3.10"
dependencies = [
  "httpx>=0.27",   # comment inside array
  'pydantic[email] (>=2,<3)',
  "rich",
  "local @ file:///tmp/local",
]

[project.optional-dependencies]
postgres = ["psycopg[binary]>=3"]
dev = ["pytest>=8", "ruff"]
docs = [
  "mkdocs",
]

[dependency-groups]
test = ["coverage", {include-group = "lint"}]
lint = ["mypy"]

[tool.ruff]
line-length = 100
`

  test("PEP 621 dependencies, extras and dependency groups", () => {
    expect(names(parsePyprojectToml(pep621, "pyproject.toml"))).toEqual([
      "httpx",
      "pydantic",
      "rich",
      "psycopg",
      "pytest (dev)",
      "ruff (dev)",
      "mkdocs (dev)",
      "coverage (dev)",
      "mypy (dev)",
    ])
  })

  const poetry = `
[tool.poetry]
name = "svc"

[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.110"
SQLAlchemy = { version = "^2.0", extras = ["asyncio"] }
numpy = [
  { version = "<2", python = "<3.9" },
  { version = ">=2", python = ">=3.9" },
]
mylib = { git = "https://github.com/me/mylib.git", branch = "main" }
sibling = { path = "../sibling", develop = true }
wheel = { url = "https://example.com/w.whl" }

[tool.poetry.group.dev.dependencies]
pytest = "^8"

[tool.poetry.group.main.dependencies]
uvicorn = "*"

[tool.poetry.dev-dependencies]
black = "*"
`

  test("Poetry dependencies, groups and legacy dev-dependencies", () => {
    expect(names(parsePyprojectToml(poetry, "svc/pyproject.toml"))).toEqual([
      "fastapi",
      "sqlalchemy",
      "numpy",
      "black (dev)",
      "pytest (dev)",
      "uvicorn",
    ])
  })

  test("PEP 621 and Poetry together are deduped (runtime wins)", () => {
    const both = `[project]\ndependencies = ["requests>=2"]\n[tool.poetry.group.dev.dependencies]\nrequests = "*"\npytest = "*"\n`
    expect(names(parsePyprojectToml(both, "pyproject.toml"))).toEqual(["requests", "pytest (dev)"])
  })

  test("date values fall back to the lite parser", () => {
    const withDate = `[project]\nname = "x"\nreleased = 1979-05-27T07:32:00Z\ndependencies = [\n  "attrs",\n  "click>=8",\n]\n`
    expect(names(parsePyprojectToml(withDate, "pyproject.toml"))).toEqual(["attrs", "click"])
  })

  test("malformed TOML never throws and keeps what it can", () => {
    const broken = `[project\nname = = "x"\n[project]\ndependencies = ["ok-pkg", "also"\n`
    expect(() => parsePyprojectToml(broken, "pyproject.toml")).not.toThrow()
    expect(parsePyprojectToml("\u0000\u0001[[[", "pyproject.toml")).toEqual([])
    expect(parsePyprojectToml(`[project]\ndependencies = ["valid"]\n[oops\n`, "pyproject.toml").map((d) => d.name)).toEqual([
      "valid",
    ])
  })

  test("requires-python and build-system are not dependencies", () => {
    const deps = parsePyprojectToml(`[build-system]\nrequires = ["setuptools"]\n[project]\nrequires-python = ">=3.9"\n`, "pyproject.toml")
    expect(deps).toEqual([])
  })
})

describe("TOML", () => {
  test("lite parser handles tables, arrays of tables, dotted and quoted keys, inline tables and strings", () => {
    const doc = parseTomlLite(
      [
        "# top",
        'title = "a \\"quoted\\" \\u00e9"',
        "lit = 'C:\\path'",
        'multi = """',
        "line1",
        'line2"""',
        "n = 1_000",
        "f = 2.5",
        "flag = true",
        "when = 1979-05-27",
        "[a.b]",
        'c.d = "e"',
        '"quoted key" = 1',
        "[[items]]",
        "name = 'one'",
        "[[items]]",
        "name = 'two'",
        "[libraries]",
        'x = { module = "g:a", version.ref = "v" }',
        "arr = [",
        "  1, # one",
        "  [2, 3],",
        "]",
      ].join("\n"),
    )
    expect(doc).toEqual({
      title: 'a "quoted" é',
      lit: "C:\\path",
      multi: "line1\nline2",
      n: 1000,
      f: 2.5,
      flag: true,
      when: "1979-05-27",
      a: { b: { c: { d: "e" }, "quoted key": 1 } },
      items: [{ name: "one" }, { name: "two" }],
      libraries: { x: { module: "g:a", version: { ref: "v" } }, arr: [1, [2, 3]] },
    })
  })

  test("lite parser refuses prototype-polluting keys", () => {
    const doc = parseTomlLite('__proto__ = { polluted = true }\n[constructor]\nx = 1\nok = "yes"\n')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(doc, "__proto__")).toBe(false)
  })

  test("parseToml uses the built-in parser when it accepts the document", () => {
    expect(parseToml('[project]\nname = "x"\n')).toEqual({ project: { name: "x" } })
  })
})

describe("pom.xml", () => {
  const pom = `<?xml version="1.0" encoding="UTF-8"?>\r
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\r
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.0</version>
    <relativePath/>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <properties>
    <java.version>21</java.version>
    <mapstruct.group>org.mapstruct</mapstruct.group>
    <mapstruct.version>1.5.5.Final</mapstruct.version>
  </properties>
  <modules><module>core</module></modules>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.springframework.cloud</groupId>
        <artifactId>spring-cloud-dependencies</artifactId>
        <version>2023.0.1</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <!-- <dependency><groupId>commented</groupId><artifactId>out</artifactId></dependency> -->
    <dependency>
      <groupId>\${mapstruct.group}</groupId>
      <artifactId>mapstruct</artifactId>
      <version>\${mapstruct.version}</version>
      <exclusions>
        <exclusion><groupId>excluded.group</groupId><artifactId>excluded</artifactId></exclusion>
      </exclusions>
    </dependency>
    <dependency><groupId>\${project.groupId}</groupId><artifactId>sibling</artifactId><version>\${project.version}</version></dependency>
    <dependency><groupId>com.example</groupId><artifactId>core</artifactId></dependency>
    <dependency><groupId>\${unknown.group}</groupId><artifactId>mystery</artifactId></dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <scope>test</scope>
    </dependency>
    <dependency><groupId>com.oracle</groupId><artifactId>ojdbc</artifactId><scope>system</scope><systemPath>/x.jar</systemPath></dependency>
    <dependency><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId><scope>provided</scope><optional>true</optional></dependency>
  </dependencies>
  <profiles><profile><id>h2</id><dependencies><dependency><groupId>com.h2database</groupId><artifactId>h2</artifactId><scope>runtime</scope></dependency></dependencies></profile></profiles>
  <build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId>
    <dependencies><dependency><groupId>plugin.dep</groupId><artifactId>nope</artifactId></dependency></dependencies></plugin></plugins></build>
</project>`

  test("collects parent, managed, direct and profile dependencies", () => {
    expect(names(parsePomXml(pom, "pom.xml"))).toEqual([
      "org.springframework.boot:spring-boot-starter-parent",
      "org.springframework.cloud:spring-cloud-dependencies",
      "org.springframework.boot:spring-boot-starter-web",
      "org.mapstruct:mapstruct",
      "org.junit.jupiter:junit-jupiter (dev)",
      "org.projectlombok:lombok",
      "com.h2database:h2",
    ])
  })

  test("child module inheriting its groupId still keeps third-party deps", () => {
    const child = `<project><parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1</version><relativePath>../pom.xml</relativePath></parent>
      <artifactId>api</artifactId>
      <dependencies>
        <dependency><groupId>\${project.groupId}</groupId><artifactId>core</artifactId></dependency>
        <dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId></dependency>
      </dependencies></project>`
    expect(names(parsePomXml(child, "api/pom.xml"))).toEqual(["com.acme:parent", "com.google.guava:guava"])
    expect(declaredPackageName("api/pom.xml", child)).toEqual({ ecosystem: "maven", name: "com.acme:api" })
  })

  test("malformed XML never throws", () => {
    expect(parsePomXml("<project><dependencies><dependency><groupId>a", "pom.xml")).toEqual([])
    expect(parsePomXml("", "pom.xml")).toEqual([])
  })
})

describe("gradle", () => {
  const groovy = `
plugins { id 'org.springframework.boot' version '3.3.0' }
repositories { maven { url "https://repo.example.com/maven2" } } // https:// in a string
buildscript { dependencies { classpath "com.android.tools.build:gradle:8.5.0" } }
dependencies {
    implementation 'com.google.guava:guava:33.0.0-jre'
    implementation "org.springframework.boot:spring-boot-starter-web"
    api("org.apache.commons:commons-lang3:\${commonsVersion}")
    testImplementation(platform("org.junit:junit-bom:5.10.2"))
    testImplementation 'org.junit.jupiter:junit-jupiter'
    implementation(enforcedPlatform('org.springframework.cloud:spring-cloud-dependencies:2023.0.1'))
    runtimeOnly group: 'org.postgresql', name: 'postgresql', version: '42.7.3'
    implementation libs.bundles.groovy
    implementation project(':utils')
    implementation files('libs/a.jar')
    // implementation 'commented.out:thing:1.0'
    /* implementation 'block.commented:thing:1.0' */
    compileOnly "org.projectlombok:lombok:1.18.32"
    annotationProcessor "org.projectlombok:lombok:1.18.32"
    implementation "org.lwjgl:lwjgl:3.3.3:natives-windows"
    implementation "com.example:thing:1.0@aar"
    developmentOnly 'org.springframework.boot:spring-boot-devtools'
    implementation('io.github.foo:bar:latest.release') { exclude group: 'x', module: 'y' }
}`

  test("Groovy DSL", () => {
    expect(names(parseGradle(groovy, "build.gradle"))).toEqual([
      "com.android.tools.build:gradle (dev)",
      "com.google.guava:guava",
      "org.springframework.boot:spring-boot-starter-web",
      "org.apache.commons:commons-lang3",
      "org.junit:junit-bom (dev)",
      "org.junit.jupiter:junit-jupiter (dev)",
      "org.springframework.cloud:spring-cloud-dependencies",
      "org.projectlombok:lombok",
      "org.lwjgl:lwjgl",
      "com.example:thing",
      "org.springframework.boot:spring-boot-devtools (dev)",
      "io.github.foo:bar",
      "org.postgresql:postgresql",
    ])
  })

  const kotlin = `
dependencies {
    implementation("io.ktor:ktor-server-core:2.3.0")
    implementation(group = "io.ktor", name = "ktor-client-core", version = "2.3.0")
    implementation(kotlin("stdlib"))
    testImplementation(kotlin("test"))
    implementation(libs.groovy.core)
    jvmMainImplementation("org.slf4j:slf4j-api:2.0.13")
    commonTestImplementation("io.kotest:kotest-assertions-core:5.9.0")
    ksp("com.google.dagger:dagger-compiler:2.51")
}`

  test("Kotlin DSL incl. map notation, kotlin() shorthand and source-set configurations", () => {
    expect(names(parseGradle(kotlin, "app/build.gradle.kts"))).toEqual([
      "io.ktor:ktor-server-core",
      "org.slf4j:slf4j-api",
      "io.kotest:kotest-assertions-core (dev)",
      "com.google.dagger:dagger-compiler",
      "io.ktor:ktor-client-core",
      "org.jetbrains.kotlin:kotlin-stdlib",
      "org.jetbrains.kotlin:kotlin-test (dev)",
    ])
  })

  const catalog = `
[versions]
groovy = "3.0.5"
checkstyle = "8.37"

[libraries]
groovy-core = { module = "org.codehaus.groovy:groovy", version.ref = "groovy" }
groovy-json = { group = "org.codehaus.groovy", name = "groovy-json", version.ref = "groovy" }
commons-lang3 = "org.apache.commons:commons-lang3:3.14.0"
guava.module = "com.google.guava:guava"
broken = { version = "1" }

[bundles]
groovy = ["groovy-core", "groovy-json"]

[plugins]
versions = { id = "com.github.ben-manes.versions", version = "0.45.0" }
`

  test("version catalogs", () => {
    const expected = [
      "org.codehaus.groovy:groovy",
      "org.codehaus.groovy:groovy-json",
      "org.apache.commons:commons-lang3",
      "com.google.guava:guava",
    ]
    expect(names(parseVersionCatalog(catalog, "gradle/libs.versions.toml"))).toEqual(expected)
    expect(names(parseGradle(catalog, "gradle/libs.versions.toml"))).toEqual(expected)
    expect(names(parseManifest("gradle/libs.versions.toml", catalog))).toEqual(expected)
  })
})

describe("parseManifest", () => {
  test("dispatches on the file name", () => {
    expect(parseManifest("a/package.json", '{"dependencies":{"zod":"1"}}')).toEqual([
      { ecosystem: "npm", name: "zod", manifestPath: "a/package.json", dev: false },
    ])
    expect(parseManifest("requirements-dev.txt", "pytest\n")).toEqual([
      { ecosystem: "pypi", name: "pytest", manifestPath: "requirements-dev.txt", dev: true },
    ])
    expect(parseManifest("pyproject.toml", '[project]\ndependencies = ["x"]')[0]?.ecosystem).toBe("pypi")
    expect(parseManifest("pom.xml", "<project><dependencies><dependency><groupId>a</groupId><artifactId>b</artifactId></dependency></dependencies></project>")).toEqual([
      { ecosystem: "maven", name: "a:b", manifestPath: "pom.xml", dev: false },
    ])
    expect(parseManifest("build.gradle.kts", 'dependencies { implementation("a:b:1") }')[0]?.name).toBe("a:b")
    expect(parseManifest("README.md", "zod")).toEqual([])
  })

  test("never throws on garbage input", () => {
    const garbage = ["", "\u0000\uffff", "{".repeat(5000), "[[[[", "<".repeat(1000), '"'.repeat(999), "\\\n\\\n", "a = [".repeat(200)]
    const paths = ["package.json", "requirements.txt", "pyproject.toml", "pom.xml", "build.gradle", "build.gradle.kts", "gradle/libs.versions.toml"]
    for (const p of paths) for (const g of garbage) expect(() => parseManifest(p, g)).not.toThrow()
  })
})

describe("declaredPackageName", () => {
  test("npm, pypi and maven", () => {
    expect(declaredPackageName("package.json", '{"name":"@me/utils"}')).toEqual({ ecosystem: "npm", name: "@me/utils" })
    expect(declaredPackageName("pyproject.toml", '[project]\nname = "My_Pkg"')).toEqual({ ecosystem: "pypi", name: "my-pkg" })
    expect(declaredPackageName("pyproject.toml", '[tool.poetry]\nname = "svc"')).toEqual({ ecosystem: "pypi", name: "svc" })
    expect(declaredPackageName("pom.xml", "<project><groupId>g</groupId><artifactId>a</artifactId></project>")).toEqual({
      ecosystem: "maven",
      name: "g:a",
    })
    expect(declaredPackageName("package.json", "{")).toBeNull()
    expect(declaredPackageName("build.gradle", "")).toBeNull()
  })
})
