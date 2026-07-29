import type {AdoMember, AdoTeam, EdgeCase, EdgeCaseReason} from '../../types/index.js'

const recommendations: Record<EdgeCaseReason, string> = {
  'no-ghemu-account': 'Invite user to GitHub org as GHEMU user',
  'guest-user': 'Guest accounts cannot be GHEMU users; create a GitHub.com account manually',
  'suspended-account': 'Reactivate user in GitHub before migrating',
  'ambiguous-match': 'Multiple GitHub users match this email; specify login manually',
  'missing-email': 'User has no verified email in Entra; add email to Entra profile',
  'circular-group-member': 'Remove circular group reference in Entra before migrating',
  'entra-role-only': 'Service account or role; create corresponding GitHub bot/team manually',
  'ado-project-role':
    'ADO project roles (Project Admin, Build Admin) have no GitHub equivalent; assign GitHub team maintainer role manually',
  'nested-group-skipped': 'Nested group exceeded depth limit; enumerate group members manually',
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
