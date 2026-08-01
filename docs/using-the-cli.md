# Using the CLI

This guide covers installation, authentication, migration, recovery, and troubleshooting.

## Install

Install the public npm package globally:

```bash
npm install --global @msft-tkendrick/a2g@preview
a2g --help
```

Consumer installation is limited to those two commands. If the npm `preview` tag does not resolve,
the release is blocked; cloning, installing pnpm, building, or globally linking a source checkout is
contributor workflow and must not be presented as consumer installation.

The local World is the default and does not require Azure. Run `a2g world` before activating Azure
Durable Functions on deployed hosts. The command signs in through the existing Azure credential
chain, verifies enabled subscriptions, and records the Azure deployment preflight only after you
select one. If the account has no subscription, it records the local preference.

The package installs `a2g` as the primary executable and retains `ado-to-github-teams` as a
compatibility alias. This project is pre-release, so pin the version you evaluate in controlled
environments.

## Install from source

### Requirements

- Git
- Node.js 22.18 or later and earlier than Node.js 26
- Docker with Compose for the durable worker used by live migrations

Clone, set up, and inspect the current commands:

```bash
git clone https://github.com/MSFT-TKENDRICK/ado-to-github-teams.git
cd ado-to-github-teams
npm run setup
npm run dev -- --help
```

Examples in this guide use the installed `a2g` command. Contributors can use
`npm run dev -- <arguments>` from a source checkout without rebuilding or installing globally.

The `apps/cli` workspace is a staged package shell, not the active migration CLI.

## Record the deployment preference

The local preference is recorded by default and never invokes Azure authentication:

```bash
a2g world --local
```

Run `a2g world` and choose Azure only when you want the optional Azure backend. The command displays
the currently recorded preference, uses the existing Azure credential chain, lists enabled
subscriptions visible to that identity, and requires an explicit subscription choice. Successful
sign-in without an enabled subscription persists local execution instead. An inaccessible
`--subscription` value also fails closed to local.

The selection is stored in the user profile at `~/.ado-github-teams/world.json`; it is local
configuration and must not be committed. It is a deployment preflight record, not a live runtime
switch: independently deployed worker and Functions hosts do not read this file. Selection does not
create resources or deploy code. After a successful Azure preflight, deployment operators activate
Azure by setting `WORKFLOW_TARGET_WORLD=azure` and the required Azure settings on both hosts.

### Deploy the Azure World

Azure is the only supported cloud deployment target. A tagged prerelease contains an
`a2g-azure-functions-<version>.zip` source deployment package. Contributors can produce the same
artifact directory from source:

```bash
npm run azure:build
```

The build fails if Workflow compilation produces empty workflow or step registries. The resulting
`.azure-functions` directory contains the Azure Functions entrypoint, generated Workflow handlers,
`host.json`, and its deployment package manifest. It intentionally does not contain `node_modules`.

Build Azure deployment artifacts on Ubuntu x64, which is the release and CI build platform. The
Workflow compiler does not currently emit usable registries on Windows ARM64, so `npm run azure:build`
fails closed there; use the verified release ZIP instead of bypassing the bundle assertion.

Provision an Azure Functions app using Node.js 22, a storage account for Durable Functions, and a
remote libSQL-compatible database hosted on Azure. Both the migration worker and Function app must
use that same database; a process-local SQLite file is rejected because separate hosts would observe
different Workflow state. Apply the `@workflow-worlds/turso` schema to the remote database before
starting either host.

Deploy the ZIP to a Linux Functions app with Oryx remote build enabled. Set
`SCM_DO_BUILD_DURING_DEPLOYMENT=true` and `ENABLE_ORYX_BUILD=true` so Azure installs production
dependencies and matching Linux native bindings. Do not use the source ZIP with
`WEBSITE_RUN_FROM_PACKAGE=1` unless dependencies are added to it first.

Configure these settings through Azure app configuration or a secret manager:

