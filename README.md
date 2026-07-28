# ado-to-github-teams

Foundation for a CLI that will migrate Azure DevOps project teams to GitHub teams. This layer
contains the build, quality, automation, and package boundaries only; migration services and
business behavior are intentionally delivered in later layers.

## Current workspace

The repository is a pnpm 10 Turborepo on Node.js 22:

- `apps/cli` provides the installable CLI shell and verified help/version paths.
- `packages/*` is reserved for real domain, core, adapter, and test-support packages as those
  implementations land. Empty packages are not committed.
- `turbo.json` defines build, lint, typecheck, unit, contract, integration, and full-test tasks.

Packages use ESM and NodeNext resolution. Public package entry points must be declared through the
`exports` map with a `types` condition; consumers must not import package internals.

## Development

Use a named Rift workspace on supported Linux or macOS as required by [`AGENTS.md`](AGENTS.md).

```bash
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
pnpm check
```

Useful focused commands are `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm build`,
`pnpm test:unit`, `pnpm test:contract`, and `pnpm test:integration`.

The CLI foundation can be exercised after a build:

```bash
node apps/cli/dist/cli.js --help
node apps/cli/dist/cli.js --version
```

## Architecture direction

Migration behavior will use Effect services and Layers around a domain that does not depend on
vendor SDKs. Schemas validate boundary and checkpoint data, tagged errors preserve failure
semantics, and destructive writes remain dry-run-first, approval-gated, checkpointed, idempotent,
and bounded in concurrency.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution gates and [`SECURITY.md`](SECURITY.md) for
security reporting and credential handling.
