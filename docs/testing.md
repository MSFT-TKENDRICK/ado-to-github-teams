# Testing

This document explains the repository's validation strategy. Mandatory engineering policy remains
in [AGENTS.md](../AGENTS.md).

## Local quality gates

The one baseline pre-merge gate is:

```bash
npm run check
```

It runs secret validation and scanning, Squad drift, formatting, linting, type checking, the build,
unit tests, contract tests, integration tests, and package smoke. Do not also require `npm test`;
that convenience suite overlaps tests already included here. Run `npm run test:bdd` additionally
only when migration scenarios, Gherkin, or TUI behavior changes.

Use the smallest relevant command while developing:

| Command                    | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `npm run secrets:check`    | Validate `.env.schema` and scan for configured secret leakage       |
| `npm run format:check`     | Check TypeScript formatting                                         |
| `npm run lint`             | Lint TypeScript source and tests                                    |
| `npm run typecheck`        | Type-check without emitting                                         |
| `npm run build`            | Compile the active root CLI                                         |
| `npm run test:unit`        | Run deterministic unit tests                                        |
| `npm run test:contract`    | Run consumer contracts and supported owned-provider verification    |
| `npm run test:integration` | Run integration tests with controlled boundaries                    |
| `npm run test:bdd`         | Run migration acceptance scenarios and write Cucumber reports       |
| `npm run test:cov`         | Merge unit, integration, contract, and chaos coverage vs thresholds |
| `npm run test:cov:strict`  | Re-measure with the istanbul provider for source-level branches     |
| `npm run test:chaos`       | Drive the real adapters against deliberately misbehaving sockets    |
| `npm run test:mutation`    | Mutation-test the pure domain core (nightly, not a push gate)       |
| `npm run package:smoke`    | Build, inspect, extract, and invoke the publishable CLI tarball     |

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

#### Running contract tests on Windows ARM64

`@pact-foundation/pact-core` ships prebuilt native binaries for `darwin-arm64`, `darwin-x64`,
`linux-arm64`, `linux-x64`, and `win32-x64`. There is no `win32-arm64` build, so an arm64 Node
process on Windows cannot load the Pact FFI and every contract suite is skipped there. CI runs on
`ubuntu-24.04`, where `scripts/assert-contract-verified.ts` enforces the gate strictly — a local
skip is a platform limitation, never a gap in the suite.

The limit is the **Node process** architecture, not the hardware: Windows on ARM runs x64 binaries
under emulation, and an x64 Node loads the `win32-x64` prebuild successfully. To get a real local
run you need an x64 Node **and** the matching x64 esbuild/rollup binaries that vitest itself
depends on:

```sh
pnpm install --config.supportedArchitectures.os[]=win32 --config.supportedArchitectures.cpu[]=x64
# then invoke vitest with an x64 node binary
```

`test/contract/support/pact-platform.ts` centralises this decision and prints an actionable notice
whenever it skips, so a skipped run explains itself instead of looking like an empty suite. Set
`A2G_SUPPRESS_PACT_SKIP_NOTICE=1` to silence it.

### Property-based tests

`test/unit/**` includes `fast-check` property tests that target the invariants AGENTS.md states as
hard guarantees — redaction completeness, path-traversal safety, persona/domain/skill matrix
enforcement, and value-free failures. A written universal guarantee is a free oracle: it is exactly
the kind of claim a property can falsify and an example test cannot.

Two rules apply:

- **Seeds are pinned.** An unpinned generator inside a required gate produces nondeterministic red
  builds. A pinned seed keeps a failure reproducible and a green run stable.
- **Never write a literal credential.** `pnpm check` leads with `secrets:check`, and the repository
  is pushed with secret-scanning push protection. Secret-shaped inputs are assembled at runtime from
  generated fragments, so the test proving secrets get scrubbed never itself looks like a leak.

This suite has already paid for itself: it found a JWT whose final base64url segment ended in `-`
passing through `redactSecrets` unredacted, because the pattern's trailing `\b` could never be
satisfied by a non-word character.

### Mutation testing

`npm run test:mutation` runs StrykerJS over the pure, decision-dense domain modules listed in
`stryker.config.json`. Line coverage answers "was this line executed"; mutation score answers "would
any test have noticed if it were wrong", which is the question worth asking about redaction, retry
classification, plan merging, and the agent-bus decoder.

