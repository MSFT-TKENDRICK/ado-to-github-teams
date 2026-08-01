# CLI operations

Use this reference for authentication, dry runs, apply runs, and reports.

Set `CLI` conceptually to `node bin/run.js` for a repository checkout or `a2g` for an explicitly approved global install.

## Discover current syntax

Before constructing a command, use the installed version's task-oriented root help:

```bash
node bin/run.js --help
node bin/run.js auth --help
node bin/run.js migrate --help
```

Root help maps preview, credential diagnosis, latest-session recovery, blocked-session resolution,
and credential-free sandbox evaluation to valid starting commands. Prefer help output over
remembered flags if the checkout differs from this reference. Completion output provides
contextual next commands; preserve the printed scope instead of reconstructing it from memory.

Migration preflight rejects dependencies, exclusions, unsupported sandbox modes, partial new-run
scope, invalid concurrency, and live `--yes` before worker or provider access. Use the printed
`Valid command:` shape as the correction source; do not discard retained `--resume` state or add
`--fresh` unless the user explicitly intends a separate run. Root help exits 0; preflight rejection
exits 2 without creating a worker session or checkpoint.

Migration help groups live scope, execution, recovery, presentation, naming/topology, worker, and
sandbox controls. `--source-org`, `--source-project`, and `--target-org` are task-shaped aliases for
`--ado-org`, `--ado-project`, and `--github-org`; they use the same preflight and checkpoint values.
Named scope profiles are not supported or persisted. Reuse only a validated retained session, and
never create a repository-local profile containing tenant scope.

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

The result has one Azure DevOps, GitHub, and Entra entry. Each entry states whether the check was
planned and attempted, its status, a safely identifiable source, a non-secret reason, and a
remediation. Omit `--ado-org` only when intentionally skipping the Azure DevOps organization check.

For unattended readiness checks, use the stable JSON contract:

```bash
node bin/run.js auth --ado-org https://dev.azure.com/ORG --json
```

JSON mode disables interactive browser and device fallback. The schema-version 1 result is the only
stdout document; never parse human presentation text. Any planned provider that is unready exits
non-zero. `--quiet` is for exit-status-only successful human checks and still prints failures. Do
not combine `--json` and `--quiet`; the CLI rejects that conflict before credential resolution or
provider access.

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
node bin/run.js migrate --sandbox happy-path
node bin/run.js migrate --sandbox apply-happy-path --apply --yes
```

The top-level command mounts the interactive surface with `happy-path` preselected; nothing starts
until the operator presses Enter, and the surface stays visible until they exit it. It requires a
real terminal. The explicit `migrate --sandbox` commands run one scenario and return, and are the
only noninteractive sandbox form. `--yes` is accepted here only
because sandbox writes are simulated; live use is rejected. Sandbox reports are marked `SANDBOX`
and are written next to the working directory. Sandbox checkpoints are isolated, and sandbox resume
is rejected by design, so do not attempt to resume a scenario.

## Dry run

Run without `--apply`:

```bash
node bin/run.js migrate --ado-org https://dev.azure.com/ORG --ado-project PROJECT --github-org GITHUB_ORG --foreground
```

The equivalent task-shaped spelling is:

```bash
node bin/run.js migrate --source-org https://dev.azure.com/ORG --source-project PROJECT --target-org GITHUB_ORG --foreground
```

A dry run performs remote reads, identity resolution, durable workflow writes, and report output.
It does not create teams or assign members. A team-name conflict can still require user feedback
to choose a proposed alternate slug.

Omit `--output` to use the unique `migration-report-<runId>.md` default. If the user requests a
custom path, check that it does not already exist before running because the CLI overwrites an
existing file.

Use `--concurrency` only when the user or an observed service limit requires tuning. The default is
`4`. Preflight rejects non-integer or non-positive values before worker access and prints a valid
command with `--concurrency 1`.

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
node bin/run.js migrate --ado-org https://dev.azure.com/ORG --ado-project PROJECT --github-org GITHUB_ORG --apply --foreground
```

Carry over reviewed `--prefix` and `--suffix` values exactly. A fresh apply run re-reads source and target state, so call out material differences from the reviewed dry run before accepting a write prompt.

Run apply commands in an interactive terminal. The CLI presents the exact persisted team and member
plan and records one immutable decision before the durable Workflow continues. Never synthesize
input, pipe `yes`, or accept the decision for the user. In sandbox mode, `--yes` applies the
scenario's predefined decisions; live use is rejected.

Copilot recovery reasoning receives categorized operation metadata, not identity names or raw
provider errors. It may automatically authorize one retry only for a transient, checkpointed,
idempotent membership write. It never retries team creation. If inference is unavailable,
malformed, recommends a skip, or conflicts with local safety checks, the worker fails closed for
human review; do not infer approval from either the model response or the original plan approval.

Every apply run — flat or `--team-topology` — checks each target team for IdP/SCIM management
before writing membership. If the adapter cannot report that status, the run fails closed with a
validation error; if a specific team is confirmed synchronized, its member writes are skipped and
reported as an `idp-managed-team` edge case directing the operator to the identity provider instead,
and the decision is re-checked (not bypassed) on resume. See
[Synchronizing a team with an identity provider group](https://docs.github.com/en/enterprise-cloud@latest/organizations/organizing-members-into-teams/synchronizing-a-team-with-an-identity-provider-group).

## Team topology

Choosing flat vs. nested team structure is a per-enterprise decision, not a CLI default to
override casually:

- **EMU / SCIM-managed enterprises** — keep entitlement teams flat (no `--team-topology`).
  GitHub does not allow a team connected to an IdP group to be a parent or child of another team,
  so nesting synchronized teams is unsupported and the tool rejects it before any write. See
  [Managing team memberships with IdP groups](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/provisioning-user-accounts-with-scim/managing-team-memberships-with-identity-provider-groups).
- **Personal-account (non-EMU) enterprises** — use `--team-topology` for a manually managed
  structural parent (OU/project) with synchronized or migration-managed leaf teams that hold the
  actual repository grants. See
  [Nested teams and inherited access](https://docs.github.com/en/organizations/organizing-members-into-teams/about-teams#nested-teams).

Before proposing a topology apply, the tool validates: the proposed repository role does not fall
below the organization's base permission (least privilege), an existing team is never silently
re-parented, secret teams cannot be nested, and any parent-team repository access already granted
is called out so it cannot silently broaden a child's effective access. Review the dry-run
hierarchy and grants sections against these checks before approving. See
[Repository roles](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization).

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

A run is complete only when the supported session status reports completion and provides its
outcome or report path. If the CLI disconnects, fails, or reports a retained blocked session,
follow [resume](resume.md).
