# DX critique cycle

## Preconditions

1. Confirm the current checkout is the app-owned worktree and the branch is not `main`.
2. Inspect `git status` and preserve all user and agent work.
3. Use one app-owned session, branch, and standalone PR for this reviewable layer.
4. Read `.squad/agents/theo/charter.md` so the review lens matches the contributor persona.
   No other persona's assessment counts as DX evidence.

## The nine pain categories

Every DX critique names, explicitly and by category, which of these it addresses. A change
that addresses none of these categories is not a DX change; route it elsewhere.

1. Developer pains and frustration points.
2. Confusing or unintuitive operations and interactions.
3. Discoverability failures — can a contributor find the right command, doc, or config?
4. Unnecessary steps in any workflow.
5. Poor or missing feedback and error messages.
6. Slow or cumbersome iteration loops.
7. Debugging friction.
8. Setup, build, test, hook, lint, or agent-config friction.
9. Documentation-vs-reality mismatch.

## Identify

Review the full developer journey: clone/install, build/change, package, consumer install,
invoke/configure, deploy/consume, and diagnose/update. Inspect `package.json` scripts, package
name/bin/files/publish metadata, `README.md`, `CONTRIBUTING.md`, release and deployment workflows,
public artifact contracts, runtime defaults and failure paths, `AGENTS.md`, hooks, tooling config,
and the skills agents load. For each surface, name the affected categories and the specific pain.

Optionally run `pnpm optimize:dx` for the five supporting signals defined in
[measurements](measurements.md). Do not treat those numbers as the review verdict; they are
input, not conclusion.

## Write-ahead prediction

Before Theo reads any supporting signal for an area under review, the runnable driver
records — through the shared `AgentBusTag` service at `src/experience/agent-bus.ts` — a
persona-authentic `expectedObservation` for that area. Each area in
`DX_AREA_CATALOG` (see `skills/optimize-dx/scripts/optimize-dx.ts`) carries its own
distinct prediction, distinguishable per area, grounded in this repository's actual current
state. `recordIntent` MUST be appended and confirmed before the measurement action runs;
`runWithIntent` structurally enforces that ordering (and the corrected bus ATTEMPTS a
terminal-outcome append on every terminal shape — success, typed failure, defect, or
interruption — surfacing a typed `TerminalOutcomeAppendFailure` if that attempt itself
fails rather than silently swallowing it), so a persona cannot revise a prediction
after seeing the outcome. Recorded events append to a run-scoped file at
`reports/agent-bus/optimize-dx/cli-contributor-engineer/{runId}.jsonl`, which lives under
the already-gitignored `reports/` tree — nothing under it is ever committed, and every
fresh run gets its own `runId` so runs never collide on disk.

A successful bus append means the write-ahead protocol worked, not that DX improved. See
[qualitative evidence](qualitative-evidence.md) for the explicit bus-success ≠ DX-success
rule.

## Implement

Make the smallest surface change that removes a real pain in one or more of the categories.
Prefer deletion, renaming, consolidation, or documentation over widening the surface. Never
widen the script surface, config surface, hook surface, or agent-touching skill footprint to
make a supporting signal look better.

## Document

In the same coherent commit, update every affected contributor-facing surface: `README.md`,
`CONTRIBUTING.md`, `docs/testing.md`, `AGENTS.md`, and the affected skill's own `SKILL.md`,
references, and generated `.github/skills/*` mirror (via `pnpm squad:build`, never by hand).
Documentation-vs-reality mismatch is category 9; leaving prose stale is itself a failure of
this cycle.

## Self-review

Run the [rubber duck](rubber-duck.md) pass. A rubber-duck specialist may attack assumptions and
cross-surface coherence, but Theo must independently validate every finding, steelman at least one
real objection, and own the DX verdict. Do not defer DX authority to another persona or agent.

## Validate and commit

For shipped CLI, package, release, or deployment claims, execute the affected command or public
artifact contract (`npm pack --dry-run`, packaged `a2g --help`, focused default/failure-path tests,
or the supported-host Azure build). Documentation-only evidence is insufficient even when drift
tests pass. For consumer installation, count the literal commands: more than one install command
plus one verification command is unacceptable, and an unresolved registry tag blocks rather than
falling back to source setup. Then run `pnpm test:unit -- documentation/dx-docs`, the smallest focused behavior tests,
and `pnpm check` before pushing. Commit with the required conventional-commits subject and Copilot
co-author trailer. Do not merge automatically merely because local validation passes.
