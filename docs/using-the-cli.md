# Using the CLI

This guide covers installation, authentication, migration, recovery, and troubleshooting. The
project is pre-release and does not currently publish a GitHub release package, so run it from a
source checkout.

## Install from source

### Requirements

- Git
- Node.js 22.18 or later and earlier than Node.js 26
- pnpm 10.34.5 through Corepack
- Docker with Compose for the durable worker used by live migrations

Clone, install, build, and inspect the current commands:

```bash
git clone https://github.com/MSFT-TKENDRICK/ado-to-github-teams.git
cd ado-to-github-teams
corepack enable
pnpm install --frozen-lockfile
pnpm build
node bin/run.js --help
```

Examples in this guide use `node bin/run.js`. After changing TypeScript source, rebuild before
using that entry point. Contributors can use `pnpm dev -- <arguments>` while developing.

The `apps/cli` workspace is a staged package shell, not the active migration CLI.

## Try the sandbox

The sandbox runs the migration orchestration against synthetic provider responses. It resolves no
credentials and performs no provider writes.

```bash
node bin/run.js --list-sandbox-scenarios
node bin/run.js --sandbox happy-path
```

The generated report is prominently marked `SANDBOX` and includes the simulated boundary
transcript. To exercise approval and resumability behavior with simulated writes:

```bash
node bin/run.js --sandbox apply-happy-path --apply --yes
```

`--yes` skips interactive prompts and applies the scenario's predefined approval decisions. It
works only in sandbox mode, where provider writes are simulated, and never authorizes live writes.
Sandbox runs cannot be resumed.

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
node bin/run.js auth --ado-org https://dev.azure.com/contoso
```

`Connect-AzAccount` or `azd auth login` can replace `az login`. For automation, prefer federated
workload identity or managed identity with a short-lived GitHub token. `ADO_PAT` is an explicit
Azure DevOps fallback.

The human-readable result reports each provider's readiness, credential source, non-secret reason,
and remediation. Omit `--ado-org` only when intentionally skipping Azure DevOps validation. For a
stable, non-interactive readiness document:

```bash
node bin/run.js auth --ado-org https://dev.azure.com/contoso --json
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
pnpm exec varlock load
pnpm exec varlock run --inject vars -- docker compose up --build -d
```

The worker becomes available at `http://127.0.0.1:7331`. The Compose configuration is a
single-host deployment with local durable state and backup. See [Architecture](architecture.md)
before adapting it for production.

## Run a migration

### Build commands from flag groups

`migrate --help` groups the full flag surface by task and includes valid live, recovery, topology,
and sandbox combinations. The three live-scope values are required together:

| Task group          | Flags                                                                | Contract                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Live scope          | `--ado-org`, `--ado-project`, `--github-org`                         | Provide all three for a new live run. The task aliases are `--source-org`, `--source-project`, and `--target-org`; use one spelling per value. |
| Execution           | `--apply`, `--foreground`, `--concurrency`                           | Dry-run is the default. Concurrency is a positive integer with default `4`.                                                                    |
| Recovery            | `--resume`, `--fresh`, `--sessions`                                  | Resume preserves retained scope and conflicts with fresh or sandbox execution.                                                                 |
| Presentation        | `--output`, `--detail guided\|compact`                               | Report path and human detail do not change the migration plan.                                                                                 |
| Naming and topology | `--prefix`, `--suffix`, `--team-topology`                            | Topology names are exact and exclude prefix or suffix modifiers.                                                                               |
| Worker              | `--worker-url`                                                       | Selects the durable worker endpoint; it does not alter migration scope.                                                                        |
| Sandbox             | `--sandbox`, `--sandbox-config`, `--list-sandbox-scenarios`, `--yes` | Uses simulated providers. `--yes` never authorizes live writes.                                                                                |

Canonical and task-shaped scope names resolve to the same command input and therefore the same
preflight, worker request, checkpoint configuration, approval context, and report. For example:

```bash
node bin/run.js migrate \
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
node bin/run.js migrate \
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
node bin/run.js migrate \
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
node bin/run.js plan:export --run-id <run-id> --output ./base.plan.json
```

Plan artifacts contain stable team, GitHub login, repository, and source-system identifiers. They
exclude credentials, approvals, completion ledgers, failures, and runtime-assigned GitHub IDs, but
remain sensitive operational data. Keep them private and do not commit them.

Use an explicit common base when two developers or agents produce alternatives:

```bash
node bin/run.js plan:merge \
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
node bin/run.js plan:diff \
  --base ./base.plan.json \
  --alternative ./developer-a.plan.json \
  --output ./developer-a.patch.json

node bin/run.js plan:apply \
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
node bin/run.js migrate \
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
node bin/run.js
```

List retained sessions before selecting a specific interrupted or blocked run:

```bash
node bin/run.js sessions
node bin/run.js sessions --blocked
node bin/run.js sessions --blocked --select
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
node bin/run.js --help
```

The task map covers:

| Goal                            | Starting command                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| Preview a migration safely      | `node bin/run.js migrate --ado-org <url> --ado-project <project> --github-org <org> --foreground` |
| Check provider credentials      | `node bin/run.js auth --ado-org <url>`                                                            |
| Reopen the latest migration     | `node bin/run.js`                                                                                 |
| Resolve blocked sessions        | `node bin/run.js sessions --blocked --select`                                                     |
| Try the CLI without credentials | `node bin/run.js --sandbox happy-path`                                                            |

Use command help for the full installed flag reference:

```bash
node bin/run.js migrate --help
node bin/run.js auth --help
node bin/run.js sessions --help
node bin/run.js plan:merge --help
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
