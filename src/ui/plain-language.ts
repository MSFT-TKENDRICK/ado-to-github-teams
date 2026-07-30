import type {EdgeCaseReason} from '../types/index.js'

const EDGE_CASE_LABELS: Record<EdgeCaseReason, string> = {
  'no-ghemu-account': 'No enterprise-managed GitHub account',
  'guest-user': 'Guest account cannot be enterprise-managed',
  'disabled-account': 'Source directory account is disabled',
  'unresolved-identity': 'Source identity could not be resolved',
  'suspended-account': 'GitHub account is suspended',
  'ambiguous-match': 'More than one GitHub account matches',
  'missing-email': 'No usable sign-in name or email',
  'circular-group-member': 'Directory group contains a circular reference',
  'entra-role-only': 'Directory entry is a role or service identity',
  'ado-project-role': 'Source project role has no direct GitHub equivalent',
  'nested-group-skipped': 'Nested directory group exceeded the depth limit',
  'idp-managed-team': 'Team membership is managed by directory synchronization',
}

export function edgeCaseLabel(reason: EdgeCaseReason): string {
  return `${EDGE_CASE_LABELS[reason]} (${reason})`
}

export function providerTerminology(): readonly string[] {
  return [
    '**Azure DevOps:** the source project and team system. Technical fields may use `ADO`.',
    '**Microsoft Entra ID:** the source identity directory. Older or technical messages may say `Entra`.',
    '**Enterprise-managed GitHub account:** a GitHub Enterprise Managed User account. Technical identifiers may use `EMU` or `GHEMU`.',
    '**Directory synchronization:** membership controlled by an identity provider through SCIM or team synchronization. Change those memberships in the source directory, not in this migration.',
    '**Sign-in name (UPN):** the directory username, usually formatted like an email address.',
  ]
}
