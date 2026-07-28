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
  checkpoints, reports, command history, fixtures, or logs.
- Redact authorization headers, tokens, user identifiers, tenant data, and provider error payloads.
- Treat team, membership, identity, and organization writes as destructive. Keep dry-run as the
  default and require recorded approval before execution.
- Validate checkpoint ownership and schema before resume. Refuse ambiguous target organizations or
  projects.

Supported versions receive security fixes on the default branch until a release policy supersedes
this foundation policy.
