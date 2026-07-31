# Qualitative DX evidence

## What counts as sufficient evidence

Sufficient evidence for a DX improvement is:

1. A concise, human-readable description of the developer-facing surface change — what
   commands, configuration, or documentation changed and why it reduces one or more of the
   nine pain categories in [workflow](workflow.md).
2. The corresponding `README.md`, `CONTRIBUTING.md`, `docs/testing.md`, `AGENTS.md`, or
   skill documentation update that keeps prose honest.

That description belongs in the pull request body and the conventional-commit body. It is not
scraped from a receipt, not derived from a synthetic friction score, and not stored in
`.squad/` mutable state. The five supporting signals in [measurements](measurements.md) may
accompany it as input, but never replace it.

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
A missing or unmoved numeric supporting signal is not by itself a block — those five signals
were never the definition of acceptance.

## Anti-fabrication

- Do not invent before/after friction scores. There are none in this loop.
- Do not synthesize wall-clock timings. Live timing is gated on `DX_MEASURE_TIMING=1` and
  never runs by default or in CI.
- Do not claim convergence because an iteration bound was reached, because a supporting
  signal moved, or because a rubber-duck pass returned "no objection". State the specific
  pain removed, in your own words, in the pull request body.
