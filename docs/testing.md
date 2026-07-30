# Testing

This document explains the repository's validation strategy. Mandatory engineering policy remains
in [AGENTS.md](../AGENTS.md).

## Local quality gates

Install from the committed lockfile, then run:

```bash
pnpm check
pnpm test
pnpm test:bdd
```

`pnpm check` runs secret validation and scanning, formatting, linting, type checking, the build,
unit tests, contract tests, integration tests, and the package smoke test. `pnpm test` is the
complete Vitest convenience suite; it overlaps the three targeted test commands. `pnpm test:bdd`
is a separate migration acceptance gate and is also enforced by CI.

Use the smallest relevant command while developing:

| Command                 | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `pnpm secrets:check`    | Validate `.env.schema` and scan for configured secret leakage    |
| `pnpm format:check`     | Check TypeScript formatting                                      |
| `pnpm lint`             | Lint TypeScript source and tests                                 |
| `pnpm typecheck`        | Type-check without emitting                                      |
| `pnpm build`            | Compile the active root CLI                                      |
| `pnpm test:unit`        | Run deterministic unit tests                                     |
| `pnpm test:contract`    | Run consumer contracts and supported owned-provider verification |
| `pnpm test:integration` | Run integration tests with controlled boundaries                 |
| `pnpm test:bdd`         | Run migration acceptance scenarios and write Cucumber reports    |
| `pnpm package:smoke`    | Build and smoke-test the staged `apps/cli` package               |

## Test boundaries

### Unit tests

Unit tests use deterministic test Layers and do not call live provider services. Put domain
behavior, decoding, retry classification, approval, idempotency, and checkpoint invariants at this
level whenever possible.

### Contract tests

Pact consumer tests cover every application-owned HTTP boundary between the CLI, workflow steps,
and worker. On Linux x64, the contract gate starts the real worker provider and verifies the
recorded interactions. The gate fails when required provider suites are absent, skipped, or contain
no passing assertions.

Azure DevOps, GitHub, and Microsoft Graph tests exercise adapters against mock providers. The
repository does not own those APIs, so these tests demonstrate request and response compatibility
with the modeled contracts; they do not prove live third-party compatibility and must not be used
as deployment evidence.

Generated Pact artifacts stay under ignored test output and are not cached or committed.

### Integration tests

Integration tests compose real internal Layers with controlled external boundaries. Destructive
scenarios assert approval, checkpoint persistence, resume compatibility, idempotency, and bounded
concurrency.

### Acceptance tests

Gherkin scenarios in `test/bdd/features` cover automated migration behavior. Scenarios tagged
`@manual @external-behavior` document checks that require a controlled enterprise tenant. CI
uploads the generated report and posts an aggregate summary on same-repository pull requests; fork
pull requests receive the artifact but not a write-capable comment.

The sandbox catalog in `sandbox/scenarios.yaml` supplies deterministic provider interactions for
the executable scenarios. Each interaction declares expected arguments and finite call counts so
missing, ambiguous, exhausted, or unused required interactions fail the run.

## Persona experiment harness

`pnpm experiment:personas` runs repeated, deterministic journeys across migration scenarios and the
modeled CLI surface. It writes ignored research artifacts under `reports/persona-experiments`.

```bash
pnpm experiment:personas
pnpm experiment:personas -- --baseline synthetic
pnpm experiment:personas -- --iterations 8 --pain-threshold 40
```

The harness checks that commands, flags, entry points, conflicts, and configured personas are
represented. Its findings are design hypotheses, not production telemetry; validate material
changes with representative operators.

The current coverage manifest requires 3/3 commands, 32/32 flags, 6/6 entrypoints, 12/12 conflicts,
and 10/10 personas, including the advanced agentic TUI operator and enterprise TUI designer added
for the interactive terminal dashboard. The accepted production baseline completed all eight
iterations with 12,576/12,576 schema-valid trace lines across 3,944 Cucumber records and no
malformed traces, missing records, or scenario failures. Its initial production iteration already
measured mean 16.6, P95 22.7, zero unintuitive actions, and zero high-harm actions; the modeled
final iteration measured mean 16.5, P95 22.7, zero unintuitive actions, and zero high-harm actions.
Adding the interactive dashboard and its two advanced-terminal personas introduced no new
unintuitive or high-harm actions, so the terminal experience is regression-free against the
converged command map, flag ergonomics, and error-prevention behavior already on the main line.

The only modeled lever with remaining initial friction is scope repetition (mean 37.5, P95 38.6),
which the optimizer raises from 0.40 to 1.00 over the first three iterations, lowering its observed
friction from 45.6 to 9.1 and driving the report to `converged-no-candidate`. Production
convergence is evaluated separately from that report-bound state: the reusable scope profile
remains unimplemented but below the pain threshold, so it is deferred rather than built
speculatively, and the optimize-ux cycle receipt must remain `continue` until the adversarial
rubber-duck gate clears. Refresh this evidence whenever commands, flags, conflicts, journeys, or
modeled levers change.

For repeated evidence-driven UX improvement cycles, use
[Optimize UX](../skills/optimize-ux/SKILL.md):

```bash
pnpm optimize:ux -- cycle
pnpm optimize:ux -- cycle --iterations 5
pnpm optimize:ux -- status
```

When an optimizer candidate changes terminal presentation, redraw, animation, resize, or TTY
lifecycle, Optimize UX delegates the visual iteration and PR-evidence work to
[Optimize TUI](../skills/optimize-tui/SKILL.md). That skill progressively discloses deterministic
capture, PNG/GIF/MP4 packaging, the 5 MiB payload limit, adversarial convergence, and PR publishing.

Omitting `--iterations` defaults that run to eight; an explicit integer from 1 through 20 is
configurable per run and persisted in its evidence. Each cycle records the branch source SHA and
worktree fingerprint. `optimizer-run.json` binds its configuration and evidence to that exact source.
The latest ignored `cycle-receipt` records selected and deferred work, validation, metrics, pull
request state, and convergence; the checkpoint supports resume in the same app-owned worktree.
Generated reports, traces, receipts, and checkpoints stay ignored and must not contain secrets or
tenant data.

After exact evidence selects a bounded plan, load the progressive
[adversarial rubber-duck review](../skills/optimize-ux/references/rubber-duck.md). A completed verdict
must record at least one finding and its resolution. Pending, revised, or blocked review and invalid
evidence fail closed rather than claiming convergence.

Exit behavior is stable: `0` means valid evidence produced a continue, converged, or stopped
decision; `1` means a blocking evidence, documentation, regression, loop, or operational failure;
and `2` means malformed usage. The optimizer is an iterative development workflow, not an
additional merge gate.

## Optional Pact authoring tools

The official SmartBear/PactFlow Agent Skills and MCP server can help contributors author or review
Pact suites. They are optional and do not affect repository validation. Never commit a broker URL,
token, username, or password. This repository does not currently publish pacts or run
`can-i-deploy`.
