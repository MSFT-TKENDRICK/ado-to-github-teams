# Contributing

Follow [`AGENTS.md`](AGENTS.md) for mandatory workspace isolation, architecture, testing, Git, and
stacked pull request rules. `AGENTS.md` is authoritative, but its named `pnpm check` gate is not
currently exposed by the active root package. Run every available CI-equivalent root check below
and identify this policy/tooling gap in the pull request rather than bypassing or inventing a
replacement check.

## Prerequisites

- Node.js 20 or later; Node.js 22 is used in CI
- npm
- Git 2.31 or later with worktree support

Use the app-owned worktree created for your session. For development outside the host application,
create a dedicated worktree and task branch, then install from the committed lockfile:

```bash
git fetch origin
git worktree add -b <task-branch> ../<task-name> origin/main
cd ../<task-name>
npm ci
npm run build
```

The active migration CLI is the root package and uses `package-lock.json`. The `apps/cli/` pnpm
workspace package is a staged CLI shell, not the current migration entry point.

## Changes

- Keep packages cohesive and expose supported entry points through `package.json` exports.
- Add tests at the lowest useful level and use test Layers for external boundaries.
- Keep generated output and credentials out of Git.
- Use conventional commits with the required Copilot co-author trailer.
- Do not bypass repository hooks.

Run the active TypeScript CLI without rebuilding while you work:

```bash
npm run dev -- --list-sandbox-scenarios
npm run dev -- --sandbox happy-path
```

The sandbox uses synthetic fixtures and does not require credentials. It is the preferred first
check for changes to migration behavior. Add or update the corresponding unit, contract,
integration, or BDD coverage for the boundary you change.

Run the same checks as CI before pushing:

```bash
npm run lint
npm run build
npm run test:unit
npm run test:contract
npm run test:integration
npm run test:bdd
npm test
```

Pull requests must describe behavior, risk, validation, and any stack dependency without claiming
unimplemented migration capability.
