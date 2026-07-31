# Installation from the repository

Use this reference only for setup, build, update, or installation tasks.

## Prerequisites

- Git
- A Node.js version satisfying the root `package.json` `engines.node` range
- pnpm through Corepack
- Network access to install dependencies

If the agent is already in an app-owned worktree, use that worktree. Do not create a nested worktree, switch branches, pull over local changes, or operate in another checkout.

## Build and verify locally

From the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
node bin/run.js --help
node bin/run.js migrate --help
```

Prefer the repository-local entry point:

```bash
node bin/run.js <command> [flags]
```

The working migration CLI currently lives in the repository root. Do not install or invoke
`apps/cli`; that workspace package is an installable shell and does not contain the migration
commands or runtime adapters. Re-check the root package and live help on every new checkout so a
future package move does not leave this guidance stale.

Dependency installation changes only the checkout's ignored dependency state. If the user asked to install or use the CLI from this repository, this local setup does not require a second conceptual approval, although the agent client may still require tool permission.

## Published installation

A global installation changes the user's environment. Do it only when the user explicitly requests a global command or approves the exact change.

```bash
npm install --global @msft-tkendrick/a2g
a2g --help
```

Do not use `sudo npm install --global`. If permissions prevent a global install, keep using `node bin/run.js` or ask the user to choose a user-owned npm prefix.

## Existing checkout and updates

Before changing an existing checkout:

1. Inspect its branch, remote, and working tree.
2. If it is dirty, do not pull, switch, reset, or overwrite files; ask how the user wants to proceed.
3. If an update is requested, fetch first and show the intended source ref and commit.
4. Re-run `pnpm install --frozen-lockfile`, the build, and the help checks after updating.

Do not run migrations merely to verify installation. `--help` is the non-network smoke check.

## Installation failures

- Unsupported Node version: stop and report the root package's current engine range; do not silently switch system runtimes.
- Frozen-lockfile failure: report the lockfile mismatch; do not regenerate it unless the user asked to change dependencies.
- Build failure: do not attempt a global install.
- Help failure after a successful build: use the repository-local command in diagnostics and preserve the original error.
