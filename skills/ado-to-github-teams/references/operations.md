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

1. Azure workload, managed, or service-principal environment credentials
2. Visual Studio Code, Azure CLI, Azure PowerShell, or Azure Developer CLI identity
3. The default Windows broker account, including the domain-joined work account
4. `GH_TOKEN`/`GITHUB_TOKEN`, then the current `gh auth` login
5. Interactive browser and device authorization when a terminal is interactive

Prefer `az login` (or `Connect-AzAccount`/`azd auth login`) plus `gh auth login` for local use.
For CI, prefer federated workload identity with `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and
`AZURE_FEDERATED_TOKEN_FILE`, plus a short-lived `GH_TOKEN`. Client secrets and `ADO_PAT` are
compatibility fallbacks only.

The CLI does not persist plaintext credentials. `~/.ado-github-teams/config.json` contains only
non-secret preferences, while interactive Azure tokens use the operating system's encrypted cache.
Legacy plaintext credential fields are removed on first load. Never read or display credential
values.

In a repository checkout, use `.env.schema` as the configuration source of truth and run commands
through Varlock. Store local sensitive overrides only as device-encrypted `varlock(...)` values in
the git-ignored `.env.local`; never ask the user to put plaintext credentials in `.env` files.

Failed write recovery uses the GitHub Copilot SDK with the currently authenticated Copilot CLI user
on the worker host. There is no separate Copilot token setting. Before a live migration, verify the
worker runs with an authenticated Copilot CLI session without requesting or displaying its
credentials.

Validate credentials interactively:

```bash
node bin/run.js auth --ado-org https://dev.azure.com/ORG
```

If interactive fallback is required, keep the terminal visible and let the user complete browser
or device authorization. Non-interactive runs fail instead of prompting. Do not ask the user to
paste a token or secret into chat.

## Sandbox (no-credential evaluation)

Sandbox mode runs the real orchestrator against synthetic fixtures. It resolves no credentials and
performs no provider writes, so it is the safest way to demonstrate the flow. Do not present a
sandbox run as a real migration.

```bash
node bin/run.js --list-sandbox-scenarios
node bin/run.js --sandbox happy-path
node bin/run.js --sandbox apply-happy-path --apply --yes
```

`--yes` is accepted here only because sandbox writes are simulated; it never authorizes a live
write. Sandbox reports are marked `SANDBOX` and are written next to the working directory. Sandbox
checkpoints are isolated, and sandbox resume is rejected by design, so do not attempt to resume a
scenario.

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

Run apply commands in an interactive terminal. The CLI presents the exact persisted team and member
plan and records one immutable decision before the durable Workflow continues. Never synthesize
input, pipe `yes`, or accept the decision for the user. `--yes` only applies to actions explicitly
marked non-destructive in sandbox mode.

Copilot recovery reasoning receives categorized operation metadata, not identity names or raw
provider errors. It may automatically authorize one retry only for a transient, checkpointed,
idempotent membership write. It never retries team creation. If inference is unavailable,
malformed, recommends a skip, or conflicts with local safety checks, the worker fails closed for
human review; do not infer approval from either the model response or the original plan approval.

## Parallel sessions inbox

Several apply runs can be suspended at once, each waiting for an operator decision. List retained
sessions or filter to those blocked on an elicitation:

```bash
node bin/run.js sessions
node bin/run.js sessions --blocked
node bin/run.js sessions --blocked --select
```

`--select` opens the interactive inbox for switching between blocked sessions and answering their
durable prompts. Each answer is bound to a stable elicitation ID and is immutable, so treat every
answer as a real approval and never synthesize one. `--json` emits the inbox for inspection only.
Blocked apply sessions still require the same informed approval as a foreground apply; use
[elicitation and approval](elicitation-and-approval.md) before answering any write decision.

## Reports and completion

The report contains mappings, edge cases, skipped items, failure history, and approval history. Treat it as potentially sensitive tenant data.

A run is complete only when the command succeeds and reports its output path. On successful completion, the CLI removes its checkpoint. If the command fails or is interrupted, follow [resume](resume.md).
