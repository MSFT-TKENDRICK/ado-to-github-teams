# ado-to-github-teams

[![CI](https://github.com/MSFT-TKENDRICK/ado-to-github-teams/actions/workflows/ci.yml/badge.svg)](https://github.com/MSFT-TKENDRICK/ado-to-github-teams/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`ado-to-github-teams` migrates Azure DevOps project teams and their members to a GitHub
organization. It resolves Microsoft Entra identities to GitHub Enterprise Managed Users, previews
the proposed changes, creates approved teams and memberships, and produces a migration report.

> [!IMPORTANT]
> This project is pre-release and has no published release package yet. Use it from a source
> checkout and test against a non-production organization first.

## What it does

- Maps Azure DevOps teams to GitHub organization teams.
- Matches Azure DevOps and Microsoft Entra identities to GitHub users.
- Supports flat team migration or an explicit organization-unit/project/repository team hierarchy.
- Exports content-addressed plans for guarded patches and explicit three-way collaboration.
- Refuses GitHub writes unless `--apply` is provided and the proposed changes are approved.
- Keeps interrupted migrations resumable and records outcomes in a Markdown report.

## Try it safely

After [installing from source](docs/using-the-cli.md#install-from-source), choose a starting command
by task:

```bash
node bin/run.js --help
```

Or run the bundled sandbox directly:

```bash
node bin/run.js --sandbox happy-path
```

The sandbox uses synthetic data and cannot write to Azure DevOps, Microsoft Entra ID, or GitHub.

## Migrate teams

1. [Start the worker and authenticate](docs/using-the-cli.md#prepare-a-live-migration).
2. Generate a dry-run report:

   ```bash
   node bin/run.js migrate --ado-org https://dev.azure.com/contoso --ado-project Platform --github-org contoso --foreground
   ```

   The equivalent task-shaped scope aliases are `--source-org`, `--source-project`, and
   `--target-org`. Use `migrate --help` to see scope, execution, recovery, presentation, topology,
   worker, and sandbox flags in separate groups.

3. Review every proposed team, membership, skipped identity, and warning in the report.
4. Run the same command with `--apply`, then approve the exact changes shown by the CLI:

   ```bash
   node bin/run.js migrate --ado-org https://dev.azure.com/contoso --ado-project Platform --github-org contoso --apply --foreground
   ```

Dry run is always the default. Reports and migration state can contain organization and identity
data; keep them private.

## GitHub Copilot Squad

The repository's eight research personas are also an SDK-first
[Squad](https://bradygaster.github.io/squad/docs/get-started/five-minute-start/) for GitHub
Copilot. [`squad.config.ts`](squad.config.ts) is the typed source of truth and imports the same
[`PERSONA_DEFINITIONS`](src/experience/personas.ts) used by the experiment harness. Scribe, Ralph,
Rai, and Fact Checker add redacted memory, read-first triage, safety review, and independent
verification.

Install dependencies, create ignored local Squad state, verify generated assets, and start the
pinned SDK runtime:

```bash
pnpm install --frozen-lockfile
pnpm squad:bootstrap
pnpm squad:check
pnpm squad:copilot
```

Address a persona directly, or describe the task for deterministic routing. The runtime enforces
per-agent tool allowlists, canonical write paths, redacted and approval-gated permission requests,
clarification limits, and reviewer lockouts. These development controls supplement, but never
replace, the migration CLI's Effect services, dry-run, approval, checkpoint, idempotency, and retry
invariants.

Squad `0.11.0` is alpha software and is pinned exactly. Mutable decisions, histories, casting
state, templates, sessions, and logs are ignored because they may contain operational context.
Only static configuration and generated definitions are committed. Use `pnpm squad:doctor` for
installation diagnostics, `pnpm squad:status` for resolution details, and `pnpm squad:nap` to
preview context compaction.

## Documentation

| Need                                                    | Read                                                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Install, authenticate, migrate, resume, or troubleshoot | [Using the CLI](docs/using-the-cli.md)                                                                     |
| Understand the system and safety model                  | [Architecture](docs/architecture.md)                                                                       |
| Understand durable workflow and topology decisions      | [Architecture decisions](docs/decisions/)                                                                  |
| Develop and test the project                            | [Contributing](CONTRIBUTING.md) and [Testing](docs/testing.md)                                             |
| Operate or improve the CLI through an agent             | [Migration operations](skills/ado-to-github-teams/SKILL.md) and [Optimize UX](skills/optimize-ux/SKILL.md) |
| Report a vulnerability                                  | [Security policy](SECURITY.md)                                                                             |

Open a [GitHub issue](https://github.com/MSFT-TKENDRICK/ado-to-github-teams/issues) for reproducible
bugs or feature requests. Do not include credentials, tenant identifiers, personal data, reports,
or migration state.

## License

Licensed under the [MIT License](LICENSE).
