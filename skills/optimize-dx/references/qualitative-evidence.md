# Qualitative DX evidence

## What counts as sufficient evidence

Sufficient evidence for a DX improvement is:

1. A concise, human-readable description of the developer-facing surface change — what
   commands, configuration, or documentation changed and why it reduces one or more of the
   nine pain categories in [workflow](workflow.md).
2. The corresponding `README.md`, `CONTRIBUTING.md`, `docs/testing.md`, `AGENTS.md`, or
   skill documentation update that keeps prose honest.
3. Executable evidence from the affected surface. For CLI/package/release/deployment changes,
   Theo runs the shipped command or public artifact contract and compares the result with the
   documentation. Examples include `npm pack --dry-run`, packaged `a2g --help`, focused
   default/failure-path tests, release-policy tests, and `npm run azure:build` on its supported host.

That description belongs in the pull request body and the conventional-commit body. It is not
scraped from a receipt, not derived from a synthetic friction score, and not stored in
`.squad/` mutable state. The supporting signals in [measurements](measurements.md) may
accompany it as input, but never replace it.

A documentation assertion that passes while the runtime command, package contents, release
channel, or deployment artifact says something else is both category 5 and category 9 and blocks
acceptance.

For consumer installation, sufficient evidence additionally requires the documented registry
dist-tag to resolve and a clean consumer to install with one command and verify with one command.
An unpublished package is blocked. Source checkout, package-manager bootstrap, build, and global
link commands are contributor workflow and cannot be counted as a consumer-install workaround.

For the primary contributor audience, sufficient onboarding evidence is exactly one pinned setup
command followed by one credential-free synthetic run command from an existing clone or app-owned
worktree. A global package-manager/Corepack prerequisite, separate build, manual Squad bootstrap, or
multiple overlapping universal validation commands blocks acceptance.

## What `converged` means

Theo declares the reviewed surface converged when, after the current change, no unresolved
finding in any of the nine categories in [workflow](workflow.md) remains for that surface.
Convergence is per-surface, not global. Other surfaces may still have real pains — those are
separate cycles.

## What `stopped` means

Stopped is any explicit user stop, or a decision by Theo not to continue for a documented
reason (out of scope, deferred to another skill, deferred to another persona for a non-DX
concern). A stop is not a failure; it must be recorded honestly in the pull request body.

## What `blocked` means

Blocked is a real regression, a missing documentation update that would leave prose stale, a
change that widens the developer-facing surface without a corresponding pain being removed, or
a change that would relax the safety invariants in [safety and delivery](safety-and-delivery.md).
A missing or unmoved supporting signal is not by itself a block — those signals
were never the definition of acceptance.

## Anti-fabrication

- Do not invent before/after friction scores. There are none in this loop.
- Do not synthesize wall-clock timings. Live timing is gated on `DX_MEASURE_TIMING=1` and
  never runs by default or in CI.
- Do not claim convergence because an iteration bound was reached, because a supporting
  signal moved, or because a rubber-duck pass returned "no objection". State the specific
  pain removed, in your own words, in the pull request body.

## Bus success is not DX success

Every iteration of `npm run optimize:dx` records a two-phase intent/outcome pair through the
shared write-ahead persona bus (`AgentBusTag` in `src/experience/agent-bus.ts`) into a
run-scoped file at `reports/agent-bus/optimize-dx/cli-contributor-engineer/{runId}.jsonl`
(each fresh invocation isolates itself under its own `runId`). A successful bus append
means only that the WRITE-AHEAD PROTOCOL worked: Theo declared a prediction before the
supporting signal was read, `runWithIntent` structurally enforced that ordering (and the
corrected bus ATTEMPTS a terminal-outcome append on every terminal shape — success, typed
failure, defect, or interruption — surfacing a typed `TerminalOutcomeAppendFailure` if that
attempt itself fails rather than silently swallowing it), and the
recorded outcome carries a bounded `(desirability, degree)` judgment against the
pre-declared prediction.

That is not the same thing as "DX improved". Bus success is NOT a DX-improved claim. The
`degree` scale is anchored per AGENTS.md — `0.0` = fully undesirable / regression, `0.5` =
matches prediction exactly or a qualitative-only area with no bus-visible verdict, `1.0` =
fully desirable and better than predicted — but even a run where every area lands at
degree `1.0` is not by itself a convergence claim. The qualitative verdict on DX quality
remains Theo's own prose in the commit/PR body, never inferred from `runStatus:
'completed'` or a successful bus append.

Anti-outcome-bias notes:

- The `AgentBusService` interface exposes only `recordIntent`, `recordOutcome`, and
  `runWithIntent`. It has no `updateIntent`, `patchIntent`, or `deleteIntent`. A persona
  cannot revise a prediction after seeing the outcome by any published method.
- If any single `recordIntent` cannot be appended, the driver fails closed (exit code `1`)
  rather than silently skipping the bus for that iteration.
- Every `expectedObservation` in `DX_AREA_CATALOG` names a concrete artifact, signal, or
  condition — a "generic optimism" prediction that would trivially match any real outcome
  is caught by the drift test in `test/unit/experience/dev-experience-bus.test.ts`.
