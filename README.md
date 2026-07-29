# ado-to-github-teams

`ado-to-github-teams` is a production-focused CLI for migrating Azure DevOps (ADO) project teams into GitHub organization teams, including identity mapping from Entra-backed ADO members to GitHub Enterprise Managed Users (GHEMU).

The tool is designed for risky migrations: dry-run first, exact-plan approval, durable Vercel Workflow execution, healing/retry behavior, and a Markdown run report with edge-case recommendations.

## Architecture (Effect-based)

The runtime is structured around `effect` services (`Context.Tag`) and composable Layers:

- **Auth service** (credential resolution + validation)
- **ADO/GitHub/Entra services** (thin adapters over SDK/API clients)
- **Checkpoint store** (schema-validated persistence)
- **Approval service** (interactive/CI-safe approval gates)
- **Report writer** (deterministic Markdown output)

Core orchestration runs as an Effect pipeline (`runEffectMigration`) inside Vercel Workflow steps, with explicit phases, bounded concurrency, typed failures (`Data.TaggedError`), and interruption-safe checkpoint flushing.

The default self-hosted World is local-first:

- Workflow runs, streams, hooks, and migration checkpoints share a SQLite database.
- NATS JetStream delivers workflow and step work with bounded redelivery.
- Litestream continuously replicates SQLite to a NATS JetStream Object Store bucket.
- Docker named volumes preserve SQLite WAL locking semantics and JetStream state.
- Remote World modules are disabled unless `WORKFLOW_ALLOW_REMOTE_TARGET=true`.

### Live vs test layer composition

- **Live CLI runs**: compose auth + SDK adapters + checkpoint/report filesystem layers.
- **Tests**: provide in-memory service layers for deterministic, credential-free execution.

## Install

```bash
npm install -g ado-to-github-teams
```

## Quickstart

Start the local durable worker:

```bash
cp .env.example .env
# Replace both example secrets with independent random values of at least 32 characters.
docker compose up --build -d
```

Export the same API token in the shell that runs the CLI:

```bash
export WORKFLOW_API_TOKEN="<same value as .env>"
```

Run a dry-run migration (default mode):

```bash
ado-to-github-teams migrate \
  --ado-org https://dev.azure.com/contoso \
  --ado-project Platform \
  --github-org contoso
```

Apply the migration:

```bash
ado-to-github-teams migrate \
  --ado-org https://dev.azure.com/contoso \
  --ado-project Platform \
  --github-org contoso \
  --apply
```

## CLI flags

| Flag | Required | Description |
| --- | --- | --- |
| `--ado-org` | Yes | Azure DevOps organization URL |
| `--ado-project` | Yes | Azure DevOps project name |
| `--github-org` | Yes | GitHub organization name |
| `--apply` | No | Execute write operations (default is dry-run) |
| `--output` | No | Markdown report output path (default: `./migration-report-<runId>.md`) |
| `--prefix` | No | Prefix for generated GitHub team names |
| `--suffix` | No | Suffix for generated GitHub team names |
| `--yes` | No | Auto-approve non-destructive prompts in CI |
| `--resume` | No | Reattach to an existing durable migration run ID |
| `--concurrency` | No | Maximum concurrent mapping requests (default: `4`) |
| `--worker-url` | No | Durable worker URL (default: `http://127.0.0.1:7331`) |

## Authentication flow

Credential resolution order is:

1. Environment variables
2. `~/.ado-github-teams/config.json`
3. Device flow fallback

### Environment variables

| Credential | Variable |
| --- | --- |
| ADO token | `ADO_PAT` |
| GitHub token | `GITHUB_PAT` |
| Entra client ID | `ENTRA_CLIENT_ID` |
| Entra client secret | `ENTRA_CLIENT_SECRET` |
| Entra tenant ID | `ENTRA_TENANT_ID` |

### Configure and validate credentials

```bash
ado-to-github-teams auth --ado-org https://dev.azure.com/contoso
```

This command validates loaded credentials with lightweight API calls.

### Device flow fallback

- **ADO/Entra**: MSAL device code flow
- **GitHub**: GitHub device flow (`/login/device/code`)

When no Entra client secret is provided, interactive device flow is used as fallback.

## Durable state, approval, and resume

Migration checkpoints and Workflow state are transactionally stored in SQLite. The local Compose stack uses `/data/workflow.db` in the `workflow-data` named volume. Litestream restores the database only when it is absent, runs a full integrity check before worker startup, then replicates it to the configured JetStream Object Store bucket.

An apply run suspends after planning. The CLI displays the exact persisted teams and member assignments, then records an immutable approval decision before resuming the Workflow hook. Replayed approval requests are accepted only when the actor, comment, and decision are identical.

The CLI prints its client-generated run ID before requesting a Workflow start. If the connection drops during startup, retain that ID and reattach:

