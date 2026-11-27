# Per-org feasibility (evidence from real cycles)

Every row comes from a cycle that actually inspected the org. Update it when evidence changes;
do not re-derive from scratch each cycle.

## Merge-rate ranking (repo-scout, 2026-11-13, 90-day window)

Outside contributors only. `outside` = PRs from NONE/CONTRIBUTOR/FIRST_TIME in window.
This is the primary selection signal: volume follows merge rate, not effort.

| repo | outside | merged | rate | gfi | hw | bug | verdict |
|---|---|---|---|---|---|---|---|
| beeware/briefcase | 79 | 66 | 84% | 4 | 0 | 42 | STRONG (AI policy mentions) |
| OWASP/OWASP-Hunting | 20 | 13 | 65% | 2 | 0 | 7 | **USABLE — active work** |
| jenkinsci/git-plugin | 17 | 11 | 65% | 1 | 0 | 0 | thin supply |
| OWASP/wstg | 54 | 34 | 63% | 0 | 2 | 0 | **USABLE — active work** |
| processing/p5.js | 79 | 41 | 52% | 8 | 40 | 106 | AI policy restricts |
| jenkinsci/jenkins | 70 | 36 | 51% | 13 | 0 | 2 | Jenkins AI policy to read |
| astropy/astropy | 54 | 27 | 50% | 0 | 0 | 321 | **USABLE — active work** |
| wagtail/wagtail.org | 6 | 3 | 50% | 0 | 1 | 12 | small sample |
| openmrs/...webservices.rest | 14 | 7 | 50% | 0 | 0 | 0 | no supply |
| OpenRefine/OpenRefine | 71 | 34 | 48% | 5 | 19 | 0 | **USABLE — active work** |
| sugarlabs/musicblocks-v4 | 96 | 42 | 44% | 22 | 16 | 0 | **USABLE — needs assignment** |
| freeCodeCamp/freeCodeCamp | 41 | 18 | 44% | 0 | 8 | 0 | **USABLE — active work** |
| sympy/sympy | 64 | 27 | 42% | 2 | 0 | 446 | AI policy mentions |
| laurent22/joplin | 80 | 29 | 36% | 0 | 0 | 475 | **USABLE — active work** |
| numpy/numpy | 40 | 14 | 35% | 0 | 0 | 0 | weak |
| wagtail/wagtail | 55 | 18 | 33% | 1 | 0 | 0 | weak |
| scipy/scipy | 69 | 19 | 28% | 3 | 0 | 0 | weak |
| pandas-dev/pandas | 33 | 8 | 24% | 0 | 0 | 697 | weak |
| networkx/networkx | 74 | 17 | 23% | 0 | 0 | 0 | weak |
| zulip/zulip | 28 | 6 | 21% | 0 | 79 | 192 | weak |
| scikit-learn/scikit-learn | 51 | 10 | 20% | 0 | 170 | 267 | weak |
| django/django | 63 | 12 | 19% | 0 | 0 | 0 | weak |
| OWASP/SecurityShepherd | 24 | 4 | 17% | 12 | 2 | 25 | weak (one PR already open) |
| RocketChat/Rocket.Chat | 29 | 5 | 17% | 7 | 0 | 0 | weak |
| processing/p5.js-web-editor | 65 | 10 | 15% | 7 | 38 | 127 | weak + AI policy |
| openmrs/openmrs-core | 64 | 9 | 14% | 0 | 0 | 0 | weak |
| oppia/oppia | 82 | 7 | 9% | 55 | 0 | 1012 | **avoid: 9% despite huge supply** |
| CircuitVerse/CircuitVerse | 99 | 3 | 3% | 31 | 7 | 0 | avoid (AI prohibited) |
| jenkinsci/credentials-plugin | 20 | 0 | 0% | 1 | 0 | 0 | avoid |
| publiclab/plots2 | 4 | 0 | 0% | 1 | 138 | 141 | dormant |

## Discovery pass (2026-11-14, labeled-issue search → merge-rate ranking)

Found 24 repos carrying live `help wanted` / `good first issue`. Added the ones that are real,
maintained communities with genuine supply:

| repo | outside | merged | rate | gfi | hw | bug |
|---|---|---|---|---|---|---|
| neomjs/neo | 100 | 85 | 85% | 21 | 21 | 5 |
| homarr-labs/homarr | 44 | 35 | 80% | 4 | 0 | 16 |
| xerial/sqlite-jdbc | 45 | 39 | 87% | 1 | 4 | 1 |
| apache/amoro | 88 | 59 | 67% | 3 | 4 | 0 |
| all-contributors/app | 53 | 32 | 60% | 4 | 4 | 0 |
| layer5io/layer5 | 97 | 54 | 56% | 34 | 129 | 0 |
| suitenumerique/docs | 54 | 19 | 35% | 11 | 1 | 39 |
| lingdojo/kana-dojo | 100 | 35 | 35% | 174 | 251 | 79 |
| Apicurio/apicurio-registry | 57 | 19 | 33% | 13 | 23 | 0 |
| CrossGL/crosstl | 56 | 21 | 38% | 11 | 6 | 395 |

Not added, despite good numbers: `GoDiao/dreamcoder` (71%), `CatVinci-Studio/Textus` (54%),
`heygen-com/hyperframes` (32%), `ahmadrosid/nakama` (78%) — thin or unverifiable community
standing, so reputation per merged PR is questionable. `grafana`, `keycloak`, `PipedreamHQ`,
`apache/seatunnel`, `import-js` have big supply but merge 0–28% of outside PRs; not worth the
effort until the merge picture changes.

Re-run any time: `gh workflow run repo-scout.yml -f discover=true -f min_stars=300`.

## AI-policy verdicts (read 2026-11-14, not inferred)

- **beeware/briefcase — PROHIBITED for this use.** CONTRIBUTING says AI tools are neither encouraged nor
  prohibited, but the linked AI Policy's *Intentionality* section says: "We do not accept unsolicited
  pull requests or issues that result from running an autonomous tool over the BeeWare code base." It also
  requires an `Assisted-by:` trailer and a template checkbox. The 84% merge rate is irrelevant: this is
  exactly the pattern the policy forbids. **Do not add.**
- **sympy/sympy — conditional, not implemented.** `AGENTS.md` requires the PR title *and* description to
  start with the robot emoji (U+1F916), a filled `AI Generation Disclosure` section naming tool and model,
  and a human who reviews every line. It also warns that fully AI-written descriptions "are more likely to
  be closed outright". Our loop implements none of that formatting. **Do not add.**
- **jenkinsci/jenkins — unknown.** No AI policy in the repo tree; Jenkins publishes one on its website.
  Unread, so unproven either way. **Do not add.**
- **CircuitVerse — prohibited.** `AGENTS.md`: "Never create a PR". Already excluded.
- **processing/p5.js — restricted.** No fully AI-generated contributions; agents must converse first.

Consequence: none of the high-merge repos held back earlier are usable, and that is the correct answer,
not an obstacle. A merged PR that violates a published policy is worse than no PR.

## Consequence for the allow-list


Active set = repos with a real merge rate and actual labeled supply, excluding known
AI/CLA/assignment gates: OWASP/OWASP-Hunting, OWASP/wstg, OWASP/owasp-mastg,
OpenRefine, joplin, astropy, freeCodeCamp, sugarlabs/musicblocks-v4, wagtail/wagtail.org.

Dropped on evidence, not on taste: oppia (9%), CircuitVerse (3%, AI prohibited), django (19%),
scikit-learn (20%), pandas (24%), zulip (21%), RocketChat (17%), openmrs-core (14%),
publiclab (dormant), numpy/scipy/networkx (weak, no labeled supply).

Held pending a human read of their AI policy: beeware (84% merge — very attractive),
jenkinsci (51%), sympy (42%), p5.js (52%). None of these should receive a PR until the policy
wording is read and accepted.