| Setting                           | Purpose                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `WORKFLOW_TARGET_WORLD=azure`     | Explicitly selects the Azure World                                     |
| `AZURE_DURABLE_STARTER_URL`       | Function-key-protected `/api/workflow-world/queue` URL                 |
| `AZURE_WORLD_DATABASE_URL`        | Shared remote libSQL endpoint hosted on Azure                          |
| `AZURE_WORLD_DATABASE_AUTH_TOKEN` | Credential for the shared database                                     |
| `A2G_DEPLOYMENT_ID`               | Immutable identity used for routing and deduplication                  |
| `WORKFLOW_BASE_URL`               | Reachable migration-worker URL used by Workflow step callbacks         |
| `AzureWebJobsStorage`             | Azure Functions storage connection resolved by the Functions host      |
| `SCM_DO_BUILD_DURING_DEPLOYMENT`  | Set to `true` so Zip Deploy runs the Oryx dependency build             |
| `ENABLE_ORYX_BUILD`               | Set to `true` on Linux so native dependencies match the Functions host |

Never place function keys, database credentials, subscription identifiers, or tenant data in the
repository. `local.settings.example.json` contains only local emulator placeholders.

## Try the interactive sandbox

The sandbox keeps one terminal surface mounted from launch until you exit it. It resolves no
credentials and performs no provider writes.

```bash
a2g sandbox
a2g --sandbox happy-path
```

The surface renders a scenario list you drive with `↑`/`↓` (or `k`/`j`), `Home`/`End`, `g` for the
scenario contracts, `Enter` to start the highlighted scenario, `r` to reopen the last run result,
and `q`, `Esc`, or `Ctrl+C` to exit. A run takes over the same surface — the production migration
dashboard, approval prompts, reports, and recovery guidance are the interfaces used by a live
migration — and returns to the list when it completes or reaches its expected failure. The
alternate screen and cursor belong to the session: they are entered once at launch and restored
once at exit, never per scenario, and an approval prompt draws inside the same surface. Only the
ADO, Entra, and GitHub service Layers return predefined responses, so a scenario supplies
deterministic provider state rather than an alternate experience, and never advances the interface
on your behalf. Top-level `a2g --sandbox` always opens this surface; a supplied scenario only
preselects a list entry and never starts on its own. The surface requires an interactive terminal;
without one the command exits 2 and points at the one-shot form below.

Run `a2g sandbox --help` to see every scenario's ID, mode, description, and predetermined service
result generated directly from the bundled catalog. The same catalog is available as a concise list:

```bash
a2g --list-sandbox-scenarios
```

For automation or a focused reproduction, keep the one-shot form:

```bash
a2g migrate --sandbox happy-path
a2g migrate --sandbox apply-happy-path --apply
```

Apply scenarios show the real approval interface. Add `--yes` only to a one-shot sandbox run when
you intentionally want the catalog's predefined approval decisions instead of prompts. `--yes`
never authorizes live writes. Individual scenario checkpoints are isolated and removed after each
run; the interactive surface stays mounted, but sandbox migrations cannot be resumed.

## Prepare a live migration

### Access

Use dedicated, least-privilege identities:

| Provider           | Access                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure DevOps       | Read projects, teams, members, users, and groups                                                                                                           |
| Microsoft Entra ID | `User.Read.All` and `GroupMember.Read.All`, or equivalent application permissions                                                                          |
| GitHub             | Read organization, team, repository, and team-sync metadata; create teams; manage memberships; and administer listed repositories when using topology mode |

Authorize the GitHub credential for the target organization when SAML SSO is enforced.

### Authentication

The CLI prefers identities already available on the host:

1. Azure workload, managed, or service-principal identity.
2. Visual Studio Code, Azure CLI, Azure PowerShell, or Azure Developer CLI sign-in.
3. The default Windows work account.
4. `GH_TOKEN` or `GITHUB_TOKEN`, then the current `gh auth` login.
5. Interactive browser or device authorization in an interactive terminal.

For local use, sign in with an Azure developer tool and GitHub CLI, then diagnose access:

```bash
az login
gh auth login
a2g auth --ado-org https://dev.azure.com/contoso
```

`Connect-AzAccount` or `azd auth login` can replace `az login`. For automation, prefer federated
workload identity or managed identity with a short-lived GitHub token. `ADO_PAT` is an explicit
Azure DevOps fallback.

