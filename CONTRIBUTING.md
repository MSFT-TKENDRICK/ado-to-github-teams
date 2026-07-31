# Contributing

Follow [AGENTS.md](AGENTS.md) for mandatory workspace isolation, architecture, testing, Git, and
pull request rules. The [architecture](docs/architecture.md) explains system boundaries, and the
[testing guide](docs/testing.md) explains the validation strategy.

## Prerequisites

- Node.js 22.18 or later and earlier than Node.js 26; Node.js 22 is used in CI
- pnpm 10.34.5 through Corepack
- Git 2.31 or later with worktree support

Use the app-owned worktree created for your session. For development outside the host application,
create a dedicated worktree and task branch, then install from the committed lockfile:

```bash
git fetch origin
git worktree add -b <task-branch> ../<task-name> origin/main
cd ../<task-name>
corepack enable
pnpm install --frozen-lockfile
pnpm squad:bootstrap
pnpm build
```

The active migration CLI is the root package. The `apps/cli` workspace is a staged package shell,
not the current migration entry point. `pnpm-workspace.yaml`'s `packages/*` glob and the `apps/cli`
staged package are a transitional monorepo layout not yet wired into the root `pnpm check` gate;
unifying them is deliberately out of scope for this pass.

## Common commands

The root `package.json` currently declares 32 pnpm scripts. Reach for the smallest command that
covers what you changed:

| Purpose                              | Command                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Install from the pinned lockfile     | `pnpm install --frozen-lockfile`                                                                          |
| Build the active CLI                 | `pnpm build`                                                                                              |
| Run source directly during iteration | `pnpm dev -- --sandbox happy-path`, `pnpm dev -- --list-sandbox-scenarios`                                |
| Apply repository formatting          | `pnpm format`                                                                                             |
| Focused validation loop              | `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`                                      |
| Full pre-push / pre-merge gate       | `pnpm check` (secrets, squad, format, lint, typecheck, build, unit, contract, integration, package smoke) |
| Vitest convenience suite             | `pnpm test`                                                                                               |
| BDD acceptance gate                  | `pnpm test:bdd`                                                                                           |
| Local Workflow worker                | `pnpm worker:dev`, `pnpm worker:build`                                                                    |
| Azure Functions source package       | `pnpm azure:dev`, `pnpm azure:build` (build on Ubuntu x64)                                                |
| Consumer package contract            | `pnpm package:smoke` (packs, extracts, and invokes the root tarball)                                      |
| Persona experiment harness           | `pnpm experiment:personas`                                                                                |
| Optimize UX cycle                    | `pnpm optimize:ux -- cycle`                                                                               |
| Optimize DX report                   | `pnpm optimize:dx`, `pnpm optimize:dx -- --iterations 3`                                                  |
| Squad bootstrap and health           | `pnpm squad:bootstrap`, `pnpm squad:check`, `pnpm squad:doctor`, `pnpm squad:status`                      |
| Secrets validation and scanning      | `pnpm secrets:check`                                                                                      |
| TUI evidence render                  | `pnpm tui:evidence`                                                                                       |

See [Testing](docs/testing.md) for the full targeted table and boundary explanations.

## Releases

Version tags publish the verified root tarball as public `@msft-tkendrick/a2g`. npm authentication
uses the short-lived GitHub Actions OIDC identity from `.github/workflows/release.yml`; do not add an
`NPM_TOKEN`. Before the first tagged publication, a package maintainer must claim the package in the
`msft-tkendrick` npm scope and configure its trusted publisher for
`MSFT-TKENDRICK/ado-to-github-teams` and `release.yml`.

## Git hooks

Lefthook is a pinned devDependency (`lefthook 2.1.10`). `pnpm install` invokes `lefthook install`,
which regenerates `.git/hooks/pre-commit` and `.git/hooks/pre-push` in the current worktree.
`lefthook.yml` at the repo root defines what actually runs:

- **pre-commit** (parallel): Prettier `--check` on staged files, ESLint on staged TypeScript,
  and `pnpm secrets:scan`.
- **pre-push**: the focused `dx-gate` subset — `pnpm format:check && pnpm lint && pnpm typecheck &&
pnpm test:unit`. Measured wall-clock for the full `pnpm check` is under two minutes on the
  reference workstation, but the full gate re-runs uncacheable contract and integration tests
  every push. The full `pnpm check` remains the required pre-merge gate and is enforced in CI.

Never bypass Lefthook (`--no-verify`, `LEFTHOOK=0`, `SKIP=...`). Bypassing the pre-commit or
pre-push hook invalidates the DX hook-enforcement supporting signal defended by
[`skills/optimize-dx/SKILL.md`](skills/optimize-dx/SKILL.md).

## Changes

- Keep packages cohesive and expose supported entry points through `package.json` exports.
- Add tests at the lowest useful level and use test Layers for external boundaries.
- Keep generated output and credentials out of Git.
- Keep `squad.config.ts` as the Squad source of truth. When personas, routing, ceremonies, hooks, or
  Squad skills change, run `pnpm squad:build` and commit the generated static assets. Do not edit
  generated roster, routing, charter, ceremony, or generated skill files directly.
- Keep Squad personas aligned with `src/experience/personas.ts`. Mutable Squad decisions, histories,
  memory, sessions, and logs are local ignored state and must never contain credentials, tenant
  identifiers, personal data, reports, or checkpoint contents.
- For TUI changes, update deterministic frame/runtime tests and
  `test/bdd/features/tui-experience.feature`, run `pnpm test:bdd`, and regenerate the reviewed
  synthetic PNG/GIF assets with `pnpm tui:evidence`. Use the progressive
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
pnpm dev -- --list-sandbox-scenarios
pnpm dev -- --sandbox happy-path
```

The sandbox uses synthetic fixtures and does not require credentials. It is the preferred first
behavior check. Add or update the corresponding unit, contract, integration, or BDD coverage for
the boundary you change.

For CLI flags, conflicts, persona journeys, or baseline changes, also run a fresh eight-iteration
production experiment and validate every `persona-actions.jsonl` line with the repository schema.
Confirm exact command, flag, entrypoint, conflict, and persona coverage before publishing.

Run the required gates before pushing:

```bash
pnpm check
pnpm test
pnpm test:bdd
```

This runs, in order: `secrets:check`, `squad:check`, `format:check`, `lint`, `typecheck`, `build`,
`test:unit`, `test:contract`, `test:integration`, and `package:smoke`. It does not include the
complete Vitest convenience command or the separate BDD gate. See [Testing](docs/testing.md) for
targeted commands, contract-test boundaries, and acceptance report behavior.

Pull requests must describe behavior, risk, validation, and any stack dependency without claiming
unimplemented migration capability. TUI pull requests must also include the latest committed static
and animated evidence described in
[`test/bdd/features/tui-experience.md`](test/bdd/features/tui-experience.md).
