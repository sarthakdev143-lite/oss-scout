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
- **astropy/astropy — blocked by author certification.** `.github/PULL_REQUEST_TEMPLATE.md` requires the
  author to check "I certify that I am human and that I take full responsibility for this pull request"
  (read 2026-11-16). An unattended PR cannot honestly satisfy a mandatory template field. **Do not submit.**
- **laurent22/joplin — unsolicited PRs are closed.** Issue #16803, filed by the maintainer on 2026-10-08,
  says drive-by and unsolicited PRs "will be closed without review". On 2026-11-14 the maintainer closed
  PR #17102 (the #17056 turndown fix) with exactly that link. **Do not submit.**
- **homarr-labs/homarr — allowed with a high evidence bar, not usable without a fixture.** `AGENTS.md`
  §"AI-assisted pull requests" (read 2026-11-16) requires every agent-prepared PR to reproduce the
  case in the running app on unmodified `dev` and on the PR head with `agent-browser`, open the PR
  body with a before/after screenshot table, disclose AI assistance in plain words, and never use the
  `homarr-triage` disclaimer. §Testing also says "Add tests only when requested"; that conflicts with
  the mandatory failing-test-first gate for an unreviewed agent change. Not a prohibition, but do not
  claim a Homarr issue without a runnable app fixture and an issue that requests a test.
- **neomjs/neo — AI agents welcome, claims are first-come.** `CONTRIBUTING.md` (read 2026-11-16)
  supports agent skills and requires a comment to claim a curated issue before starting; the bot
  assigns the first eligible claimant and the claim lasts three days. PRs need the canonical
  `Resolves #<issue>` body and an `Authored by` line. #21016 is not practically available: open PR
  #21015 carries the same Effect-button fix and the maintainer is steering it to that ticket.
  #20747 is a core scheduling design fork explicitly held for the #20751 discussion, so it is not a
  first-PR candidate either.

Consequence: none of the high-merge repos held back earlier are usable, and that is the correct answer,
not an obstacle. A merged PR that violates a published policy is worse than no PR.

## Consequence for the allow-list


Active set = repos with a real merge rate and actual labeled supply, excluding known
AI/CLA/assignment gates: OWASP/OWASP-Hunting, OWASP/wstg, OWASP/owasp-mastg,
OpenRefine, freeCodeCamp, sugarlabs/musicblocks-v4, wagtail/wagtail.org, apache/amoro.
(joplin and astropy were removed on 2026-11-16; their gates are below.)

Dropped on evidence, not on taste: oppia (9%), CircuitVerse (3%, AI prohibited), django (19%),
scikit-learn (20%), pandas (24%), zulip (21%), RocketChat (17%), openmrs-core (14%),
publiclab (dormant), numpy/scipy/networkx (weak, no labeled supply).

Held pending a human read of their AI policy: beeware (84% merge — very attractive),
jenkinsci (51%), sympy (42%), p5.js (52%). None of these should receive a PR until the policy
wording is read and accepted.