The human-readable result reports each provider's readiness, credential source, non-secret reason,
and remediation. Omit `--ado-org` only when intentionally skipping Azure DevOps validation. For a
stable, non-interactive readiness document:

```bash
a2g auth --ado-org https://dev.azure.com/contoso --json
```

JSON mode disables browser and device fallback, writes one schema-version 1 document to stdout, and
exits nonzero when a planned provider is not ready. Use `--quiet` for exit-status-only successful
human checks. `--json` and `--quiet` are mutually exclusive.

The repository declares configuration in [`.env.schema`](../.env.schema). Keep local sensitive
overrides as device-encrypted `varlock(prompt)` values in the ignored `.env.local`; never store
plaintext credentials in repository files, reports, or commands.

### Start the durable worker

A live migration requires the local worker. Configure two different random values of at least 32
characters:

```dotenv
WORKFLOW_API_TOKEN=varlock(prompt)
WORKFLOW_TASK_SECRET=varlock(prompt)
```

Encrypt the values and start the Compose stack:

```bash
npm exec -- varlock load
npm exec -- varlock run --inject vars -- docker compose up --build -d
```

The worker becomes available at `http://127.0.0.1:7331`. The Compose configuration is a
single-host deployment with local durable state and backup. See [Architecture](architecture.md)
before adapting it for production.

## Run a migration

### Build commands from flag groups

`migrate --help` groups the full flag surface by task and includes valid live, recovery, topology,
and sandbox combinations. The three live-scope values are required together:

| Task group          | Flags                                                                                                 | Contract                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live scope          | `--ado-org`, `--ado-project`, `--github-org`                                                          | Provide all three for a new live run. The task aliases are `--source-org`, `--source-project`, and `--target-org`; use one spelling per value.       |
| Execution           | `--apply`, `--foreground`, `--concurrency`                                                            | Dry-run is the default. Concurrency is a positive integer with default `4`.                                                                          |
| Recovery            | `--resume`, `--fresh`, `--sessions`                                                                   | Resume preserves retained scope and conflicts with fresh or sandbox execution.                                                                       |
| Presentation        | `--output`, `--detail guided\|compact`                                                                | Report path and human detail do not change the migration plan.                                                                                       |
| Naming and topology | `--prefix`, `--suffix`, `--team-topology`                                                             | Topology names are exact and exclude prefix or suffix modifiers.                                                                                     |
| Worker              | `--worker-url`                                                                                        | Selects the durable worker endpoint; it does not alter migration scope.                                                                              |
| Sandbox             | `sandbox`, `--scenario`, `migrate --sandbox`, `--sandbox-config`, `--list-sandbox-scenarios`, `--yes` | Top-level `--sandbox [scenario]` mounts the interactive surface and only preselects a list entry. Explicit `migrate --sandbox <scenario>` runs once. |

Canonical and task-shaped scope names resolve to the same command input and therefore the same
preflight, worker request, checkpoint configuration, approval context, and report. For example:

```bash
a2g migrate \
  --source-org https://dev.azure.com/contoso \
  --source-project Platform \
  --target-org contoso \
  --foreground
```

Named persisted scope profiles are not supported. This avoids selecting a stale tenant target
implicitly. A retained durable session is the only scope-reuse path: no-argument reopen or
`--resume` uses its validated checkpoint scope, while `--fresh` requires a complete explicit scope.
Do not create or commit repository-local files containing organization or project identifiers.

### 1. Generate a dry run

Omit `--apply`:

```bash
a2g migrate \
  --ado-org https://dev.azure.com/contoso \
  --ado-project Platform \
  --github-org contoso \
  --foreground
```

In PowerShell, use one line or PowerShell backticks:

```powershell
node .\bin\run.js migrate --ado-org https://dev.azure.com/contoso --ado-project Platform --github-org contoso --foreground
```

Without `--foreground`, the command queues the run, prints its ID, and returns. Reopen the CLI to
check progress. The example waits for completion so the report is ready to review:

- target organizations and project;
- proposed team names and slugs;
- mapped and unmapped members;
- skipped identities and edge cases;
- failures and recovery actions.

