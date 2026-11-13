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
