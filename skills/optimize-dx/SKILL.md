---
name: optimize-dx
description: Use this skill to critique the full contributor-to-consumer CLI journey — clone, change, package, install, invoke, configure, deploy, diagnose, and update — against developer pains, discoverability, feedback, iteration, tooling, and documentation-vs-reality failures; then implement one bounded change and verify the affected command or artifact contract.
license: MIT
compatibility: Requires this repository, Git 2.31+, pnpm 10.34.5, Node.js 22.18 through 25, and an app-owned Git worktree/session.
metadata:
  author: MSFT-TKENDRICK
  version: '0.4.0'
---

# Optimize developer experience

Operate only in the current app-owned worktree and its one branch/PR. This skill's primary
deliverable is a qualitative critique of the repository's developer-facing surface, one bounded
surface change, executable evidence from the affected shipped command or public artifact contract,
and the documentation update that keeps prose honest. DevEx is not reduced to numeric repository
metrics.

## Route the task

- Read [workflow](references/workflow.md) for the identify → implement → document → self-review
  cycle and the nine pain categories a surface is critiqued against.
- Read the [area catalog](references/areas/INDEX.md) to route the current cycle to the one
  DevEx area under review, including CLI naming/invocation, packaging/distribution,
  release/versioning, and build/package/deploy. Do not read every area file — that is a
  discoverability failure of its own.
- Read [qualitative evidence](references/qualitative-evidence.md) before deciding what counts as
  sufficient DX evidence, or what `converged`, `stopped`, and `blocked` mean for this loop.
- Read [rubber duck](references/rubber-duck.md) after a candidate surface change is selected —
  a rubber-duck specialist may challenge the work, but Theo (`cli-contributor-engineer`) validates
  the objections and remains the sole DX authority.
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

The bare form defaults to fifteen iterations (`DEFAULT_DX_ITERATIONS`, defined inside this
skill's driver so the DevEx loop stays isolated from the operator persona experiment).
`--iterations <n>` overrides that with any integer from 1 through 20; the driver rotates
through all fifteen areas in the [area catalog](references/areas/INDEX.md) in list order,
wrapping when `n` exceeds catalog length. Each iteration prints the area under review, the
checklist reference file, Theo's persona-authentic prediction for that area, and the
supporting numeric signals from `src/experience/dev-experience.ts` that are meaningful for
that area (most areas have none — by design).

Every iteration also records a two-phase write-ahead intent/outcome pair through the
shared persona bus (`AgentBusTag`, `src/experience/agent-bus.ts`) into a run-scoped file at
`reports/agent-bus/optimize-dx/cli-contributor-engineer/{runId}.jsonl` (already gitignored;
each fresh invocation gets its own `runId` so runs never collide on disk). The
driver fails closed on any bus append failure — no silent skip. Bus success means the
write-ahead protocol worked, not that DX improved; see
[qualitative evidence](references/qualitative-evidence.md#bus-success-is-not-dx-success).

The final `runStatus: 'completed'` line means only that the requested passes finished
without error. Whether the developer experience actually improved or converged is Theo's
qualitative judgment, recorded in the commit/PR body per
[qualitative evidence](references/qualitative-evidence.md). The driver never fabricates a
`converged` or `stopped` claim; it exits `1` on a real error (missing `package.json`,
`turbo.json`, `lefthook.yml`, or area catalog) and `2` on malformed usage.

## Review ownership

Only the `cli-contributor-engineer` persona (Theo) reviews developer-experience quality,
journeys, friction, and evidence acceptance. Operator personas, Fact Checker, Scribe, Rai, and
other agents may perform adversarial challenge, mechanical implementation, or security/privacy
checks on DX changes, but Theo must validate their claims and their assessments are not DX review
evidence. `DEVEX_JOURNEYS` in
`src/experience/dev-experience.ts` binds this loop's persona to `cli-contributor-engineer`
structurally so the operator experiment and this loop cannot leak into each other.