The default output is `migration-report-<run-id>.md`. The parent of a custom `--output` path must
already exist, and an existing file is overwritten.

Optional `--prefix`, `--suffix`, and `--concurrency` values must be reviewed as part of the plan.
Use `--detail compact` for scan-friendly output instead of the default guided presentation.

### 2. Apply the reviewed plan

Run the same scope and naming options with `--apply`:

```bash
a2g migrate \
  --ado-org https://dev.azure.com/contoso \
  --ado-project Platform \
  --github-org contoso \
  --apply \
  --foreground
```

Discovery runs again against current provider state. The workflow pauses before writes and shows
the exact persisted team and member changes. The operator must approve those changes in the CLI.
`--yes` is rejected outside sandbox mode.

Existing matching teams and active memberships are handled idempotently. Membership changes for
IdP-synchronized teams are skipped and reported; manage those memberships in the identity
provider.

## Collaborate on migration plans

After a run reaches `dry-run` or a later phase, export its materialized operations through the
authenticated worker:

```bash
a2g plan:export --run-id <run-id> --output ./base.plan.json
```

Plan artifacts contain stable team, GitHub login, repository, and source-system identifiers. They
exclude credentials, approvals, completion ledgers, failures, and runtime-assigned GitHub IDs, but
remain sensitive operational data. Keep them private and do not commit them.

Use an explicit common base when two developers or agents produce alternatives:

```bash
a2g plan:merge \
  --base ./base.plan.json \
  --left ./developer-a.plan.json \
  --right ./developer-b.plan.json \
  --output ./merged.plan.json \
  --conflicts ./merge-conflicts.json
```

Disjoint and identical edits merge automatically. A same-operation add/add, modify/modify, or
delete/modify difference writes the conflict document and exits with status 2. Resolve it by adding
`"resolution": "left"` or `"resolution": "right"` to every conflict entry, then rerun with
`--resolutions ./merge-conflicts.json`. Resolutions can select only a proposed side; they cannot
inject a third operation.

Hash-guarded patches are useful for transporting one alternative:

```bash
a2g plan:diff \
  --base ./base.plan.json \
  --alternative ./developer-a.plan.json \
  --output ./developer-a.patch.json

a2g plan:apply \
  --base ./base.plan.json \
  --patch ./developer-a.patch.json \
  --output ./developer-a-rebuilt.plan.json
```

All commands refuse incompatible schema, configuration, topology, source snapshot, or policy
metadata. Patches also refuse stale per-operation preconditions. Output paths must not already
exist.

Merged artifacts are review and collaboration inputs in this release; they are deliberately not
imported into a running checkpoint or applied directly to GitHub. Importing would otherwise carry
unverified destination state or bypass approval. Re-run discovery against current providers and
approve the exact persisted live plan before writes.

For a local worker database outside Compose, `plan:export` also accepts
`--checkpoint-db <path-to-workflow.db>`. Normal Compose operation should use the worker API.

## Define an explicit team topology

Flat migration creates one GitHub team for each selected Azure DevOps team. Use
`--team-topology` only when a reviewed hierarchy and repository grants are required.

```yaml
version: 1
organizationalUnit:
  name: Engineering
  description: Structural Engineering team
projectTeam:
  name: Payments
repositories:
  - repository: payments-api
    teamName: Payments API Contributors
    sourceAdoTeams:
      - Payments Contributors
      - API Maintainers
    role: write
```

Run a dry run first:

```bash
a2g migrate \
  --ado-org https://dev.azure.com/contoso \
  --ado-project Payments \
  --github-org contoso \
  --team-topology ./payments-topology.yaml
```

Topology mode creates structural organization-unit and project teams, plus one leaf team per
repository entry. Only leaf teams receive migrated members and direct repository roles. Supported
roles are `read`, `triage`, `write`, `maintain`, and `admin`; `admin` also requires
`allowAdmin: true`.

Topology names are exact, so `--prefix` and `--suffix` cannot be combined with
`--team-topology`. The CLI rejects cross-organization repositories, duplicate mappings, missing or
archived repositories, incompatible existing parents, synchronized teams that cannot be nested,
permission downgrades, and grants below the organization's base permission.

