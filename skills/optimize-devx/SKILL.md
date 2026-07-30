---
name: optimize-devx
description: Use this skill when an agent must measure, report, and defend real developer-experience quantities in this repository — pnpm script surface, documentation drift for that surface, git-hook enforcement status, duplicate formatter configuration, and dangling turbo.json inputs — and stop truthfully when the numbers stop moving. Activate for contributor onboarding review, tooling consolidation, git-hook enforcement audits, or scheduled DX regression checks.
license: MIT
compatibility: Requires this repository, Git 2.31+, pnpm 10.34.5 via Corepack, Node.js 22.18 through 25, and an app-owned Git worktree/session.
metadata:
  author: MSFT-TKENDRICK
  version: '0.1.0'
---

# Optimize developer experience

Measure real, falsifiable DX quantities in this repository — never simulated
persona friction. Compare each measurement against the prose that claims it,
flag any drift, and stop when the numbers no longer move.

## Route the task

- Read [measurements](references/measurements.md) before running anything or
  interpreting results.
- The Theo research persona (`cli-contributor-engineer`) in
  `src/experience/personas.ts` is the shared lens. Do not invent a new persona.
- Non-negotiable engineering policy in `AGENTS.md` remains authoritative.

## Start or resume

```bash
pnpm optimize:devx
```

The command reads `package.json`, `turbo.json`, `lefthook.yml`, and the repo
root file listing, computes the five deterministic measurements exposed by
`src/experience/dev-experience.ts`, and prints a plain-text report to stdout.
It does not write files, does not spawn destructive commands, and does not
touch generated Squad state.

## The five measurements

1. `countPackageScripts` — total root pnpm scripts. Drift here is documentation
   drift in `CONTRIBUTING.md` and the Theo persona rationale.
2. `documentedScriptRatio` — fraction of the script surface that the
   contributor-facing docs actually name.
3. `hookEnforcementStatus` — `enforced` only when both `lefthook.yml` and the
   `lefthook` devDependency are present. Either alone is `fail-open`.
4. `duplicateFormatConfigCount` — count of resolvable Prettier configs at the
   repo root. A healthy repo has exactly `1`.
5. `danglingTurboInputs` — Turbo task `inputs` entries that do not resolve to
   real files. Anything non-empty is a broken cache signal.

## Required agent behavior

1. Run `pnpm optimize:devx` and read the current values.
2. Compare each measurement against the prose that asserts it
   (`CONTRIBUTING.md`, `README.md`, `src/experience/personas.ts`).
3. Run `pnpm test:unit -- documentation/devx-docs` to fail closed on drift.
4. If a fix is required, make the smallest surgical change, then re-run
   `pnpm optimize:devx` and confirm the drift is gone.
5. Never widen the surface (add scripts, add configs, add tasks) to make a
   number look better. Prefer deletion or documentation.

## Non-negotiable safety

- Do not touch migration safety invariants, approval flow, checkpoint code, or
  the Effect service boundaries described in `AGENTS.md`.
- Never bypass the git hooks this skill is designed to defend. `--no-verify`,
  `LEFTHOOK=0`, and `SKIP=...` on the pre-commit or pre-push path invalidate
  every measurement here.
- Do not commit generated artifacts, timing traces, or secrets. Live wall-clock
  timing is gated on `DX_MEASURE_TIMING=1` and never runs by default or in CI.
- Do not fabricate convergence. If the measurements are unchanged across two
  runs, report `no drift` rather than claiming an improvement.
