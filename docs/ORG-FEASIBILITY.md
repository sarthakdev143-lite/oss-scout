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

## neomjs/neo (2026-11-28, first PR #22569)

- No CLA. `CONTRIBUTING.md` §5 explicitly welcomes autonomous agents; no AI ban.
- Claim bot: comment on the issue to claim; `github-actions` assigns the first eligible claimant, 3-day lease renewed by any comment.
- PR must target `dev`, carry a standalone `Resolves #N` line and the template's `Authored by @handle (model, reasoning, harness)` line;
  check with `npx -y -p neo-agent-skills neo-agent-skills-pr-body --body-file <file>`.
- Unit tier needs Node 24, `npm install`, `npm run bundle-browser-deps`, and `git` on PATH (a spec runs `git ls-files`).
  Specs touching local/UTC conversion must be run with `npm run test-unit-tz` (`NEO_UNIT_TZ=<zone>`).
- Supply: maintainer-agent filed `good first issue` + `help wanted` bugs, specific and well specified.

## OWASP/Threat-Dragon (2026-11-28) — AI policy gate

- `AGENTS.md` explicit boundaries: agents must not open issues, comment on GitHub, open PRs, commit or push; humans
  write all docs. Issues also carry an `AI forbidden` label and #1590 tracks a stricter AI-contributions policy.
- Verdict: do not contribute. Owner should add `OWASP/Threat-Dragon` to `repos.deny`.

## Supply notes (2026-11-28)

- DependencyTrack/dependency-track: real bugs use the `defect` label and are almost all user-filed; maintainer-filed
  `help wanted` items are enhancements/spikes. Little supply under rule (a).
- openwisp/openwisp-controller: bugs are maintainer-filed but heavily claimed or linked to PRs; AGENTS.md requires a
  full-suite run (60 min) before pushing.
- OWASP/Nest: assignment queue on popular issues is long and unanswered; do not add to it.
- asyncapi/generator (2026-11-28): all 16 open unassigned `bug` issues are filed by CONTRIBUTOR/NONE and most carry
  `Awaiting Approval`; no maintainer-filed supply under rule (a). asyncapi/cli bugs are likewise NONE/CONTRIBUTOR-filed and mostly `stale`.
- ONEARMY/community-platform and freeCodeCamp (2026-11-28): maintainer-filed `help wanted` items are UI features or
  test-only tasks, not cream defects (s3b).
- DependencyTrack/dependency-track (2026-11-28, cycle 5): the maintainer-filed `defect` items are #3230 (open PR #7170),
  #325 and #353 (no maintainer activity since 2019 and 2022, stale). Nothing eligible under s2.
- neomjs/neo (2026-11-28): e2e shards are flaky across unrelated PRs (grid, board, scheduler specs fail on other branches the
  same day); judge a PR on the specs it touches, not the aggregate `e2e-engine` check.
