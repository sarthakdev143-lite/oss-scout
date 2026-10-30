# TRIAL2 — doomscroller (code-level fix)

- Date: 2026-10-30
- Repo: `sarthakdev143-lite/doomscroller` (branch `master`, base `2ddc8d4`)
- Trial branch: `trial/compose-credit-truncation` (commit `11ccc30`)
- Issue: #3 (`[bug] compose() drops creator credit + hashtags on long descriptions`)
- PR: https://github.com/sarthakdev143-lite/doomscroller/pull/4
  (`[oss-scout trial-2] Preserve creator credit + hashtags on long descriptions`, Fixes #3)
- Untouched: trial-1 issue #1 and PR #2.

## Recon

Spawned 3 parallel audit subagents over the whole tree
(scheduler/quota/clips/discovery/config; geometry/variation/ffmpeg/metadata;
scrapers/analytics/main/models/db). Ranked candidates:

1. `compose()` tail-truncation drops credit/hashtags (chosen — compliance
   invariant, pure function, trivially testable).
2. `variation.py` fixed `speed_min == speed_max` silently ignored (real, left for
   another round — one PR max).
3. `_atempo_chain(0)` infinite loop (real, riskier to test, deferred).
4. `yt_dlp_scraper.py` hardcoded `ytsearch5` ignoring computed `per` (real,
   needs network mocks, deferred).

## Issue

`app/metadata.py:196` (master): `"\n\n".join(blocks)[:_DESCRIPTION_MAX]` with
`blocks = [body, hashtags, credit]`. A body ≥ ~5000 chars cuts off the hashtag
block and the creator-credit block — even under `require_credit=True`, which
exists precisely for renders that crop on-screen attribution. Filed as #3.

## Failing test (before fix, on master)

`tests/test_metadata_compose.py` (existing `test_description_is_capped` only
asserts length, never credit survival). Repro run in docker sandbox on pristine
master: `len == 5000`, `credit kept: False`, `shorts kept: False`. New tests
added on the trial branch:

- `test_long_description_preserves_credit_and_hashtags`
- `test_long_description_preserves_credit_without_a_handle`

## Fix

`compose()` now truncates the free-form body to
`_DESCRIPTION_MAX - len(tail) - len("\n\n")` first, then joins
`[body?, hashtags, credit?]`. Net diff: +16/−7 in one function, no signature
or dependency change. Short/empty-body output verified byte-identical to old
behavior; pathological tail-over-cap degrades to previous behavior.

## Gate verdicts

- **Verification gate: PASS.** Full suite in docker (`python:3.12-slim`,
  `pytest -m "not slow"`): baseline master = 189 passed + 1 failed
  (`test_resolve_font_finds_something_on_this_machine` — missing system fonts
  in slim image, pre-existing env failure); post-fix = 191 passed + the
  identical 1 env failure. Targeted file run: 30/30 passed incl. both new tests.
- **Critic self-review: PASS @ 0.9.** Minimal single-function diff; cap math
  exact (`len == 5000`, credit/url/hashtags present); no behavior change for
  short bodies; no new failure modes.
- **Security pass: PASS (strict).** Pure string-truncation reorder — no
  secrets, network, exec, or input-handling changes; author/URL interpolation
  unchanged (no new injection surface; description is never executed).
