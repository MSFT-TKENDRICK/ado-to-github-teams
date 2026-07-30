# Interrupted runs and resume

Read this reference whenever a command was interrupted, a retained session exists, or `--resume`
is considered.

## Preserve the interruption boundary

On a normal interrupt, allow the CLI to disconnect cleanly. The worker continues to own durable
state and may continue until it reaches a decision or completion boundary. Do not stop the worker
or queue merely because the CLI process exited.

The default local World stores durable state in `~/.ado-github-teams/workflow.db`; Compose stores
it in the `workflow-data` volume. This state may contain tenant, team, and identity data. Never
commit, upload, paste, edit, or query the database to reconstruct a migration.

## Inspect before selecting

Use the supported session API:

```bash
node bin/run.js sessions
node bin/run.js sessions --blocked
```

Use the run ID, source, target, status, current stage, pending event, and update time shown by the
CLI. Do not print identities, credentials, reports, or internal event data. If several sessions
match, ask the user to choose. Never pick a run solely because it is newest.

## Resume eligibility

Before resume, verify all of the following:

1. The user identified the intended run.
2. ADO organization, ADO project, and GitHub organization exactly match the retained session.
3. The CLI checkout/version and naming rules are compatible with the interrupted run.
4. The worker reports the session through the supported API.
5. The current credentials still target and authorize the same organizations.
6. The reported stage and pending event are plausible for the reported interruption.

If any check fails or cannot be established, do not resume. Start a new dry run instead.

## Write-phase warning

The retained workflow stage controls where execution continues. A run in a write phase may
continue a previously approved apply even if the reconnecting command omits `--apply`.

Therefore:

- never use omission of `--apply` as a safety control for resume;
- treat a write-capable stage or pending write approval as destructive;
- show the stage, targets, remaining planned changes, and exact resume command;
- obtain fresh explicit user approval immediately before starting;
- include `--apply` to make the write intent visible.

## Resume command

Use the original targets and reviewed naming flags:

```bash
node bin/run.js migrate --ado-org https://dev.azure.com/ORG --ado-project PROJECT --github-org GITHUB_ORG --apply --resume RUN_ID --foreground
```

Run it interactively. The workflow skips completed units, but it can ask for destructive approval
again. The user must answer those prompts.

Omit `--output` to receive a unique report path. If the user requests a custom path, verify that it
does not already exist because the CLI overwrites existing report files.

Do not manually mark work complete, edit workflow state, or retry with a different target.

## After resume

- Success: report the final outcome and report path.
- Declined approval: report that no approval was granted and preserve the retained session.
- Failure or second interruption: report the last known stage and pending event.
- Missing session: fail closed; do not reconstruct one from a report.
