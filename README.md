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

> [!IMPORTANT]
> This project is pre-release. Test against a non-production organization first, and review the
> generated report before using `--apply`.

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

| Provider | Required access |
| --- | --- |
| Azure DevOps | Read projects, teams, team members, users, and groups |
| GitHub | Read organization/team/repository metadata; create teams; manage team membership; and, for `--team-topology`, administer team repository access and read team-sync state |
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

Confirm that the CLI can discover the migration, session-inbox, and authentication commands:

```bash
node bin/run.js --help
node bin/run.js migrate --help
node bin/run.js sessions --help
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
npx skills add MSFT-TKENDRICK/ado-to-github-teams --skill persona-ux-optimizer
```

The operating skill uses progressive disclosure for repository installation, authentication,
dry-run and apply operations, interrupted-session recovery, and user feedback and approval gates.
The repository-owned [`skills/persona-ux-optimizer`](skills/persona-ux-optimizer) skill runs the
measured persona experiment as a bounded, resumable improvement loop with exact evidence,
anti-regression, documentation-freshness, and truthful convergence gates.

## Configure authentication

The CLI first uses identities already available on the machine:

1. Azure workload, managed, or service-principal identity;
2. Visual Studio Code, Azure CLI, Azure PowerShell, or Azure Developer CLI sign-in;
3. the default Windows Web Account Manager account, including a domain-joined work account;
4. `GH_TOKEN`/`GITHUB_TOKEN`, then the current `gh auth` login; and
5. interactive browser or device authorization only when no ambient identity succeeds.

For the simplest local setup, sign in once with an Azure developer tool and GitHub CLI:

```bash
az login
gh auth login
node bin/run.js auth --ado-org https://dev.azure.com/contoso
```

`Connect-AzAccount` or `azd auth login` can replace `az login`. On Windows, the CLI also attempts
silent broker authentication with the signed-in work or domain account before prompting.

For non-interactive runs, prefer federated workload identity or managed identity plus a short-lived
GitHub token. `ADO_PAT` remains an optional explicit override for Azure DevOps:

```bash
export AZURE_CLIENT_ID="<entra-application-client-id>"
export AZURE_TENANT_ID="<entra-tenant-id>"
export AZURE_FEDERATED_TOKEN_FILE="/path/to/oidc-token"
export GH_TOKEN="<github-token>"
# Optional: export ADO_PAT="<azure-devops-token>"
```

`DefaultAzureCredential` also supports managed identity, certificates, and client-secret
authentication when passwordless options are unavailable. The legacy `ENTRA_CLIENT_ID`,
`ENTRA_TENANT_ID`, and `ENTRA_CLIENT_SECRET` aliases remain supported for compatibility.

