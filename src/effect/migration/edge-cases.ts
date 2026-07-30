import type {AdoMember, AdoTeam, EdgeCase, EdgeCaseReason} from '../../types/index.js'

const recommendations: Record<EdgeCaseReason, string> = {
  'no-ghemu-account':
    'Provision an enterprise-managed GitHub account for this person before migrating',
  'guest-user':
    'Guest accounts cannot become enterprise-managed GitHub accounts; review the person and access need manually',
  'disabled-account':
    'Enable the person in Microsoft Entra ID and provision their account before migrating',
  'unresolved-identity':
    'Link the Azure DevOps identity to an active person in Microsoft Entra ID before migrating',
  'suspended-account': 'Reactivate user in GitHub before migrating',
  'ambiguous-match': 'Multiple GitHub users match this email; specify login manually',
  'missing-email': 'Add a usable sign-in name or verified email to the Microsoft Entra ID profile',
  'circular-group-member':
    'Remove the circular directory-group reference in Microsoft Entra ID before migrating',
  'entra-role-only':
    'This entry is a role or service identity rather than a person; create the appropriate GitHub bot or team manually',
  'ado-project-role':
    'Azure DevOps project roles such as Project Admin and Build Admin have no direct GitHub equivalent; assign the appropriate GitHub team role manually',
  'nested-group-skipped': 'Nested group exceeded depth limit; enumerate group members manually',
  'idp-managed-team':
    'Directory synchronization controls this team; add or remove members in the Microsoft Entra ID group or GitHub team-synchronization configuration, not this tool',
}

export function createEdgeCase(
  reason: EdgeCaseReason,
  details: string,
  adoIdentity?: AdoMember,
  adoTeam?: AdoTeam,
): EdgeCase {
  return {
    reason,
    details,
    recommendation: recommendations[reason],
    ...(adoIdentity ? {adoIdentity} : {}),
    ...(adoTeam ? {adoTeam} : {}),
  }
}

export function isProjectRole(displayName: string): boolean {
  return /(project|build|release).*(admin|administrator|role)/i.test(displayName)
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}
