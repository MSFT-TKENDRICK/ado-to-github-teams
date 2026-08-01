# Contributing

Follow [AGENTS.md](AGENTS.md) for mandatory workspace isolation, architecture, testing, Git, and
pull request rules. The [architecture](docs/architecture.md) explains system boundaries, and the
[testing guide](docs/testing.md) explains the validation strategy.

## Prerequisites

- Node.js 22.18 or later and earlier than Node.js 26; Node.js 22 is used in CI
- Git 2.31 or later with worktree support

For a human contributor in an existing clone, the complete on-ramp is:

```bash
npm run setup
npm run dev -- --sandbox happy-path
```

`npm run setup` uses the pinned pnpm version internally to install the committed lockfile, installs
the repository hooks, and bootstraps ignored local Squad state. No global pnpm, Corepack, separate
build, or manual Squad step is required. Agent sessions must additionally follow the worktree
isolation rules in [AGENTS.md](AGENTS.md); app-managed sessions already satisfy them.
The sandbox mounts an interactive surface with `happy-path` preselected. Press Enter to exercise the
production migration and TUI presentation path in that same surface, then press `q` to exit; only
ADO, Entra, and GitHub provider boundaries use deterministic fixtures.

The active migration CLI is the root package. The `apps/cli` workspace is a staged package shell,
not the current migration entry point. Package smoke exercises it for compatibility; normal feature
work targets the root package.

## Common commands

The root `package.json` currently declares 33 scripts. Reach for the smallest command that
covers what you changed:

| Purpose                              | Command                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| One-command repository setup         | `npm run setup`                                                                                          |
| Build the active CLI                 | `npm run build`                                                                                          |
| Run source directly during iteration | `npm run dev -- --sandbox happy-path`, `npm run dev -- --list-sandbox-scenarios`                         |
| Apply repository formatting          | `npm run format`                                                                                         |
| Focused validation loop              | `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run test:unit`                         |
| Only baseline pre-merge gate         | `npm run check` (secrets, Squad, format, lint, types, build, unit, contract, integration, package smoke) |
| Vitest convenience suite             | `npm test` (optional; overlaps checks already included by `npm run check`)                               |
| Conditional BDD acceptance gate      | `npm run test:bdd` for migration scenarios, Gherkin, or TUI behavior                                     |
| Local Workflow worker                | `npm run worker:dev`, `npm run worker:build`                                                             |
| Azure Functions source package       | `npm run azure:dev`, `npm run azure:build` (build on Ubuntu x64)                                         |
| Consumer package contract            | `npm run package:smoke` (packs, extracts, and invokes the root tarball)                                  |
| Persona experiment harness           | `npm run experiment:personas`                                                                            |
| Optimize UX cycle                    | `npm run optimize:ux -- cycle`                                                                           |
| Optimize DX report                   | `npm run optimize:dx`, `npm run optimize:dx -- --iterations 3`                                           |
| Squad health                         | `npm run squad:check`, `npm run squad:doctor`, `npm run squad:status`                                    |
| Secrets validation and scanning      | `npm run secrets:check`                                                                                  |
| TUI evidence render                  | `npm run tui:evidence`                                                                                   |

See [Testing](docs/testing.md) for the full targeted table and boundary explanations.

## Releases

Version tags publish the verified root tarball as public `@msft-tkendrick/a2g`. npm authentication
uses the short-lived GitHub Actions OIDC identity from `.github/workflows/release.yml`; do not add an
`NPM_TOKEN`. Before the first tagged publication, a package maintainer must claim the package in the
`msft-tkendrick` npm scope and configure its trusted publisher for
`MSFT-TKENDRICK/ado-to-github-teams` and `release.yml`.

## Git hooks

Lefthook is a pinned devDependency (`lefthook 2.1.10`). `npm run setup` invokes the pinned pnpm install, which runs `lefthook install`,
which regenerates `.git/hooks/pre-commit` and `.git/hooks/pre-push` in the current worktree.
`lefthook.yml` at the repo root defines what actually runs:

- **pre-commit** (parallel): Prettier `--check` on staged files, ESLint on staged TypeScript,
  and `npm run secrets:scan`.
