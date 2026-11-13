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

## Consequence for the allow-list

Active set = repos with a real merge rate and actual labeled supply, excluding known
AI/CLA/assignment gates: OWASP/OWASP-Hunting, OWASP/wstg, OWASP/owasp-mastg,
OpenRefine, joplin, freeCodeCamp, sugarlabs/musicblocks-v4, wagtail/wagtail.org.
astropy was removed on 2026-11-13: its AI policy closes autonomous-agent PRs.

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
| OpenRefine | none found; agents allowed | probe 2026-11-13: gfi 2, help-wanted 11, tests 6 unassigned (19 total); no CLA; `AGENTS.md` tells agents to run `./refine lint` and add tests. The real bug label is `Type: Bug` (not `bug`): only 2 open unassigned, both non-maintainer. #6289 blocked by open PR #8020, #1858 by #7958. #5985 (Cypress `.tar.gz`) is obsolete after #7508 replaced `cypress-file-upload` with native `selectFile`; remaining test issues are harness/CI work. | **USABLE but thin today** |
| scikit-learn | none found | probe 2026-11-13: help-wanted 100, bug 100, no CLA, no AI policy | **ADDED** |
| pandas | none found (uses issue triage heavily) | probe: bug 100, no CLA, no AI policy | **ADDED** |
| astropy | **AI policy prohibits agent PRs** | `astropy/astropy-project/policies/ai-policy.md`: "Autonomous workflows (agents) are not human contributors... or we will close the PR." | **BLOCKED for autonomous work** |
| joplin | **individual CLA required** | `readme/dev/index.md`: "All contributors to the project must sign our Individual Contributor License Agreement." No signature on record for this account. `CLAUDE.md` is agent guidance, not an AI prohibition. | **BLOCKED until the owner signs the CLA** |
| sympy | AI policy in `AGENTS.md` | probe flagged it | needs a human read first |
| beeware | AI policy in `CONTRIBUTING.md` | probe flagged it | needs a human read first |
| scipy | none found | probe: gfi 3 only | low yield |
| numpy / matplotlib / networkx | none found | probe: 0 on all three labels | low yield |
| freeCodeCamp | AI in code allowed; no CLA found | contributing FAQ: AI is "OK in code" but "not OK in comments/responses". Probe 2026-11-13: 8 target-labeled unassigned; #71399 carries the "not currently open for contribution" banner and open PR #71601; #71609 has open PR #71615; #70526 has open PR #71617 and lives in `.github/` (k1). | **thin — verify per issue** |
| wagtail.org | no CLA/AI gate found | probe 2026-11-13: 11 target-labeled unassigned (help wanted 1, bug 10); #652 blocked by open PR #658; #602 last maintainer activity 2026-03-12 (>180d stale); #75 blocked on upstream `wagtail/wagtail#14666` (OPEN) after maintainers chose teaser-only feeds; #321 last maintainer activity 2025-01-02. No CONTRIBUTING file. | **thin; stale/contested** |

## Practical consequences

- The realistic steady state with these gates is roughly **1 verified PR/day**, not 2. The cap stays
  at 2 as a ceiling; do not manufacture work to fill it.
- Highest-yield path today: **OWASP** (proven), then **OpenRefine** (agents allowed, tests
  required), then **freeCodeCamp** (AI in code allowed, but thin supply). Astropy is out
  (AI policy closes agent PRs), joplin is out (individual CLA), and jenkinsci/zulip are
  outside `repos.allow`.
- A cycle that reports "no eligible survivor" must name the gate per candidate, as cycle 4 of
  2026-11-13 did. That standard is the difference between a real hold and a filter eating the pool.
- If throughput must rise, the lever is **more orgs without CLA/assignment gates**, not a looser
  quality bar.
- Cycle 6 of 2026-11-13 rebuilt the pools with updated-desc ordering (up to 100 per org) and found the
  viable set exhausted for that day: every top candidate was s2-blocked, or k1/k4-excluded. The limiting
  factor is the allow-list's gates plus open competing PRs, not issue-search volume.
