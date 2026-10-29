# VPS_PLAN.md — oss-scout (development)

Source: README.md, docs/ARCHITECTURE.md, package.json scripts.
Verify commands: `bunx tsc --noEmit -p tsconfig.json` (exit 0, 2026-10-29),
`bun test --timeout 30000` (sample: test/config.test.ts 33 pass).
Baseline: main green on typecheck; full suite to be confirmed on VPS.

## Milestones

### M1 — Keep main green (CI hygiene)
- [ ] T1: `bun install` clean + typecheck green on VPS (node 24 / bun 1.3)
- [ ] T2: full `bun test --timeout 30000` green, record failures as issues
- [ ] T3: `bun src/cli.ts config-schema` regenerates schema/ without diff drift

### M2 — Docs / config parity
- [ ] T4: README + docs/CODESPACES.md + oss-scout.config.example.json agree on config keys
- [ ] T5: `oss-doctor` covers missing-token and wrong-config-path cases (tested)

### M3 — Known-limitations fixes (small, one PR each)
- [ ] T6: pick smallest item from README "Known limitations" with a unit test
- [ ] T7: next smallest item, same rule

## Rules (from VPS.md §4B)
- One task = one branch `feat/YYYY-MM-DD-<slug>` from main + one PR (`gh pr create --fill`) to main.
- Never push main directly. Never self-merge unless CI green and brief allows.
- Daily rollup branch `dev/vps-YYYY-MM-DD` holds only `docs/daily/YYYY-MM-DD.md` + plan updates.
- Model for all work: `opencode-go/muse-spark-1.3-contributor`.
