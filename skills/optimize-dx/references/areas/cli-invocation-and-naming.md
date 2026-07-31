# CLI invocation and naming

Review the installed command as a consumer sees it, not only the source entrypoint.

- Is the primary executable short, memorable, and consistent in package metadata, help, errors,
  examples, and diagnostics?
- Does packaged `a2g --help` lead with `a2g`, while any legacy name is clearly a compatibility
  alias rather than the recommended command?
- Are subcommands discoverable through shipped help without requiring repository knowledge?
- Do prompts describe the operation they actually perform, especially preflight versus live
  runtime switching?
- Can a failing invocation identify the command, next action, and relevant configuration without
  exposing secrets?

**Required evidence:** run the packaged primary command and the affected subcommand help. Source
tests or prose alone do not prove the consumer invocation.
