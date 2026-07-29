# CLI operations

Use this reference for authentication, dry runs, apply runs, and reports.

Set `CLI` conceptually to `node bin/run.js` for a repository checkout or `ado-to-github-teams` for an explicitly approved global install.

## Discover current syntax

Before constructing a command, use the installed version's help:

```bash
node bin/run.js --help
node bin/run.js auth --help
node bin/run.js migrate --help
```

Prefer help output over remembered flags if the checkout differs from this reference.

## Credentials

Credential resolution order is:

1. Environment variables
2. `~/.ado-github-teams/config.json`
3. Interactive device flow

Supported environment variables include `ADO_PAT`, `GITHUB_PAT`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, and `ENTRA_TENANT_ID`.

The current CLI persists resolved credentials, including credentials sourced from environment variables or device flow, to `~/.ado-github-teams/config.json`. Tell the user this before the first `auth` or `migrate` command and obtain approval for that local credential persistence. Never read or display credential values.

Failed write recovery uses the GitHub Copilot SDK with the currently authenticated Copilot CLI user.
There is no separate Copilot token setting. Before a live migration, verify the operator has an
authenticated Copilot CLI session without requesting or displaying its credentials.

Validate credentials interactively:

```bash
node bin/run.js auth --ado-org https://dev.azure.com/ORG
```

If device flow is required, keep the terminal visible and let the user complete browser authorization and secret prompts. Do not ask the user to paste a token or secret into chat.

## Dry run

Run without `--apply`:

```bash
node bin/run.js migrate --ado-org https://dev.azure.com/ORG --ado-project PROJECT --github-org GITHUB_ORG
```

A dry run performs remote reads, identity resolution, local checkpoint writes, and local report output. It does not create teams or assign members. A team-name conflict can still require user feedback to choose a proposed alternate slug.

Omit `--output` to use the unique `migration-report-<runId>.md` default. If the user requests a
custom path, check that it does not already exist before running because the CLI overwrites an
existing file.

Use `--concurrency` only when the user or an observed service limit requires tuning. The default is
`4`, and values below `1` are normalized to `1`.

After completion, inspect and summarize:

- exact ADO and GitHub targets;
- generated GitHub team names and slugs;
- mapped and unmapped member counts;
- every edge case and recommended remediation;
- failures and skipped items;
- output report path.

Retrieve the user's feedback. Do not advance to apply while ambiguous identities, unacceptable names, unexpected scope, or unresolved failures remain.

## Apply

Apply only after a completed, reviewed dry run and fresh approval of the exact proposed changes:

```bash
node bin/run.js migrate --ado-org https://dev.azure.com/ORG --ado-project PROJECT --github-org GITHUB_ORG --apply
```

Carry over reviewed `--prefix` and `--suffix` values exactly. A fresh apply run re-reads source and target state, so call out material differences from the reviewed dry run before accepting a write prompt.

Run apply commands in an interactive terminal. The CLI separately asks before:

- creating the proposed GitHub teams;
- assigning the proposed members;
- using an alternate slug for a name conflict;
- skipping an item blocked by GitHub SSO enforcement;
- applying an inferred skip or an ambiguous recovery recommendation.

Never synthesize input, pipe `yes`, or accept these prompts for the user. `--yes` only applies to actions explicitly marked non-destructive; omit it unless the user has a specific CI need.

Copilot recovery reasoning receives categorized operation metadata, not identity names or raw
provider errors. It may automatically authorize one retry only for a transient, checkpointed,
idempotent membership write. It never retries team creation. If inference is unavailable,
malformed, or conflicts with local safety checks, fail closed or elicit an explicit operator
decision; do not infer approval from the model response.

## Reports and completion

The report contains mappings, edge cases, skipped items, failure history, and approval history. Treat it as potentially sensitive tenant data.

A run is complete only when the command succeeds and reports its output path. On successful completion, the CLI removes its checkpoint. If the command fails or is interrupted, follow [resume](resume.md).
