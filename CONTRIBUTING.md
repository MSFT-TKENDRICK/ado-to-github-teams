# Contributing

Follow [`AGENTS.md`](AGENTS.md) for mandatory workspace isolation, architecture, testing, Git, and
stacked pull request rules.

## Prerequisites

- Node.js 22.18 or later in the supported engine range
- Corepack with pnpm 10.34.5
- Rift 0.0.10 on supported Linux or macOS storage

Create a dedicated named Rift workspace, use a task-specific branch, and install from the committed
lockfile:

```bash
rift init --here
rift create --name <task-name>
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
```

## Changes

- Keep packages cohesive and expose supported entry points through `package.json` exports.
- Add tests at the lowest useful level and use test Layers for external boundaries.
- Keep generated output and credentials out of Git.
- Use conventional commits with the required Copilot co-author trailer.
- Let Lefthook format and lint staged files and run typechecking. Never bypass a hook.

Run `pnpm check` before pushing. Pull requests must describe behavior, risk, validation, and any
stack dependency without claiming unimplemented migration capability.
