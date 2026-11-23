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

## Gates found 2026-11-22 (read from the repos, not inferred)

| Org / repo | Gate | Evidence | Status |
|---|---|---|---|
| astropy/astropy | AI policy: autonomous agents not accepted | `astropy-project/policies/ai-policy.md`: "Autonomous workflows ("agents") are not human contributors. Astropy reviewers expect to interact with the human controlling the account, or we will close the PR." Also requires the contributor to engage with reviewers personally. | **do not submit; ask owner to add to repos.deny** |
| laurent22/joplin | CLA required | `readme/dev/index.md`: "All contributors to the project must sign our Individual Contributor License Agreement"; `.github/workflows/cla.yml` enforces it. The earlier "no CLA" probe was wrong. | blocked until the owner signs the CLA |
| storybookjs/storybook | AI policy | `CONTRIBUTING.md`: PRs "entirely generated by AI with no human involvement (e.g. by an automated agent)" are labelled and closed after 3 days unless a real person responds. | **do not submit; ask owner to add to repos.deny** |
| homarr-labs/homarr | AI PR rules | `AGENTS.md` "AI-assisted pull requests": a PR must be proven in the running app with `agent-browser` on `dev` and the PR head, "A PR that does not meet them will be closed." | blocked (cannot meet the proof requirement) |
| OWASP/owasp-mastg | AI disclosure template | PR template needs tool and model names and, for first-time contributors using AI, an export of the AI session. The single disclosure line cannot satisfy it. | blocked |
| stdlib-js/stdlib | AI disclosure template | PR template asks how AI was used and for a disclosure of it. | blocked unless the template can be met with the disclosure line |
| wemake-services/django-modern-rest | AI policy: autonomous agents not allowed | `.github/AI_POLICY.md` (the PR template links it): "We do not allow autonomous agents to be used for contributing to our projects. We will close any pull requests that we believe were created autonomously." Correction: the earlier "none found" only read `CONTRIBUTING.md`. Bugs #1699/#1700 also have open linked PRs (#1856, #1857). | **do not touch**; please add to repos.deny |
| career-ops-hq/career-ops | none found for bug fixes | `CONTRIBUTING.md`: bug fixes go straight to a PR, no CLA. Unattended agents must avoid the listed owner-reviewed paths (CLAUDE.md, AGENTS.md, web/, workflows, updater, ...); scripts and tests are not on that list. | **USABLE**, first PR 2026-11-22 (#7607, merged 2026-11-23 by the maintainer after approval) |
| OpenAEV-Platform/openaev | signed commits required | `.github/workflows/openaev-check-signed-commit.yml` runs `FiligranHQ/filigran-ci-tools/actions/check-signed-commit`: "all commits must be PGP-signed". No signing key on this account. No AI prohibition (AGENTS.md is written for agents). Pool 2026-11-22: 69 issues, 30 maintainer-filed bugs. | **blocked until the owner registers a signing key** |
| neomjs/neo | AI disclosure template | `.github/PULL_REQUEST_TEMPLATE.md` requires exact model, version, reasoning effort and harness for any LLM-assisted PR; curated issues need a `/claim`. | blocked (the single disclosure line cannot satisfy it) |
| TabularisDB/tabularis | none found | No AI text in CONTRIBUTING/AGENTS.md. Maintainer-filed bugs get a maintainer PR quickly (#1636 -> #1637); the rest are feature requests. | usable; no eligible issue 2026-11-22 |
| career-ops-hq/career-ops | none for AI; supply is contested | Maintainer-filed bug #7581 got an outside PR (#7602) within hours; older bugs (#3035, #5514, #3103) are long-investigated flakes or decision-gated. Owner-reviewed paths: `web/`, `.github/`, ... | usable; no eligible issue 2026-11-22 |
| wagtail/wagtail.org | none found | Maintainer-filed bugs are either linked to PRs (#652 -> #658), stale > 180 days, or design questions. | no eligible issue 2026-11-22 |
| keleus/BewlyCat | issues are user-filed | All 18 labeled issues are filed by non-maintainers, so rule (a) excludes them. | nothing to do |
| layer5io/layer5 | no defect supply | Maintainer-filed items are a chore, an epic and a design task. | nothing to do |
| OWASP/wstg, soxoj/maigret | no labeled supply | pool query returned 0 open unassigned target-label issues | nothing to do |

Operational note: the Search API has a 30 requests/minute limit and a secondary limit. Build pools with
`repos/OWNER/REPO/issues?labels=...&assignee=none` (core quota) and pace the calls; a 96-call search burst
on 2026-11-22 tripped both limits.

## Note 2026-11-23: xerial/sqlite-jdbc native fixes

Fixes to `src/main/ext/*.c` cannot go green in CI on their own: test jobs use the prebuilt libs committed under `src/main/resources/org/sqlite/native`, which only the manual
**Build Native** workflow regenerates. The maintainer (gotson) accepts this: #1489 was merged with red CI after a native rebuild, and #1509 was approved on 2026-11-23 in the same state.
A red `ExtensionTest` on such a PR is expected; say so in the PR body and let the maintainer rebuild. Do not weaken the test.
