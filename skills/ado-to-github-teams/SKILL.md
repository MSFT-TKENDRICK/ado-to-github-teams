---
name: ado-to-github-teams
description: Use this skill when a user wants to install or operate the ado-to-github-teams CLI, migrate Azure DevOps project teams to GitHub organization teams, authenticate the CLI, review a dry run, apply a migration, recover an interrupted run, inspect a checkpoint, or resume a migration. Apply it even when the user asks generally to move ADO teams or memberships to GitHub without naming the CLI.
license: MIT
compatibility: Primarily for GitHub Copilot CLI. Requires Git, a Node.js version supported by the repository's root package, network access to Azure DevOps, Microsoft Graph, and GitHub, and credentials with the required read or write permissions.
metadata:
  author: MSFT-TKENDRICK
  version: "0.1.0"
---

# Operate ado-to-github-teams

Use the repository's CLI as the source of truth. Do not replace it with ad hoc API calls.

## Route the task

Read only the reference needed for the current operation:

- Read [installation](references/installation.md) to build, install, update, or verify the CLI.
- Read [operations](references/operations.md) to authenticate, evaluate the no-credential sandbox, plan a migration, run a dry run, apply it, use the parallel-session inbox, or interpret a report.
- Read [resume](references/resume.md) after an interruption or whenever a checkpoint or `--resume` is involved.
- Read [elicitation and approval](references/elicitation-and-approval.md) before handling credentials, changing installation state, selecting a target, accepting any CLI prompt, running `--apply`, or resuming a checkpoint.

## Required workflow

1. Classify the request as installation, authentication, dry run, apply, resume, or diagnosis.
2. Establish the exact ADO organization URL, ADO project, and GitHub organization. Never infer an organization or project when more than one is plausible.
3. Default to a dry run. Never infer permission to apply from a request to inspect, plan, test, migrate, continue, or resume.
4. Use `node bin/run.js` from a built repository checkout unless the user explicitly requests a global installation.
5. Keep interactive authentication and approval prompts visible to the user. Never answer a destructive prompt on the user's behalf.
6. After a dry run, summarize the exact proposed teams, member counts, edge cases, failures, and report path. Retrieve user feedback before proposing an apply run.
7. Before any apply or write-capable resume, present the exact command, target organizations, proposed changes, known exceptions, and recovery checkpoint behavior; then obtain fresh explicit approval.
8. Report the command outcome, report path, run ID when available, and any remaining checkpoint. Do not claim completion if approval was declined, the process was interrupted, or failures remain.

## Safety invariants

- Dry run is the default; `--apply` is opt-in.
- `--yes` does not authorize destructive operations and must not be presented as doing so.
- Team creation, member assignment, conflict resolution, and SSO skip/continue decisions require the user's decision.
- Checkpoints and reports may contain tenant and identity data. Keep them local, do not commit them, and disclose only the minimum metadata needed.
- Never request that credentials or tokens be pasted into chat, logs, commands, reports, or committed files.
- A resumed checkpoint may already be in a write phase. Omission of `--apply` does not make such a resume safe; follow the resume reference and obtain explicit approval.
- Do not edit checkpoint JSON. If targets, naming rules, CLI version, or checkpoint integrity are uncertain, fail closed and start a new dry run.