```bash
ado-to-github-teams migrate \
  --ado-org https://dev.azure.com/contoso \
  --ado-project Platform \
  --github-org contoso \
  --apply \
  --resume 7a4c8f4e-f7f2-4bc5-b3d0-a5d2e6f5f8b1
```

`--resume` never creates another Workflow generation. Workflow delivery also repairs a missing migration-to-Workflow link before executing work, closing the process-crash window after queue publication. Resume rejects incompatible schema or migration configuration. Completed teams and member assignments are skipped; team creation is verified remotely before a retry and membership uses GitHub's idempotent `PUT`.

### Local and remote World configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WORKFLOW_SQLITE_PATH` | `~/.ado-github-teams/workflow.db` | SQLite state database |
| `WORKFLOW_NATS_URLS` | `nats://127.0.0.1:4222` | Comma-separated JetStream servers |
| `WORKFLOW_BASE_URL` | `http://127.0.0.1:7331` | Public worker URL |
| `WORKFLOW_NATS_CONCURRENCY` | `10` | Bounded queue concurrency |
| `LITESTREAM_NATS_URL` | `nats://nats:4222` in Compose | Replication server |
| `LITESTREAM_NATS_BUCKET` | `migration_backups` | Object Store bucket |

To use another Workflow World, set `WORKFLOW_TARGET_WORLD` to its module target and explicitly set `WORKFLOW_ALLOW_REMOTE_TARGET=true`. Local mode remains the default when no target is configured.

## Edge case guide

| EdgeCaseReason | Meaning | Recommendation |
| --- | --- | --- |
| `no-ghemu-account` | No GitHub Enterprise Managed User matched the identity email/UPN | Invite user to GitHub org as GHEMU user |
| `guest-user` | Entra identity is a guest account | Guest accounts cannot be GHEMU users; create a GitHub.com account manually |
| `suspended-account` | GitHub account exists but is suspended | Reactivate user in GitHub before migrating |
| `ambiguous-match` | Multiple GitHub users match the same email | Specify login manually |
| `missing-email` | No valid email available for mapping | Add email to Entra profile |
| `circular-group-member` | Circular group nesting was detected | Remove circular Entra reference before migration |
| `entra-role-only` | Identity appears to be service/role-backed, not a user | Create GitHub bot/team equivalent manually |
| `ado-project-role` | ADO project role has no direct GitHub equivalent | Assign GitHub maintainer/admin role manually |
| `nested-group-skipped` | Nested groups exceeded depth limit or could not be flattened | Enumerate nested group members manually |

## Failure mode reference

| FailureMode | Trigger | Healing behavior |
| --- | --- | --- |
| `RATE_LIMITED` | HTTP 429 | Retry with backoff / Retry-After |
| `TOKEN_EXPIRED` | HTTP 401 | Token refresh path + retry |
| `TEAM_NAME_CONFLICT` | Team create validation/conflict | Generate alternative slug with approval |
| `PARTIAL_FAILURE` | Partial write/update failure | Skip failed item and continue |
| `USER_SUSPENDED` | Suspended target user | Skip user assignment |
| `CIRCULAR_GROUP` | Group cycle detected | Skip problematic group branch |
| `SSO_ENFORCEMENT` | GitHub 403 + SSO header | Explicit approval to skip/continue |
| `NETWORK_ERROR` | Transient network failure | Retry |
| `PERMISSION_DENIED` | HTTP 403 (non-SSO) | Abort migration |
| `NOT_FOUND` | HTTP 404 | Skip missing item |
| `VALIDATION_ERROR` | HTTP 400/422 | Skip invalid item |
| `UNKNOWN` | Unclassified failure | Abort migration |

## Reports

Each run emits a Markdown report with:

1. Run summary
2. Mapped teams
3. Member mapping details
4. Edge cases
5. Skipped items
6. Failure log
7. Approval history

## PACT contract tests

Contract tests are under `test/contract` and generate pact files at `test/contract/pacts/`. They cover every application-owned HTTP boundary: CLI-to-worker start/status/approval/report and Workflow-step-to-worker prepare/apply. NATS, Litestream, and Workflow SDK calls use their upstream protocol contracts rather than application-owned PACT providers.

Run contract tests:

```bash
pnpm test:contract
```

Run all tests:

```bash
pnpm test
```

Effect-focused tests include:

- tagged error classification
- retry policy behavior
- malformed schema decode rejection
- cancellation checkpoint flush
- bounded concurrency and destructive approval invariants

## Development

```bash
pnpm install
pnpm build
pnpm test
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution guidance and [`SECURITY.md`](SECURITY.md) for security reporting.

## Contributing

1. Fork and create a feature branch.
2. Add or update tests for your changes.
3. Run `pnpm build && pnpm test`.
4. Open a pull request with migration context and risk notes.