Do not use nested topology for IdP-synchronized entitlement teams. GitHub does not allow a team
connected to an IdP group to be a parent or child team. See
[ADR 0002](decisions/0002-explicit-team-topology.md) for the decision and access-model limitations.

## Resume and manage sessions

Durable session state is stored by the worker. Running the CLI without arguments reopens the latest
compatible session:

```bash
a2g
```

List retained sessions before selecting a specific interrupted or blocked run:

```bash
a2g sessions
a2g sessions --blocked
a2g sessions --blocked --select
```

Use `--resume <run-id>` with the original scope and options to select a retained run explicitly.
Use `--fresh` with a complete scope when a new run is required instead of reopening a compatible
session.

Resume can continue a previously approved write phase. Treat it as destructive when the selected
run had `--apply`; verify the source, target, topology digest, and naming options, then obtain fresh
operator approval. Do not edit the workflow database or reconstruct state from a report.

## Discover commands

Root help is organized by operator task and includes safe starting commands. It also explains that
running the CLI without arguments reopens the latest compatible durable migration:

```bash
a2g --help
```

The task map covers:

| Goal                            | Starting command                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| Preview a migration safely      | `a2g migrate --ado-org <url> --ado-project <project> --github-org <org> --foreground` |
| Check provider credentials      | `a2g auth --ado-org <url>`                                                            |
| Reopen the latest migration     | `a2g`                                                                                 |
| Resolve blocked sessions        | `a2g sessions --blocked --select`                                                     |
| Try the CLI without credentials | `a2g --sandbox happy-path`                                                            |

The optional top-level scenario only preselects a list entry; this starting command mounts an
interactive surface that stays visible until you press `q`, `Esc`, or Ctrl+C, and it starts nothing
until you press Enter.

Use command help for the full installed flag reference:

```bash
a2g migrate --help
a2g auth --help
a2g sessions --help
a2g plan:merge --help
```

Unknown-command recovery points back to the task map and safe preview/reopen examples. Completed
migrations print valid next commands alongside the run ID and report path; a completed dry run
prints the same reviewed scope as an apply command rather than requiring manual reconstruction.
Unknown commands also exit 2 before oclif command loading and print the task-help, safe-preview, and
no-argument reopen routes on stderr.

Migration command preflight validates flag dependencies and exclusions, sandbox mode, complete
scope for new runs, positive concurrency, and live noninteractive readiness before worker or
provider access. Root help exits 0. Invalid migration input exits 2 on stderr with a
`MigrationCommandPreflightFailure` technical detail and a `Valid command:` line that preserves
compatible values and removes or supplies the conflicting value. It never starts a worker session,
creates a checkpoint, or performs provider reads after a preflight failure. Runtime, provider,
authentication, and failed-readiness errors remain exit 1 unless a command documents a more
specific contract.

The source/target aliases do not create a second precedence layer or persisted profile. They are
equivalent spellings for the canonical scope flags, and rejected commands continue to render the
canonical, non-secret `Valid command:` shape.

## Agent-assisted operation

Install the repository as a GitHub Copilot CLI plugin:

```bash
copilot plugin install MSFT-TKENDRICK/ado-to-github-teams
```

Or install only the portable Agent Skill:

```bash
npx skills add MSFT-TKENDRICK/ado-to-github-teams --skill ado-to-github-teams
```

The skill adds task routing and approval guidance; it does not replace the migration CLI.

## Troubleshooting

- **A flag is rejected:** run the `Valid command:` shape printed by preflight, or use the current
  command's `--help` output.
- **Live scope is missing:** provide `--ado-org`, `--ado-project`, and `--github-org`.
- **Custom report fails:** create the output directory first.
- **Worker is unavailable:** confirm the Compose worker is healthy and that `WORKFLOW_API_TOKEN`
  is available to both the CLI and worker.
- **Resume is rejected:** use the same scope, apply mode, topology, prefix, and suffix as the
  retained run, or start a new dry run with `--fresh`.
- **A synchronized team is skipped:** change its membership in the identity provider.

Open a [GitHub issue](https://github.com/MSFT-TKENDRICK/ado-to-github-teams/issues) for reproducible
problems without including sensitive migration data.