Repository configuration is declared in [`.env.schema`](.env.schema) and enforced with
[Varlock](https://varlock.dev/). Never put plaintext secrets in tracked files. For local overrides,
create a git-ignored `.env.local`, use `varlock(prompt)` for each sensitive value, and run
`pnpm exec varlock load`; Varlock prompts securely and replaces each placeholder with a
device-encrypted value. `pnpm dev` automatically validates and injects the resolved configuration.

Validate all three credentials before starting a migration:

```bash
node bin/run.js auth --ado-org https://dev.azure.com/contoso
```

The command reports one non-secret diagnostic for Azure DevOps, GitHub, and Entra. Each provider
entry states what was planned and attempted, the safely identifiable credential source, the outcome,
and the next remediation. Azure DevOps organization access can only be checked when `--ado-org` is
provided; otherwise that provider is explicitly reported as skipped while GitHub and Entra are
still validated.

For unattended validation, request the stable schema-version 1 JSON document on stdout:

```bash
node bin/run.js auth --ado-org https://dev.azure.com/contoso --json
```

The JSON contains provider status, source, check, reason, and remediation fields, but never tokens,
tenant identifiers, organization URLs, or raw provider errors. JSON mode disables interactive
browser and device fallback so the document is the only stdout output. Any failed provider produces
a non-zero process exit. `--quiet` suppresses successful human diagnostics while preserving failure
output and exit status. `--json` and `--quiet` are mutually exclusive so automation cannot
accidentally request and suppress the same output.

The CLI never writes access tokens, PATs, or client secrets to
`~/.ado-github-teams/config.json`. That file contains only non-secret preferences and is created
with user-only permissions. Interactive Azure tokens use the operating system's encrypted token
cache. If an older config contains plaintext credentials, the CLI removes them on first load.

### GitHub Copilot authentication for recovery reasoning

Live migrations use the GitHub Copilot SDK to assess failed write units. The SDK uses the currently
authenticated GitHub Copilot CLI user on the worker host; the migration does not accept or persist
a separate Copilot token. Start the worker in an environment with an authenticated Copilot CLI
session.

Inference is advisory and fail-closed. The prompt contains operation metadata and a categorized
failure, not identity names or raw provider error text. Only a transient, checkpointed, idempotent
membership write can be retried automatically, and then only once with a high-confidence safe
decision. Team creation is never retried automatically. Skips and ambiguous recommendations are
not covered by the original plan approval and fail closed for human review; unavailable or
malformed inference cannot authorize a write.

### Interactive authorization

If ambient authentication is unavailable in an interactive terminal:

- Azure DevOps and Entra first open interactive browser authentication and then fall back to device
  authorization. `AZURE_TENANT_ID` or `ENTRA_TENANT_ID` selects a tenant; otherwise
  `organizations` is used.
- GitHub device authorization requires an OAuth app client ID in `GITHUB_CLIENT_ID` or at the
  prompt.
- Azure interactive authorization uses `ENTRA_CLIENT_ID` or `ENTRA_PUBLIC_CLIENT_ID` when set,
  otherwise a built-in development client ID.

In CI or another non-interactive terminal, the CLI never prompts and instead fails with guidance
when no ambient credentials are available.

## Start the durable local worker

The migration CLI runs durable work on the [Workflow Development Kit](https://workflow.dev/) (the
`workflow` and `@workflow/world` packages). The Workflow DevKit executes on a pluggable *World* that
supplies storage, queuing, authentication, and streaming. The upstream project publishes three
Worlds:

- the **Vercel World** (`@workflow/world-vercel`) is the managed, hosted option;
- the **Local World** (`@workflow/world-local`) is intended for development only; and
- the **Postgres World** (`@workflow/world-postgres`) is the official self-hosted reference
  implementation for multi-host production.

This repository does not use any of those by default. It composes a community, local-first World
instead: the Turso/libSQL World (`@workflow-worlds/turso`) keeps workflow and migration state in
SQLite, and a NATS JetStream World (`@fantasticfour/world-nats-jetstream`) delivers workflow and
step work. [Litestream](https://litestream.io/) replicates the SQLite database asynchronously into a
JetStream Object Store bucket. This gives durable, single-node disaster recovery, not high
availability. For self-hosted, multi-host production, target the Postgres World described in
[Local and remote World configuration](#local-and-remote-world-configuration).

```bash
# In .env.local:
# WORKFLOW_API_TOKEN=varlock(prompt)
# WORKFLOW_TASK_SECRET=varlock(prompt)
pnpm exec varlock load
pnpm exec varlock run --inject vars -- docker compose up --build -d
```

The worker runs through Varlock with `APP_ENV=production`, so startup fails before the first network
call if either independent worker secret is missing or shorter than 32 characters. The same
Varlock invocation passes the API token to Docker Compose and to subsequent source CLI runs.

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

### Model an OU, project, and repository contributor hierarchy

There is no safe one-to-one translation from Azure DevOps teams and ACLs to GitHub teams. Azure
DevOps supports object-level `Allow` and `Deny` semantics, while GitHub repository access is
additive and child teams inherit every repository grant assigned to a parent. The topology mode
therefore requires an explicit YAML or JSON plan and never infers repository permissions from an
Azure DevOps team name or permission.

Choose a GitHub organization boundary for governance, not solely because an ADO project contains
multiple repositories. An organization is the practical boundary for ownership, base repository
permissions, identity policy, audit administration, billing, Actions policy, repository rules, and
visibility. Map an ADO project to its own GitHub organization only when it needs that independent
policy and administration boundary. Otherwise, place its project team beneath an OU team in a
shared organization and keep repository access on leaf teams. If an OU spans several GitHub
organizations, evaluate GitHub enterprise teams separately; this tool creates organization teams
only.

```yaml
version: 1
organizationalUnit:
  name: Engineering
  description: Structural team for the Engineering OU
projectTeam:
  name: Payments
  description: Structural team for the Payments ADO project
repositories:
  - repository: payments-api
    teamName: Payments API Contributors
    sourceAdoTeams:
      - Payments Contributors
      - API Maintainers
    role: write
  - repository: contoso/payments-docs
    teamName: Payments Docs Contributors
    sourceAdoTeams:
      - Payments Contributors
    role: triage
```

Run and review a dry-run before apply:

```bash
node bin/run.js migrate \
  --ado-org https://dev.azure.com/contoso \
  --ado-project Payments \
  --github-org contoso \
  --team-topology ./payments-topology.yaml
```

The plan creates `Engineering > Payments > repository contributor team`. Structural OU and
project teams receive no repository grants or migrated members. Each repository leaf receives the
combined, deduplicated membership of its named source ADO teams and only its configured direct
repository role. `--prefix` and `--suffix` cannot be combined with `--team-topology`; topology names
are exact.

Supported direct roles are `read`, `triage`, `write`, `maintain`, and `admin`. An `admin` grant is
rejected unless the plan also sets `allowAdmin: true`. The tool rejects duplicate or cross-org
repository mappings, missing or archived repositories, secret nested teams, incompatible existing
parents, IdP-managed teams, existing structural-parent repository access, custom roles it cannot
represent, proposed grants below the organization base permission, and permission downgrades.
Existing teams are never silently re-parented.

Topology apply adds a third approval gate after team creation and member assignment. The exact
repository, leaf team, direct role, organization base permission, and repository visibility are
shown and checkpointed before each grant. Resume requires the same topology file content digest.
Topology checkpoints use schema version `2`; checkpoints from an earlier release must be restarted
from a fresh dry-run so an older approval cannot authorize hierarchy or repository-grant writes.

> [!CAUTION]
> A direct team grant is not a complete effective-access calculation. Organization base access,
> internal-repository visibility, enterprise policies, direct and outside collaborators, other
> teams, deploy keys, and custom repository roles can widen access. Keep base permission at `none`
> where policy allows, audit all parent-team grants, and review repository collaborators before
> apply. Azure DevOps `Deny` ACLs must be reviewed manually because GitHub has no equivalent deny
> grant.

Nested teams and identity-provider synchronization are mutually exclusive. GitHub documents that
teams connected to IdP groups cannot be parents or children. Topology mode checks both Enterprise
Managed Users external-group connections and non-EMU team-synchronization mappings, and fails
closed unless the token can inspect at least one applicable endpoint. For Enterprise Managed
Users, keep SCIM-managed access teams flat or use nested migration-managed teams, but do not mix
both models.
Outside collaborators cannot be team members, so grant their exceptional repository access
separately and include it in the compliance review.

Relevant GitHub guidance:

- [Nested teams and inherited access](https://docs.github.com/en/organizations/organizing-members-into-teams/about-teams#nested-teams)
- [Repository roles](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)
- [Managing team memberships with IdP groups](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/provisioning-user-accounts-with-scim/managing-team-memberships-with-identity-provider-groups)
- [Enterprise repository policies](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-accounts-and-repositories/managing-repositories-in-your-enterprise/governing-how-people-use-repositories-in-your-enterprise)

For a classic PAT, use a dedicated migration identity with the minimum target-org authorization
needed for team management and private-repository administration, and authorize it for SAML SSO.
For fine-grained credentials or a GitHub App, scope access to the target organization and listed
repositories, with organization members/team write access, repository metadata read access, and
repository administration write access. The identity preflight also needs permission to inspect
external-group or team-synchronization connections. Enterprise policy can still prohibit an
otherwise authorized write.

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

If a write fails, Copilot may authorize one bounded retry of a verified idempotent membership
write. Any proposed skip or unclear recovery fails closed for human review before the durable run
is resumed.

### Membership writes are refused for IdP-managed teams

Every apply run — including the default flat mapping, not only `--team-topology` mode — checks
each target team with the GitHub adapter's `isTeamIdpManaged` capability before proposing or
writing any membership change. If the adapter cannot report IdP-managed status at all, the run
fails closed with a typed validation error rather than risk fighting an identity provider's
synchronization. If a specific team is confirmed to be synchronized by SCIM or GitHub team sync,
its member writes are skipped and recorded as an `idp-managed-team` edge case directing the
operator to change membership in the identity provider instead; the migration continues for any
other, non-synchronized teams. This decision is persisted to the checkpoint immediately, so a
resumed run re-derives the same skip rather than re-attempting the write, and a team that becomes
synchronized between runs is re-evaluated and blocked on every apply. EMU/SCIM-managed
enterprises should keep these entitlement teams flat (no `--team-topology`); see
[Model an OU, project, and repository contributor hierarchy](#model-an-ou-project-and-repository-contributor-hierarchy)
for when nested topology is appropriate instead.

Relevant GitHub guidance:

- [Synchronizing a team with an identity provider group](https://docs.github.com/en/enterprise-cloud@latest/organizations/organizing-members-into-teams/synchronizing-a-team-with-an-identity-provider-group)
- [Managing team memberships with IdP groups](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/provisioning-user-accounts-with-scim/managing-team-memberships-with-identity-provider-groups)

### Resume an interrupted apply run

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

### Switch between blocked parallel sessions

List every retained migration session, or filter to sessions waiting for an operator:

```bash
node bin/run.js sessions
node bin/run.js sessions --blocked
```

Use the interactive inbox to switch between blocked sessions and answer durable elicitations.
After each answer, the selector returns to the refreshed cross-session inbox:

```bash
node bin/run.js sessions --blocked --select
```

Every answer is bound to a stable elicitation ID. Decisions are immutable, competing answers are
serialized, and a durable resume lease safely redelivers answers after transient failures without
resuming the same hook twice. `--json` emits the session list for automation.

When healing cannot safely continue, aborting the elicitation writes an escalation dossier. It
includes the semantic error summary, estimated agent and human remediation work, Entra principal
description, workflow, hook, and agent trace identifiers, source and target configuration, redacted
logs, and redacted Copilot conversation history. Treat escalation reports as sensitive operational
artifacts even though credentials and user principal names are redacted.

### Local and remote World configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WORKFLOW_SQLITE_PATH` | `~/.ado-github-teams/workflow.db` | SQLite state database |
| `WORKFLOW_NATS_URLS` | `nats://127.0.0.1:4222` | Comma-separated JetStream servers |
| `WORKFLOW_BASE_URL` | `http://127.0.0.1:7331` | Public worker URL |
| `WORKFLOW_NATS_CONCURRENCY` | `10` | Bounded queue concurrency |
| `LITESTREAM_NATS_URL` | `nats://nats:4222` in Compose | Replication server |
| `LITESTREAM_NATS_BUCKET` | `migration_backups` | Object Store bucket |

To use a different Workflow World, install it, set `WORKFLOW_TARGET_WORLD` to its module target, and
explicitly set `WORKFLOW_ALLOW_REMOTE_TARGET=true`. The community Turso/JetStream World remains the
default. For self-hosted production, install `@workflow/world-postgres` and set
`WORKFLOW_TARGET_WORLD=@workflow/world-postgres`; that World is configured through its own
`WORKFLOW_POSTGRES_*` variables rather than the SQLite and JetStream settings above.

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
| `--sessions` | No | `false` | Open the interactive parallel-session elicitation inbox |
| `--worker-url` | No | `http://127.0.0.1:7331` | Durable worker URL |
| `--yes` | No | `false` | Approve the displayed migration plan without prompting |
| `--sandbox` | No | - | Run a named scenario through simulated integration boundaries |
| `--sandbox-config` | No | Bundled YAML | Load scenarios from an editable YAML catalog |
| `--list-sandbox-scenarios` | No | `false` | List configured sandbox scenarios and exit |

Run `node bin/run.js migrate --help` for the generated CLI reference.

### `sessions`

| Flag | Required | Default | Description |
| --- | --- | --- | --- |
| `--blocked` | No | `false` | Show only sessions with pending elicitations |
| `--select` | No | `false` | Interactively switch between and answer blocked sessions |
| `--json` | No | `false` | Emit the session inbox as JSON |
| `--worker-url` | No | `http://127.0.0.1:7331` | Durable worker URL |

### `auth`

```text
node bin/run.js auth [--ado-org <url>] [--json | --quiet]
```

| Flag | Required | Default | Description |
| --- | --- | --- | --- |
| `--ado-org` | No | - | Validate access to this Azure DevOps organization; without it, the ADO check is explicitly skipped |
| `--json` | No | `false` | Disable interactive fallback and emit only the stable, schema-version 1, non-secret provider diagnostic document on stdout |
| `--quiet` | No | `false` | Suppress successful human diagnostics while retaining failure output and exit status |

Human and JSON output use the same decoded provider model. Azure DevOps, GitHub, and Entra each
report planned and attempted state, status, safely identifiable credential source, reason, and
remediation. Any planned provider that is unready makes the command exit non-zero. `--json` and
`--quiet` conflict and are rejected before credential resolution or provider access.

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
| `pnpm secrets:check` | Validate `.env.schema` and scan for leaked configured secrets |
| `pnpm format` | Format `src/`, `test/`, and `scripts/` with Prettier |
| `pnpm format:check` | Check `src/`, `test/`, and `scripts/` match Prettier formatting (no writes) |
| `pnpm lint` | Lint `src/`, `test/`, and `scripts/` |
| `pnpm typecheck` | Type-check `src/`, `test/`, and `scripts/` with `tsc --noEmit` |
| `pnpm test:unit` | Run unit tests |
| `pnpm test:contract` | Run Pact consumer tests and, on Linux/x64 CI, owned-boundary provider verification, then assert the gate did not silently skip every contract test on a Pact-capable platform |
| `pnpm test:integration` | Run integration tests |
| `pnpm test:bdd` | Run executable migration acceptance scenarios and write `reports/cucumber.md` |
| `pnpm experiment:personas` | Run eight production-baseline persona passes over migration BDD scenarios and the schema-validated complete CLI journey catalog, then write ignored research artifacts under `reports/persona-experiments/` |
| `pnpm persona:optimize -- cycle` | Run or resume the exact-validated persona UX improvement cycle in an app-owned worktree |
| `pnpm test` | Run the complete Vitest suite (convenience alias; not part of `pnpm check`, since `test:unit`/`test:contract`/`test:integration` already cover every `test/**/*.test.ts` file individually) |
| `pnpm package:smoke` | Build `apps/cli` and verify its packaged CLI output |
| `pnpm check` | Run the full local quality gate: secrets, format, lint, typecheck, build, unit, contract, integration, and package smoke |

`pnpm check` is the required pre-push/pre-merge gate and mirrors CI's `validate` job. Run it before
opening or updating a pull request:

```bash
pnpm check
```

Which is equivalent to running, in order:

```bash
pnpm secrets:check
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm package:smoke
```

`test:unit`, `test:contract`, and `test:integration` together already exercise every file matched
by `test/**/*.test.ts`, so `pnpm check` does not additionally run the bare `pnpm test` alias - doing
so would silently re-run the same suites a second time for no extra coverage. `pnpm test:bdd` is a
separate, additional acceptance gate (see below) that CI also runs and is not part of `pnpm
check`'s dependency chain, since its BDD/PR-comment behavior needs its own `continue-on-error`
handling in CI to keep fork pull requests unprivileged.

The Cucumber features in `test/bdd/features/` distinguish deterministic acceptance behavior from
`@manual @external-behavior` scenarios that require a controlled enterprise tenant. CI uploads the
generated report and maintains one synthetic, aggregate-only BDD summary comment on same-repository
pull requests. Fork pull requests still run the required gate and upload the report, but do not
receive a comment because GitHub grants their workflow token read-only permissions.

Run the human-centered design experiment harness to exercise every automated migration scenario and
the complete modeled CLI surface repeatedly through eight contrasting, goal- and context-based
personas:

```bash
pnpm experiment:personas
```

The harness runs eight bounded iterations by default. Each iteration preserves the executable
migration BDD observations and adds deterministic offline journeys for no-argument routing, root and
command help, version, unknown commands, `migrate`, `auth`, `sessions`, every declared command flag,
and important invalid flag combinations. Structured journey metadata assigns command, entrypoint,
flags, conflicts, personas, and friction levers directly instead of inferring CLI coverage from step
keywords.

The run fails if the coverage manifest leaves any command, flag, entrypoint behavior, conflict, or
persona unrepresented. Coverage appears in `persona-experiment.md`, `persona-experiment.json`, and
the focused `cli-coverage.json`. Exact action and thought traces, including migration-versus-CLI
source and command context, are written to `persona-actions.jsonl`; every line is shape-validated
before artifacts are accepted. Cucumber NDJSON, JSONL, and all generated reports remain under the
ignored `reports/` tree.

The default `production` baseline keeps the original six migration-experience levers plus
`automationClarity` and `credentialSetup` at full strength. It models the four remaining CLI-wide
dimensions at honest partial values: command discoverability, flag ergonomics, repetitive scope
entry, and error prevention. The current declarative coverage manifest requires 3/3 commands,
27/27 flags, 6/6 entrypoint behaviors, 9/9 important conflicts, and 8/8 personas. The report ranks
remaining candidates and records whether the bound was reached or no candidate remained; it never
claims convergence merely because the requested iterations completed.

The accepted provider-readiness run completed all eight iterations with 8,624/8,624 valid trace
lines and no malformed traces or scenario failures. The implementation comparison uses the
immutable corrected lower-layer evidence, not an optimization decision within the current run:
credential setup moved from P95 46.7 with 5/6 unintuitive actions to current full-strength traces at
P95 26.4 with 0/8, and automation clarity moved from P95 38.9 with 0/10 to P95 23.7 with 0/15.
Because both levers start at full strength in the current production baseline, the ranking correctly
excludes them and optimizes only remaining candidates. These values are baseline evidence for this
implementation, not a substitute for future fresh runs: every persona iteration that changes
commands, flags, conflicts, journeys, or modeled levers must update the directly affected
documentation and regenerate exact evidence before acceptance.

Use `--baseline synthetic` for the intentionally incomplete legacy comparison, or `--baseline
production` explicitly for the current production design. `--iterations`, `--optimization-step`,
and `--pain-threshold` also remain available:

```bash
pnpm experiment:personas -- --baseline synthetic
pnpm experiment:personas -- --iterations 8 --pain-threshold 40
```

These simulations generate hypotheses; validate high-impact findings with representative migration
operators before changing production behavior.

### Iterate persona UX with an agent

Use the repository-owned optimizer only from an app-owned worktree and non-`main` branch:

```bash
pnpm persona:optimize -- cycle
pnpm persona:optimize -- status
```

Each cycle fetches current `main`, captures the branch source SHA and worktree fingerprint, runs the
configured persona experiment (eight iterations by default), and writes a unique ignored evidence
directory. `optimizer-run.json` binds the run and configuration to the exact source SHA. The
validator recomputes every iteration from every Cucumber JSONL file, checks all trace lines against
the exact schema, compares a normalized trace multiset to the JSON report, and rejects missing,
unexpected, duplicated, or malformed records. The coverage gate currently expects 3/3 commands,
26/26 flags, 6/6 entrypoints, and 8/8 conflicts.

The latest ignored `cycle-receipt` is
`.persona-ux-optimizer/latest-receipt.json`; durable resume state is
`.persona-ux-optimizer/checkpoint.json`. A receipt records source/baseline identity, artifact
counts, selected and deferred complexity, changed code/docs, validation, initial and final metrics,
PR state, remaining friction, convergence, and the next wakeup. Generated reports, traces, receipts,
and checkpoints stay ignored and must not contain secrets or tenant data.

Candidates are limited to unaddressed production friction and ranked by high-harm actions, P95
friction, then unintuitive actions. A cycle selects 1-10 fixes within six points (small=1, medium=3,
large=5). A high-harm increase blocks the cycle. Bound exhaustion
(`iteration-bound-reached-with-candidates`) is not convergence: continue until no unaddressed
candidate remains above the modeled threshold, or a fresh rerun proves all feasible opportunity is
insufficient. Repeated candidates/no progress, invalid or stale evidence, stale docs, failed CI, a
real blocker, or a user stop are recorded without a success-shaped convergence claim.

Every cycle must refresh README/operator/security guidance, executable help/examples, coverage
counts, output schemas, baseline evidence, and exit behavior. **Exit behavior:** `0` means evidence
is valid and the decision is continue/converged/stopped; `1` means a blocking evidence, docs,
regression, loop, or operational failure; `2` means malformed usage. Run focused checks during the
cycle and the full `pnpm check` before push.

For scheduled use, attach an hourly automation to the same app session. It should read the durable
checkpoint, rerun `pnpm persona:optimize -- cycle --next-wakeup <RFC3339>`, implement only the
receipt's bounded selection, validate/docs/commit, and rerun. Do not create a new branch per wakeup.
See the skill's [workflow](skills/persona-ux-optimizer/references/workflow.md),
[evidence and convergence](skills/persona-ux-optimizer/references/evidence-and-convergence.md), and
[safety and delivery](skills/persona-ux-optimizer/references/safety-and-delivery.md) references.

Pact covers every application-owned HTTP boundary: CLI-to-worker start, status, approval, and
report requests, plus Workflow-step-to-worker prepare, apply, and escalation-report requests. For
those boundaries the gate runs real Pact provider verification (`Verifier.verifyProvider()`)
against the actual `src/worker.ts` app on CI (Linux/x64, where Pact's native core is supported), so
a passing gate means the worker genuinely satisfies the recorded consumer interactions.

Three independent guards keep this gate from silently passing without verifying anything: each
provider test asserts the recorded pact file contains every expected interaction before calling
`Verifier.verifyProvider()`; `pnpm test:contract` finishes by running
`scripts/assert-contract-verified.ts` against the Vitest JSON report, which on a Pact-capable
platform (always true on CI) fails the build if zero tests ran or any test was skipped; and that
same script additionally requires `workflow-worker-provider.test.ts` and
`workflow-task-provider.test.ts` by name (see `REQUIRED_PROVIDER_VERIFICATION_FILES`) to be present
in the report with at least one fully-passing assertion each - so a vitest config or glob change
that silently dropped the real provider-verification suites from the run, while leaving the
consumer suites green, still fails the gate. All three checks are a no-op on unsupported local dev
platforms (win32/arm64) so local development is never blocked. See
`test/unit/scripts/assert-contract-verified.test.ts` for coverage of every branch.

### Third-party contract coverage

The Azure DevOps, GitHub, and Microsoft Graph Pact suites also exercise production adapters against
mock providers, but we do not own those APIs and cannot run provider verification against them from
this repository. Passing those suites proves our adapters send/parse the request and response
shapes they were written against; it is **not** evidence of live compatibility with the real
services, and their generated pacts must never be published to a broker or cited as `can-i-deploy`
evidence for a third-party provider. Each of those spec files documents this limitation inline.
Validate real drift with a controlled, human-reviewed run against a non-production organization or
tenant whenever an adapter or the targeted third-party API version changes; this is intentionally a
manual, judgment-based check rather than an automated gate, mirroring the `@manual
@external-behavior` BDD scenarios in `test/bdd/features/external-production-constraints.feature`.

### Author and review Pact tests with PactFlow tooling (optional)

Contributors who use GitHub Copilot can install the official SmartBear/PactFlow agent skills and MCP
server to help author and review the Pact suites. This is optional developer tooling. It is not
required to build, test, or run the CLI, and it does not change migration behavior.

Install the skills with the [skills.sh](https://skills.sh/) CLI or the
[`gh skill`](https://github.com/github/gh-skill) extension, which place the
[`pactflow/pactflow-agent-skills`](https://github.com/pactflow/pactflow-agent-skills) skills in the
GitHub Copilot discovery locations:

```bash
npx skills add pactflow/pactflow-agent-skills
# or
gh skill install pactflow/pactflow-agent-skills
```

To let the assistant talk to a PactFlow workspace or Pact Broker, add the official
[`@smartbear/mcp`](https://www.npmjs.com/package/@smartbear/mcp) server to your MCP client. Configure
it so the broker URL and token are prompted at runtime instead of being stored in the file. In VS
Code, add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "smartbear": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@smartbear/mcp@latest"],
      "env": {
        "PACT_BROKER_BASE_URL": "${input:pact_broker_base_url}",
        "PACT_BROKER_TOKEN": "${input:pact_broker_token}"
      }
    }
  },
  "inputs": [
    {
      "id": "pact_broker_base_url",
      "type": "promptString",
      "description": "PactFlow or Pact Broker base URL"
    },
    {
      "id": "pact_broker_token",
      "type": "promptString",
      "description": "PactFlow API token",
      "password": true
    }
  ]
}
```

Never commit `PACT_BROKER_BASE_URL`, `PACT_BROKER_TOKEN`, or an open-source broker's
username/password. For repository-local runs, route them through Varlock the same way as other
sensitive configuration: keep them as device-encrypted `varlock(prompt)` values in the git-ignored
`.env.local` rather than in any tracked file. Use `PACT_BROKER_USERNAME` and `PACT_BROKER_PASSWORD`
in place of the token for an open-source Pact Broker.

This repository provider-verifies its own owned boundaries: the CLI-to-worker and
Workflow-step-to-worker HTTP boundaries described above run real Pact provider verification
(`Verifier.verifyProvider()`) against `src/worker.ts` on CI. The consumer suites for Azure DevOps,
GitHub, and Microsoft Graph remain compatibility checks against mock providers (see
[Third-party contract coverage](#third-party-contract-coverage)) — those third-party providers never
verify the pacts this project generates and produce no provider-verification or `can-i-deploy`
evidence for them. This project does not currently publish pacts to a broker or run `can-i-deploy`.
Use the broker, publishing, provider-verification, and `can-i-deploy` tools above only against a
workspace where you have configured deployable pacticipants and provider verification.

### Repository layout

| Path | Purpose |
| --- | --- |
| `src/commands/` | `auth` and `migrate` CLI commands |
| `src/effect/` | Migration orchestration, schemas, services, and live Layers |
| `src/services/` | Azure DevOps, GitHub, and Microsoft Entra adapters |
| `sandbox/` | Synthetic migration scenarios and acceptance feature |
| `test/` | Unit, contract, integration, and BDD test suites |
| `skills/ado-to-github-teams/` | CLI operating Agent Skill and references |
| `skills/persona-ux-optimizer/` | Iterative persona UX optimizer skill, exact validator, checkpoint loop, and references |
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
