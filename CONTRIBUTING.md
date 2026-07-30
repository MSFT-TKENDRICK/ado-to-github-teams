# Contributing

Follow [`AGENTS.md`](AGENTS.md) for mandatory workspace isolation, architecture, testing, Git, and
stacked pull request rules. Run every available CI-equivalent root check below.

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

The active migration CLI is the root package and uses `pnpm-lock.yaml`. The `apps/cli/` workspace
package is a staged CLI shell, not the current migration entry point.

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
- Treat documentation as an acceptance gate. In the same logical commits as a CLI or persona change,
  update README usage/reference, generated or declarative help metadata, operator and security
  guidance, CLI coverage counts, journey identities, and experiment baseline evidence wherever they
  are directly affected. Add deterministic assertions for executable help and documentation
  contracts; do not open or update a pull request with stale flags, conflicts, output semantics, or
  metrics.
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
check for changes to migration behavior. Add or update the corresponding unit, contract,
integration, or BDD coverage for the boundary you change.

For CLI flags, conflicts, persona journeys, or baseline changes, also run a fresh eight-iteration
production experiment and validate every `persona-actions.jsonl` line with the repository schema.
Confirm exact command, flag, entrypoint, conflict, and persona coverage before publishing.

Run the same checks as CI before pushing:

```bash
pnpm check
```

This runs, in order: `secrets:check`, `squad:check`, `format:check`, `lint`, `typecheck`, `build`,
`test:unit`, `test:contract`, `test:integration`, and `package:smoke`. Additionally run `pnpm
test:bdd` for changes to migration behavior, since it is a separate acceptance gate not covered by
`pnpm check` (see the README for why).

Pull requests must describe behavior, risk, validation, and any stack dependency without claiming
unimplemented migration capability.
