# Safety and delivery for DX changes

## Non-negotiable safety

- Do not touch migration safety invariants, approval flow, checkpoint code, or the Effect
  service boundaries described in `AGENTS.md`. Developer convenience never relaxes them.
- Never bypass Lefthook. `--no-verify`, `LEFTHOOK=0`, and `SKIP=...` on the pre-commit or
  pre-push path invalidate every hook-enforcement supporting signal in
  [measurements](measurements.md) and every claim this skill makes about hook safety.
- Do not commit generated artifacts, timing traces, credentials, or tenant data. Live
  wall-clock timing is gated on `DX_MEASURE_TIMING=1` and never runs by default or in CI.
- Do not fabricate evidence. If the same surface produces no new qualitative finding across
  two consecutive reviews, report `converged` truthfully; do not invent a pain to justify a
  further change.

## Documentation freshness

Every DX cycle keeps the following synchronized with the change, in the same coherent commit:

- root `README.md` "Contributor quick start" and repo map;
- `CONTRIBUTING.md` common-commands table, hooks section, and validation gates;
- `docs/testing.md` targeted table and DX evidence-loop section;
- `AGENTS.md` whenever a policy statement changes;
- the affected skill's own `SKILL.md`, references, and generated `.github/skills/*` mirror
  (produced by `pnpm squad:build`, never hand-edited).

Stale prose is category 9 in [workflow](workflow.md) — "documentation-vs-reality mismatch" —
and blocks completion.

## Scope discipline

Out of scope for this skill:

- TUI Gherkin scenarios, `pnpm tui:evidence`, PACT/contract-artifact regeneration, and
  ESLint major-version changes. Route those to the appropriate specialist.
- Numeric friction scoring, before/after wall-clock timing, or synthetic persona simulation
  of the developer experience.

## Branch and PR topology

Use one app-owned session, one branch, and one standalone app-native pull request per
reviewable DX layer. Do not stack DX cycles unless there is a genuine dependency, in which
case follow the stacked-PR rules in `AGENTS.md`.

## Review and merge readiness

Before pushing, run focused tests for the changed behavior plus the literal `pnpm check` gate
from the worktree root. Resolve required CI, merge conflicts, and stale approvals without
force-pushing reviewed work. Use conventional commits with the required Copilot co-author
trailer. Do not merge automatically merely because local validation passes.