It is deliberately **not** part of `pnpm check`. Mutation testing re-runs the suite per surviving
mutant, and adding it to the mandatory push gate is the fastest way to get the gate bypassed. Run it
nightly or before touching the domain core. Adapters, oclif command shells, and the TUI are excluded:
their behaviour is proven by contract and integration suites that the mutation runner does not
execute, so every mutant there would survive for a reason that says nothing about test quality.

### Coverage

`npm run test:cov` merges the unit, integration, contract, and chaos suites and checks the
thresholds in `vitest.config.ts`. The gate currently sits at **83.86% lines/statements, 83.88%
branches, 87.69% functions** across 1,043 tests, with an enforced global floor of 82%.

**The provider must be pinned or the number is meaningless.** Measured on the same `test/unit` run,
`v8` reports 78.14% branch coverage and `istanbul` reports 51.88% — a 26-point spread over identical
code and identical tests. `v8` maps bytecode coverage back through source maps and therefore never
sees source-level branches that the TypeScript/esbuild pipeline collapses, including much of what
Effect's generator plumbing emits; it finds roughly a third fewer branches to begin with. `v8` is the
pinned default; `COVERAGE_PROVIDER=istanbul` (via `npm run test:cov:strict`) runs the stricter
source-level audit. Only ever compare a number against another number from the same provider.

Thresholds are a **ratchet**: raise them as coverage improves, never lower them to make a branch
pass. They sit about two points under the measured values, which is enough — coverage here was
verified deterministic over nine measurements (three runs of `test/unit/workflow` alone, three of
that plus the worker HTTP surface, and three of the full `test:cov` set). Every group showed zero
per-file spread and the full runs agreed to the digit. The only observed wobble is a single branch
appearing or not in a ~4,400 branch denominator, which does not move a reported percentage.

If you ever do see a coverage number move without a code change, check whether something else was
running vitest at the same time. Two concurrent runs in one worktree will corrupt the merge and
produce a misleading figure.

Per-directory floors are **additive guards, not exclusions** — the global figures are still computed
over the whole of `src`. Adapter directories carry lower floors because AGENTS.md forbids unit tests
from calling live services, so their coverage legitimately arrives from the contract, chaos, and
integration runs.

Coverage is blind to anything running outside the vitest process — `package:smoke`, the Pact
provider apps, and the entire Cucumber suite (`test:bdd` runs through `tsx`). `src/azure` reports 0%
for the same reason: it only ever executes inside the deployed Azure Functions host. Treat a low
number for those paths as a measurement limitation, not as an invitation to refactor around the
instrument.

### Integration tests

Integration tests compose real internal Layers with controlled external boundaries. Destructive
scenarios assert approval, checkpoint persistence, resume compatibility, idempotency, and bounded
concurrency.

### Chaos tests

`test/chaos` drives the **real** adapters against a deliberately misbehaving peer:
`test/chaos/support/fault-server.ts` is a dependency-free HTTP server that resets sockets before
headers, resets part-way through a body, truncates a declared `Content-Length`, hangs, and throttles
with `Retry-After`.

This exists because of a specific gap the other suites cannot close. Unit tests prove the
orchestrator reacts correctly to a `TransientFailure` _value_, and contract tests prove
request/response shapes match. Neither proves the step in between — that the HTTP client actually
produces a retryable failure when a real peer misbehaves. A fault-injection Layer cannot prove it
either, because it replaces the boundary where the fault lives.

The suite immediately earned its place: it found that every real socket fault was classified as
`ValidationFailure`, which is **not** retryable. Node's global `fetch` throws
`TypeError: fetch failed` with `code === undefined` and puts the real `SocketError` in `cause`, so
`classifyServiceError` never saw a transport code and fell through to its permanent-failure default.
A transient blip mid-migration therefore aborted the run instead of being retried.

Two rules keep this suite trustworthy:

- **Faults are scripted, never random.** Randomised chaos in a required gate produces
  non-reproducible red builds and gets disabled. A fixed fault sequence is reproducible and still
  exercises the path that matters, which is why `test:chaos` is safe to include in `npm run check`.
