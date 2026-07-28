# ado-to-github-teams

[![CI](https://github.com/MSFT-TKENDRICK/ado-to-github-teams/actions/workflows/ci.yml/badge.svg)](https://github.com/MSFT-TKENDRICK/ado-to-github-teams/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`ado-to-github-teams` is a command-line tool for migrating Azure DevOps project teams and their
members into a GitHub organization. It maps Entra-backed Azure DevOps identities to GitHub
Enterprise Managed Users (GHEMU), creates GitHub teams, assigns members, and writes an auditable
Markdown report.

The migration is designed to fail safely:

- every run is a dry-run unless `--apply` is provided;
- planned team changes are shown before any write;
- team creation and member assignment require separate operator approvals;
- checkpoints make interrupted apply runs resumable; and
- retries are bounded and completed writes are not repeated.

> [!IMPORTANT]
> This project is pre-release. Test against a non-production organization first, and review the
> generated report before using `--apply`.

## Prerequisites

- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org/) 20 or later (Node.js 22 is used in CI)
- Azure DevOps, GitHub, and Microsoft Entra credentials with access to the source and target
  organizations

Use least-privilege credentials dedicated to the migration:

| Provider | Required access |
| --- | --- |
| Azure DevOps | Read projects, teams, team members, users, and groups |
| GitHub | Read organization membership and create teams/manage team membership |
| Microsoft Entra ID | `User.Read.All` and `GroupMember.Read.All` as delegated permissions, or equivalent application permissions |

If the GitHub organization enforces SAML SSO, authorize the token for that organization before
running the migration.

## Install a release

Download the `.tgz` package and matching `.sha256` file from the
[latest GitHub release](https://github.com/MSFT-TKENDRICK/ado-to-github-teams/releases/latest).
Verify the checksum, then install the package with npm:

```bash
sha256sum --check ado-to-github-teams-<version>.tgz.sha256
npm install --global ./ado-to-github-teams-<version>.tgz
ado-to-github-teams --help
```

Release workflow runs started manually also provide the package and checksum as a downloadable
GitHub Actions artifact for 30 days.

## Set up from source

Clone the repository, install the locked dependencies, and build the CLI:

```bash
git clone https://github.com/MSFT-TKENDRICK/ado-to-github-teams.git
cd ado-to-github-teams
npm ci
npm run build
```

Confirm that the CLI can discover both commands:

```bash
node bin/run.js --help
node bin/run.js migrate --help
```

All examples below use `node bin/run.js`. After changing TypeScript source, run `npm run build`
again before invoking the built CLI.

## Configure authentication

Credentials are resolved in this order:

1. environment variables;
2. `~/.ado-github-teams/config.json`; then
3. interactive device authorization.

For a non-interactive run, set the credentials in your shell. Do not put real values in repository
files or commit them to source control.

**macOS or Linux**

```bash
export ADO_PAT="<azure-devops-token>"
export GITHUB_PAT="<github-token>"
export ENTRA_CLIENT_ID="<entra-application-client-id>"
export ENTRA_CLIENT_SECRET="<entra-application-client-secret>"
export ENTRA_TENANT_ID="<entra-tenant-id>"
```

**PowerShell**

```powershell
$env:ADO_PAT = "<azure-devops-token>"
$env:GITHUB_PAT = "<github-token>"
$env:ENTRA_CLIENT_ID = "<entra-application-client-id>"
$env:ENTRA_CLIENT_SECRET = "<entra-application-client-secret>"
$env:ENTRA_TENANT_ID = "<entra-tenant-id>"
```

Validate all three credentials before starting a migration:

```bash
node bin/run.js auth --ado-org https://dev.azure.com/contoso
```

Every command that resolves credentials, including `auth` and `migrate`, saves the resolved values
to `~/.ado-github-teams/config.json` even when they came from environment variables. That file
contains plaintext secrets: restrict access to it, never copy it into the repository, and remove
it when it is no longer needed.

### Interactive device authorization

If tokens or a client secret are absent, the CLI can prompt for device authorization:

- Azure DevOps uses `ADO_TENANT_ID` when set and otherwise uses the `organizations` tenant.
- GitHub device authorization requires an OAuth app client ID in `GITHUB_CLIENT_ID` or at the
  prompt.
- Entra device authorization uses `ENTRA_CLIENT_ID` or `ENTRA_PUBLIC_CLIENT_ID` when set, otherwise
  a built-in public client ID. `ENTRA_TENANT_ID` defaults to `organizations`. Leave the
  client-secret prompt empty to select device authorization.

## Run a migration

### 1. Generate a dry-run report

Dry-run is the default and does not create teams or assign members:

```bash
node bin/run.js migrate \
  --ado-org https://dev.azure.com/contoso \
  --ado-project Platform \
  --github-org contoso
```

Review the report for proposed team names, member mappings, skipped identities, edge cases, and
failures. Migration reports can contain organization and identity data, so store and share them as
sensitive operational artifacts. The default `migration-report-<run-id>.md` name is ignored by
Git.

To add a naming convention or tune read concurrency, include the optional flags in another
dry-run:

```bash
node bin/run.js migrate \
  --ado-org https://dev.azure.com/contoso \
  --ado-project Platform \
  --github-org contoso \
  --prefix "ado-" \
  --suffix "-migrated" \
  --concurrency 4
```

### 2. Apply the reviewed migration

Run the same scope with `--apply`:

```bash
node bin/run.js migrate \
  --ado-org https://dev.azure.com/contoso \
  --ado-project Platform \
  --github-org contoso \
  --apply
```

The CLI prints the exact team slugs before team creation and summarizes member assignments before
that phase. Both destructive phases require explicit interactive approval, so apply runs cannot
run unattended. Although the CLI accepts `--yes`, no current prompts are classified as
auto-approvable; the flag has no effect today.

The examples use Bash line continuations. In PowerShell, put the command on one line or use
PowerShell backticks:

```powershell
node .\bin\run.js migrate --ado-org https://dev.azure.com/contoso --ado-project Platform --github-org contoso
```

### Resume an interrupted apply run

Apply checkpoints are stored at `~/.ado-github-teams/checkpoints/<run-id>.json`. Reuse the original
scope and pass the checkpoint filename's run ID. On an interrupted run, the same ID also appears in
the default report filename:

```bash
node bin/run.js migrate \
  --ado-org https://dev.azure.com/contoso \
  --ado-project Platform \
  --github-org contoso \
  --apply \
  --resume 7a4c8f4e-f7f2-4bc5-b3d0-a5d2e6f5f8b1
```

Completed team creations and member assignments are skipped. Successful runs remove their
checkpoint; failed or interrupted apply runs retain it for recovery.

## Command reference

### `migrate`

| Flag | Required | Default | Description |
| --- | --- | --- | --- |
| `--ado-org` | Yes | - | Azure DevOps organization URL |
| `--ado-project` | Yes | - | Azure DevOps project name |
| `--github-org` | Yes | - | GitHub organization name |
| `--apply` | No | `false` | Execute GitHub writes |
| `--output` | No | `./migration-report-<run-id>.md` | Markdown report path; its parent directory must already exist |
| `--prefix` | No | Empty | Prefix added to generated GitHub team names |
| `--suffix` | No | Empty | Suffix added to generated GitHub team names |
| `--concurrency` | No | `4` | Maximum concurrent mapping requests; values below 1 become 1 |
| `--resume` | No | New run | Resume a checkpoint by run ID |
| `--yes` | No | `false` | Reserved for auto-approvable prompts; currently has no effect |

Run `node bin/run.js migrate --help` for the generated CLI reference.

### `auth`

```text
node bin/run.js auth [--ado-org <url>] [--quiet]
```

Pass `--ado-org` to validate the Azure DevOps credential as well as GitHub and Entra credentials.
Without it, Azure DevOps validation is skipped.

## Mapping behavior and reports

Azure DevOps team names become GitHub team names after the optional prefix and suffix are applied.
The generated slug follows GitHub-compatible normalization. Existing matching teams and active
memberships are treated idempotently rather than created again.

Each Markdown report contains:

1. the run scope and dry-run/apply status;
2. mapped teams and members;
3. unmapped or ambiguous identities;
4. edge cases and skipped items;
5. failure and recovery actions; and
6. recorded approvals.

Common edge cases include guest or suspended users, missing email addresses, ambiguous GitHub
matches, nested groups, and Azure DevOps roles without a direct GitHub equivalent. Resolve report
findings before applying the migration.

## Development

The active migration CLI is implemented in `src/` and built to `dist/`. The `apps/cli/` package is
a staged workspace shell and is not the migration entry point documented above.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the exact root dependencies from `package-lock.json` |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm run lint` | Lint `src/` and `test/` |
| `npm run test:unit` | Run unit tests |
| `npm run test:contract` | Run provider contract tests |
| `npm run test:integration` | Run integration tests |
| `npm test` | Run the complete Vitest suite |

The CI-equivalent local validation sequence is:

```bash
npm run lint
npm run build
npm run test:unit
npm run test:contract
npm run test:integration
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.

## Support and security

Open a [GitHub issue](https://github.com/MSFT-TKENDRICK/ado-to-github-teams/issues) for reproducible
bugs and feature requests. Do not include tokens, tenant identifiers, personal data, reports, or
checkpoint contents.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Licensed under the [MIT License](LICENSE).
