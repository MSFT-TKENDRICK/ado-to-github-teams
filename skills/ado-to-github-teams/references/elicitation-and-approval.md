# Elicitation, feedback, and approval

Use this reference whenever user input can affect scope, credentials, naming, writes, recovery, or exception handling.

## Elicit before execution

Ask the user when any of these are missing or ambiguous:

- the exact ADO organization URL, ADO project, or GitHub organization;
- whether to use the current checkout or perform an explicitly requested global installation;
- whether interactive sign-in is permitted when ambient authentication is unavailable;
- intended team-name prefix or suffix when naming requirements were stated but not resolved;
- the output path when replacing an existing report is possible;
- which checkpoint to resume when more than one is plausible;
- whether changed CLI code, targets, credentials, or naming rules invalidate a checkpoint.

Do not elicit values with safe, documented defaults unless the user's intent conflicts with those defaults. State that dry run is the default, use repository-local execution by default, and choose a new report path rather than overwriting an existing one.

## Retrieve feedback after planning

After a dry run, provide a compact decision brief:

```text
Targets: <ADO org>/<project> -> <GitHub org>
Plan: <team count> teams, <member assignment count> assignments
Exceptions: <edge-case and failure counts>
Names: <prefix/suffix and any alternate slugs>
Report: <local path>
Recommendation: apply | revise and rerun | stop
```

Then ask the user to choose whether to revise, stop, or proceed to an approval step. User feedback is required when there are ambiguous mappings, name conflicts, unexpected teams or members, skipped identities, permission failures, or a changed source/target state.

Do not invent identity mappings, alternate logins, organizational policy, or acceptance of edge cases.

## Approval standard

Approval for a write must be:

- **informed**: show exact targets, actions, counts, exceptions, and command;
- **specific**: limited to this run and this proposed change;
- **fresh**: obtained after the latest dry run or resume inspection;
- **affirmative**: silence, prior unrelated consent, and a request to "continue" are not approval to write;
- **recordable**: let the CLI capture its own approval prompt and history.

The agent must not answer these CLI decisions for the user:

| Decision | Why user input is required |
| --- | --- |
| Create GitHub teams | Destructive organization write |
| Assign team members | Identity and membership write |
| Accept an alternate slug | Changes the reviewed target mapping |
| Skip after SSO enforcement | Accepts incomplete migration behavior |
| Resume at or after `create-teams` | Can continue prior writes |
| Install globally | Changes the user's environment |

Keep the interactive terminal visible and ask the user to respond there. Do not use piped input or automation to bypass prompts.

## No additional approval needed

Within an already authorized task, the agent may:

- run `--help`;
- inspect repository metadata and build prerequisites;
- perform the requested repository-local dependency install and build;
- summarize a local report without exposing identity details;
- allow the CLI's bounded retry for rate limits or transient network failures.

Still respect tool-level permission prompts imposed by the agent client.

## Stop rather than elicit continuation

Stop and report the failure when:

- permission is denied without an SSO-specific skip path;
- the failure is unknown or checkpoint integrity is uncertain;
- the requested checkpoint does not exist;
- target or configuration compatibility cannot be verified;
- the user declines any required approval.

Do not turn these failures into a generic "continue anyway" question.
