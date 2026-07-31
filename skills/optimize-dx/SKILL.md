---
name: optimize-dx
description: Use this skill when an agent must qualitatively critique this repository's developer experience — pains, unintuitive operations, discoverability failures, unnecessary steps, poor feedback, slow iteration loops, debugging friction, setup/build/test/hook/lint/agent-config friction, and documentation-vs-reality mismatch — then implement one bounded surface change, refresh the corresponding contributor documentation, and stop truthfully. Activate for contributor onboarding review, tooling consolidation, git-hook enforcement audits, or scheduled DX regression checks.
license: MIT
compatibility: Requires this repository, Git 2.31+, pnpm 10.34.5 via Corepack, Node.js 22.18 through 25, and an app-owned Git worktree/session.
metadata:
  author: MSFT-TKENDRICK
  version: '0.3.0'
---

# Optimize developer experience

Operate only in the current app-owned worktree and its one branch/PR. This skill's primary
deliverable is a qualitative critique of the repository's developer-facing surface, one bounded
surface change, and the documentation update that keeps prose honest. DevEx is not reduced to
numeric repository metrics.

## Route the task

- Read [workflow](references/workflow.md) for the identify → implement → document → self-review
  cycle and the nine pain categories a surface is critiqued against.
- Read the [area catalog](references/areas/INDEX.md) to route the current cycle to the one
  DevEx area under review (documentation, repo structure/config, onboarding, hierarchy,
  workspaces, packages, developer tools, git hooks, git/GitHub CLI, devcontainers, or dotfiles).
  Do not read every area file — that is a discoverability failure of its own.
- Read [qualitative evidence](references/qualitative-evidence.md) before deciding what counts as
  sufficient DX evidence, or what `converged`, `stopped`, and `blocked` mean for this loop.
- Read [rubber duck](references/rubber-duck.md) after a candidate surface change is selected —
  Theo (`cli-contributor-engineer`) performs the adversarial self-review alone.
- Read [safety and delivery](references/safety-and-delivery.md) before edits, commits, or
  branch/PR topology decisions.
- Read [measurements](references/measurements.md) only when a supporting numeric signal from
  `src/experience/dev-experience.ts` is relevant. Those five signals are supporting evidence,
  never the definition of acceptance.

## Start or resume

```bash
pnpm optimize:dx
pnpm optimize:dx -- --iterations 3
```

The bare form defaults to eight iterations (`DEFAULT_DX_ITERATIONS`, defined inside this
skill's driver so the DevEx loop stays isolated from the operator persona experiment).
`--iterations <n>` overrides that with any integer from 1 through 20; the driver rotates
through the eleven areas in the [area catalog](references/areas/INDEX.md) in list order,
wrapping when `n` exceeds catalog length. Each iteration prints the area under review, the
checklist reference file, and the supporting numeric signals from
`src/experience/dev-experience.ts` that are meaningful for that area (most areas have none —
by design).

The final `runStatus: 'completed'` line means only that the requested passes finished
without error. Whether the developer experience actually improved or converged is Theo's
qualitative judgment, recorded in the commit/PR body per
[qualitative evidence](references/qualitative-evidence.md). The driver never fabricates a
`converged` or `stopped` claim; it exits `1` on a real error (missing `package.json`,
`turbo.json`, `lefthook.yml`, or area catalog) and `2` on malformed usage.

## Review ownership

Only the `cli-contributor-engineer` persona (Theo) reviews developer-experience quality,
journeys, friction, and evidence acceptance. Operator personas, Fact Checker, Scribe, Rai, and
other agents may perform mechanical implementation or security/privacy checks on DX changes,
but their assessments are not DX review evidence. `DEVEX_JOURNEYS` in
`src/experience/dev-experience.ts` binds this loop's persona to `cli-contributor-engineer`
structurally so the operator experiment and this loop cannot leak into each other.
