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
pnpm build
```

The active migration CLI is the root package and uses `pnpm-lock.yaml`. The `apps/cli/` workspace
package is a staged CLI shell, not the current migration entry point.

## Changes

- Keep packages cohesive and expose supported entry points through `package.json` exports.
- Add tests at the lowest useful level and use test Layers for external boundaries.
- Keep generated output and credentials out of Git.
- Use conventional commits with the required Copilot co-author trailer.
- Do not bypass repository hooks.

Run the same checks as CI before pushing:

```bash
pnpm lint
pnpm build
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm test:bdd
pnpm test
```

Pull requests must describe behavior, risk, validation, and any stack dependency without claiming
unimplemented migration capability.
