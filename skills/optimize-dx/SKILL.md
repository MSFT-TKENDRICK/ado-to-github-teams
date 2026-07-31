---
name: optimize-dx
description: Use this skill when an agent must qualitatively critique this repository's developer experience — pains, unintuitive operations, discoverability failures, unnecessary steps, poor feedback, slow iteration loops, debugging friction, setup/build/test/hook/lint/agent-config friction, and documentation-vs-reality mismatch — then implement one bounded surface change, refresh the corresponding contributor documentation, and stop truthfully. Activate for contributor onboarding review, tooling consolidation, git-hook enforcement audits, or scheduled DX regression checks.
license: MIT
compatibility: Requires this repository, Git 2.31+, pnpm 10.34.5 via Corepack, Node.js 22.18 through 25, and an app-owned Git worktree/session.
metadata:
  author: MSFT-TKENDRICK
  version: '0.2.0'
---

# Optimize developer experience

Operate only in the current app-owned worktree and its one branch/PR. This skill's primary
deliverable is a qualitative critique of the repository's developer-facing surface, one bounded
surface change, and the documentation update that keeps prose honest. DevEx is not reduced to
numeric repository metrics.

## Route the task

- Read [workflow](references/workflow.md) for the identify → implement → document → self-review
  cycle and the nine pain categories a surface is critiqued against.
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
```

The command reads `package.json`, `turbo.json`, `lefthook.yml`, and the repo root file listing,
prints the five deterministic supporting signals defined in `src/experience/dev-experience.ts`
to stdout, and exits 0. It does not fabricate a friction score, does not write files, and does
not spawn destructive commands. Treat its output as one input among many, never as the review
verdict.

## Review ownership

Only the `cli-contributor-engineer` persona (Theo) reviews developer-experience quality,
journeys, friction, and evidence acceptance. Operator personas, Fact Checker, Scribe, Rai, and
other agents may perform mechanical implementation or security/privacy checks on DX changes,
but their assessments are not DX review evidence. `DEVEX_JOURNEYS` in
`src/experience/dev-experience.ts` binds this loop's persona to `cli-contributor-engineer`
structurally so the operator experiment and this loop cannot leak into each other.