| Org | Gate | Evidence | Status |
|---|---|---|---|
| OWASP | none found | PR #98 verified end to end (fix + failing test) | **WORKS** |
| OWASP/wstg | no gate, but no target-labeled supply | probe 2026-11-16: 24 open, 8 unassigned, 0 carrying `good first issue`/`help wanted`/`bug`/`confirmed`/`tests`/`documentation`; the labels are `new`, `revise`, `enhancement`, `question` | empty under the target-label rule |
| OWASP/OWASP-Hunting | 30-day repo cooldown | submitted 2026-11-13; cooldown until 2026-12-13. 2026-11-16 pool has new target-labelled bugs #87–#91 (layout, WCAG target size, menu scroll, search relevance), all unassigned | blocked until 2026-12-13 |
| OWASP/mastg (allow-list names it `OWASP/owasp-mastg`; GitHub resolves to `OWASP/mastg`) | assignment required before a PR; first-time AI contributors must attach an AI session export and staged review commits | contributing page (read 2026-11-16): "Only open a pull request after an issue has been assigned to you or after receiving explicit prior approval"; `.github/PULL_REQUEST_TEMPLATE.md` AI disclosure; 100 open, 7 target-labeled, 5 of 7 also `TEMPORARILY-BLOCKED-FROM-ASSIGNMENT` | **do not touch unattended** |
| zulip | must carry `help wanted` to claim | zulipbot rejected a claim on a `bug`-only issue | works, narrow |
| jenkinsci | none found, but heavy build | core changes need Stapler/URL-binding depth | works for plugins, not core |
| RocketChat | CLA on main repo; SDK at per-repo cap | #438 open | partly blocked |
| oppia | CLA + approved approach + assignment | no recorded CLA for this account | blocked until CLA |
| CircuitVerse | AI contributions prohibited | `AGENTS.md`: "Never create a PR" | **do not touch** |
| processing / p5.js | AI contributions restricted | policy: no fully AI-generated work; converse first | **do not touch** |
| sugarlabs | maintainer assignment required before starting | README process. 2026-11-16 maintainer-filed singer defects #1050–#1054 are unassigned and concrete, but #1041 is still open, so no second PR in musicblocks-v4 | blocked until assigned; no second open PR |
| xerial/sqlite-jdbc | per-repo cap; no AI policy found | open PR #1509 already fixes new #1508 (SIGSEGV in bundled `rightstr()` for a large negative length); 87% outside merge rate | **WORKS — one PR at a time** |
| publiclab | dormant repos, stale issues | recent issues >180 days | low yield |
| wagtail | often already has a linked PR; #75 is a product decision | #652/#658; #75: 2025-02-09 maintainer comment says the teaser-plus-summary feed is desired, and the 2026-09-30 follow-up points to the still-open upstream design proposal wagtail/wagtail#14666 | check for PR first |
| django | CLA + triage process | contributor agreement required | blocked until CLA |
| openmrs | process-heavy; some repos are tooling | querystore#80 is `.claude/` tooling (out of scope) | selective |
| LibreHealth | no usable repo pool | GitHub search returned HTTP 422 | skip |
| OpenRefine | none found | probe 2026-11-13: gfi 5, help-wanted 19, no CLA, no AI policy | **ADDED** |
| scikit-learn | none found | probe 2026-11-13: help-wanted 100, bug 100, no CLA, no AI policy | **ADDED** |
| pandas | none found (uses issue triage heavily) | probe: bug 100, no CLA, no AI policy | **ADDED** |
| joplin | unsolicited PRs closed without review | #16803; maintainer closed PR #17102 with it on 2026-11-14 | **do not touch** |
| astropy | PR template requires "I certify that I am human" | `.github/PULL_REQUEST_TEMPLATE.md` (read 2026-11-16) | **do not touch** |
| apache/amoro | no AI policy found; claim with a literal `take` comment | #4455 submitted 2026-11-16 as PR #4507; new #4508 (AMS default startup "Lack required property: port") is a real defect but #4507 is open and today's org slot is used; 67% outside merge rate | **WORKS — one PR at a time** |
| neomjs/neo | claim via bot; one open curated claim | `CONTRIBUTING.md` "Claim before you start" (read 2026-11-16); #21016 covered by PR #21015; #20747 held for #20751; #20780 claim extended by `neo-opus-vega` to 2026-11-18 23:59Z (PR #20828 closed, reopen pending; #20865 already landed the main-side metadata-only half) | **WORKS — first claim wins; core scheduling fork and #20780 are held** |
| homarr-labs/homarr | AI-assisted PR needs running-app before/after screenshots; tests only when requested | `AGENTS.md` §AI-assisted pull requests and §Testing (read 2026-11-16) | **WORKS — high evidence cost; not usable without a fixture** |
| sympy | AI policy in `AGENTS.md` | probe flagged it | needs a human read first |
| beeware | AI policy in `CONTRIBUTING.md` | probe flagged it | needs a human read first |
| scipy | none found | probe: gfi 3 only | low yield |
| numpy / matplotlib / networkx | none found | probe: 0 on all three labels | low yield |
| freeCodeCamp | none found | probe 2026-11-16: 63 unassigned inspected, 8 target-labelled. The two live help-wanted defects are carried by open PRs #71601 (#71399) and #71615 (#71609); #63788/#70526 also have open PRs #63817/#71617 | low yield until those PRs close |

## Practical consequences

- The realistic steady state with these gates is roughly **1 verified PR/day**, not 2. The cap stays
  at 2 as a ceiling; do not manufacture work to fill it.
- Highest-yield path today: **OWASP** (proven), then **jenkinsci plugins** (no CLA, real labeled
  issues), then **zulip** issues that actually carry `help wanted`.
- A cycle that reports "no eligible survivor" must name the gate per candidate, as cycle 4 of
  2026-11-13 did. That standard is the difference between a real hold and a filter eating the pool.
- If throughput must rise, the lever is **more orgs without CLA/assignment gates**, not a looser
  quality bar.
