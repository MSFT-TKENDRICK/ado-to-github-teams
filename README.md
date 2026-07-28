# ado-to-github-teams

`ado-to-github-teams` is a production-focused CLI for migrating Azure DevOps (ADO) project teams into GitHub organization teams, including identity mapping from Entra-backed ADO members to GitHub Enterprise Managed Users (GHEMU).

The tool is designed for risky migrations: dry-run first, explicit approval checkpoints, resumable checkpoints, healing/retry behavior, and a Markdown run report with edge-case recommendations.

## Architecture (Effect-based)

The runtime is structured around `effect` services (`Context.Tag`) and composable Layers:

- **Auth service** (credential resolution + validation)
- **ADO/GitHub/Entra services** (thin adapters over SDK/API clients)
- **Checkpoint store** (schema-validated persistence)
- **Approval service** (interactive/CI-safe approval gates)
- **Report writer** (deterministic Markdown output)

Core orchestration runs as an Effect pipeline (`runEffectMigration`) with explicit phases, bounded concurrency, typed failures (`Data.TaggedError`), and interruption-safe checkpoint flushing.

### Live vs test layer composition

- **Live CLI runs**: compose auth + SDK adapters + checkpoint/report filesystem layers.
- **Tests**: provide in-memory service layers for deterministic, credential-free execution.

## Install

```bash
npm install -g ado-to-github-teams
```

### Agent skill and GitHub Copilot plugin

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

The skill uses progressive disclosure for repository installation, authentication, dry-run and
apply operations, interrupted-session recovery, and user feedback and approval gates.

## Quickstart

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
| `--resume` | No | Resume from checkpoint run ID |

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

## Checkpoints and resume

Checkpoint files are saved under:

```text
~/.ado-github-teams/checkpoints/<runId>.json
```

Resume a failed/incomplete migration:

```bash
ado-to-github-teams migrate \
  --ado-org https://dev.azure.com/contoso \
  --ado-project Platform \
  --github-org contoso \
  --apply \
  --resume 7a4c8f4e-f7f2-4bc5-b3d0-a5d2e6f5f8b1
```

The runner skips already completed teams/member assignments from checkpoint state.

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

Contract tests are under `test/contract` and generate pact files at `test/contract/pacts/`.

Run contract tests:

```bash
npm run test:contract
```

Run all tests:

```bash
npm test
```

Effect-focused tests include:

- tagged error classification
- retry policy behavior
- malformed schema decode rejection
- cancellation checkpoint flush
- bounded concurrency and destructive approval invariants

## Development

```bash
npm install
npm run build
npm test
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution guidance and [`SECURITY.md`](SECURITY.md) for security reporting.

## Contributing

1. Fork and create a feature branch.
2. Add or update tests for your changes.
3. Run `npm run build && npm test`.
4. Open a pull request with migration context and risk notes.
