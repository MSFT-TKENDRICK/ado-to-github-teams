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
- Validate retained-session ownership, scope, and configuration before resume. Refuse ambiguous
  target organizations or projects.

Supported versions receive security fixes on the default branch until a release policy supersedes
this foundation policy.