| Org | Gate | Evidence | Status |
|---|---|---|---|
| OWASP | none found | PR #98 verified end to end (fix + failing test) | **WORKS** |
| zulip | must carry `help wanted` to claim | zulipbot rejected a claim on a `bug`-only issue | works, narrow |
| jenkinsci | none found, but heavy build | core changes need Stapler/URL-binding depth | works for plugins, not core |
| RocketChat | CLA on main repo; SDK at per-repo cap | #438 open | partly blocked |
| oppia | CLA + approved approach + assignment | no recorded CLA for this account | blocked until CLA |
| CircuitVerse | AI contributions prohibited | `AGENTS.md`: "Never create a PR" | **do not touch** |
| processing / p5.js | AI contributions restricted | policy: no fully AI-generated work; converse first | **do not touch** |
| sugarlabs | maintainer assignment required before starting | README process | blocked until assigned |
| publiclab | dormant repos, stale issues | recent issues >180 days | low yield |
| wagtail | often already has a linked PR | #652/#658, #104/#105 | check for PR first |
| django | CLA + triage process | contributor agreement required | blocked until CLA |
| openmrs | process-heavy; some repos are tooling | querystore#80 is `.claude/` tooling (out of scope) | selective |
| LibreHealth | no usable repo pool | GitHub search returned HTTP 422 | skip |
| OpenRefine | none found | probe 2026-11-13: gfi 5, help-wanted 19, no CLA, no AI policy | **ADDED** |
| scikit-learn | none found | probe 2026-11-13: help-wanted 100, bug 100, no CLA, no AI policy | **ADDED** |
| pandas | none found (uses issue triage heavily) | probe: bug 100, no CLA, no AI policy | **ADDED** |
| joplin | none found | probe: bug 100, no CLA, no AI policy | **ADDED** |
| astropy | none found | probe: bug 100, no CLA | not added yet (start with four) |
| sympy | AI policy in `AGENTS.md` | probe flagged it | needs a human read first |
| beeware | AI policy in `CONTRIBUTING.md` | probe flagged it | needs a human read first |
| scipy | none found | probe: gfi 3 only | low yield |
| numpy / matplotlib / networkx | none found | probe: 0 on all three labels | low yield |
| freeCodeCamp | none found | probe: help-wanted 8 | low yield |

## Practical consequences

- The realistic steady state with these gates is roughly **1 verified PR/day**, not 2. The cap stays
  at 2 as a ceiling; do not manufacture work to fill it.
- Highest-yield path today: **OWASP** (proven), then **jenkinsci plugins** (no CLA, real labeled
  issues), then **zulip** issues that actually carry `help wanted`.
- A cycle that reports "no eligible survivor" must name the gate per candidate, as cycle 4 of
  2026-11-13 did. That standard is the difference between a real hold and a filter eating the pool.
- If throughput must rise, the lever is **more orgs without CLA/assignment gates**, not a looser
  quality bar.

## Allow-list & gate updates (2026-11-26)

- **Moved to `ops/denied-repos.txt`:** `astropy/astropy`, `wagtail/wagtail.org`, `beeware/briefcase`,
  `CircuitVerse/CircuitVerse`, `processing/p5.js`, `wemake-services/django-modern-rest`,
  `learningequality/kolibri` (AI policy prohibits/rejects autonomous PRs), `laurent22/joplin` (CLA +
  closes unsolicited PRs), `homarr-labs/homarr` (live-app browser screenshots required),
  `OpenCTI-Platform/opencti` (signed commits + heavy full-stack test dependencies).