- **pre-push**: the focused `dx-gate` subset — format, lint, typecheck, and unit tests. Measured
  wall-clock for the full `npm run check` is under two minutes on the
  reference workstation, but the full gate re-runs uncacheable contract and integration tests
  every push. The full `npm run check` remains the one required baseline pre-merge gate and is
  enforced in CI.

Never bypass Lefthook (`--no-verify`, `LEFTHOOK=0`, `SKIP=...`). Bypassing the pre-commit or
pre-push hook invalidates the DX hook-enforcement supporting signal defended by
[`skills/optimize-dx/SKILL.md`](skills/optimize-dx/SKILL.md).

## Changes

- Keep packages cohesive and expose supported entry points through `package.json` exports.
- Add tests at the lowest useful level and use test Layers for external boundaries.
- Keep generated output and credentials out of Git.
- Keep `squad.config.ts` as the Squad source of truth. When personas, routing, ceremonies, hooks, or
  Squad skills change, run `npm run squad:build` and commit the generated static assets. Do not edit
  generated roster, routing, charter, ceremony, or generated skill files directly.
- Keep Squad personas aligned with `src/experience/personas.ts`. Mutable Squad decisions, histories,
  memory, sessions, and logs are local ignored state and must never contain credentials, tenant
  identifiers, personal data, reports, or checkpoint contents.
- For TUI changes, update deterministic frame/runtime tests and
  `test/bdd/features/tui-experience.feature`, run `npm run test:bdd`, and regenerate the reviewed
  synthetic PNG/GIF assets with `npm run tui:evidence`. Use the progressive
  [Optimize TUI skill](skills/optimize-tui/SKILL.md) for iterative review, optional MP4 packaging,
  payload limits, and pull-request publishing. Commit durable assets under
  `test/bdd/features/evidence/tui/` and embed them with exact validation commands in the pull request
  body. Reviewers must be able to evaluate TUI behavior without running the application. Do not use
  tenant identifiers, credentials, migration reports, or non-synthetic traces in visual evidence.
- Treat documentation as an acceptance gate. In the same logical commits as a CLI or persona change,
  update README usage/reference, generated or declarative help metadata, operator and security
  guidance, CLI coverage counts, journey identities, and experiment baseline evidence wherever they
  are directly affected. Add deterministic assertions for executable help and documentation
  contracts; do not open or update a pull request with stale flags, conflicts, output semantics, or
  metrics.
- Keep canonical flags, aliases, `helpGroup` metadata, valid examples, and the CLI coverage manifest
  synchronized. An alias is part of the supported flag count and must have an executable persona
  journey proving it reaches the same command contract.
- Declare every application environment variable in `.env.schema`, mark credentials `@sensitive`,
  and use encrypted `.env.local` overrides through Varlock rather than plaintext `.env` files.
- Use conventional commits with the required Copilot co-author trailer.
- Do not bypass repository hooks.

Run the active TypeScript CLI without rebuilding while you work:

```bash
npm run dev -- --list-sandbox-scenarios
npm run dev -- --sandbox happy-path
```

The sandbox uses synthetic fixtures and does not require credentials. It is the preferred first
behavior check; the interactive surface needs a real terminal, so use
`npm run dev -- migrate --sandbox happy-path` for piped or scripted checks. Add or update the
corresponding unit, contract, integration, or BDD coverage for the boundary you change.

For CLI flags, conflicts, persona journeys, or baseline changes, also run a fresh eight-iteration
production experiment and validate every `persona-actions.jsonl` line with the repository schema.
Confirm exact command, flag, entrypoint, conflict, and persona coverage before publishing.

Run the one baseline gate before pushing:

```bash
npm run check
```

Run `npm run test:bdd` additionally only when migration scenarios, Gherkin, or TUI behavior changes.
`npm test` is an optional convenience suite and must not be prescribed alongside `npm run check`.
See [Testing](docs/testing.md) for targeted commands, contract-test boundaries, and acceptance report
behavior.

Pull requests must describe behavior, risk, validation, and any stack dependency without claiming
unimplemented migration capability. TUI pull requests must also include the latest committed static
and animated evidence described in
[`test/bdd/features/tui-experience.md`](test/bdd/features/tui-experience.md).
