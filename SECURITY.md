# Security policy

## Reporting a vulnerability

Report vulnerabilities through the repository's private GitHub security advisory flow. Do not open a
public issue or include exploit details, credentials, tenant identifiers, personal data, or access
tokens in a pull request.

Include the affected revision, impact, reproduction conditions, and a safe contact method. The
maintainers will coordinate validation, remediation, and disclosure.

## Credential and migration safety

- Use separate least-privilege credentials for Azure DevOps, Microsoft Entra ID, and GitHub.
- Store secrets in the approved secret manager or environment; never in repository files,
  workflow state, reports, command history, fixtures, or logs.
- Redact authorization headers, tokens, user identifiers, tenant data, and provider error payloads.
- Use `auth --ado-org <url>` for provider readiness and `auth --json` for automation. Diagnostic
  output must remain noninteractive, schema-validated, and non-secret: never add tokens, tenant
  identifiers, organization URLs, configuration paths, or raw provider errors. A planned provider
  failure must retain a non-zero exit, and `--json --quiet` must be rejected before credential or
  provider access.
- Treat team, membership, identity, and organization writes as destructive. Keep dry-run as the
  default and require recorded approval before execution.
- Migration command preflight must reject contradictory flags, unsupported sandbox modes, partial
  new-run scope, invalid concurrency, and live noninteractive approval before worker or provider
  access. A rejected command must exit 2 and print a non-secret corrected command shape.
- `--source-org`, `--source-project`, and `--target-org` are aliases for the canonical live-scope
  flags, not a separate configuration source. The CLI must not persist an implicit or named scope
  profile; retained checkpoint scope is the only reuse path and remains subject to resume validation.
  Never commit organization URLs, project names, or target organizations in a local profile file.
- Validate retained-session ownership, scope, and configuration before resume. Refuse ambiguous
  target organizations or projects.
- Treat Squad as development-time orchestration, not an application security boundary. Its hooks
  supplement but do not replace the migration CLI's approval, checkpoint, idempotency, and retry
  enforcement.
- Keep Squad decisions, histories, memory, sessions, logs, and telemetry free of credentials,
  tenant identifiers, personal data, generated reports, and checkpoint contents. These mutable paths
  are ignored locally; only static `squad.config.ts` and generated definitions are committed.
- Keep `.mcp.json` on the pinned local Squad CLI. Do not replace it with a floating package version
  or add tokens to MCP configuration.

Supported versions receive security fixes on the default branch until a release policy supersedes
this foundation policy.