- **Assignment-gated repos unlocked via `s2b` / `8c` (request assignment first, implement once assigned):**
  - `OWASP/Nest` (42% merge, Python, no CLA; PR template includes an AI checkbox — fill truthfully)
  - `OWASP/owasp-mastg` (42% merge, Python, no CLA; unassigned issues often lack target labels)
  - `layer5io/layer5` (61% merge, JS, DCO `git commit -s` required, assignment required)
  - `sugarlabs/musicblocks-v4` (TS, assignment required; PR #1041 currently open)
- **Newly pinned open-contribution GSoC/OWASP repos (no CLA, AI-permissive):**
  - `OWASP/Threat-Dragon` (67% merge, JS, `AGENTS.md` operating contract)
  - `OWASP/wrongsecrets` (91% merge, no CLA/AI ban; prefer non-challenge bugs/fixes)
  - `asyncapi/cli` (75% merge, TypeScript, clean `CONTRIBUTING.md`)
  - `kornia/kornia` (64% merge, Python, pro-AI `AI_POLICY.md`, PR #6809 merged)
  - `DependencyTrack/dependency-track` (66% merge, Java, OWASP Flagship, DCO `git commit -s`)
  - `OWASP/pytm` (67% merge, Python, clean `CONTRIBUTING.md`)
  - `asyncapi/generator` (62% merge, JS, `AGENTS.md` AI checkbox + `Generated-by:`)
  - `asyncapi/studio` (56% merge, TypeScript, clean `CONTRIBUTING.md`)
  - `asyncapi/parser-js` (50% merge, TypeScript, clean `CONTRIBUTING.md`)
  - `openwisp/openwisp-controller` (59% merge, Python, `AGENTS.md` project guide)
  - `apache/dolphinscheduler` (53% merge, Java, `AGENTS.md` project guide)

## Cycle findings (2026-11-27)

- **apache/dolphinscheduler**: no AI ban in `AGENTS.md`/CONTRIBUTING; PR template has a mandatory "generated or assisted by AI?" section
  (answer truthfully), commit style `[Fix-<issue>][<Scope>]`, spotless enforced, no CLA/DCO. Tests run on H2 in docker
  (`./mvnw ... -am clean test`; `clean` is required or JaCoCo fails). First PR: #18828.
- **asyncapi/cli**: flooded, 60+ open PRs and nearly every labelled bug already has one (s2 linked PR). Low yield until the queue drains.
- **DependencyTrack**: pool is mostly docs, by-design or enhancement; no cream defect found 11-27.
- **OWASP/Threat-Dragon**: maintainer-filed bugs last touched 2026-05-28 (180-day stale line); AI Contributions Policy still being drafted (#1590). Re-check before touching.
- **xerial/sqlite-jdbc**: any PR that changes `src/main/ext/*.c` and adds a JVM-crashing test goes red until maintainers run Build Native
  (CI tests the committed prebuilt libs). Prefer tests that fail by assertion, not by crashing the JVM.

## Gate updates (2026-11-27, cycle 2)

- **openwisp/openwisp-controller** - AI permitted, with conditions. Read the Anti AI Spam Policy
  (openwisp.io/docs/dev/general/code-of-conduct.html): AI assistance is allowed, but PRs on issues not validated by
  maintainers, unexplained or untested PRs, and repeated "please assign me" comments are treated as spam (temporary ban).
  The PR template has a mandatory checklist, `AGENTS.md` requires a full-suite run (60 min) before pushing, and commit
  subjects need an allowed prefix and past tense. Most maintainer-filed bugs already have a maintainer PR (#1424 -> #1433).
  Status: usable only for a validated, un-PR'd bug; none today.
  Re-checked 2026-11-27 (cycle 13): `openwisp-companion` auto-closes PRs not linked to a maintainer-validated issue within 24h
  (e.g. #1501 for #1419), and a maintainer pointed to the Anti AI Spam Policy on #1442. Maintainer-filed bugs #1419 (no validation,
  three prior PRs closed), #1396 (maintainer: "working as designed") and #1424 (open PR #1433) are all blocked.
- **OWASP/Nest** - assignment-gated (PR template: unassigned PRs auto-closed; no AI ban, AI checkbox). Only ~15 bug issues are
  maintainer-filed and nearly all are claimed, PR'd or stale (2026-11-27 pool check).
- **Java/Maven repos (harness gate)** - the harness host runs JDK 25. Projects pinning old Lombok (e.g. apache/dolphinscheduler,
  lombok 1.18.20) cannot build on the host, so a plain `./mvnw ...` verify_cmd is auto-closed as NOT-VERIFIED even when the
  fix passes on the project's JDK. Use a pinned-JDK docker command as verify_cmd and run that exact string first.

## Gate updates (2026-11-27, cycle 3)

- **asyncapi/generator** - the open `bug` pool (10 issues on 2026-11-27) is entirely contributor-filed and labelled `Awaiting Approval`
  (maintainers have not validated them). These fail the maintainer-filed rule; wait for the label to be removed or look at
  maintainer-filed `good first issue`/`help wanted` instead.
- **GitHub API (tooling gate)** - bursts of `search/issues` calls trigger the secondary rate limit (HTTP 403) even with quota left;
  it persisted >100 s. Space queries by >=10 s and keep a cycle to a handful of searches.

## Gate updates (2026-11-27, cycle 4)

- **OWASP/pytm** - no AI policy in CONTRIBUTING (PR welcome, one clean commit per PR). Maintainer (izar) files logic bugs unlabelled and
  opens his own fix PR the same day (#397 -> #401, #396 -> #400); #373 was fixed by #392. Check for a linked PR before spending time.
  Status: usable only for an unlabelled maintainer-filed bug without a linked PR; none today.
- **layer5io/layer5** - AGENTS.md is LLM-friendly (`git commit -s`, `make setup` + `make site`, verify by curling the rendered page). Tests are
  `node --test` on pure utility modules only: UI-component defects (e.g. #8521, Steps-indicator has no click handler) cannot be proven by a
  test, so skip them under rule (c) unless the defect lives in a pure util.
- **Discovery tooling** - `gh issue list --json` has no `authorAssociation`; use `gh api repos/R/issues?state=open&per_page=100` and filter
  `author_association` and `pull_request==null` instead (core API, no search rate limit).

## Gate updates (2026-11-27, cycle 5)

- **asyncapi/generator** - `good first issue` and `help wanted` pools are empty (read 2026-11-27). The only issues with the maintainer
  `Approved Issue` label (#2297, #2291, #2290) are still contributor-filed (author_association CONTRIBUTOR), so they fail rule (a).
  Re-check only if a maintainer files one.

## Gate updates (2026-11-27, cycle 7)

- **OWASP/Threat-Dragon - AI POLICY PROHIBITS autonomous PRs (new, read from `AGENTS.md`).** Explicit Boundaries: "Humans create issues,
  comment on issues, submit PRs..."; "Agents must not open issues, comment on GitHub, open PRs, approve PRs, merge..."; "Agents must not commit
  or push unless a human explicitly asks"; several issues carry an `AI forbidden` label. Under s0b this repo must not receive a PR, however real
  the bug (#972 undo/redo, #1226 thumbnail mismatch). Owner action: add `OWASP/Threat-Dragon` to `repos.deny`. Earlier notes calling it
  "AI-permissive / usable" (2026-11-26 allow-list update) are superseded by this.
- **Unlabelled maintainer-filed pool, pinned OWASP repos (read 2026-11-27 via REST, assignee=none):** wstg 0; owasp-mastg 45 (all content
  work - tools, tests, demos, knowledge - and nearly all `TEMPORARILY-BLOCKED-FROM-ASSIGNMENT`; no code defects); wrongsecrets 4 (ideas/new
  challenges, not defects); OWASP-Hunting 1 (#96 feature, repo on cooldown); Threat-Dragon 60+ (policy-blocked, see above).

## Gate updates (2026-11-27, cycle 50)

- **R0Y00/Xbox2Windows** - all open `bug` issues are contributor-filed (rule a); maintainer-filed `help wanted` are GPU-emulator roadmap/research items,
  not unit-testable defects. No eligible work today.
- **ONEARMY/community-platform** - maintainer-filed `help wanted`/`good first issue` are feature and test-coverage work (Ambassador Programme, Academy, map e2e); no defect.
- **freeCodeCamp** - 0 unassigned issues carrying target labels (2026-11-27).
- **asyncapi/studio** - only labelled bug (#1359) is external-filed and stale since 2026-09.
- **layer5io/layer5** - maintainer-filed labelled pool is chores/perf-plugin installs/UI layout/epic; no testable pure-util defect (confirms cycle 4).

## Gate updates (2026-11-27, cycle 52)

- **openwisp/openwisp-controller** - remaining maintainer-filed bugs not covered above: #1478 (PR #1483 closed; fix depends on openwisp-utils#760, an
  external claimant asked 09-04), #864 (open PR #1252; commenter reports it already fixed on master), #744 (PR #1215 closed, companion auto-assigned
  the claimant). All blocked or not validated; the Anti AI Spam Policy makes an unvalidated PR a ban risk.
- **asyncapi/parser-js** - every maintainer-filed bug has an open PR: #876 (#1184, #1268), #878 (#1182), #924 (#1274). s2 linked-PR blocker for all.
- **OWASP/Nest** - 2026-11-27 bug pool (unassigned, REST, 70+ items) is almost all CONTRIBUTOR/NONE-filed (fails rule a). Maintainer-filed
  (COLLABORATOR) items are #3934 (perf tweak), #3898 (UI polish), #2861 (feature), #2701 (ideas), #908 (epic): none a defect. No assignment request made.

## Gate updates (2026-11-27, violation follow-up)

- **Java/Maven verify_cmd (confirmed with evidence)** - host JDKs available: `/usr/lib/jvm/temurin-{11,17,21,25}-jdk-amd64`, default is 25.
  apache/dolphinscheduler (Lombok 1.18.20) cannot compile on 25 even on unmodified `dev`. A host-runnable verify_cmd that works:
  `JAVA_HOME=/usr/lib/jvm/temurin-11-jdk-amd64 ./mvnw -B -ntp -pl <modules> -am clean test -Dtest=<Tests> -Dsurefire.failIfNoSpecifiedTests=false`
  (proven on #18828, 15 tests green). Always run the exact ledger string before submitting. If a docker run created root-owned `target/`
  dirs in the clone, remove them via docker before re-running on the host, or `clean` fails.
- **jxxghp/MoviePilot** - all open `bug` issues (2026-11-27, 11 items) are user reports (author_association NONE), none maintainer-filed: fails rule (a).
- **OWASP/wrongsecrets** - labelled pool is two maintainer ideas (#201 testbed, #37 new challenges); no defect.
