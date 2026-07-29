# ado-to-github-teams

[![CI](https://github.com/MSFT-TKENDRICK/ado-to-github-teams/actions/workflows/ci.yml/badge.svg)](https://github.com/MSFT-TKENDRICK/ado-to-github-teams/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`ado-to-github-teams` is a command-line tool for migrating Azure DevOps project teams and their
members into a GitHub organization. It maps Entra-backed Azure DevOps identities to GitHub
Enterprise Managed Users (GHEMU), creates GitHub teams, assigns members, and writes an auditable
Markdown report.

The migration is designed to fail safely:

- every run is a dry-run unless `--apply` is provided;
- the exact persisted plan is shown and approved before any write;
- approval is recorded before the durable workflow resumes;
- SQLite checkpoints make interrupted runs resumable; and
- retries are bounded and completed writes are not repeated.

> [!IMPORTANT] This project is pre-release. Test against a non-production organization first, and
> review the generated report before using `--apply`.

## Quick start: try it without credentials

The bundled sandbox is the fastest way to see a complete migration. It uses production orchestration
with synthetic provider responses, so it does not contact Azure DevOps, GitHub, or Microsoft Entra
and cannot write to them. This path requires Git, Node.js 22.18 or later and earlier than Node.js 26,
and pnpm 10.34.5 through Corepack.

```bash
git clone https://github.com/MSFT-TKENDRICK/ado-to-github-teams.git
cd ado-to-github-teams
corepack enable
pnpm install --frozen-lockfile
pnpm build
node bin/run.js --sandbox happy-path
```

A successful run ends with output like:

```text
SANDBOX: happy-path — no provider writes will be performed.
Sandbox scenario complete. Run ID: <run-id>
Sandbox report written to ...sandbox-report-happy-path.md
```

Inspect the report to see the mapped teams and members, skipped identities, edge cases, approvals,
and provider-boundary transcript.

To exercise the approval and checkpoint phases while keeping provider writes simulated:

```bash
node bin/run.js --sandbox apply-happy-path --apply --yes
```

Choose the path that matches what you want to do next:

| Goal | Start here |
| --- | --- |
| Evaluate the migration safely | [Explore scenarios in the sandbox](#explore-scenarios-in-the-sandbox) |
| Run a real migration | [Requirements and access](#requirements-and-access), then [install a release](#install-a-release) |
| Change or test the code | [Set up from source](#set-up-from-source), then [development](#development) |
| Automate with an agent | [Agent skill and GitHub Copilot plugin](#agent-skill-and-github-copilot-plugin) |

## Requirements and access

- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org/) 22.18 or later and earlier than Node.js 26
- pnpm 10.34.5 through Corepack
- Azure DevOps, GitHub, and Microsoft Entra credentials with access to the source and target
  organizations

Use least-privilege credentials dedicated to the migration:

| Provider           | Required access                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| Azure DevOps       | Read projects, teams, team members, users, and groups                                                      |
| GitHub             | Read organization membership and create teams/manage team membership                                       |
| Microsoft Entra ID | `User.Read.All` and `GroupMember.Read.All` as delegated permissions, or equivalent application permissions |

If the GitHub organization enforces SAML SSO, authorize the token for that organization before
running the migration.

## Install

### Install a release

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

### Set up from source

Clone the repository, install the locked dependencies, and build the CLI:

```bash
git clone https://github.com/MSFT-TKENDRICK/ado-to-github-teams.git
cd ado-to-github-teams
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Confirm that the CLI can discover both commands:

```bash
node bin/run.js --help
node bin/run.js migrate --help
```

All examples below use `node bin/run.js`. After changing TypeScript source, run `pnpm build`
again before invoking the built CLI. During development, use `pnpm dev -- <arguments>` to run the
TypeScript entry point without rebuilding:

```bash
pnpm dev -- --sandbox happy-path
```

## Explore scenarios in the sandbox

Sandbox mode runs the production migration orchestrator while replacing the ADO, Entra, GitHub, and
approval boundaries with deterministic fixtures. It does not resolve credentials or construct live
provider clients.

List the bundled scenarios, then run one directly from the initial CLI entrypoint:

```bash
node bin/run.js --list-sandbox-scenarios
node bin/run.js --sandbox happy-path
```

The generated report is clearly marked `SANDBOX — NO PROVIDER WRITES WERE PERFORMED` and includes
the exact boundary transcript. Apply scenarios still exercise the normal approval and checkpoint
phases, but GitHub writes are simulated:

```bash
node bin/run.js --sandbox apply-happy-path --apply
```

Pass `--yes` to use that scenario's configured approval decisions non-interactively. This behavior
is limited to sandbox mode. Sandbox checkpoints are isolated under
`.ado-github-teams/sandbox-checkpoints/`; sandbox resume is intentionally rejected because response
queues start from fixture state.

The bundled acceptance scenarios are specified in standard Gherkin at
[`sandbox/migration.feature`](sandbox/migration.feature), with editable YAML responses in
[`sandbox/scenarios.yaml`](sandbox/scenarios.yaml). Use a modified catalog without rebuilding:

```bash
node bin/run.js --sandbox happy-path --sandbox-config ./my-scenarios.yaml
```

Each YAML interaction names an integration operation, exact arguments, one or more typed responses,
and finite `minCalls`/`maxCalls`. Response arrays model retries. Missing, ambiguous, exhausted, or
unused required interactions fail closed. Keep fixture data synthetic and add a matching
`@sandbox-<scenario-id>` Gherkin scenario when extending the catalog.

## Agent skill and GitHub Copilot plugin

The agent-native operating guide lives at
[`skills/ado-to-github-teams`](skills/ado-to-github-teams). Install the repository as a GitHub
Copilot CLI plugin:

```bash
copilot plugin install MSFT-TKENDRICK/ado-to-github-teams
```

Or install only the portable Agent Skill with the skills.sh CLI:

```bash
npx skills add MSFT-TKENDRICK/ado-to-github-teams --skill ado-to-github-teams
```

The skill uses progressive disclosure for repository installation, authentication, dry-run and apply
operations, interrupted-session recovery, and user feedback and approval gates.

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
contains plaintext secrets: restrict access to it, never copy it into the repository, and remove it
when it is no longer needed.

### Interactive device authorization

If tokens or a client secret are absent, the CLI can prompt for device authorization:

- Azure DevOps uses `ADO_TENANT_ID` when set and otherwise uses the `organizations` tenant.
- GitHub device authorization requires an OAuth app client ID in `GITHUB_CLIENT_ID` or at the
  prompt.
- Entra device authorization uses `ENTRA_CLIENT_ID` or `ENTRA_PUBLIC_CLIENT_ID` when set, otherwise
  a built-in public client ID. `ENTRA_TENANT_ID` defaults to `organizations`. Leave the
  client-secret prompt empty to select device authorization.

## Start the durable local worker

The migration CLI schedules production work through Vercel Workflow. The default self-hosted
World is local-first: SQLite stores workflow and migration state, NATS JetStream delivers workflow
and step work, and Litestream replicates SQLite into a JetStream Object Store bucket.

```bash
cp .env.example .env
# Replace both example secrets with independent random values of at least 32 characters.
# Add the provider credentials described above.
docker compose up --build -d
```

Export the same API token in the shell that runs the CLI:

```bash
export WORKFLOW_API_TOKEN="<same value as .env>"
```

The Compose stack uses named volumes for SQLite WAL locking and JetStream persistence. The worker
restores a missing database from Litestream, verifies database integrity, and then accepts work on
`http://127.0.0.1:7331`.

## Run a migration

### 1. Generate a dry-run report

Dry-run is the default and does not create teams or assign members.

The examples use Bash line continuations. In PowerShell, put the command on one line or use
PowerShell backticks.

```bash
node bin/run.js migrate \
  --ado-org https://dev.azure.com/contoso \
  --ado-project Platform \
  --github-org contoso
```

```powershell
node .\bin\run.js migrate --ado-org https://dev.azure.com/contoso --ado-project Platform --github-org contoso
```

The Workflow worker starts discovery in the background, so the command returns immediately with a
durable run ID. Identical concurrent provider reads are coalesced, and completed mapping batches are
checkpointed as they finish. Use `--foreground` when a script needs to wait for the report.

Review the report for proposed team names, member mappings, skipped identities, edge cases, and
failures. Migration reports can contain organization and identity data, so store and share them as
sensitive operational artifacts. The default `migration-report-<run-id>.md` name is ignored by Git.

To add a naming convention or tune read concurrency, include the optional flags in another dry-run:

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

Run the same scope with `--apply`. Discovery runs in the background and stops before the first
destructive approval:

```bash
node bin/run.js migrate \
  --ado-org https://dev.azure.com/contoso \
  --ado-project Platform \
  --github-org contoso \
  --apply
```

Reopen the CLI with no arguments at any time. It restores the latest durable Workflow run, displays
current progress, and prints the exact team and member changes when approval is ready:

```bash
node bin/run.js
```

The CLI prints the exact persisted team and member changes, records one immutable interactive
decision, and only then resumes the suspended Workflow.

### Resume an interrupted run

Checkpoints and Workflow links are stored in `~/.ado-github-teams/workflow.db`. Running the CLI with
no arguments reopens the latest session. Completed parallel mapping batches, team creations, and
member assignments are skipped, while interrupted work continues with the configured concurrency.
Use `--resume` to select a different retained session explicitly:

```bash
node bin/run.js migrate \
  --ado-org https://dev.azure.com/contoso \
  --ado-project Platform \
  --github-org contoso \
  --apply \
  --resume 7a4c8f4e-f7f2-4bc5-b3d0-a5d2e6f5f8b1
```

`--resume` reattaches to the existing Workflow generation and never starts a duplicate. Resume
rejects incompatible schema or mapping configuration. Completed team creations and member
assignments are skipped, team creation is verified remotely before retry, and GitHub membership
writes are idempotent.

Use `--fresh` with a complete scope to start a separate session instead of reopening the latest
Workflow.

### Local and remote World configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WORKFLOW_SQLITE_PATH` | `~/.ado-github-teams/workflow.db` | SQLite state database |
| `WORKFLOW_NATS_URLS` | `nats://127.0.0.1:4222` | Comma-separated JetStream servers |
| `WORKFLOW_BASE_URL` | `http://127.0.0.1:7331` | Public worker URL |
| `WORKFLOW_NATS_CONCURRENCY` | `10` | Bounded queue concurrency |
| `LITESTREAM_NATS_URL` | `nats://nats:4222` in Compose | Replication server |
| `LITESTREAM_NATS_BUCKET` | `migration_backups` | Object Store bucket |

To use another Workflow World, set `WORKFLOW_TARGET_WORLD` to its module target and explicitly set
`WORKFLOW_ALLOW_REMOTE_TARGET=true`. Local mode remains the default.

## Command reference

### `migrate`

| Flag | Required | Default | Description |
| --- | --- | --- | --- |
| `--ado-org` | Live mode | Scenario scope | Azure DevOps organization URL |
| `--ado-project` | Live mode | Scenario scope | Azure DevOps project name |
| `--github-org` | Live mode | Scenario scope | GitHub organization name |
| `--apply` | No | `false` | Execute GitHub writes |
| `--output` | No | Live: `./migration-report-<run-id>.md`; sandbox: `./sandbox-report-<scenario-id>.md` | Markdown report path; its parent directory must already exist |
| `--prefix` | No | Empty | Prefix added to generated GitHub team names |
| `--suffix` | No | Empty | Suffix added to generated GitHub team names |
| `--concurrency` | No | `4` | Maximum concurrent mapping requests; values below 1 become 1 |
| `--resume` | No | Latest run for bare CLI | Resume a durable Workflow by run ID |
| `--fresh` | No | `false` | Start a separate Workflow instead of reopening the latest session |
| `--foreground` | No | `false` | Wait for the durable migration to complete |
| `--worker-url` | No | `http://127.0.0.1:7331` | Durable worker URL |
| `--yes` | No | `false` | Approve the displayed migration plan without prompting |
| `--sandbox` | No | - | Run a named scenario through simulated integration boundaries |
| `--sandbox-config` | No | Bundled YAML | Load scenarios from an editable YAML catalog |
| `--list-sandbox-scenarios` | No | `false` | List configured sandbox scenarios and exit |

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

The active migration CLI is implemented in `src/` and built to `dist/`. The `apps/cli/` package is a
staged workspace shell and is not the migration entry point documented above.

| Command | Purpose |
| --- | --- |
| `pnpm install --frozen-lockfile` | Install the exact root dependencies from `pnpm-lock.yaml` |
| `pnpm build` | Compile TypeScript into `dist/` |
| `pnpm dev -- <arguments>` | Run the TypeScript CLI directly, for example `pnpm dev -- --sandbox happy-path` |
| `pnpm worker:build` | Compile the durable Workflow worker |
| `pnpm lint` | Lint `src/`, `test/`, and `scripts/` |
| `pnpm test:unit` | Run unit tests |
| `pnpm test:contract` | Run consumer Pact compatibility tests |
| `pnpm test:integration` | Run integration tests |
| `pnpm test:bdd` | Run executable migration acceptance scenarios and write `reports/cucumber.md` |
| `pnpm test` | Run the complete Vitest suite |

The CI-equivalent local validation sequence is:

```bash
pnpm lint
pnpm build
pnpm worker:build
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm test:bdd
pnpm test
```

The Cucumber features in `test/bdd/features/` distinguish deterministic acceptance behavior from
`@manual @external-behavior` scenarios that require a controlled enterprise tenant. CI uploads the
generated report and maintains one synthetic, aggregate-only BDD summary comment on same-repository
pull requests. Fork pull requests still run the required gate and upload the report, but do not
receive a comment because GitHub grants their workflow token read-only permissions.

Pact covers every application-owned HTTP boundary: CLI-to-worker start, status, approval, and
report requests, plus Workflow-step-to-worker prepare and apply requests. The GitHub, Azure DevOps,
and Microsoft Graph Pact suites also exercise production adapters against mock providers. Those
third-party SaaS providers do not verify the generated pacts, so their results are compatibility
checks rather than provider verification or `can-i-deploy` evidence.

### Repository layout

| Path | Purpose |
| --- | --- |
| `src/commands/` | `auth` and `migrate` CLI commands |
| `src/effect/` | Migration orchestration, schemas, services, and live Layers |
| `src/services/` | Azure DevOps, GitHub, and Microsoft Entra adapters |
| `sandbox/` | Synthetic migration scenarios and acceptance feature |
| `test/` | Unit, contract, integration, and BDD test suites |
| `skills/ado-to-github-teams/` | Agent Skill instructions and operational references |
| `apps/cli/` | Staged workspace shell; not the active migration CLI |

See [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.

## Troubleshooting and support

- Run `node bin/run.js --help` or `node bin/run.js migrate --help` when a flag is rejected.
- If the CLI reports missing live scope, provide all of `--ado-org`, `--ado-project`, and
  `--github-org`.
- Create the parent directory before using `--output`; the CLI creates the report file, not its
  parent directories.
- Resume with the same source, target, apply mode, prefix, and suffix used by the original run.
  Incompatible checkpoint configuration is rejected.

Open a [GitHub issue](https://github.com/MSFT-TKENDRICK/ado-to-github-teams/issues) for reproducible
bugs and feature requests. Do not include tokens, tenant identifiers, personal data, reports, or
checkpoint contents.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Licensed under the [MIT License](LICENSE).
