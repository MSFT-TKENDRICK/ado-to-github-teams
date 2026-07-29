# Interrupted runs and resume

Read this reference whenever a command was interrupted, a checkpoint exists, or `--resume` is considered.

## Preserve the interruption boundary

On a normal interrupt, allow the CLI to exit and flush checkpoint state. Do not immediately kill the process tree. If it does not exit, report that checkpoint freshness is uncertain before taking further action.

Checkpoint files are stored at:

```text
~/.ado-github-teams/checkpoints/<runId>.json
```

They may contain tenant, team, and identity data. Never commit, upload, or paste a checkpoint into chat.

## Inspect before selecting

Inspect checkpoints read-only. Extract only:

- `runId`
- `timestamp`
- `phase`
- `adoOrg`
- `adoProject`
- `githubOrg`
- counts of completed teams and completed member assignments

Do not print mappings, identities, credentials, or the full JSON. If several checkpoints match, ask the user to choose using the minimal metadata above. Never pick the newest checkpoint solely by timestamp.

## Resume eligibility

Before resume, verify all of the following:

1. The user identified the intended run.
2. ADO organization, ADO project, and GitHub organization exactly match the checkpoint.
3. The CLI checkout/version and naming rules are compatible with the interrupted run.
4. The checkpoint parses without modification.
5. The current credentials still target and authorize the same organizations.
6. The checkpoint phase and completed-item counts are plausible for the reported interruption.

If any check fails or cannot be established, do not resume. Start a new dry run instead.

## Write-phase warning

The checkpoint phase controls where execution continues. A checkpoint in `create-teams`, `assign-members`, or `report` may continue a previously approved apply run even if the new command omits `--apply`.

Therefore:

- never use omission of `--apply` as a safety control for resume;
- treat a resume at or after `create-teams` as destructive;
- show the phase, targets, completed counts, remaining planned changes, and exact resume command;
- obtain fresh explicit user approval immediately before starting;
- include `--apply` to make the write intent visible.

## Resume command

Use the original targets and reviewed naming flags:

```bash
node bin/run.js migrate --ado-org https://dev.azure.com/ORG --ado-project PROJECT --github-org GITHUB_ORG --apply --resume RUN_ID
```

Run it interactively. The CLI skips team slugs and team/member pairs already recorded as completed, but it can ask for destructive approval again. The user must answer those prompts.

Omit `--output` to receive a unique report path. If the user requests a custom path, verify that it
does not already exist because the CLI overwrites existing report files.

Do not manually mark work complete, edit phase values, merge checkpoints, or retry with a different target.

## After resume

- Success: report the new report path and confirm that the checkpoint was removed.
- Declined approval: report that no approval was granted and preserve the checkpoint.
- Failure or second interruption: report the last known phase and whether the checkpoint timestamp advanced.
- Missing checkpoint: fail closed; do not reconstruct one from a report.
