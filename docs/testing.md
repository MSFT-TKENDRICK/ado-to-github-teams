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

## Optional Pact authoring tools

The official SmartBear/PactFlow Agent Skills and MCP server can help contributors author or review
Pact suites. They are optional and do not affect repository validation. Never commit a broker URL,
token, username, or password. This repository does not currently publish pacts or run
`can-i-deploy`.
