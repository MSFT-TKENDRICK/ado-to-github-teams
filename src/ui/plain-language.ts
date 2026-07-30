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

const EDGE_CASE_RECOMMENDATIONS: Record<EdgeCaseReason, string> = {
  'no-ghemu-account':
    'Provision an enterprise-managed GitHub account for this person before migrating',
  'guest-user':
    'Guest accounts cannot become enterprise-managed GitHub accounts; review the person and access need manually',
  'disabled-account':
    'Enable the person in Microsoft Entra ID and provision their account before migrating',
  'unresolved-identity':
    'Link the Azure DevOps identity to an active person in Microsoft Entra ID before migrating',
  'suspended-account': 'Reactivate the person in GitHub before migrating',
  'ambiguous-match': 'More than one GitHub account matches; specify the login manually',
  'missing-email': 'Add a usable sign-in name or verified email to the Microsoft Entra ID profile',
  'circular-group-member':
    'Remove the circular directory-group reference in Microsoft Entra ID before migrating',
  'entra-role-only':
    'This entry is a role or service identity rather than a person; create the appropriate GitHub bot or team manually',
  'ado-project-role':
    'Azure DevOps project roles such as Project Admin and Build Admin have no direct GitHub equivalent; assign the appropriate GitHub team role manually',
  'nested-group-skipped':
    'The nested group exceeded the depth limit; review and add its members manually',
  'idp-managed-team':
    'Directory synchronization controls this team; add or remove members in the Microsoft Entra ID group or GitHub team-synchronization configuration, not this tool',
}

export function edgeCaseLabel(reason: EdgeCaseReason): string {
  return `${EDGE_CASE_LABELS[reason]} (${reason})`
}

export function edgeCaseRecommendation(reason: EdgeCaseReason): string {
  return EDGE_CASE_RECOMMENDATIONS[reason]
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
