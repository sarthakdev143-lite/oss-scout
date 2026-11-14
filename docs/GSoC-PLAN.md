# GSoC plan — OWASP

Written 2026-11-14. The 2026 cycle is over; the next one (2027) follows the usual shape: mentoring
organizations and idea lists publish around **February**, applications open around **March**. Confirm
the dates when Google announces them — do not plan against last year's calendar.

## The target: one org, not many

OWASP. Reasons, in order:

1. You already have a **verified contribution merged into their workflow**: OWASP-Hunting #98, a real
   defect in their duplicate-payload checker, proven by tests that fail without the fix.
2. Security matches your stated interest and is a coherent story for a proposal.
3. No CLA, no assignment gate, no AI prohibition — unlike Oppia, Django, Rocket.Chat, BeeWare,
   CircuitVerse or p5.js, all of which block or restrict this kind of contribution.

`OWASP/SecurityShepherd` #1098 is still open. Its outcome is worth watching: a maintainer already
touched that branch, which is a good sign.

## What actually gets selected

Not PR count. Mentors select people they have talked to, whose proposal they believe in, and who have
shown they can ship inside *their* codebase. A hundred drive-by PRs lowers your odds, because it invites
the question "did they write this?" — and every AI policy we read puts that question first.

The target is **3–5 substantive contributions in the OWASP project you propose for**, plus a visible,
human presence in their community.

## Steps

1. **Join the channel.** OWASP Slack invite: <https://owasp.org/slack/invite>. Find the project's
   channel and the GSoC channel. Say hello once, properly — not a copy-paste blast.
2. **Read the GSoC pages.** <https://owasp.org/gsoc/> lists the current edition, the **Student
   Application Template (SAT)** and the **ideas list**. Read the two most recent idea lists; they show
   what kinds of projects OWASP actually mentors.
3. **Pick one or two ideas** and one project codebase (candidates: OWASP-Hunting, OWASP/wstg,
   SecurityShepherd). Read its open issues and its roadmap before asking anything.
4. **Ask one good question.** Something that shows you read the code: "the duplicate checker indexes
   payloads by hash; would you want normalisation before hashing, or is that out of scope?" Not
   "how do I contribute?".
5. **Land 3–5 real PRs in that codebase**, in the area of the proposal. Depth beats breadth here.
6. **Write the proposal from the SAT**, share a draft with a mentor, revise, submit.

## Intro message draft (edit before sending)

> Hi — I'm Sarthak (GitHub: sarthakdev143-lite). I work mostly in Python and TypeScript with a focus on
> application security, and I'd like to contribute to OWASP through GSoC.
>
> I've already landed a fix in OWASP-Hunting: the duplicate checker skipped any payload starting with
> `#`, so SSTI payloads like `#{7*7}` were invisible to deduplication
> (https://github.com/OWASP/OWASP-Hunting/pull/98). Tests for it fail without the change.
>
> I'd like to go deeper in that area — payload corpus handling and dedup quality — rather than spread
> across projects. Is there an issue or a piece of the roadmap you'd point a new contributor at? I'd
> rather work on something you actually want than guess.
>
> I use AI tooling as part of my workflow and disclose it in every PR; I'm responsible for every line I
> submit.

Why it works: specific, shows a merged change, names a real defect, asks one bounded question, discloses
honestly. It does not ask for a project idea — it asks what they want.

## Proposal skeleton (fill from the SAT)

1. **Title** — the outcome, not the technology.
2. **Problem** — what is broken/missing today, with evidence (issues, benchmarks, code references).
3. **Approach** — the design, alternatives considered, why this one.
4. **Deliverables** — concrete artefacts (code, tests, docs) a reviewer can tick off.
5. **Timeline** — weekly milestones across the coding period, including a buffer.
6. **Risks** — what could go wrong and the fallback.
7. **About you** — relevant work, availability, and the PRs you already landed.
8. **AI disclosure** — state what tooling you used and that you understand the result.

## What the bot does meanwhile

- Keeps 2 PRs/day ceiling but effectively a few per week, **OWASP-weighted**, cream-only, never two open
  PRs in one repo, 30-day per-repo cooldown.
- Never touches the proposal, never posts to the community channels, never replies to maintainers.
  Those are yours — they are the part that gets you selected.
- Stops submitting to any repo whose AI policy forbids autonomous contributions; that list is in
  `docs/ORG-FEASIBILITY.md`.

## Honest odds

OWASP takes a handful of contributors from a much larger applicant pool. What moves you from "no" to
"maybe" is a mentor who has seen your name, a proposal they helped shape, and evidence you can ship.
What moves you from "maybe" to "yes" is a proposal that solves something they actually need. Neither is
manufactured by volume.