- **Faults are never expressed as Pact interactions.** Response _shapes_ are contract-derived, but
  the faults are not part of any contract. For the two internally-verified bi-directional contracts,
  a synthetic failure interaction would become a provider obligation and force the provider to
  reproduce a fault on demand.

### Acceptance tests

Gherkin scenarios in `test/bdd/features` cover automated migration behavior. Scenarios tagged
`@manual @external-behavior` document checks that require a controlled enterprise tenant. CI
uploads the generated report and posts an aggregate summary on same-repository pull requests; fork
pull requests receive the artifact but not a write-capable comment.

The sandbox catalog in `sandbox/scenarios.yaml` supplies deterministic provider interactions for
the executable scenarios. Each interaction declares expected arguments and finite call counts so
missing, ambiguous, exhausted, or unused required interactions fail the run.

## Persona experiment harness

`npm run experiment:personas` runs repeated, deterministic journeys across migration scenarios and the
modeled CLI surface. It writes ignored research artifacts under `reports/persona-experiments`.

```bash
npm run experiment:personas
npm run experiment:personas -- --baseline synthetic
npm run experiment:personas -- --iterations 8 --pain-threshold 40
```

The harness checks that commands, flags, entry points, conflicts, and configured personas are
represented. Its findings are design hypotheses, not production telemetry; validate material
changes with representative operators.

The current coverage manifest requires 3/3 commands, 32/32 flags, 6/6 entrypoints, 12/12 conflicts,
and 10/10 operator personas — the ten operator personas modeled in `CLI_JOURNEYS`, including the
advanced agentic TUI operator and enterprise TUI designer added for the interactive terminal
dashboard. The accepted production baseline completed all eight iterations with 12,576/12,576
schema-valid trace lines across 3,944 Cucumber records and no malformed traces, missing records, or
scenario failures. Its initial production iteration already measured mean 16.6, P95 22.7, zero
unintuitive actions, and zero high-harm actions; the modeled final iteration measured mean 16.5,
P95 22.7, zero unintuitive actions, and zero high-harm actions. Adding the interactive dashboard
and its two advanced-terminal personas introduced no new unintuitive or high-harm actions, so the
terminal experience is regression-free against the converged command map, flag ergonomics, and
error-prevention behavior already on the main line.

The only modeled lever with remaining initial friction is scope repetition (mean 37.5, P95 38.6),
which the optimizer raises from 0.40 to 1.00 over the first three iterations, lowering its observed
friction from 45.6 to 9.1 and driving the report to `converged-no-candidate`. Production
convergence is evaluated separately from that report-bound state: the reusable scope profile
remains unimplemented but below the pain threshold, so it is deferred rather than built
speculatively, and the optimize-ux cycle receipt must remain `continue` until the adversarial
rubber-duck gate clears. Refresh this evidence whenever commands, flags, conflicts, journeys, or
modeled levers change.

### Two evidence loops, isolated by domain

The operator persona experiment above measures the **ten operator personas** against `CLI_JOURNEYS`
— the shipped CLI's commands, flags, conflicts, and help surface. A **separate, non-overlapping
developer-experience evidence loop** measures the single contributor persona
(`cli-contributor-engineer`) against `DEVEX_JOURNEYS` and the deterministic measurements in
`src/experience/dev-experience.ts`. It is run via `npm run optimize:dx` (default: 15
iterations across the full 15-area catalog in `skills/optimize-dx/references/areas/`) or,
per run, `npm run optimize:dx -- --iterations <n>` where `<n>` is an integer from 1 through 20.
It is defended by the drift gate in `test/unit/documentation/dx-docs.test.ts`. Only the contributor persona (Theo) reviews
DevEx quality, journeys, friction, and evidence acceptance; the operator experiment and its
participants never assess DevEx, and the DevEx loop never participates in the operator experiment.
The ship-and-consume journey rejects documentation-only evidence: package, release, command-help,
World-selection, and deployment-artifact claims must execute their affected public contract.
These two systems share the persona-definition source file but partition by
`PersonaDomain = 'operator' | 'developer'` so their evidence never mixes.

For repeated evidence-driven UX improvement cycles, use
[Optimize UX](../skills/optimize-ux/SKILL.md):

```bash
npm run optimize:ux -- cycle
npm run optimize:ux -- cycle --iterations 5
npm run optimize:ux -- status
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
